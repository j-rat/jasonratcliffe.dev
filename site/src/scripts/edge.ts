// Renders /edge/ from data/edge-threats.json (written daily by the edge-report Lambda).
// Everything is built with DOM APIs and text nodes: paths and user agents come from attackers.

export const EDGE_DATA = '/data/edge-threats.json';
const STALE_HOURS = 36;
const SVG = 'http://www.w3.org/2000/svg';
const TECHNIQUE = /^T\d{4}(\.\d{3})?$/;
// Probes in these categories target real pages; a 200 there is expected, not a leak.
const NON_FILE_CATEGORIES = new Set(['vulnerability-scanning', 'exploit-attempts']);

interface Mitre { id: string; name: string }
interface Category { id: string; label: string; tactic: string; mitre: Mitre[]; count: number; statuses: Record<string, number> }
interface Day { date: string; requests: number; probes: number }
export const CONTACT_KEYS = ['honeypot', 'bypass', 'cross_origin', 'invalid', 'throttled', 'wrong_route'] as const;
type ContactKey = (typeof CONTACT_KEYS)[number];
type ContactCounts = Record<ContactKey, number>;
export interface ContactStats {
  days: number;
  totals: ContactCounts;
  invalid_reasons: { reason: string; count: number }[];
  daily: ({ date: string } & ContactCounts)[];
}
export interface EdgeReport {
  version: 1;
  generated_at: string;
  window: { start: string; end: string };
  totals: { requests: number; probes: number; truncated: boolean };
  categories: Category[];
  probe_statuses: Record<string, number>;
  top_paths: { path: string; category: string; count: number }[];
  scanner_families: { family: string; count: number }[];
  countries: { code: string; count: number }[];
  daily: Day[];
  contact?: ContactStats | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string';

export function isReport(d: any): d is EdgeReport {
  return !!d && d.version === 1 && isStr(d.generated_at) && !isNaN(Date.parse(d.generated_at))
    && d.totals && isNum(d.totals.requests) && isNum(d.totals.probes)
    && Array.isArray(d.categories) && d.categories.every((c: any) => isStr(c.id) && isStr(c.label) && isNum(c.count) && Array.isArray(c.mitre))
    && Array.isArray(d.top_paths) && Array.isArray(d.scanner_families) && Array.isArray(d.countries) && Array.isArray(d.daily);
}

const isCounts = (c: any): c is ContactCounts => !!c && CONTACT_KEYS.every((k) => isNum(c[k]));

/** The contact block, or null if it's missing or malformed (the page then hides the section). */
export function contactStats(r: EdgeReport): ContactStats | null {
  const c: any = r.contact;
  if (!c || !isNum(c.days) || !isCounts(c.totals) || !Array.isArray(c.daily) || !Array.isArray(c.invalid_reasons)) return null;
  const daily = c.daily.filter((d: any) => d && isStr(d.date) && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && isCounts(d));
  const invalid_reasons = c.invalid_reasons.filter((x: any) => x && isStr(x.reason) && isNum(x.count));
  return { days: c.days, totals: c.totals, daily, invalid_reasons };
}

export async function loadReport(): Promise<EdgeReport | null> {
  try {
    const res = await fetch(EDGE_DATA, { cache: 'no-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    return isReport(data) ? data : null;
  } catch {
    return null;
  }
}

export const techniqueUrl = (id: string) =>
  TECHNIQUE.test(id) ? `https://attack.mitre.org/techniques/${id.replace('.', '/')}/` : null;

const fmt = (n: number) => n.toLocaleString('en-US');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function relative(iso: string): string {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Categories where a file-style probe got a 200 (possible exposure). */
export function leaks(r: EdgeReport): string[] {
  return r.categories.filter((c) => !NON_FILE_CATEGORIES.has(c.id) && (c.statuses?.['200'] ?? 0) > 0).map((c) => c.label);
}

function renderStats(root: HTMLElement, r: EdgeReport) {
  const set = (k: string, v: string) => { const d = root.querySelector(`[data-k="${k}"]`); if (d) d.textContent = v; };
  set('updated', relative(r.generated_at));
  set('requests', fmt(r.totals.requests));
  set('probes', fmt(r.totals.probes));
  set('share', r.totals.requests ? `${((100 * r.totals.probes) / r.totals.requests).toFixed(1)}%` : '0%');

  const leak = root.querySelector<HTMLElement>('[data-edge-leak]')!;
  const exposed = leaks(r);
  const stale = (Date.now() - Date.parse(r.generated_at)) / 3_600_000 > STALE_HOURS;
  if (exposed.length) {
    leak.dataset.state = 'alert';
    leak.textContent = `ALERT: a probe received HTTP 200 in: ${exposed.join(', ')}. Investigating.`;
  } else if (stale) {
    leak.dataset.state = 'warn';
    leak.textContent = `This report was generated ${relative(r.generated_at)}; the daily refresh may have failed.`;
  } else {
    leak.dataset.state = 'ok';
    leak.textContent = 'Leak check passed: no file probe received HTTP 200. Everything sensitive-looking got 403 or 404.';
  }
  if (r.totals.truncated) leak.textContent += ' (Very high volume: counts are partial.)';
}

function renderTechniques(host: HTMLElement, r: EdgeReport) {
  host.replaceChildren();
  const cats = [...r.categories].sort((a, b) => b.count - a.count);
  for (const c of cats) {
    const card = el('article', 'card tech');
    if (!c.count) card.dataset.zero = '';
    const head = el('header');
    const title = el('div');
    title.append(el('p', 'tactic', c.tactic), el('h3', undefined, c.label));
    head.append(title, el('span', 'count', fmt(c.count)));
    const mitre = c.mitre.filter((m) => techniqueUrl(m.id) && isStr(m.name));
    const ids = el('div', 'ids');
    for (const m of mitre) {
      const url = techniqueUrl(m.id)!;
      const a = el('a', undefined, m.id);
      a.href = url;
      a.rel = 'noopener noreferrer';
      a.title = m.name;
      a.setAttribute('aria-label', `${m.id} ${m.name} (MITRE ATT&CK)`);
      ids.append(a);
    }
    const codes = el('p', 'codes');
    const entries = Object.entries(c.statuses ?? {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) codes.textContent = 'not seen in the last 24 hours';
    entries.forEach(([code, n], i) => {
      if (i) codes.append(' · ');
      const bad = code === '200' && !NON_FILE_CATEGORIES.has(c.id);
      codes.append(el('span', bad ? 'bad' : undefined, `HTTP ${code} × ${fmt(n)}`));
    });
    card.append(head, el('p', 'muted small', mitre.map((m) => m.name).join(' · ')), ids, codes);
    host.append(card);
  }
}

function renderTrend(host: HTMLElement, r: EdgeReport) {
  host.replaceChildren();
  const days = r.daily.slice(-30);
  if (!days.length) {
    host.append(el('p', 'empty', 'The trend fills in as daily reports accumulate.'));
    return;
  }
  const W = 600, H = 160, gap = 2;
  const max = Math.max(1, ...days.map((d) => d.requests));
  const bw = (W - gap * (days.length - 1)) / days.length;
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const total = days.reduce((s, d) => s + d.probes, 0);
  const peak = days.reduce((a, d) => (d.probes > a.probes ? d : a), days[0]);
  chart.setAttribute('aria-label', `${fmt(total)} probes over ${days.length} days; busiest day ${peak.date} with ${fmt(peak.probes)}.`);
  days.forEach((d, i) => {
    const x = i * (bw + gap);
    const rh = (d.requests / max) * H;
    const ph = (d.probes / max) * H;
    const req = svg('rect', { class: 'requests', x, y: H - rh, width: bw, height: rh });
    const pro = svg('rect', { class: 'probes', x, y: H - ph, width: bw, height: ph });
    const tip = svg('title', {});
    tip.textContent = `${d.date}: ${fmt(d.probes)} probes of ${fmt(d.requests)} requests`;
    req.append(tip);
    pro.append(tip.cloneNode(true));
    chart.append(req, pro);
  });
  const axis = el('p', 'axis-row');
  axis.append(el('span', undefined, days[0].date), el('span', undefined, days[days.length - 1].date));
  const legend = el('p', 'legend-row');
  const item = (cls: string, label: string) => { const s = el('span'); s.append(el('span', `swatch ${cls}`), label); return s; };
  legend.append(item('p', 'Probes'), item('r', 'All requests'));
  host.append(chart, axis, legend);
}

function renderPaths(host: HTMLElement, r: EdgeReport) {
  host.replaceChildren();
  const labels = new Map(r.categories.map((c) => [c.id, c.label]));
  if (!r.top_paths.length) {
    host.append(el('li', 'empty', 'No probed paths in the last 24 hours.'));
    return;
  }
  for (const p of r.top_paths) {
    if (!isStr(p.path) || !isNum(p.count)) continue;
    const li = el('li');
    li.title = labels.get(p.category) ?? '';
    li.append(el('span', undefined, p.path), el('span', 'n', `× ${fmt(p.count)}`));
    host.append(li);
  }
}

function renderBars(host: HTMLElement, items: { label: string; count: number }[], empty: string) {
  host.replaceChildren();
  if (!items.length) {
    host.append(el('li', 'empty', empty));
    return;
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  for (const i of items) {
    const li = el('li');
    const row = el('div', 'row');
    row.append(el('span', undefined, i.label), el('span', 'n', fmt(i.count)));
    const bar = svg('svg', { viewBox: '0 0 100 6', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    bar.append(svg('rect', { class: 'track', x: 0, y: 0, width: 100, height: 6, rx: 3 }));
    bar.append(svg('rect', { class: 'fill', x: 0, y: 0, width: Math.max(2, (100 * i.count) / max), height: 6, rx: 3 }));
    li.append(row, bar);
    host.append(li);
  }
}

// Chart series: 4 categorical slots (validated for CVD on the site's dark surface), fixed order.
const CONTACT_SERIES: { cls: string; label: string; keys: ContactKey[] }[] = [
  { cls: 's1', label: 'Honeypot', keys: ['honeypot'] },
  { cls: 's2', label: 'Origin blocked', keys: ['bypass', 'cross_origin'] },
  { cls: 's3', label: 'Throttled', keys: ['throttled'] },
  { cls: 's4', label: 'Rejected input', keys: ['invalid', 'wrong_route'] },
];

function renderContactChart(host: HTMLElement, c: ContactStats) {
  host.replaceChildren();
  const days = c.daily.slice(-30);
  const sum = (d: ContactCounts, keys: ContactKey[]) => keys.reduce((s, k) => s + d[k], 0);
  const totals = days.map((d) => CONTACT_SERIES.reduce((s, x) => s + sum(d, x.keys), 0));
  const all = totals.reduce((a, b) => a + b, 0);
  if (!days.length || !all) {
    host.append(el('p', 'empty', `No blocked contact-form traffic in the last ${c.days} days.`));
    return;
  }
  const W = 600, H = 140, gap = 2;
  const max = Math.max(1, ...totals);
  const bw = (W - gap * (days.length - 1)) / days.length;
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  chart.setAttribute('aria-label', `${fmt(all)} blocked contact-form requests over ${days.length} days: `
    + CONTACT_SERIES.map((x) => `${x.label} ${fmt(days.reduce((s, d) => s + sum(d, x.keys), 0))}`).join(', ') + '.');
  days.forEach((d, i) => {
    const x = i * (bw + gap);
    let y = H;
    const tipText = `${d.date}: ` + CONTACT_SERIES.map((s) => `${s.label} ${fmt(sum(d, s.keys))}`).join(' · ');
    for (const s of CONTACT_SERIES) {
      const v = sum(d, s.keys);
      if (!v) continue;
      const h = Math.max(2, (v / max) * (H - 8)); // headroom for the 2px minimums
      y -= h;
      const seg = svg('rect', { class: s.cls, x, y, width: bw, height: Math.max(1, h - gap) });
      const tip = svg('title', {});
      tip.textContent = tipText;
      seg.append(tip);
      chart.append(seg);
    }
  });
  const axis = el('p', 'axis-row');
  axis.append(el('span', undefined, days[0].date), el('span', undefined, days[days.length - 1].date));
  const legend = el('p', 'legend-row');
  for (const s of CONTACT_SERIES) {
    const item = el('span');
    item.append(el('span', `swatch ${s.cls}`), s.label);
    legend.append(item);
  }
  host.append(chart, axis, legend);
}

function renderContact(root: HTMLElement, r: EdgeReport) {
  const section = root.querySelector<HTMLElement>('[data-contact-section]');
  if (!section) return;
  const c = contactStats(r);
  section.hidden = !c;
  if (!c) return;
  for (const k of CONTACT_KEYS) {
    const d = section.querySelector(`[data-c="${k}"]`);
    if (d) d.textContent = fmt(c.totals[k]);
  }
  renderContactChart(section.querySelector('[data-contact-trend]')!, c);
  renderBars(section.querySelector('[data-contact-reasons]')!, c.invalid_reasons.map((x) => ({ label: x.reason, count: x.count })),
    `No rejected input in the last ${c.days} days.`);
}

function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return 'Unknown';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function renderEmpty(root: HTMLElement) {
  root.querySelectorAll('[data-k]').forEach((d) => (d.textContent = '—'));
  const leak = root.querySelector<HTMLElement>('[data-edge-leak]')!;
  leak.dataset.state = 'warn';
  leak.textContent = 'No data yet. The report runs daily at 00:15 UTC.';
  for (const sel of ['[data-edge-techniques]', '[data-edge-trend]', '[data-edge-paths]', '[data-edge-families]', '[data-edge-countries]']) {
    root.querySelector(sel)?.replaceChildren();
  }
}

export function render(root: HTMLElement, r: EdgeReport) {
  renderStats(root, r);
  renderTechniques(root.querySelector('[data-edge-techniques]')!, r);
  renderTrend(root.querySelector('[data-edge-trend]')!, r);
  renderPaths(root.querySelector('[data-edge-paths]')!, r);
  renderBars(root.querySelector('[data-edge-families]')!, r.scanner_families.filter((f) => isStr(f.family) && isNum(f.count)).map((f) => ({ label: f.family, count: f.count })), 'No probes in the last 24 hours.');
  renderBars(root.querySelector('[data-edge-countries]')!, r.countries.filter((c) => isStr(c.code) && isNum(c.count)).map((c) => ({ label: countryName(c.code), count: c.count })), 'No probes in the last 24 hours.');
  renderContact(root, r);
}

export async function initEdge() {
  const root = document.querySelector<HTMLElement>('[data-edge]');
  if (!root) return;
  const report = await loadReport();
  if (report) render(root, report);
  else renderEmpty(root);
}
