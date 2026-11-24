// Log viewer UI. Values come from logs (paths and user agents are attacker-controlled), so everything
// is rendered with text nodes; no innerHTML anywhere.
const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';
const state = { views: [], view: null, range: '24h', result: null, sort: null, groupBy: '', pageIndex: 0, cursors: [null], all: false, last: null };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// ---- loader: "jasonratcliffe.dev" as a circuit, current flowing left to right ----
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const loader = { pending: 0, timer: 0, raf: 0, level: 0, target: 0, built: false };
const BUS_Y = 96;
const BUS = { from: 12, to: 628 };

/** Lay the board once the word is visible (glyph positions need layout): a bus, and a via + pad per letter. */
function buildCircuit() {
  if (loader.built) return;
  const word = $('.ld-dim .ld-glyphs');
  const xs = [];
  try {
    for (let i = 0; i < word.getNumberOfChars(); i++) {
      const box = word.getExtentOfChar(i);
      xs.push({ x: box.x + box.width / 2, bottom: Math.min(box.y + box.height, BUS_Y - 8) });
    }
  } catch { /* not laid out yet: bus only */ }
  for (const host of [$('[data-traces]'), $('[data-traces-live]')]) {
    // Traces are drawn in the direction current flows: the bus left to right, each via from the bus up.
    host.append(svg('path', { class: 'ld-trace', d: `M${BUS.from} ${BUS_Y} H${BUS.to}` }));
    for (const c of xs) {
      host.append(svg('path', { class: 'ld-trace', d: `M${c.x.toFixed(1)} ${BUS_Y} V${(c.bottom - 2).toFixed(1)}` }));
      host.append(svg('circle', { class: 'ld-pad', cx: c.x.toFixed(1), cy: BUS_Y, r: 2.6 }));
    }
  }
  loader.built = xs.length > 0;
}

function loaderFrame() {
  // Ease toward the target; while waiting the target creeps toward 92% and never quite arrives.
  if (loader.pending) loader.target += (0.92 - loader.target) * 0.008;
  loader.level += (loader.target - loader.level) * 0.08;
  const x = BUS.from + loader.level * (BUS.to - BUS.from + 8);
  $('[data-front]').setAttribute('width', x.toFixed(1));
  const spark = $('[data-spark]');
  spark.setAttribute('cx', Math.min(x, BUS.to).toFixed(1));
  // The spark at the front edge crackles a little; with reduced motion it holds still.
  spark.setAttribute('r', reduceMotion ? '3' : (2.2 + Math.random() * 2.2).toFixed(1));
  $('.ld-terminals circle').classList.toggle('on', loader.level > 0.99);
  if (loader.pending || loader.level < 0.995) loader.raf = requestAnimationFrame(loaderFrame);
  else setTimeout(() => { if (!loader.pending) $('[data-loader]').hidden = true; }, 260);
}

function showLoader(caption) {
  const box = $('[data-loader]');
  $('[data-loader-caption]').textContent = caption;
  if (!box.hidden) return;
  box.hidden = false;
  buildCircuit();
  loader.level = 0;
  loader.target = 0.18;
  cancelAnimationFrame(loader.raf);
  loader.raf = requestAnimationFrame(loaderFrame);
}

/** Run `work`, showing the loader only if it takes longer than a quarter second (no flash on fast loads). */
async function withLoader(caption, work) {
  loader.pending += 1;
  if (loader.pending === 1) loader.timer = setTimeout(() => showLoader(caption), 250);
  try {
    return await work();
  } finally {
    loader.pending -= 1;
    if (!loader.pending) {
      clearTimeout(loader.timer);
      loader.target = 1; // close the circuit, then hide
    }
  }
}

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  if (res.status === 401) {
    location.href = '/login?error=session%20expired';
    throw new Error('unauthorized');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const NUM = /^(<?\$)?-?\d+(\.\d+)?%?$/;
const numeric = (v) => Number(String(v).replace(/[<$%]/g, ''));
let regionNames;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { regionNames = null; }

/** "DE" -> "Germany (DE)"; anything else unchanged. */
function countryLabel(code) {
  if (!/^[A-Z]{2}$/.test(code ?? '')) return code;
  try {
    const name = regionNames?.of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

/** Columns whose every value is a number (or $ / %). Those are summed when grouping and sort numerically. */
// Codes and timestamps look numeric but are labels: never summed, grouped like text.
const LABELS = new Set(['status', 'time', 'method', 'class', 'month']);
const numericColumns = (columns, rows) => columns.filter((c) => !LABELS.has(c) && rows.length && rows.every((r) => NUM.test(String(r[c] ?? ''))));

function groupRows(columns, rows, by) {
  const nums = numericColumns(columns, rows).filter((c) => c !== by && !/^\$|%$/.test(String(rows[0]?.[c] ?? '')));
  const groups = new Map();
  for (const r of rows) {
    const key = r[by] ?? '';
    const g = groups.get(key) ?? { [by]: key, rows: 0, ...Object.fromEntries(nums.map((c) => [c, 0])) };
    g.rows += 1;
    for (const c of nums) g[c] += numeric(r[c]);
    groups.set(key, g);
  }
  const out = [...groups.values()].map((g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, typeof v === 'number' ? String(Math.round(v * 100) / 100) : v])));
  return { columns: [by, 'rows', ...nums], rows: out };
}

function sortRows(columns, rows, sort) {
  if (!sort || !columns.includes(sort.col)) return rows;
  const isNum = numericColumns([sort.col], rows).length === 1;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[sort.col] ?? '', y = b[sort.col] ?? '';
    return dir * (isNum ? numeric(x) - numeric(y) : String(x).localeCompare(String(y), undefined, { numeric: true }));
  });
}

function renderGroupControl(columns, rows, groupable) {
  const sel = $('[data-group]');
  sel.hidden = !groupable;
  $('[data-group-label]').hidden = !groupable;
  if (!groupable) return;
  const nums = new Set(numericColumns(columns, rows));
  sel.replaceChildren();
  const none = el('option', undefined, 'No grouping');
  none.value = '';
  sel.append(none);
  for (const c of columns.filter((c) => !nums.has(c) && c !== 'time')) {
    const o = el('option', undefined, `Group by ${c.replace(/_/g, ' ')}`);
    o.value = c;
    sel.append(o);
  }
  if (!columns.includes(state.groupBy) || nums.has(state.groupBy)) state.groupBy = '';
  sel.value = state.groupBy;
}

/** Draw the current result: optional grouping, then sorting; headers are buttons that toggle the sort. */
function drawTable() {
  const { columns: baseCols, rows: baseRows } = state.result;
  const grouped = state.groupBy ? groupRows(baseCols, baseRows, state.groupBy) : { columns: baseCols, rows: baseRows };
  const { columns } = grouped;
  const rows = sortRows(columns, grouped.rows, state.sort);
  const nums = new Set(numericColumns(columns, rows));
  const table = $('[data-table]');
  const head = el('tr');
  for (const c of columns) {
    const th = el('th');
    const active = state.sort?.col === c;
    th.setAttribute('aria-sort', active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    if (nums.has(c)) th.className = 'num';
    const b = el('button', 'sort', c.replace(/_/g, ' '));
    b.type = 'button';
    b.append(el('span', 'arrow', active ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''));
    b.addEventListener('click', () => {
      state.sort = { col: c, dir: active && state.sort.dir === 'desc' ? 'asc' : active ? 'desc' : nums.has(c) ? 'desc' : 'asc' };
      drawTable();
    });
    th.append(b);
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'muted', 'No rows for this range.');
    td.colSpan = Math.max(1, columns.length);
    tr.append(td);
    tbody.append(tr);
  }
  for (const r of rows) {
    const tr = el('tr');
    for (const c of columns) {
      const v = r[c] ?? '';
      const td = el('td', nums.has(c) ? 'num' : undefined, v);
      if (c === 'status' && /^[45]/.test(v)) td.classList.add('bad');
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);
  const scope = state.last?.paged ? ' on this page · sorting and grouping apply to this page; use Show all for the whole period' : '';
  $('[data-count]').textContent = state.groupBy ? `${rows.length} groups of ${baseRows.length} rows${scope}` : `${rows.length} rows${scope}`;
}

function renderTable(columns, rows, { groupable = false } = {}) {
  // Full country names next to every ISO code, so grouping and sorting use the readable label too.
  const shown = rows.map((r) => ('country' in r ? { ...r, country: countryLabel(r.country) } : r));
  state.result = { columns, rows: shown };
  if (!groupable) state.groupBy = '';
  state.sort = null;
  renderGroupControl(columns, shown, groupable);
  drawTable();
}

const SERIES = ['s1', 's2', 's3', 's4'];
function renderChart(chart, rows) {
  const host = $('[data-chart]');
  host.replaceChildren();
  host.hidden = !chart || !rows.length;
  if (host.hidden) return;
  const times = [...new Set(rows.map((r) => r[chart.x]))].sort();
  const series = [...new Set(rows.map((r) => r[chart.series] ?? 'value'))].sort().slice(0, 4);
  const value = (t, s) => rows.filter((r) => r[chart.x] === t && (r[chart.series] ?? 'value') === s).reduce((a, r) => a + Number(r[chart.y] || 0), 0);
  const totals = times.map((t) => series.reduce((a, s) => a + value(t, s), 0));
  const max = Math.max(1, ...totals);
  const W = 720, H = 160, gap = 2, bw = Math.max(1, (W - gap * (times.length - 1)) / times.length);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${chart.y} over time by ${chart.series}` });
  times.forEach((t, i) => {
    let y = H;
    series.forEach((name, k) => {
      const v = value(t, name);
      if (!v) return;
      const h = (v / max) * (H - 4);
      y -= h;
      const rect = svg('rect', { x: i * (bw + gap), y, width: bw, height: Math.max(1, h - 1), class: SERIES[k] });
      const tip = svg('title');
      tip.textContent = `${t} · ${name}: ${chart.format ? chart.format(v) : v}`;
      rect.append(tip);
      s.append(rect);
    });
  });
  const legend = el('p', 'legend mono small');
  series.forEach((name, k) => {
    const item = el('span');
    item.append(el('span', `swatch ${SERIES[k]}`), name);
    legend.append(item);
  });
  const axis = el('p', 'axis mono small muted');
  axis.append(el('span', undefined, times[0]), el('span', undefined, times[times.length - 1]));
  host.append(s, axis, legend);
}

const money = (n) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

function tiles(items) {
  const host = $('[data-tiles]');
  host.replaceChildren();
  host.hidden = !items;
  for (const [label, value, hint] of items ?? []) {
    const d = el('div', 'tile');
    d.append(el('p', 'tile-label mono', label), el('p', 'tile-value mono', value));
    if (hint) d.append(el('p', 'tile-hint muted small', hint));
    host.append(d);
  }
}

async function runCosts(refresh = false) {
  const v = state.views.find((x) => x.id === state.view);
  $('[data-title]').textContent = v.title;
  $('[data-desc]').textContent = v.description;
  $('[data-meta]').textContent = 'Asking Cost Explorer…';
  $('[data-run]').disabled = true;
  const banner = $('[data-banner]');
  try {
    $('[data-pager]').replaceChildren();
    state.last = null;
    const c = await withLoader('Asking Cost Explorer…', () => api('/api/costs', { refresh }));
    const notes = [];
    if (c.source === 'sample') notes.push(`Sample data: ${c.reason}.`);
    else if (!/^Active/.test(c.tag.status)) notes.push(`The ${c.tag.key} tag is "${c.tag.status}" in Billing, so Cost Explorer can't filter on it yet and totals stay at $0 until it is activated (see the README).`);
    banner.hidden = !notes.length;
    banner.textContent = notes.join(' ');
    tiles([
      ['Month to date', money(c.totals.monthToDate)],
      ['Forecast, month end', c.totals.forecastMonthEnd === null ? 'n/a' : money(c.totals.forecastMonthEnd), c.totals.forecastMonthEnd === null ? 'not enough history yet' : undefined],
      ['Last month', money(c.totals.lastMonth)],
      [`Last ${c.months.length} months`, money(c.totals.sixMonths)],
    ]);
    $('[data-meta]').textContent = `Tag ${c.tag.key} = ${c.tag.value} (${c.tag.status}) · unblended cost, ${c.currency} · ${c.cached ? 'cached' : 'fresh'} as of ${c.asOf.replace('T', ' ').slice(0, 16)} UTC · Cost Explorer lags about a day`;
    // Chart: monthly totals stacked by the three biggest components plus "Other".
    const top = c.components.slice(0, 3).map((x) => x.component);
    const rows = c.months.flatMap((m) => {
      const other = Object.entries(m.byComponent).filter(([k]) => !top.includes(k)).reduce((a, [, n]) => a + n, 0);
      return [...top.map((k) => ({ month: m.month, component: k, cost: String(m.byComponent[k] ?? 0) })), { month: m.month, component: 'Other', cost: String(other) }];
    });
    renderChart({ x: 'month', y: 'cost', series: 'component', format: money }, rows);
    const total6 = c.totals.sixMonths || 1;
    renderTable(['component', 'this month', 'last month', `${c.months.length} months`, 'share'], c.components.map((x) => ({
      component: x.component, 'this month': money(x.monthToDate), 'last month': money(x.lastMonth),
      [`${c.months.length} months`]: money(x.sixMonths), share: `${Math.round((100 * x.sixMonths) / total6)}%`,
    })));
  } catch (e) {
    $('[data-meta]').textContent = e.message;
  } finally {
    $('[data-run]').disabled = false;
  }
}

function renderPager(p, total) {
  const nav = $('[data-pager]');
  nav.replaceChildren();
  const button = (label, onClick, disabled = false, primary = false) => {
    const b = el('button', primary ? 'btn btn-primary' : 'btn', label);
    b.type = 'button';
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  };
  if (state.all) {
    nav.append(el('span', 'mono muted small', `All ${total} rows for this period`), button('Back to pages', () => { state.all = false; run(0); }));
    return;
  }
  const label = p.kind === 'index' ? `Page ${p.index + 1} of ${p.pages}` : `Page ${p.index + 1}${p.hasMore ? '' : ' (last)'}`;
  nav.append(
    button('‹ Previous', () => run(p.index - 1), p.index === 0),
    el('span', 'mono small', label),
    button('Next ›', () => run(p.index + 1), !p.hasMore),
    button('Show all for this period', () => { state.all = true; run(0); }, p.index === 0 && !p.hasMore),
  );
}

async function run(pageIndex = 0) {
  const v = state.views.find((x) => x.id === state.view);
  if (pageIndex === 0 && !state.all) state.cursors = [null];
  state.pageIndex = pageIndex;
  tiles(null);
  $('[data-title]').textContent = v.title;
  $('[data-desc]').textContent = v.description;
  $('[data-meta]').textContent = 'Running query…';
  $('[data-run]').disabled = true;
  const banner = $('[data-banner]');
  try {
    const r = await withLoader(state.all ? 'Fetching every row for this period…' : 'Querying CloudWatch Logs…',
      () => api('/api/query', { view: state.view, range: state.range, page: pageIndex, cursor: state.cursors[pageIndex] ?? null, all: state.all }));
    if (r.page.kind === 'cursor' && r.page.nextCursor) state.cursors[pageIndex + 1] = r.page.nextCursor;
    banner.hidden = r.source !== 'sample';
    banner.textContent = r.source === 'sample' ? `Sample data: ${r.reason}.` : '';
    $('[data-meta]').textContent = r.source === 'aws'
      ? `${r.page.total !== undefined ? `${r.page.total} rows in total` : `${r.rows.length} rows on this page`} · ${r.ms ?? 0} ms · ${((r.scannedBytes ?? 0) / 1e6).toFixed(2)} MB scanned · ${(r.groups ?? []).join(', ')}`
      : `${r.page.total !== undefined ? `${r.page.total} rows in total` : `${r.rows.length} rows on this page`} (sample)`;
    renderChart(r.chart, r.rows);
    renderTable(r.columns, r.rows, { groupable: true });
    state.last = { paged: !state.all && (r.page.index > 0 || r.page.hasMore) };
    renderPager(r.page, r.page.total ?? r.rows.length);
    drawTable();
  } catch (e) {
    $('[data-meta]').textContent = e.message;
  } finally {
    $('[data-run]').disabled = false;
  }
}

function select(id) {
  state.view = id;
  state.groupBy = '';
  state.sort = null;
  state.all = false;
  state.last = null;
  const isCost = state.views.find((x) => x.id === id)?.kind === 'cost';
  $('[data-range]').hidden = isCost;
  $('[data-run]').textContent = isCost ? 'Refresh' : 'Run';
  for (const b of document.querySelectorAll('[data-views] button')) b.setAttribute('aria-current', String(b.dataset.id === id));
  if (isCost) runCosts();
  else run();
}

async function init() {
  const me = await withLoader('Signing you in…', () => api('/api/me'));
  const mins = Math.max(0, Math.round((me.expires - Date.now()) / 60000));
  $('[data-who]').textContent = `${me.name} · ${me.scope} · session ${mins} min left${me.mode === 'sample' ? ' · sample mode' : ''}`;
  const { views, ranges } = await api('/api/views');
  state.views = views;
  const list = $('[data-views]');
  let group = '';
  for (const v of views) {
    if (v.group !== group) {
      group = v.group;
      list.append(el('li', 'group mono', { edge: 'Edge (CloudFront)', contact: 'Functions', costs: 'Costs' }[group] ?? group));
    }
    const li = el('li');
    const b = el('button', 'view', v.title);
    b.type = 'button';
    b.dataset.id = v.id;
    b.addEventListener('click', () => select(v.id));
    li.append(b);
    list.append(li);
  }
  const range = $('[data-range]');
  for (const r of ranges) {
    const o = el('option', undefined, r.label);
    o.value = r.id;
    o.selected = r.id === state.range;
    range.append(o);
  }
  range.addEventListener('change', () => { state.range = range.value; state.all = false; run(0); });
  $('[data-group]').addEventListener('change', (e) => { state.groupBy = e.target.value; state.sort = null; drawTable(); });
  $('[data-run]').addEventListener('click', () => (state.views.find((x) => x.id === state.view)?.kind === 'cost' ? runCosts(true) : run(0)));
  $('[data-logout]').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    location.href = '/login';
  });
  select(views[0].id);
}

init();
