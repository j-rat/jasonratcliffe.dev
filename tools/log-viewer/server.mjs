// Admin log viewer, localhost prototype.
//   app (backend-for-frontend): http://localhost:4322   identity provider: http://localhost:4323
// The browser holds only an opaque HttpOnly session cookie. Tokens stay in this process, and every
// API call re-validates the access token the way an API Gateway JWT authorizer would.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomToken, verifyJwt } from './lib/crypto.mjs';
import { audit, cookie, json, parseCookies, readBody, redirect, send, serveFile } from './lib/http.mjs';
import { createProvider, pkceChallenge } from './lib/provider.mjs';
import { RANGES, VIEWS, viewList } from './lib/views.mjs';
import { runView } from './lib/logs.mjs';
import { costOverview } from './lib/costs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1'; // never listen on the network
const APP_PORT = Number(process.env.LV_PORT || 4322);
const OP_PORT = APP_PORT + 1;
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const ISSUER = `http://localhost:${OP_PORT}`;
const API_AUDIENCE = 'log-viewer-api';
const REQUIRED_SCOPE = 'logs:read';
const SAMPLE = process.argv.includes('--sample');
const COST_VIEW = { id: 'costs', title: 'Cost overview', description: 'Spend for resources tagged application = resume, by architecture component.', group: 'costs', kind: 'cost' };
const GLOBAL_CSS = path.join(HERE, '../../site/src/styles/global.css');

const configFile = process.env.LV_CONFIG || path.join(HERE, '.local/config.json');
if (!fs.existsSync(configFile)) {
  console.error('No local admin yet. Run: node setup.mjs');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));

// ---- identity provider (separate origin, like Cognito would be) ----
const provider = createProvider({ config, issuer: ISSUER, appOrigin: APP_ORIGIN, apiAudience: API_AUDIENCE, globalCss: GLOBAL_CSS });
http.createServer((req, res) => provider.handle(req, res).catch((e) => {
  audit('provider-error', { error: e.message });
  send(res, 500, 'Error');
})).listen(OP_PORT, HOST);

// ---- the app: sessions, auth transactions ----
const sessions = new Map(); // sid -> { sub, name, accessToken, expires }
const transactions = new Map(); // tx -> { state, nonce, verifier, created }
let jwks = null; // fetched from the provider like a real relying party, then cached

async function getJwks() {
  if (!jwks) jwks = await (await fetch(`${ISSUER}/jwks`)).json();
  return jwks;
}

function session(req) {
  const sid = parseCookies(req).lv_session;
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return { sid, ...s };
}

/** What an API Gateway JWT authorizer checks, plus the scope this API requires. */
async function authorize(req) {
  const s = session(req);
  if (!s) return { error: 'no session' };
  try {
    const claims = verifyJwt(s.accessToken, { jwks: await getJwks(), issuer: ISSUER, audience: API_AUDIENCE, typ: 'at+jwt' });
    if (!String(claims.scope ?? '').split(' ').includes(REQUIRED_SCOPE)) return { error: 'missing scope' };
    return { claims, session: s };
  } catch (e) {
    return { error: e.message };
  }
}

/** Reject state-changing requests from other sites (defense in depth on top of SameSite=Strict). */
const sameOrigin = (req) => req.headers.origin === APP_ORIGIN;

const clearSession = cookie('lv_session', '', { maxAge: 0 });

async function app(req, res) {
  const url = new URL(req.url, APP_ORIGIN);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /static/global.css') return serveFile(res, GLOBAL_CSS);
  if (req.method === 'GET' && /^\/static\/[a-z-]+\.(css|js)$/.test(url.pathname)) return serveFile(res, path.join(HERE, 'public', path.basename(url.pathname)));

  if (route === 'GET /') return redirect(res, session(req) ? '/logs' : '/login');
  if (route === 'GET /login') return serveFile(res, path.join(HERE, 'public/login.html'));

  if (route === 'GET /auth/start') {
    const tx = randomToken(18);
    const t = { state: randomToken(16), nonce: randomToken(16), verifier: randomToken(48), created: Date.now() };
    transactions.set(tx, t);
    const q = new URLSearchParams({
      response_type: 'code', client_id: config.client.id, redirect_uri: `${APP_ORIGIN}/auth/callback`,
      scope: `openid profile ${REQUIRED_SCOPE}`, state: t.state, nonce: t.nonce,
      code_challenge: pkceChallenge(t.verifier), code_challenge_method: 'S256',
    });
    // Lax, not Strict: it has to survive the top-level redirect back from the provider.
    return redirect(res, `${ISSUER}/authorize?${q}`, { 'Set-Cookie': cookie('lv_tx', tx, { maxAge: 600, sameSite: 'Lax' }) });
  }

  if (route === 'GET /auth/callback') {
    const txId = parseCookies(req).lv_tx;
    const t = txId && transactions.get(txId);
    transactions.delete(txId);
    const done = { 'Set-Cookie': cookie('lv_tx', '', { maxAge: 0 }) };
    const fail = (why) => {
      audit('callback-rejected', { reason: why });
      return redirect(res, `/login?error=${encodeURIComponent(why)}`, done);
    };
    if (!t || Date.now() - t.created > 600_000) return fail('sign-in expired');
    if (url.searchParams.get('state') !== t.state) return fail('state mismatch');
    if (url.searchParams.get('error')) return fail(url.searchParams.get('error'));
    const tokenRes = await fetch(`${ISSUER}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${config.client.id}:${config.client.secret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: `${APP_ORIGIN}/auth/callback`, code_verifier: t.verifier }),
    });
    if (!tokenRes.ok) return fail('token exchange failed');
    const tokens = await tokenRes.json();
    let id;
    try {
      id = verifyJwt(tokens.id_token, { jwks: await getJwks(), issuer: ISSUER, audience: config.client.id });
      if (id.nonce !== t.nonce) throw new Error('nonce mismatch');
    } catch (e) {
      return fail(`id token rejected: ${e.message}`);
    }
    const sid = randomToken(32);
    const expires = Math.min(Date.now() + 8 * 3600_000, tokens.expires_in * 1000 + Date.now());
    sessions.set(sid, { sub: id.sub, name: id.name, accessToken: tokens.access_token, expires });
    audit('session-started', { sub: id.sub });
    return redirect(res, '/logs', { 'Set-Cookie': [done['Set-Cookie'], cookie('lv_session', sid, { maxAge: Math.floor((expires - Date.now()) / 1000) })] });
  }

  if (route === 'POST /auth/logout') {
    if (!sameOrigin(req)) return send(res, 403, 'Forbidden');
    const s = session(req);
    if (s) {
      sessions.delete(s.sid);
      audit('session-ended', { sub: s.sub });
    }
    return json(res, 200, { ok: true }, { 'Set-Cookie': clearSession });
  }

  if (route === 'GET /logs') {
    if (!session(req)) return redirect(res, '/login');
    return serveFile(res, path.join(HERE, 'public/logs.html'));
  }

  if (url.pathname.startsWith('/api/')) {
    const auth = await authorize(req);
    if (auth.error) {
      audit('api-denied', { path: url.pathname, reason: auth.error });
      return json(res, 401, { error: 'unauthorized' }, { 'Set-Cookie': clearSession });
    }
    if (route === 'GET /api/me') {
      return json(res, 200, { name: auth.session.name, sub: auth.claims.sub, expires: auth.session.expires, scope: auth.claims.scope, mode: SAMPLE ? 'sample' : 'aws' });
    }
    if (route === 'GET /api/views') return json(res, 200, { views: [...viewList(), COST_VIEW], ranges: Object.entries(RANGES).map(([id, r]) => ({ id, label: r.label })) });
    if (route === 'POST /api/query') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
      let body;
      try {
        body = JSON.parse(await readBody(req, 1024));
      } catch {
        return json(res, 400, { error: 'bad request' });
      }
      // Ids only, checked against the allowlists. No query text is ever accepted from the browser.
      if (!Object.hasOwn(VIEWS, body?.view) || !Object.hasOwn(RANGES, body?.range)) return json(res, 400, { error: 'unknown view or range' });
      // Paging: a small page number, an epoch-ms cursor (digits only), and the "show all" switch. Nothing else.
      const page = body.page ?? 0;
      const cursor = body.cursor ?? null;
      if (!Number.isInteger(page) || page < 0 || page > 1000) return json(res, 400, { error: 'bad page' });
      if (cursor !== null && !/^\d{10,16}$/.test(String(cursor))) return json(res, 400, { error: 'bad cursor' });
      if (body.all !== undefined && typeof body.all !== 'boolean') return json(res, 400, { error: 'bad request' });
      audit('query', { sub: auth.claims.sub, view: body.view, range: body.range, page, all: body.all === true });
      try {
        const result = await runView(body.view, body.range, { forceSample: SAMPLE, sid: auth.session.sid, page, cursor, all: body.all === true });
        return json(res, 200, { view: body.view, range: body.range, chart: VIEWS[body.view].chart ?? null, ...result });
      } catch (e) {
        audit('query-failed', { view: body.view, error: e.name });
        return json(res, 502, { error: `Query failed: ${e.name}` });
      }
    }
    if (route === 'POST /api/costs') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
      let body = {};
      try {
        body = JSON.parse((await readBody(req, 256)) || '{}');
      } catch {
        return json(res, 400, { error: 'bad request' });
      }
      audit('costs', { sub: auth.claims.sub, refresh: body?.refresh === true });
      try {
        return json(res, 200, await costOverview({ refresh: body?.refresh === true, forceSample: SAMPLE }));
      } catch (e) {
        audit('costs-failed', { error: e.name });
        return json(res, 502, { error: `Cost Explorer failed: ${e.name}` });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  return send(res, 404, 'Not found');
}

http.createServer((req, res) => app(req, res).catch((e) => {
  audit('app-error', { error: e.message });
  send(res, 500, 'Error');
})).listen(APP_PORT, HOST, () => {
  console.log(`Log viewer:        ${APP_ORIGIN}${SAMPLE ? '   (sample data only)' : ''}`);
  console.log(`Identity provider: ${ISSUER}`);
});
