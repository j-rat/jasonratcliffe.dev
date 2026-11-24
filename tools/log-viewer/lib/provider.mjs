// A minimal local OpenID provider, standing in for Cognito during the prototype.
// Authorization Code + PKCE (S256) only, one confidential client, one MFA user, RS256 tokens.
// Swapping to Cognito later means changing ISSUER and the client settings; the app side doesn't change.
import { checkPassword, checkTotp, publicJwk, randomToken, safeEqual, sha256, signJwt } from './crypto.mjs';
import { audit, CSP, escapeHtml, json, readForm, redirect, send, serveFile } from './http.mjs';

const CODE_TTL = 60; // seconds
const TOKEN_TTL = 3600;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
const OTP_WINDOW_MS = 5 * 60_000; // time allowed between the password step and the code
const MAX_OTP_TRIES = 3; // wrong codes before the password is asked for again

export function createProvider({ config, issuer, appOrigin, apiAudience, globalCss }) {
  const redirectUri = `${appOrigin}/auth/callback`;
  const jwks = { keys: [publicJwk(config.signingKey.pem, config.signingKey.kid)] };
  const pending = new Map(); // login transactions, id -> authorize params
  const codes = new Map(); // one-time codes
  const failures = { count: 0, until: 0 };
  let lastTotpStep = -1; // a TOTP code can be used once

  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    scopes_supported: ['openid', 'profile', 'logs:read'],
  };

  // Chrome applies form-action to the redirect after a form POST, so the app origin must be allowed.
  const pageCsp = CSP(`'self' ${appOrigin}`);

  // One generic message for every credential failure: it never says whether the username, the password
  // or the code was wrong.
  const AUTH_FAILED = 'Authentication failed.';

  // Two steps on one transaction: password first, then (only after the password succeeds) the TOTP code.
  // The step lives on the server-side transaction, so a form can't skip straight to the code.
  function loginPage(res, txId, { stage = 'password', error = '' } = {}) {
    const fields = stage === 'otp'
      ? `<p class="muted">Enter the 6-digit code from your authenticator app.</p>
<label>Authenticator code<input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus></label>`
      : `<label>Username<input name="username" autocomplete="username" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in · local identity provider</title>
<link rel="stylesheet" href="/static/global.css"><link rel="stylesheet" href="/static/provider.css"></head>
<body><main class="op wrap">
<p class="eyebrow">Local identity provider</p>
<h1>${stage === 'otp' ? 'Verify it’s you' : 'Sign in'}</h1>
<p class="muted">Stand-in for Cognito managed login. The log viewer never sees these credentials.</p>
<form class="card" method="post" action="/authorize" autocomplete="on">
<input type="hidden" name="tx" value="${escapeHtml(txId)}">
${fields}
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<button class="btn btn-primary" type="submit">${stage === 'otp' ? 'Verify' : 'Continue'}</button>
</form></main></body></html>`;
    send(res, error ? 401 : 200, html, 'text/html; charset=utf-8', { csp: pageCsp });
  }

  /** Replace a transaction under a fresh id (the old id stops working), optionally changing its step. */
  function rotate(oldId, tx, changes) {
    pending.delete(oldId);
    const id = randomToken(18);
    pending.set(id, { ...tx, ...changes });
    return id;
  }

  function fail(stage) {
    failures.count += 1;
    if (failures.count >= MAX_FAILURES) failures.until = Date.now() + LOCKOUT_MS;
    audit('login-failed', { stage, failures: failures.count, locked: failures.count >= MAX_FAILURES });
  }

  function issueTokens(code) {
    const now = Math.floor(Date.now() / 1000);
    const { user, signingKey, client } = config;
    const header = { alg: 'RS256', kid: signingKey.kid };
    const idToken = signJwt({ ...header, typ: 'JWT' }, {
      iss: issuer, sub: user.sub, aud: client.id, iat: now, exp: now + TOKEN_TTL, auth_time: code.authTime,
      nonce: code.nonce, name: user.name, amr: ['pwd', 'otp'],
    }, signingKey.pem);
    const accessToken = signJwt({ ...header, typ: 'at+jwt' }, {
      iss: issuer, sub: user.sub, aud: apiAudience, client_id: client.id, iat: now, exp: now + TOKEN_TTL,
      jti: randomToken(12), scope: code.scope,
    }, signingKey.pem);
    return { id_token: idToken, access_token: accessToken, token_type: 'Bearer', expires_in: TOKEN_TTL, scope: code.scope };
  }

  return {
    jwks,
    async handle(req, res) {
      const url = new URL(req.url, issuer);
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /.well-known/openid-configuration') return json(res, 200, discovery);
      if (route === 'GET /jwks') return json(res, 200, jwks);
      if (route === 'GET /static/global.css') return serveFile(res, globalCss);
      if (route === 'GET /static/provider.css') return serveFile(res, new URL('../public/provider.css', import.meta.url).pathname);

      if (route === 'GET /authorize') {
        const q = Object.fromEntries(url.searchParams);
        // Never redirect to an unregistered URI: show the error here instead.
        if (q.client_id !== config.client.id || q.redirect_uri !== redirectUri) return send(res, 400, 'Unknown client or redirect_uri');
        const fail = (error) => redirect(res, `${redirectUri}?error=${error}&state=${encodeURIComponent(q.state ?? '')}`);
        if (q.response_type !== 'code') return fail('unsupported_response_type');
        if (!q.code_challenge || q.code_challenge_method !== 'S256') return fail('invalid_request');
        const scopes = (q.scope ?? '').split(' ');
        if (!scopes.includes('openid')) return fail('invalid_scope');
        const txId = randomToken(18);
        pending.set(txId, { ...q, stage: 'password', scope: scopes.filter((s) => discovery.scopes_supported.includes(s)).join(' '), created: Date.now() });
        return loginPage(res, txId);
      }

      if (route === 'POST /authorize') {
        const form = await readForm(req).catch(() => ({}));
        const tx = pending.get(form.tx);
        if (!tx || Date.now() - tx.created > 10 * 60_000) return send(res, 400, 'Sign-in request expired. Start again from the log viewer.');
        if (Date.now() < failures.until) {
          audit('login-locked');
          return loginPage(res, form.tx, { stage: tx.stage, error: 'Too many failed attempts. Try again in 15 minutes.' });
        }
        const { user } = config;

        if (tx.stage !== 'otp') {
          // Step 1: username + password. Both checks always run (no short circuit), so a wrong username
          // takes as long as a wrong password and the response is identical.
          const nameOk = safeEqual(form.username ?? '', user.username);
          const passwordOk = checkPassword(form.password ?? '', user.password);
          if (!(nameOk && passwordOk)) {
            fail('password');
            return loginPage(res, form.tx, { error: AUTH_FAILED });
          }
          audit('login-password-ok');
          const next = rotate(form.tx, tx, { stage: 'otp', passwordAt: Date.now(), otpTries: 0 });
          return loginPage(res, next, { stage: 'otp' });
        }

        // Step 2: the TOTP code, reachable only through a transaction whose password step succeeded.
        if (Date.now() - tx.passwordAt > OTP_WINDOW_MS) {
          const restart = rotate(form.tx, tx, { stage: 'password' });
          return loginPage(res, restart, { error: AUTH_FAILED });
        }
        const step = checkTotp(user.totpSecret, form.otp ?? '');
        if (step === null || step <= lastTotpStep) {
          fail('otp');
          tx.otpTries += 1;
          // Too many wrong codes for this password: back to step 1.
          if (tx.otpTries >= MAX_OTP_TRIES) return loginPage(res, rotate(form.tx, tx, { stage: 'password' }), { error: AUTH_FAILED });
          return loginPage(res, form.tx, { stage: 'otp', error: AUTH_FAILED });
        }
        failures.count = 0;
        lastTotpStep = step;
        pending.delete(form.tx);
        const code = randomToken(24);
        codes.set(code, {
          clientId: tx.client_id, redirectUri: tx.redirect_uri, challenge: tx.code_challenge, nonce: tx.nonce,
          scope: tx.scope, authTime: Math.floor(Date.now() / 1000), expires: Date.now() + CODE_TTL * 1000,
        });
        audit('login-succeeded', { sub: user.sub });
        return redirect(res, `${tx.redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(tx.state ?? '')}`, { csp: pageCsp });
      }

      if (route === 'POST /token') {
        const [scheme, creds] = (req.headers.authorization ?? '').split(' ');
        const [id, secret] = scheme === 'Basic' ? Buffer.from(creds ?? '', 'base64').toString().split(':') : [];
        if (id !== config.client.id || !safeEqual(secret ?? '', config.client.secret)) return json(res, 401, { error: 'invalid_client' });
        const form = await readForm(req).catch(() => ({}));
        if (form.grant_type !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' });
        const code = codes.get(form.code);
        codes.delete(form.code); // single use, even when the exchange fails
        if (!code || code.expires < Date.now() || code.clientId !== id || code.redirectUri !== form.redirect_uri) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        const challenge = Buffer.from(sha256(form.code_verifier ?? '')).toString('base64url');
        if (!safeEqual(challenge, code.challenge)) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return json(res, 200, issueTokens(code));
      }

      return send(res, 404, 'Not found');
    },
  };
}

export const pkceChallenge = (verifier) => Buffer.from(sha256(verifier)).toString('base64url');
