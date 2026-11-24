// Viewer IPs: queries may select `c-ip as ip`, but lib/logs.mjs replaces every `ip` value with its network
// prefix (IPv4 /24, IPv6 /48) and re-aggregates before anything is sent to the browser. `sum` lists the
// numeric columns to add up when several IPs collapse into one prefix.

// Event views (`events: true`) list individual log lines newest first and page with a time cursor:
// each page asks Logs Insights for PAGE_SIZE + 1 lines older than the last one shown, so nothing beyond the
// current page is fetched. `ts` (epoch ms) is the cursor; the server strips it before rows leave.
export const PAGE_SIZE = 50;
export const MAX_ROWS = 10_000; // Logs Insights' own ceiling, used by "Show all"
const page = ({ limit, before }) => `${before ? `| filter @timestamp < ${Number(before)} ` : ''}| sort @timestamp desc | limit ${limit}`;

// Named, server-side views. The browser only ever sends a view id and a range id; the query text and the
// log group come from this file, so a stolen session can't run arbitrary Logs Insights queries.

const PROJECT = process.env.LV_PROJECT || 'resume-site';

export const LOG_GROUPS = {
  edge: `/aws/vendedlogs/${PROJECT}-cloudfront`,
  contact: `/aws/lambda/${PROJECT}-contact`,
  report: `/aws/lambda/${PROJECT}-edge-report`,
};

export const RANGES = {
  '1h': { label: 'Last hour', seconds: 3600, bin: '5m' },
  '24h': { label: 'Last 24 hours', seconds: 86_400, bin: '1h' },
  '7d': { label: 'Last 7 days', seconds: 7 * 86_400, bin: '6h' },
};

// `chart` names the columns for a simple bar chart (x = time bucket, y = value).
export const VIEWS = {
  'edge-traffic': {
    title: 'Edge traffic',
    group: 'edge',
    description: 'Requests over time by status class.',
    query: (r) => "fields `sc-status` as status | fields concat(substr(status, 0, 1), 'xx') as class "
      + `| stats count(*) as requests by bin(${r.bin}) as time, class | sort time asc`,
    chart: { x: 'time', y: 'requests', series: 'class' },
  },
  'top-paths': {
    title: 'Top paths',
    group: 'edge',
    description: 'Most requested paths, the status they got, and where from.',
    query: () => "stats count(*) as requests by `cs-uri-stem` as path, `sc-status` as status, `c-country` as country "
      + '| sort requests desc | limit 10000',
  },
  'top-sources': {
    title: 'Top sources',
    group: 'edge',
    description: 'Requests by source network (IPv4 /24, IPv6 /48) and country.',
    query: () => "stats count(*) as requests by `c-ip` as ip, `c-country` as country, `sc-status` as status "
      + '| sort requests desc | limit 10000',
    // Status folds into an errors count; the per-status rows then merge by source + country.
    post: (rows) => rows.map(({ status, ...r }) => ({ ...r, errors: /^[45]/.test(status ?? '') ? r.requests : '0' })),
    sum: ['requests', 'errors'],
    sortBy: 'requests',
  },
  errors: {
    title: 'Errors (4xx / 5xx)',
    group: 'edge',
    description: 'Failed requests by path, method and status.',
    query: () => "filter `sc-status` like /^[45]/ "
      + "| stats count(*) as requests by `cs-uri-stem` as path, `cs-method` as method, `sc-status` as status, "
      + "`c-ip` as ip, `c-country` as country | sort requests desc | limit 10000",
    sum: ['requests'],
    sortBy: 'requests',
  },
  cache: {
    title: 'Cache results',
    group: 'edge',
    description: 'How CloudFront answered: Hit, Miss, RefreshHit, Error, Redirect.',
    query: () => "stats count(*) as requests by `x-edge-result-type` as result | sort requests desc",
  },
  countries: {
    title: 'Countries',
    group: 'edge',
    description: 'Requests by viewer country (IPs are never logged).',
    query: () => "stats count(*) as requests by `c-country` as country | sort requests desc | limit 10000",
  },
  recent: {
    title: 'Recent requests',
    group: 'edge',
    description: 'Every request at the edge, newest first.',
    events: true,
    query: (r, p) => "fields @timestamp as time, toMillis(@timestamp) as ts, `c-ip` as ip, `c-country` as country, `cs-method` as method, "
      + "`cs-uri-stem` as path, `sc-status` as status, `x-edge-result-type` as result, `cs(User-Agent)` as user_agent "
      + page(p),
  },
  'api-requests': {
    title: 'Contact API requests',
    group: 'contact',
    groups: ['edge'],
    description: 'Every request to /api/* as the edge saw it: the source and country the functions never see.',
    events: true,
    query: (r, p) => "filter `cs-uri-stem` like /^\\/api\\// "
      + "| fields @timestamp as time, toMillis(@timestamp) as ts, `c-ip` as ip, `c-country` as country, `cs-method` as method, "
      + "`cs-uri-stem` as path, `sc-status` as status, `cs(User-Agent)` as user_agent " + page(p),
  },
  'contact-outcomes': {
    title: 'Contact form outcomes',
    group: 'contact',
    description: 'Every outcome the contact Lambda logged, including delivered messages.',
    query: () => 'filter message like /"request_id"/ '
      + '| parse message /"event": "(?<event>[a-z-]+)"/ | parse message /"reason": "(?<rs>[^"]+)"/ '
      + '| fields coalesce(rs, "-") as reason | filter ispresent(event) '
      + '| stats count(*) as count by event, reason | sort count desc',
  },
  'lambda-health': {
    title: 'Lambda health',
    group: 'contact',
    groups: ['contact', 'report'],
    description: 'Invocations, errors and duration for both functions.',
    query: () => 'filter type = "platform.report" '
      + '| stats count(*) as invocations, sum(record.status != "success") as failed, '
      + 'round(avg(record.metrics.durationMs), 1) as avg_ms, round(max(record.metrics.durationMs), 1) as max_ms by @log as function',
  },
  'lambda-errors': {
    title: 'Lambda errors and warnings',
    group: 'contact',
    groups: ['contact', 'report'],
    description: 'Latest ERROR and WARNING lines from both functions.',
    events: true,
    query: (r, p) => 'filter level in ["ERROR", "WARNING", "WARN"] '
      + '| fields @timestamp as time, toMillis(@timestamp) as ts, @log as function, level, message ' + page(p),
  },
};

export const viewList = () => Object.entries(VIEWS).map(([id, v]) => ({ id, title: v.title, description: v.description, group: v.group }));

// ---- sample data (no AWS credentials) ----

function seeded(seed) {
  let s = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function sampleRows(viewId, rangeId) {
  const rnd = seeded(viewId + rangeId);
  const range = RANGES[rangeId];
  const now = Date.now();
  const n = (lo, hi) => Math.floor(lo + rnd() * (hi - lo));
  const iso = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  // Documentation-only address ranges (RFC 5737, RFC 3849): never real viewers.
  const ips = ['192.0.2.14', '192.0.2.201', '198.51.100.7', '203.0.113.50', '203.0.113.9', '2001:db8:85a3::8a2e:370:7334', '2001:db8:85a3:1::5'];
  const countries = ['US', 'DE', 'NL', 'SG', 'GB', 'FR', 'CN', 'IN'];
  const paths = ['/', '/blog/', '/edge/', '/architecture/', '/resume.pdf', '/.env', '/wp-login.php', '/blog/oidc-and-jwts/', '/.git/config', '/api/contact'];
  switch (viewId) {
    case 'edge-traffic': {
      const step = { '5m': 300e3, '1h': 3600e3, '6h': 21600e3 }[range.bin];
      const rows = [];
      for (let t = now - range.seconds * 1000; t <= now; t += step) {
        rows.push({ time: iso(t - (t % step)), class: '2xx', requests: String(n(10, 60)) });
        rows.push({ time: iso(t - (t % step)), class: '3xx', requests: String(n(0, 8)) });
        rows.push({ time: iso(t - (t % step)), class: '4xx', requests: String(n(1, 20)) });
      }
      return rows;
    }
    case 'top-paths':
      return paths.flatMap((p) => countries.slice(0, n(1, 4)).map((country) => ({ path: p, status: p.startsWith('/.') || p.includes('wp-') ? '404' : '200', country, requests: String(n(3, 300)) })))
        .sort((a, b) => b.requests - a.requests);
    case 'top-sources':
      return ips.flatMap((ip, i) => ['200', '404'].map((status) => ({ ip, country: countries[i % countries.length], status, requests: String(n(1, 120)) })));
    case 'errors':
      return paths.filter((p) => p.startsWith('/.') || p.includes('wp-') || p === '/api/contact')
        .flatMap((p) => ips.slice(0, n(1, 4)).map((ip, i) => ({ path: p, method: 'GET', status: '404', ip, country: countries[i], requests: String(n(2, 90)) })));
    case 'cache':
      return [['Hit', 500], ['Miss', 120], ['RefreshHit', 40], ['Error', 60], ['Redirect', 25]].map(([result, m]) => ({ result, requests: String(n(m / 2, m)) }));
    case 'countries':
      return ['US', 'DE', 'NL', 'SG', 'GB', 'FR', 'CN', 'IN'].map((country) => ({ country, requests: String(n(5, 300)) })).sort((a, b) => b.requests - a.requests);
    case 'contact-outcomes':
      return [['sent', '-', 2], ['honeypot', '-', 4], ['invalid', 'name missing', 6], ['invalid', 'malformed', 3], ['rejected', 'cross-origin', 1]]
        .map(([event, reason, m]) => ({ event, reason, count: String(n(1, m + 1)) }));
    case 'lambda-health':
      return [`${PROJECT}-contact`, `${PROJECT}-edge-report`].map((f, i) => ({
        function: f, invocations: String(n(5, 40)), failed: String(i ? 0 : n(0, 2)), avg_ms: String(i ? 2400.5 : 7.2), max_ms: String(i ? 9100.3 : 91.0),
      }));
    case 'lambda-errors':
      return [{ time: iso(now - 3600e3 * 5), ts: String(now - 3600e3 * 5), function: `${PROJECT}-contact`, level: 'ERROR', message: '{"event": "send-failed", "error": "ThrottlingException"}' }];
    case 'recent':
      return Array.from({ length: 180 }, (_, i) => ({
        time: iso(now - i * 47_000), ts: String(now - i * 47_000), ip: ips[n(0, ips.length)], country: countries[n(0, 4)], method: 'GET', path: paths[n(0, paths.length)],
        status: ['200', '200', '304', '404'][n(0, 4)], result: ['Hit', 'Miss', 'Hit', 'Error'][n(0, 4)],
        user_agent: ['Mozilla/5.0 (Macintosh)', 'curl/8.4.0', 'python-requests/2.32', 'zgrab/0.x'][n(0, 4)],
      }));
    case 'api-requests':
      return Array.from({ length: 64 }, (_, i) => ({
        time: iso(now - i * 260_000), ts: String(now - i * 260_000), ip: ips[n(0, ips.length)], country: countries[n(0, 4)], method: ['POST', 'POST', 'GET', 'OPTIONS'][n(0, 4)],
        path: '/api/contact', status: ['200', '400', '404', '429'][n(0, 4)], user_agent: ['Mozilla/5.0 (Windows)', 'curl/8.4.0', 'Go-http-client/1.1'][n(0, 3)],
      }));
    default:
      return [];
  }
}
