// Animated OIDC Authorization Code + PKCE flow for the OIDC/JWT blog post.
// SVG built with createElementNS, motion with SMIL <animateMotion> (no inline styles, CSP-safe),
// text through textContent only. Honors prefers-reduced-motion.

type Actor = 'user' | 'app' | 'op' | 'api';
type Phase = 'Setup' | 'Authentication' | 'Authorization';
interface Step {
  from: Actor;
  to: Actor;
  packet: string; // short label on the moving token / arrow
  title: string;
  phase: Phase;
  body: string;
  detail?: string;
  result?: 'ok' | 'fail';
}
type Scenario = 'ok' | 'expired' | 'scope';

const SVG = 'http://www.w3.org/2000/svg';
const ACTORS: { id: Actor; name: string; sub: string; x: number }[] = [
  { id: 'user', name: 'User', sub: 'browser', x: 80 },
  { id: 'app', name: 'App', sub: 'OIDC client', x: 247 },
  { id: 'op', name: 'IdP', sub: 'identity provider', x: 413 },
  { id: 'api', name: 'API', sub: 'resource server', x: 580 },
];
const X = Object.fromEntries(ACTORS.map((a) => [a.id, a.x])) as Record<Actor, number>;
const LANE_Y = 150;
const AUTOPLAY_MS = 3600;

const COMMON: Step[] = [
  {
    from: 'user', to: 'app', packet: 'Sign in', phase: 'Setup', title: 'The user clicks “Sign in”',
    body: 'The app has no idea who this is yet. It will not ask for a password itself: it sends the user to the identity provider, which is the only party that ever sees credentials.',
  },
  {
    from: 'app', to: 'op', packet: 'discovery', phase: 'Setup', title: 'The app reads the provider’s discovery document',
    body: 'One well-known URL lists every endpoint and the JWKS location (the provider’s public signing keys). Apps and APIs cache it.',
    detail: 'GET https://login.example.com/.well-known/openid-configuration\n→ authorization_endpoint, token_endpoint, jwks_uri,\n  id_token_signing_alg_values_supported: ["RS256"]',
  },
  {
    from: 'app', to: 'op', packet: '/authorize', phase: 'Authentication', title: 'Redirect to the provider with state, nonce and a PKCE challenge',
    body: 'The browser is redirected to the authorization endpoint. state stops CSRF on the way back, nonce will be echoed inside the ID token, and code_challenge is a hash of a secret only this app instance holds.',
    detail: 'GET /authorize?response_type=code\n  &client_id=orders-web-client\n  &scope=openid profile orders:read\n  &redirect_uri=https://app.example.com/callback\n  &state=af0ifjsldkj&nonce=n-0S6_WzA2Mj\n  &code_challenge=E9Melhoa2Owv…&code_challenge_method=S256',
  },
  {
    from: 'user', to: 'op', packet: 'password + MFA', phase: 'Authentication', title: 'The user authenticates with the provider',
    body: 'Password, passkey, MFA, conditional access: all of it happens here, on the provider’s domain. The app never handles credentials, and the provider records how strongly the user authenticated (acr / amr).',
  },
  {
    from: 'op', to: 'app', packet: 'code', phase: 'Authentication', title: 'The provider redirects back with a one-time code',
    body: 'Only a short-lived authorization code crosses the browser, never a token. The app checks state matches what it sent.',
    detail: 'GET https://app.example.com/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj',
  },
  {
    from: 'app', to: 'op', packet: 'code + verifier', phase: 'Authentication', title: 'The app redeems the code at the token endpoint',
    body: 'A direct back-channel call. The provider hashes code_verifier and compares it with the earlier code_challenge, so a stolen code is useless to anyone who didn’t start the flow.',
    detail: 'POST /token\ngrant_type=authorization_code&code=SplxlOBeZQQYbYS6WxSbIA\n&redirect_uri=https://app.example.com/callback\n&client_id=orders-web-client&code_verifier=dBjftJeZ4CVP…',
  },
  {
    from: 'op', to: 'app', packet: 'JWTs', phase: 'Authentication', title: 'Tokens come back: ID token and access token',
    body: 'The ID token is for the app (aud = its client ID). The access token is for the API (aud = the API). Both are JWTs signed with the provider’s private key.',
    detail: '{ "id_token": "eyJhbGciOiJSUzI1NiIs…",\n  "access_token": "eyJhbGciOiJSUzI1NiIs…",\n  "token_type": "Bearer", "expires_in": 900,\n  "refresh_token": "8xLOxBtZp8…" }',
  },
  {
    from: 'app', to: 'app', packet: 'validate', phase: 'Authentication', title: 'The app validates the ID token: the user is authenticated', result: 'ok',
    body: 'Signature against the JWKS key named by kid, iss exactly the provider, aud is this app, exp in the future, nonce matches. Now the app knows who the user is and starts a session.',
    detail: '✓ signature (RS256, kid 3f9c)   ✓ iss   ✓ aud = orders-web-client\n✓ exp   ✓ nonce = n-0S6_WzA2Mj\n→ signed in as sub 00u8f2k1q9ZxP4 (“Ada Lovelace”)',
  },
  {
    from: 'app', to: 'api', packet: 'Bearer JWT', phase: 'Authorization', title: 'The app calls the API with the access token',
    body: 'The access token goes in the Authorization header. The ID token stays with the app: APIs only accept tokens issued to them.',
    detail: 'GET https://api.example.com/orders\nAuthorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6ImF0K2p3dCJ9…',
  },
];

const VERIFY_OK: Step = {
  from: 'api', to: 'api', packet: 'verify', phase: 'Authorization', title: 'The API verifies the token locally', result: 'ok',
  body: 'No call to the provider per request: the API verifies the signature with the public key it cached from the JWKS, then checks iss, aud and exp. The token is genuine and current.',
  detail: '✓ alg RS256 (allowlisted)   ✓ signature   ✓ iss\n✓ aud = https://api.example.com/orders   ✓ exp (14 min left)',
};

const SCENARIOS: Record<Scenario, Step[]> = {
  ok: [
    ...COMMON,
    VERIFY_OK,
    {
      from: 'api', to: 'api', packet: 'authorize', phase: 'Authorization', title: 'The API authorizes the request from the claims', result: 'ok',
      body: 'Authentication said who; now the API decides what. GET /orders needs the orders:read scope, and the token carries it.',
      detail: 'required: scope orders:read\ntoken:    scope "openid profile orders:read", roles ["reader"]\n→ allowed',
    },
    {
      from: 'api', to: 'app', packet: '200 OK', phase: 'Authorization', title: 'Authenticated and authorized: 200 OK', result: 'ok',
      body: 'The user proved who they are once, to the provider. Every API call after that rides on a short-lived signed token that each service checks for itself.',
      detail: 'HTTP/1.1 200 OK\nContent-Type: application/json\n\n[{ "id": "A-1042", "status": "shipped" }]',
    },
  ],
  expired: [
    ...COMMON,
    {
      from: 'api', to: 'api', packet: 'verify', phase: 'Authorization', title: 'Verification fails: the token has expired', result: 'fail',
      body: 'The signature is fine, but exp is in the past. Signed tokens can’t be recalled, so short lifetimes are what limit the damage of a leaked one.',
      detail: '✓ signature   ✓ iss   ✓ aud\n✗ exp 1795436100 < now 1795436400 (expired 5 min ago)',
    },
    {
      from: 'api', to: 'app', packet: '401', phase: 'Authorization', title: '401 Unauthorized: authenticate again', result: 'fail',
      body: '401 means “I don’t know who you are”: no valid credentials. The app uses its refresh token at the token endpoint to get a fresh access token and retries, without bothering the user.',
      detail: 'HTTP/1.1 401 Unauthorized\nWWW-Authenticate: Bearer error="invalid_token",\n  error_description="The access token expired"',
    },
  ],
  scope: [
    ...COMMON,
    VERIFY_OK,
    {
      from: 'api', to: 'api', packet: 'authorize', phase: 'Authorization', title: 'Authorization fails: the scope is missing', result: 'fail',
      body: 'The token is valid and the user is known, but DELETE /orders needs orders:write and the user only consented to orders:read. Valid is not the same as permitted.',
      detail: 'required: scope orders:write\ntoken:    scope "openid profile orders:read"\n→ denied',
    },
    {
      from: 'api', to: 'app', packet: '403', phase: 'Authorization', title: '403 Forbidden: known, but not allowed', result: 'fail',
      body: '403 means “I know who you are, and the answer is no.” Retrying with the same token won’t help; the user needs a different role or must consent to a broader scope.',
      detail: 'HTTP/1.1 403 Forbidden\nWWW-Authenticate: Bearer error="insufficient_scope",\n  scope="orders:write"',
    },
  ],
};

function svg(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, cls = 'btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  return b;
}

export function initAuthFlow() {
  const host = document.querySelector<HTMLElement>('[data-auth-flow]');
  if (!host) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  host.replaceChildren();

  // ---- controls ----
  const bar = el('div', 'af-bar');
  const scenario = el('select');
  scenario.setAttribute('aria-label', 'Scenario');
  for (const [v, t] of [['ok', 'Happy path: 200 OK'], ['expired', 'Expired access token: 401'], ['scope', 'Missing scope: 403']]) {
    const o = el('option', undefined, t);
    o.value = v;
    scenario.append(o);
  }
  const prev = button('← Back');
  const play = button('▶ Play', 'btn btn-primary');
  const next = button('Next →');
  const restart = button('↺ Restart');
  const fullBtn = button('Show full flow');
  fullBtn.setAttribute('aria-pressed', 'false');
  bar.append(scenario, prev, play, next, restart, fullBtn);

  // ---- diagram ----
  const chart = svg('svg', { viewBox: '0 0 660 200', class: 'af-svg', role: 'img' });
  const defs = svg('defs');
  const marker = svg('marker', { id: 'af-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 13, markerHeight: 13, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M0 0L10 5L0 10z', class: 'af-head' }));
  const failMarker = svg('marker', { id: 'af-arrow-fail', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 13, markerHeight: 13, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
  failMarker.append(svg('path', { d: 'M0 0L10 5L0 10z', class: 'af-head fail' }));
  defs.append(marker, failMarker);
  chart.append(defs);
  const actorNodes = new Map<Actor, SVGElement>();
  const lifelines: SVGElement[] = [];
  for (const a of ACTORS) {
    const g = svg('g', { class: 'af-actor' });
    const life = svg('line', { x1: a.x, y1: 80, x2: a.x, y2: 192, class: 'af-life' });
    lifelines.push(life);
    g.append(life);
    g.append(svg('rect', { x: a.x - 76, y: 12, width: 152, height: 66, rx: 10 }));
    const n = svg('text', { x: a.x, y: 42, class: 'af-name' });
    n.textContent = a.name;
    const s = svg('text', { x: a.x, y: 64, class: 'af-sub' });
    s.textContent = a.sub;
    g.append(n, s);
    chart.append(g);
    actorNodes.set(a.id, g);
  }
  const stage = svg('g');
  chart.append(stage);

  // ---- step panel + stepper ----
  const panel = el('div', 'af-panel');
  panel.setAttribute('aria-live', 'polite');
  const meta = el('p', 'af-meta mono');
  const title = el('h4', 'af-title');
  const body = el('p', 'af-body');
  const detail = el('pre', 'af-detail');
  panel.append(meta, title, body, detail);
  const stepper = el('ol', 'af-steps');

  host.append(bar, chart, panel, stepper);

  // ---- state ----
  let steps = SCENARIOS.ok;
  let i = 0;
  let timer: number | undefined;
  let full = false;

  // Full flow: every step as one row of a sequence diagram; the current step is highlighted.
  const ROW = 40, TOP = 112;
  function drawFull() {
    stage.replaceChildren();
    const height = TOP + steps.length * ROW;
    chart.setAttribute('viewBox', `0 0 660 ${height}`);
    lifelines.forEach((l) => l.setAttribute('y2', String(height - 8)));
    const cur = steps[i];
    for (const [id, node] of actorNodes) node.classList.toggle('active', id === cur.from || id === cur.to);
    steps.forEach((s, k) => {
      const y = TOP + k * ROW;
      const state = k === i ? 'current' : k < i ? 'done' : 'todo';
      const cls = s.result === 'fail' ? 'fail' : s.result === 'ok' ? 'ok' : '';
      const g = svg('g', { class: `af-row ${state} ${cls}` });
      g.addEventListener('click', () => { stop(); i = k; render(); });
      const tip = svg('title');
      tip.textContent = `${k + 1}. ${s.title}`;
      g.append(tip);
      const label = svg('text', { class: 'af-row-label' });
      if (s.from === s.to) {
        const x = X[s.from];
        g.append(svg('rect', { x: x - 70, y: y - 14, width: 140, height: 28, rx: 14, class: 'af-row-pill' }));
        label.setAttribute('x', String(x));
        label.setAttribute('y', String(y + 5));
        label.textContent = `${k + 1}  ${s.result === 'fail' ? '✗' : '✓'} ${s.packet}`;
        g.append(label);
      } else {
        const x1 = X[s.from], x2 = X[s.to];
        const dir = x2 > x1 ? 1 : -1;
        const a1 = x1 + dir * 6, a2 = x2 - dir * 6;
        g.append(svg('line', { x1: a1, y1: y + 4, x2: a2, y2: y + 4, class: 'af-row-line', 'marker-end': s.result === 'fail' ? 'url(#af-arrow-fail)' : 'url(#af-arrow)' }));
        label.setAttribute('x', String((x1 + x2) / 2));
        label.setAttribute('y', String(y - 4));
        label.textContent = `${k + 1}  ${s.packet}`;
        g.append(label);
        if (k === i && !reduce) {
          const dot = svg('circle', { r: 5, class: 'af-row-dot' });
          const motion = svg('animateMotion', { path: `M${a1} ${y + 4} L${a2} ${y + 4}`, dur: '1s', fill: 'freeze', begin: 'indefinite' });
          dot.append(motion);
          g.append(dot);
          stage.append(g);
          (motion as unknown as SVGAnimationElement).beginElement?.();
          return;
        }
      }
      stage.append(g);
    });
  }

  function drawStep(s: Step) {
    stage.replaceChildren();
    chart.setAttribute('viewBox', '0 0 660 200');
    lifelines.forEach((l) => l.setAttribute('y2', '192'));
    for (const [id, node] of actorNodes) node.classList.toggle('active', id === s.from || id === s.to);
    const cls = s.result === 'fail' ? 'fail' : s.result === 'ok' ? 'ok' : '';

    if (s.from === s.to) {
      // A local step (validation / authorization) on one actor: a badge with a check or a cross.
      const x = X[s.from];
      const g = svg('g', { class: `af-self ${cls}` });
      g.append(svg('rect', { x: x - 76, y: LANE_Y - 22, width: 152, height: 44, rx: 22 }));
      const t = svg('text', { x, y: LANE_Y + 6, class: 'af-packet-text' });
      t.textContent = `${s.result === 'fail' ? '✗' : '✓'} ${s.packet}`;
      g.append(t);
      if (!reduce) g.append(svg('animate', { attributeName: 'opacity', from: 0, to: 1, dur: '0.5s', fill: 'freeze' }));
      stage.append(g);
      return;
    }

    const x1 = X[s.from], x2 = X[s.to];
    const dir = x2 > x1 ? 1 : -1;
    const a1 = x1 + dir * 6, a2 = x2 - dir * 6;
    stage.append(svg('line', { x1: a1, y1: LANE_Y, x2: a2, y2: LANE_Y, class: `af-msg ${cls}`, 'marker-end': s.result === 'fail' ? 'url(#af-arrow-fail)' : 'url(#af-arrow)' }));
    const w = Math.max(70, s.packet.length * 10.2 + 26);
    const packet = svg('g', { class: `af-packet ${cls}` });
    packet.append(svg('rect', { x: -w / 2, y: -17, width: w, height: 34, rx: 17 }));
    const t = svg('text', { x: 0, y: 6, class: 'af-packet-text' });
    t.textContent = s.packet;
    packet.append(t);
    if (reduce) {
      packet.setAttribute('transform', `translate(${(a1 + a2) / 2} ${LANE_Y - 26})`);
    } else {
      const motion = svg('animateMotion', {
        path: `M${a1} ${LANE_Y - 26} L${a2} ${LANE_Y - 26}`, dur: '1.1s', fill: 'freeze', begin: 'indefinite',
        calcMode: 'spline', keyTimes: '0;1', keySplines: '0.4 0 0.2 1',
      });
      packet.append(motion);
      // Park it at the start until the animation begins.
      packet.setAttribute('transform', `translate(0 0)`);
      stage.append(packet);
      (motion as unknown as SVGAnimationElement).beginElement?.();
      return;
    }
    stage.append(packet);
  }

  function render() {
    const s = steps[i];
    if (full) drawFull();
    else drawStep(s);
    meta.textContent = `Step ${i + 1} of ${steps.length} · ${s.phase}`;
    meta.dataset.phase = s.phase.toLowerCase();
    title.textContent = s.title;
    body.textContent = s.body;
    detail.textContent = s.detail ?? '';
    detail.hidden = !s.detail;
    chart.setAttribute('aria-label', `Step ${i + 1}: ${s.title}`);
    [...stepper.children].forEach((li, k) => {
      li.classList.toggle('done', k < i);
      li.classList.toggle('current', k === i);
      const b = li.firstElementChild as HTMLButtonElement;
      if (k === i) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
    prev.disabled = i === 0;
    next.disabled = i === steps.length - 1;
  }

  function buildStepper() {
    stepper.replaceChildren(...steps.map((s, k) => {
      const li = el('li', s.result === 'fail' ? 'fail' : undefined);
      const b = button(`${k + 1}. ${s.title}`, 'af-step');
      b.addEventListener('click', () => { stop(); i = k; render(); });
      li.append(b);
      return li;
    }));
  }

  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    play.textContent = '▶ Play';
  }

  function start() {
    if (i === steps.length - 1) i = 0;
    render();
    play.textContent = '❚❚ Pause';
    timer = window.setInterval(() => {
      if (i >= steps.length - 1) return stop();
      i++;
      render();
    }, AUTOPLAY_MS);
  }

  play.addEventListener('click', () => (timer === undefined ? start() : stop()));
  next.addEventListener('click', () => { stop(); if (i < steps.length - 1) { i++; render(); } });
  prev.addEventListener('click', () => { stop(); if (i > 0) { i--; render(); } });
  fullBtn.addEventListener('click', () => {
    full = !full;
    fullBtn.textContent = full ? 'Step-by-step view' : 'Show full flow';
    fullBtn.setAttribute('aria-pressed', String(full));
    host.classList.toggle('full', full);
    render();
  });
  restart.addEventListener('click', () => { stop(); i = 0; render(); });
  scenario.addEventListener('change', () => {
    stop();
    steps = SCENARIOS[scenario.value as Scenario];
    i = Math.min(i, steps.length - 1);
    buildStepper();
    render();
  });

  buildStepper();
  render();
}
