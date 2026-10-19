// Hero animation: requests stream toward a cloud; the edge shield lets clean
// traffic through (green) and drops hostile packets (red). Pure text in a <pre>.

const W = 64;
const H = 15;
const SHIELD_X = 24;

const CLOUD = [
  '               .--~~~~--.        ',
  '          .-~~~          ~-.     ',
  '       .-~   +----------+   ~.   ',
  '      (      | S3 origin|     )  ',
  '     (       +----------+      ) ',
  '      ~.     private · OAC   .~  ',
  '        ~-.______________.-~     ',
];

interface Packet { x: number; y: number; bad: boolean; dead: number; label: string }

const GOOD = ['GET /', 'GET /blog', 'POST /api', 'GET /pdf'];
const BAD = ["' OR 1=1", '../etc', '<script>', 'nmap -sS', 'curl s3://'];

export function initAsciiCloud(el: HTMLElement): void {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const packets: Packet[] = [];
  let tick = 0;
  let blocked = 0;
  let allowed = 0;
  let timer: number | undefined;

  const cloudTop = 4;
  const cloudLeft = SHIELD_X + 6;
  const lanes = [cloudTop + 2, cloudTop + 3, cloudTop + 4];

  const render = () => {
    const grid: { ch: string; cls: string }[][] = Array.from({ length: H }, () =>
      Array.from({ length: W }, () => ({ ch: ' ', cls: '' })),
    );
    const put = (x: number, y: number, s: string, cls = '') => {
      for (let i = 0; i < s.length; i++) {
        const cx = x + i;
        if (cx >= 0 && cx < W && y >= 0 && y < H && s[i] !== ' ') grid[y][cx] = { ch: s[i], cls };
      }
    };

    CLOUD.forEach((row, i) => put(cloudLeft, cloudTop + i - 1, row.slice(0, W - cloudLeft), 'c'));
    for (let y = 1; y < H - 2; y++) put(SHIELD_X, y, y === 1 ? '▲' : y === H - 3 ? '▼' : '║', 's');
    put(SHIELD_X - 5, 0, 'EDGE / WAF-lite', 'm');
    put(0, H - 1, `allowed ${String(allowed).padStart(4)}   blocked ${String(blocked).padStart(4)}   tls 1.2+  hsts  csp`, 'm');

    for (const p of packets) {
      if (p.dead > 0) { put(p.x, p.y, p.dead % 2 ? 'x' : '*', 'r'); continue; }
      put(p.x - p.label.length - 1, p.y, p.label, p.bad ? 'rl' : 'gl');
      put(p.x, p.y, p.bad ? '■' : '●', p.bad ? 'r' : 'g');
    }

    // Build with spans so colour classes apply; text is our own constants only.
    const frag = document.createDocumentFragment();
    grid.forEach((row, y) => {
      let run = '';
      let cls = row[0].cls;
      const flush = () => {
        if (!run) return;
        if (cls) { const s = document.createElement('span'); s.className = cls; s.textContent = run; frag.append(s); }
        else frag.append(run);
        run = '';
      };
      for (const cell of row) {
        if (cell.cls !== cls) { flush(); cls = cell.cls; }
        run += cell.ch;
      }
      flush();
      if (y < H - 1) frag.append('\n');
    });
    el.replaceChildren(frag);
  };

  const step = () => {
    tick++;
    if (tick % 5 === 0 && packets.length < 8) {
      const bad = Math.random() < 0.45;
      const pool = bad ? BAD : GOOD;
      const label = pool[Math.floor(Math.random() * pool.length)];
      const rows = bad ? Array.from({ length: H - 5 }, (_, i) => i + 2) : lanes;
      // Only spawn into a row whose left edge is clear, so labels never overlap.
      const free = rows.filter((r) => !packets.some((p) => p.y === r && p.x - p.label.length < label.length + 12));
      if (free.length) packets.push({
        x: label.length + 1,
        y: free[Math.floor(Math.random() * free.length)],
        bad,
        dead: 0,
        label,
      });
    }
    for (const p of packets) {
      if (p.dead > 0) { p.dead--; continue; }
      p.x++;
      if (p.bad && p.x >= SHIELD_X - 1) { p.dead = 4; p.x = SHIELD_X - 1; blocked++; }
      if (!p.bad && p.x >= cloudLeft + 8) { p.dead = -1; allowed++; }
    }
    for (let i = packets.length - 1; i >= 0; i--) if (packets[i].dead === 0 && packets[i].bad && packets[i].x === SHIELD_X - 1) packets.splice(i, 1);
    for (let i = packets.length - 1; i >= 0; i--) if (packets[i].dead === -1) packets.splice(i, 1);
    render();
  };

  const start = () => {
    stop();
    if (reduce.matches) {
      // Still frame: one allowed and one blocked packet frozen mid-flight.
      blocked = 1; allowed = 1;
      packets.splice(0, packets.length,
        { x: SHIELD_X - 1, y: 3, bad: true, dead: 1, label: '' },
        { x: 18, y: 8, bad: true, dead: 0, label: "' OR 1=1" },
        { x: SHIELD_X + 4, y: lanes[1], bad: false, dead: 0, label: 'GET /' },
      );
      render();
      return;
    }
    timer = window.setInterval(step, 110);
  };
  const stop = () => { if (timer) window.clearInterval(timer); timer = undefined; };

  // Pause when off-screen or the tab is hidden.
  const io = new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? start() : stop()));
  io.observe(el);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reduce.addEventListener('change', start);
  render();
}
