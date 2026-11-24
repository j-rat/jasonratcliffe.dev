// Runs a named view with CloudWatch Logs Insights using the default AWS credential chain
// (your `aws login` / AWS_PROFILE session). Falls back to labeled sample data when there are no credentials.
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand, StopQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { LOG_GROUPS, MAX_ROWS, PAGE_SIZE, RANGES, sampleRows, VIEWS } from './views.mjs';
import net from 'node:net';

/** Network prefix for a viewer IP: IPv4 /24, IPv6 /48. Anything else becomes '-'. The full IP is dropped. */
export function ipPrefix(ip) {
  const v = String(ip ?? '').trim();
  if (net.isIPv4(v)) return `${v.split('.').slice(0, 3).join('.')}.0/24`;
  if (net.isIPv6(v)) {
    const [head, tail = ''] = v.toLowerCase().split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const full = v.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    return `${full.slice(0, 3).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/48`;
  }
  return '-';
}

/** Replace every `ip` with `source` (its prefix), run the view's post hook, and merge rows that now match. */
export function protectIps(view, rows) {
  // Swap `ip` for `source` in place, so column order is kept; the full address goes no further.
  let out = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => (k === 'ip' ? ['source', ipPrefix(v)] : [k, v]))));
  if (view.post) out = view.post(out);
  if (!view.sum) return out;
  const merged = new Map();
  for (const r of out) {
    const key = JSON.stringify(Object.entries(r).filter(([k]) => !view.sum.includes(k)));
    const m = merged.get(key);
    if (!m) merged.set(key, { ...r });
    else for (const k of view.sum) m[k] = String(Number(m[k] || 0) + Number(r[k] || 0));
  }
  return [...merged.values()].sort((a, b) => Number(b[view.sortBy] || 0) - Number(a[view.sortBy] || 0));
}

const REGION = process.env.AWS_REGION || 'us-east-1';
const TIMEOUT_MS = 30_000;
const client = new CloudWatchLogsClient({ region: REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NO_CREDS = new Set(['CredentialsProviderError', 'ExpiredTokenException', 'UnrecognizedClientException', 'InvalidSignatureException', 'TokenRefreshRequired']);

// Summary views: Logs Insights computes every group anyway, so the result is kept briefly per session and
// handed out PAGE_SIZE rows at a time. Event views never use this: they fetch one page per query.
const SUMMARY_TTL_MS = 5 * 60_000;
const summaries = new Map(); // `${sid}|${view}|${range}` -> { at, result }

function pruneSummaries() {
  for (const [k, v] of summaries) if (Date.now() - v.at > SUMMARY_TTL_MS) summaries.delete(k);
  while (summaries.size > 100) summaries.delete(summaries.keys().next().value);
}

const columnsOf = (rows) => [...new Set(rows.flatMap((r) => Object.keys(r)))];

/** One Logs Insights query -> raw rows (or labeled sample rows when there are no credentials). */
async function query(view, range, p, forceSample) {
  const sample = async (reason) => {
    await sleep(Number(process.env.LV_SAMPLE_DELAY_MS || 0)); // sample mode only: lets you see the loader
    let rows = sampleRows(view.id, range.id);
    if (view.events) rows = rows.filter((r) => !p.before || Number(r.ts) < Number(p.before)).slice(0, p.limit);
    return { source: 'sample', reason, raw: rows };
  };
  if (forceSample) return sample('sample mode');
  const end = Math.floor(Date.now() / 1000);
  const groups = (view.groups ?? [view.group]).map((g) => LOG_GROUPS[g]);
  const started = Date.now();
  try {
    const { queryId } = await client.send(new StartQueryCommand({
      logGroupNames: groups, startTime: end - range.seconds, endTime: end, queryString: view.query(range, p), limit: Math.min(MAX_ROWS, p.limit),
    }));
    for (;;) {
      const res = await client.send(new GetQueryResultsCommand({ queryId }));
      if (res.status === 'Complete') {
        const raw = (res.results ?? []).map((row) => Object.fromEntries(row.filter((f) => !f.field.startsWith('@ptr')).map((f) => [f.field, f.value ?? ''])));
        return { source: 'aws', raw, ms: Date.now() - started, scannedBytes: res.statistics?.bytesScanned ?? 0, groups };
      }
      if (['Failed', 'Cancelled', 'Timeout', 'Unknown'].includes(res.status)) throw new Error(`query ${res.status}`);
      if (Date.now() - started > TIMEOUT_MS) {
        await client.send(new StopQueryCommand({ queryId })).catch(() => {});
        throw new Error('query timed out');
      }
      await sleep(700);
    }
  } catch (err) {
    if (NO_CREDS.has(err.name) || /credential/i.test(err.message)) return sample('no usable AWS credentials (run `aws login`, or set AWS_PROFILE)');
    throw err;
  }
}

/**
 * Run a view for one page.
 *   events:  { cursor } -> PAGE_SIZE lines older than the cursor (or up to MAX_ROWS with all)
 *   summary: { page }   -> rows page*PAGE_SIZE.. of the cached result (or every row with all)
 */
export async function runView(viewId, rangeId, { forceSample = false, sid = '', page = 0, cursor = null, all = false } = {}) {
  const view = { id: viewId, ...VIEWS[viewId] };
  const range = { id: rangeId, ...RANGES[rangeId] };

  if (view.events) {
    const limit = all ? MAX_ROWS : PAGE_SIZE + 1; // one extra line says whether there is a next page
    const q = await query(view, range, { limit, before: all ? null : cursor }, forceSample);
    const hasMore = !all && q.raw.length > PAGE_SIZE;
    const pageRaw = all ? q.raw : q.raw.slice(0, PAGE_SIZE);
    const nextCursor = hasMore ? pageRaw.at(-1)?.ts ?? null : null;
    const rows = protectIps(view, pageRaw.map(({ ts, ...r }) => r));
    const { raw, ...meta } = q;
    return { ...meta, rows, columns: columnsOf(rows), page: { kind: 'cursor', index: page, size: PAGE_SIZE, hasMore, nextCursor }, all };
  }

  pruneSummaries();
  const key = `${sid}|${viewId}|${rangeId}`;
  let cached = summaries.get(key);
  if (!cached || page === 0 && !all) { // page 0 is a fresh run; later pages and "show all" reuse it
    const q = await query(view, range, { limit: MAX_ROWS }, forceSample);
    const { raw, ...meta } = q;
    cached = { at: Date.now(), result: { ...meta, rows: protectIps(view, raw) } };
    summaries.set(key, cached);
  }
  const { rows: everything, ...meta } = cached.result;
  const total = everything.length;
  const index = Math.min(page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
  const rows = all ? everything : everything.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);
  return {
    ...meta, rows, columns: columnsOf(everything), all, cachedAt: new Date(cached.at).toISOString(),
    page: { kind: 'index', index, size: PAGE_SIZE, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), hasMore: !all && (index + 1) * PAGE_SIZE < total },
  };
}
