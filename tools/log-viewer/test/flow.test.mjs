// End to end: start the server in sample mode with a throwaway admin, then walk the whole sign-in flow
// the way a browser would, plus the attacks the spec says must fail.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { totp } from '../lib/crypto.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4400 + Math.floor(Math.random() * 400);
const APP = `http://localhost:${PORT}`;
const OP = `http://localhost:${PORT + 1}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-'));
const env = { ...process.env, LV_CONFIG: path.join(tmp, 'config.json'), LV_PASSWORD: 'test-password-123', LV_PORT: String(PORT) };
execFileSync('node', ['setup.mjs'], { cwd: ROOT, env });
const config = JSON.parse(fs.readFileSync(env.LV_CONFIG, 'utf8'));
const server = spawn('node', ['server.mjs', '--sample'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
const logs = [];
server.stdout.on('data', (d) => logs.push(String(d)));
await new Promise((resolve) => server.stdout.once('data', resolve));

test.after(() => { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const cookiesFrom = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));
const noFollow = (url, opts = {}) => fetch(url, { redirect: 'manual', ...opts });

const txOf = (html) => /name="tx" value="([^"]+)"/.exec(html)?.[1];
const postAuthorize = (fields) => noFollow(`${OP}/authorize`, { method: 'POST', body: new URLSearchParams(fields) });

async function signIn({ username = 'admin', password = env.LV_PASSWORD, step } = {}) {
  const start = await noFollow(`${APP}/auth/start`);
  const tx = cookiesFrom(start).join('; ');
  const page = await (await fetch(start.headers.get('location'))).text();
  // Step 1: username + password only.
  const first = await postAuthorize({ tx: txOf(page), username, password });
  const firstHtml = await first.text();
  if (first.status !== 200 || !firstHtml.includes('name="otp"')) return { ok: false, stage: 'password', status: first.status, html: firstHtml };
  // Step 2: the code, on the new transaction id the password step handed back.
  const otp = totp(config.user.totpSecret, step ?? Math.floor(Date.now() / 30000));
  const post = await postAuthorize({ tx: txOf(firstHtml), otp });
  if (post.status !== 302) return { ok: false, stage: 'otp', status: post.status, html: await post.text() };
  const cb = await noFollow(post.headers.get('location'), { headers: { cookie: tx } });
  return { ok: cb.headers.get('location') === '/logs', cookie: cookiesFrom(cb).join('; '), callback: post.headers.get('location'), tx };
}

async function freshTx() {
  const start = await noFollow(`${APP}/auth/start`);
  return txOf(await (await fetch(start.headers.get('location'))).text());
}

test('unauthenticated requests are refused', async () => {
  assert.equal((await noFollow(`${APP}/logs`)).headers.get('location'), '/login');
  assert.equal((await fetch(`${APP}/api/me`)).status, 401);
  assert.equal((await fetch(`${APP}/api/query`, { method: 'POST', headers: { origin: APP }, body: '{"view":"recent","range":"1h"}' })).status, 401);
  assert.equal((await fetch(`${APP}/api/costs`, { method: 'POST', headers: { origin: APP }, body: '{}' })).status, 401);
});

test('wrong password is refused; correct password + TOTP signs in and queries work', async () => {
  const bad = await signIn({ password: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, 'password', 'no MFA prompt after a wrong password');
  assert.equal(bad.status, 401);
  assert.match(bad.html, /Authentication failed\./);
  assert.ok(!bad.html.includes('name="otp"'));

  const s = await signIn({ step: Math.floor(Date.now() / 30000) + 1 }); // next step: unused, still in the window
  assert.ok(s.ok, 'signed in');
  const me = await (await fetch(`${APP}/api/me`, { headers: { cookie: s.cookie } })).json();
  assert.equal(me.scope, 'openid profile logs:read');

  const q = await fetch(`${APP}/api/query`, { method: 'POST', headers: { cookie: s.cookie, origin: APP, 'content-type': 'application/json' }, body: '{"view":"top-paths","range":"24h"}' });
  assert.equal(q.status, 200);
  const body = await q.json();
  assert.equal(body.source, 'sample');
  assert.ok(body.rows.length > 0);

  // Allowlists: unknown views, ranges and raw query text are rejected without running anything.
  for (const bodyText of ['{"view":"costs","range":"24h"}', '{"view":"fields @message","range":"24h"}', '{"view":"recent","range":"365d"}', '{"view":"__proto__","range":"1h"}', 'not json']) {
    const r = await fetch(`${APP}/api/query`, { method: 'POST', headers: { cookie: s.cookie, origin: APP }, body: bodyText });
    assert.equal(r.status, 400, bodyText);
  }
  // Viewer IPs reach the browser only as prefixes.
  const recent = await (await fetch(`${APP}/api/query`, { method: 'POST', headers: { cookie: s.cookie, origin: APP }, body: '{"view":"recent","range":"1h"}' })).text();
  assert.match(recent, /\/24|\/48/);
  assert.ok(!/"\d+\.\d+\.\d+\.(?!0\/24)\d+"/.test(recent), 'full IPv4 in response');

  // Paging. Event views: 50 lines per page by time cursor, no overlap, Show all returns everything.
  const page = (body) => fetch(`${APP}/api/query`, { method: 'POST', headers: { cookie: s.cookie, origin: APP }, body: JSON.stringify(body) });
  const p1 = await (await page({ view: 'recent', range: '24h' })).json();
  assert.equal(p1.rows.length, 50);
  assert.equal(p1.page.hasMore, true);
  assert.match(p1.page.nextCursor, /^\d{13}$/);
  assert.ok(p1.rows.every((r) => !('ts' in r)), 'cursor field stripped');
  const p2 = await (await page({ view: 'recent', range: '24h', page: 1, cursor: p1.page.nextCursor })).json();
  assert.equal(p2.rows.length, 50);
  assert.ok(p2.rows[0].time <= p1.rows.at(-1).time, 'page 2 is older than page 1');
  assert.equal(new Set([...p1.rows, ...p2.rows].map((r) => r.time)).size, 100, 'no overlap');
  const every = await (await page({ view: 'recent', range: '24h', all: true })).json();
  assert.equal(every.rows.length, 180);
  assert.equal(every.page.hasMore, false);
  // Summary views: page through the cached result.
  const s1 = await (await page({ view: 'top-paths', range: '24h' })).json();
  assert.ok(s1.page.total > 0 && s1.rows.length === Math.min(50, s1.page.total));
  // Paging input is validated.
  for (const bad of [{ page: -1 }, { page: 1.5 }, { page: 5000 }, { cursor: 'abc' }, { cursor: '1; fields @message' }, { all: 'yes' }]) {
    assert.equal((await page({ view: 'recent', range: '24h', ...bad })).status, 400, JSON.stringify(bad));
  }

  // Costs: sample data in sample mode, tag-filtered, and never a query parameter that changes what's read.
  const costs = await (await fetch(`${APP}/api/costs`, { method: 'POST', headers: { cookie: s.cookie, origin: APP }, body: '{}' })).json();
  assert.equal(costs.tag.key, 'application');
  assert.equal(costs.tag.value, 'resume');
  assert.equal(costs.months.length, 6);
  assert.ok(costs.components.length > 0 && costs.totals.sixMonths > 0);
  const crossCost = await fetch(`${APP}/api/costs`, { method: 'POST', headers: { cookie: s.cookie, origin: 'https://evil.test' }, body: '{}' });
  assert.equal(crossCost.status, 403);

  // Cross-site POSTs are refused even with a valid session.
  const cross = await fetch(`${APP}/api/query`, { method: 'POST', headers: { cookie: s.cookie, origin: 'https://evil.test' }, body: '{"view":"recent","range":"1h"}' });
  assert.equal(cross.status, 403);

  // Replaying the authorization code fails: codes are single use.
  const replay = await noFollow(s.callback, { headers: { cookie: s.tx } });
  assert.match(replay.headers.get('location'), /error/);

  // The same TOTP code can't be used twice.
  const again = await signIn({ step: Math.floor(Date.now() / 30000) + 1 });
  assert.equal(again.ok, false);
  assert.equal(again.stage, 'otp');
  assert.match(again.html, /Authentication failed\./);

  // Sign out ends the session.
  await fetch(`${APP}/auth/logout`, { method: 'POST', headers: { cookie: s.cookie, origin: APP } });
  assert.equal((await fetch(`${APP}/api/me`, { headers: { cookie: s.cookie } })).status, 401);

  // Audit lines never contain secrets.
  const text = logs.join('');
  assert.match(text, /"event":"login-succeeded"/);
  assert.match(text, /"event":"query"/);
  assert.ok(!text.includes(env.LV_PASSWORD) && !text.includes('access_token'));
});

test('the token endpoint enforces client auth and PKCE', async () => {
  const basic = (secret) => `Basic ${Buffer.from(`${config.client.id}:${secret}`).toString('base64')}`;
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: 'x', redirect_uri: `${APP}/auth/callback`, code_verifier: 'y' });
  assert.equal((await fetch(`${OP}/token`, { method: 'POST', headers: { authorization: basic('wrong') }, body })).status, 401);
  assert.equal((await fetch(`${OP}/token`, { method: 'POST', headers: { authorization: basic(config.client.secret) }, body })).status, 400);
});

test('the provider refuses unregistered redirect URIs and missing PKCE', async () => {
  const q = (o) => new URLSearchParams({ response_type: 'code', client_id: config.client.id, redirect_uri: `${APP}/auth/callback`, scope: 'openid', state: 's', code_challenge: 'c', code_challenge_method: 'S256', ...o });
  assert.equal((await noFollow(`${OP}/authorize?${q({ redirect_uri: 'https://evil.test/cb' })}`)).status, 400);
  assert.match((await noFollow(`${OP}/authorize?${q({ code_challenge_method: 'plain' })}`)).headers.get('location'), /invalid_request/);
});

test('the sign-in form asks for the code only after a correct password, and never says which field was wrong', async () => {
  const first = await (await fetch(`${OP}/authorize?${new URLSearchParams({ response_type: 'code', client_id: config.client.id, redirect_uri: `${APP}/auth/callback`, scope: 'openid', state: 's', code_challenge: 'c', code_challenge_method: 'S256' })}`)).text();
  assert.ok(first.includes('name="password"') && !first.includes('name="otp"'), 'step 1 has no code field');

  // Wrong username and wrong password give the same page (apart from the transaction id).
  const strip = (h) => h.replace(/name="tx" value="[^"]+"/, '');
  const wrongUser = await postAuthorize({ tx: await freshTx(), username: 'nobody', password: env.LV_PASSWORD });
  const wrongPass = await postAuthorize({ tx: await freshTx(), username: 'admin', password: 'nope' });
  assert.equal(wrongUser.status, 401);
  assert.equal(wrongPass.status, 401);
  assert.equal(strip(await wrongUser.text()), strip(await wrongPass.text()));

  // A code can't be sent before the password step: the transaction is still on step 1.
  const skip = await postAuthorize({ tx: await freshTx(), otp: totp(config.user.totpSecret) });
  const skipHtml = await skip.text();
  assert.equal(skip.status, 401);
  assert.ok(skipHtml.includes('name="password"') && !skipHtml.includes('name="otp"'));

  // The password step retires its transaction id; the old one can't be reused for the code step.
  const tx = await freshTx();
  const ok = await postAuthorize({ tx, username: 'admin', password: env.LV_PASSWORD });
  assert.ok((await ok.text()).includes('name="otp"'));
  assert.equal((await postAuthorize({ tx, otp: totp(config.user.totpSecret) })).status, 400);
});

test('repeated failures lock the account', async () => {
  for (let i = 0; i < 5; i++) await signIn({ password: 'wrong' });
  const locked = await signIn();
  assert.equal(locked.ok, false);
  assert.match(locked.html, /Too many failed attempts/);
});
