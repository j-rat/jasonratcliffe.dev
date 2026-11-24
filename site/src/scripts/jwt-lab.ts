// JWT lab for the OIDC/JWT blog post. Builds signed demo tokens in the browser with WebCrypto.
// Nothing is sent anywhere: keys and tokens live only in this page. All output uses DOM text nodes.

type Alg = 'HS256' | 'RS256';
type Kind = 'id' | 'access';
type Json = Record<string, unknown>;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const pad = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const b64json = (o: Json) => b64url(enc.encode(JSON.stringify(o)));
const randomId = (n = 16) => b64url(crypto.getRandomValues(new Uint8Array(n)));

function pem(der: ArrayBuffer, label: string): string {
  const body = btoa(String.fromCharCode(...new Uint8Array(der))).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${body.trim()}\n-----END ${label}-----`;
}

interface Keys { alg: Alg; secret: string; rsa?: CryptoKeyPair; kid: string }

async function signingKey(k: Keys, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (k.alg === 'HS256') {
    return crypto.subtle.importKey('raw', enc.encode(k.secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
  }
  return usage === 'sign' ? k.rsa!.privateKey : k.rsa!.publicKey;
}

const algParams = (alg: Alg) => (alg === 'HS256' ? { name: 'HMAC' } : { name: 'RSASSA-PKCS1-v1_5' });

export async function signJwt(header: Json, payload: Json, k: Keys): Promise<string> {
  const input = `${b64json(header)}.${b64json(payload)}`;
  const sig = await crypto.subtle.sign(algParams(k.alg), await signingKey(k, 'sign'), enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyJwt(token: string, k: Keys): Promise<boolean> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return false;
  try {
    return await crypto.subtle.verify(algParams(k.alg), await signingKey(k, 'verify'), b64urlDecode(s), enc.encode(`${h}.${p}`));
  } catch {
    return false;
  }
}

export function decodePart(part: string): Json | null {
  try {
    return JSON.parse(dec.decode(b64urlDecode(part)));
  } catch {
    return null;
  }
}

// ---- decoding and verification of arbitrary tokens ----

type VerifyAlg = { params: AlgorithmIdentifier | RsaPssParams | EcdsaParams; importParams: RsaHashedImportParams | EcKeyImportParams | HmacImportParams; kind: 'hmac' | 'rsa' | 'ec' };

export function algSpec(alg: string): VerifyAlg | null {
  const m = /^(HS|RS|PS|ES)(256|384|512)$/.exec(alg);
  if (!m) return null;
  const hash = `SHA-${m[2]}`;
  switch (m[1]) {
    case 'HS': return { kind: 'hmac', params: { name: 'HMAC' }, importParams: { name: 'HMAC', hash } };
    case 'RS': return { kind: 'rsa', params: { name: 'RSASSA-PKCS1-v1_5' }, importParams: { name: 'RSASSA-PKCS1-v1_5', hash } };
    case 'PS': return { kind: 'rsa', params: { name: 'RSA-PSS', saltLength: Number(m[2]) / 8 }, importParams: { name: 'RSA-PSS', hash } };
    default: {
      const curve = { 256: 'P-256', 384: 'P-384', 512: 'P-521' }[m[2]]!;
      return { kind: 'ec', params: { name: 'ECDSA', hash }, importParams: { name: 'ECDSA', namedCurve: curve } };
    }
  }
}

function pemBody(text: string): Uint8Array<ArrayBuffer> | null {
  const m = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/.exec(text);
  if (!m) return null;
  try {
    return Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Import whatever the reader pasted (PEM, JWK, JWKS or an HMAC secret) as a verification key. */
export async function importVerifyKey(input: string, alg: string, kid?: string): Promise<{ key: CryptoKey; source: string } | { error: string }> {
  const spec = algSpec(alg);
  if (!spec) return { error: alg === 'none' ? 'alg is "none": the token is unsigned. Reject it.' : `Unsupported alg "${alg}".` };
  const text = input.trim();
  if (!text) return { error: 'Paste a key to check the signature.' };
  try {
    if (spec.kind === 'hmac') {
      if (text.startsWith('-----BEGIN') || text.startsWith('{')) return { error: `${alg} uses a shared secret, not a public key. (Handing an HMAC verifier a public key is the classic algorithm-confusion attack.)` };
      return { key: await crypto.subtle.importKey('raw', enc.encode(text), spec.importParams, false, ['verify']), source: 'shared secret' };
    }
    const der = pemBody(text);
    if (der) return { key: await crypto.subtle.importKey('spki', der, spec.importParams, false, ['verify']), source: 'PEM public key' };
    if (text.startsWith('{')) {
      const json = JSON.parse(text);
      let jwk: JsonWebKey & { kid?: string } = json;
      let source = 'JWK';
      if (Array.isArray(json.keys)) {
        const match = json.keys.find((k: { kid?: string }) => kid !== undefined && k.kid === kid) ?? (json.keys.length === 1 ? json.keys[0] : null);
        if (!match) return { error: `No key in the JWKS has kid "${kid ?? ''}".` };
        jwk = match;
        source = `JWKS key kid ${match.kid ?? '(none)'}`;
      }
      const { kty, n, e, crv, x, y } = jwk;
      return { key: await crypto.subtle.importKey('jwk', { kty, n, e, crv, x, y }, spec.importParams, false, ['verify']), source };
    }
    return { error: `${alg} needs a public key: paste a PEM (-----BEGIN PUBLIC KEY-----), a JWK or a JWKS.` };
  } catch {
    return { error: `That key doesn't match ${alg}, or isn't valid.` };
  }
}

export async function verifyWith(token: string, alg: string, key: CryptoKey): Promise<boolean> {
  const spec = algSpec(alg);
  const [h, p, s] = token.split('.');
  if (!spec || !s) return false;
  try {
    return await crypto.subtle.verify(spec.params, key, b64urlDecode(s), enc.encode(`${h}.${p}`));
  } catch {
    return false;
  }
}

const CLAIM_INFO: Record<string, string> = {
  iss: 'Issuer: who signed the token',
  sub: 'Subject: stable ID of the user or workload',
  aud: 'Audience: who the token is for',
  exp: 'Expires',
  nbf: 'Not valid before',
  iat: 'Issued at',
  jti: 'Unique token ID',
  auth_time: 'When the user authenticated',
  nonce: 'Ties an ID token to its login request',
  azp: 'Client the token was issued to',
  acr: 'Authentication context (assurance level)',
  amr: 'Authentication methods used',
  scope: 'Permissions granted (OAuth)',
  scp: 'Permissions granted (OAuth)',
  client_id: 'Client that requested the token',
  roles: 'Roles (custom claim)',
  groups: 'Groups (custom claim)',
  name: 'Profile: display name',
  email: 'Profile: email address',
  email_verified: 'Profile: email ownership was verified',
  at_hash: 'Hash binding the ID token to an access token',
  sid: 'Session ID at the provider',
};
const TIME_CLAIMS = new Set(['exp', 'nbf', 'iat', 'auth_time']);

function relativeTime(sec: number): string {
  const diff = sec - Date.now() / 1000;
  const abs = Math.abs(diff);
  const unit = abs < 90 ? `${Math.round(abs)} s` : abs < 5400 ? `${Math.round(abs / 60)} min` : abs < 172800 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} days`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

export type Decoded = { parts: string[]; header: Json; payload: Json } | { error: string };

export function decodeToken(raw: string): Decoded {
  const token = raw.trim().replace(/^Bearer\s+/i, '');
  if (!token) return { error: '' };
  const parts = token.split('.');
  if (parts.length === 5) return { error: 'This is an encrypted JWT (JWE, 5 parts). Only the intended recipient can decrypt it.' };
  if (parts.length !== 3) return { error: `A signed JWT has 3 dot-separated parts; this has ${parts.length}.` };
  if (parts.some((x, k) => k < 2 && !/^[A-Za-z0-9_-]+$/.test(x))) return { error: 'The header or payload isn’t Base64URL.' };
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (!header || typeof header !== 'object') return { error: 'The header doesn’t decode to JSON.' };
  if (!payload || typeof payload !== 'object') return { error: 'The payload doesn’t decode to JSON.' };
  return { parts, header, payload };
}

// ---- DOM helpers (text nodes only) ----

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function field(label: string, input: HTMLInputElement | HTMLSelectElement, hint?: string): HTMLLabelElement {
  const l = el('label', 'jl-field');
  l.append(el('span', 'jl-label', label), input);
  if (hint) l.append(el('span', 'jl-hint', hint));
  return l;
}

function text(name: string, value: string, attrs: Partial<HTMLInputElement> = {}): HTMLInputElement {
  const i = el('input');
  i.name = name;
  i.value = value;
  i.autocomplete = 'off';
  i.spellcheck = false;
  Object.assign(i, attrs);
  return i;
}

function select(name: string, options: [string, string][]): HTMLSelectElement {
  const s = el('select');
  s.name = name;
  for (const [v, t] of options) {
    const o = el('option', undefined, t);
    o.value = v;
    s.append(o);
  }
  return s;
}

const DEFAULTS = { idAud: 'orders-web-client', accessAud: 'https://api.example.com/orders' };

export function initJwtLab() {
  const host = document.querySelector<HTMLElement>('[data-jwt-lab]');
  if (!host || !globalThis.crypto?.subtle) return;
  host.replaceChildren();

  // ---- form ----
  const form = el('form', 'jl-form');
  form.noValidate = true;
  const kind = select('kind', [['id', 'ID token'], ['access', 'Access token']]);
  const alg = select('alg', [['RS256', 'RS256 (key pair)'], ['HS256', 'HS256 (shared secret)']]);
  const iss = text('iss', 'https://login.example.com');
  const sub = text('sub', '00u8f2k1q9ZxP4');
  const aud = text('aud', DEFAULTS.idAud);
  const name = text('name', 'Ada Lovelace');
  const scope = text('scope', 'openid profile orders:read');
  const roles = text('roles', 'reader');
  const minutes = text('minutes', '15', { type: 'number', inputMode: 'numeric' } as Partial<HTMLInputElement>);
  const secret = text('secret', randomId(32));
  const audField = field('Audience (aud)', aud, 'Who the token is for. ID token: the app’s client ID. Access token: the API.');
  const idOnly = el('div', 'jl-grid');
  idOnly.append(field('Name (name)', name, 'A profile claim from the openid profile scope.'));
  const accessOnly = el('div', 'jl-grid');
  accessOnly.append(
    field('Scopes (scope)', scope, 'Space-separated permissions the user consented to.'),
    field('Roles (roles)', roles, 'Comma-separated custom claim, set by your identity provider.'),
  );
  const secretField = field('Shared secret (HS256)', secret, 'Anyone holding this can mint tokens, so verifiers must keep it as safe as the issuer.');
  const grid = el('div', 'jl-grid');
  grid.append(
    field('Token type', kind, 'ID token: who signed in (OIDC). Access token: what the caller may do (OAuth).'),
    field('Signing algorithm', alg, 'OIDC providers sign with a private key (RS256/ES256); anyone can verify with the public key.'),
    field('Issuer (iss)', iss, 'The identity provider’s URL. Verifiers match it exactly.'),
    field('Subject (sub)', sub, 'A stable, opaque user ID. Never reassigned.'),
    audField,
    field('Expires in minutes (exp)', minutes, 'Try a negative number to mint an already-expired token.'),
  );
  const actions = el('div', 'jl-actions');
  const generate = el('button', 'btn btn-primary', 'Generate signed JWT');
  generate.type = 'submit';
  actions.append(generate);
  form.append(grid, idOnly, accessOnly, secretField, actions);

  // ---- output ----
  const out = el('div', 'jl-out');
  out.hidden = true;
  const tokenBox = el('p', 'jl-token mono');
  tokenBox.setAttribute('aria-label', 'Encoded JWT');
  const copy = el('button', 'btn', 'Copy token');
  copy.type = 'button';
  const open = el('a', 'btn', 'Open jwt.io ↗');
  open.href = 'https://jwt.io/';
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  const tamper = el('button', 'btn', 'Tamper: edit the payload without re-signing');
  tamper.type = 'button';
  const toDecoder = el('button', 'btn', 'Send to decoder ↓');
  toDecoder.type = 'button';
  const tokenActions = el('div', 'jl-actions');
  tokenActions.append(copy, toDecoder, tamper, open);
  const status = el('p', 'jl-status mono');
  status.setAttribute('role', 'status');
  const headerPre = el('pre', 'jl-json');
  const payloadPre = el('pre', 'jl-json');
  const decoded = el('div', 'jl-decoded');
  const hBox = el('div');
  hBox.append(el('h4', 'jl-h head', 'Header'), headerPre);
  const pBox = el('div');
  pBox.append(el('h4', 'jl-h pay', 'Payload (claims)'), payloadPre);
  decoded.append(hBox, pBox);
  const keyTitle = el('h4', 'jl-h sig');
  const keyHelp = el('p', 'jl-hint');
  const keyPre = el('pre', 'jl-json');
  const jwksTitle = el('h4', 'jl-h', 'JWKS: how the provider publishes that key');
  const jwksPre = el('pre', 'jl-json');
  const checksTitle = el('h4', 'jl-h', 'What a resource server checks before trusting it');
  const checks = el('ul', 'jl-checks');
  out.append(tokenBox, tokenActions, status, decoded, keyTitle, keyHelp, keyPre, jwksTitle, jwksPre, checksTitle, checks);

  // ---- decoder: paste any JWT ----
  const dz = el('section', 'jl-decoder');
  dz.setAttribute('aria-labelledby', 'jl-decoder-h');
  const dzTitle = el('h4', 'jl-h', 'Decode and verify a JWT');
  dzTitle.id = 'jl-decoder-h';
  const dzNote = el('p', 'jl-hint', 'Paste any JWT (a leading “Bearer ” is fine). It is decoded right here in your browser; nothing is sent anywhere.');
  const dzInput = el('textarea', 'jl-textarea mono');
  dzInput.rows = 4;
  dzInput.spellcheck = false;
  dzInput.setAttribute('aria-label', 'JWT to decode');
  dzInput.placeholder = 'eyJhbGciOi…';
  const dzError = el('p', 'jl-error');
  dzError.setAttribute('role', 'status');
  const dzView = el('div', 'jl-dz-view');
  const dzToken = el('p', 'jl-token mono');
  const dzHeader = el('pre', 'jl-json');
  const dzPayload = el('pre', 'jl-json');
  const dzDecoded = el('div', 'jl-decoded');
  const dh = el('div');
  dh.append(el('h4', 'jl-h head', 'Header'), dzHeader);
  const dp = el('div');
  dp.append(el('h4', 'jl-h pay', 'Payload'), dzPayload);
  dzDecoded.append(dh, dp);
  const dzClaimsWrap = el('div', 'jl-table-wrap');
  const dzClaims = el('table', 'jl-claims');
  dzClaimsWrap.append(dzClaims);
  const dzTime = el('p', 'jl-status mono');
  const dzKeyLabel = el('label', 'jl-field');
  const dzKey = el('textarea', 'jl-textarea mono');
  dzKey.rows = 3;
  dzKey.spellcheck = false;
  dzKey.placeholder = '-----BEGIN PUBLIC KEY----- …   or   {"keys":[…]}   or a shared secret';
  dzKeyLabel.append(el('span', 'jl-label sig', 'Verify signature (optional)'), dzKey,
    el('span', 'jl-hint', 'Public key as PEM, a JWK, or the provider’s whole JWKS (the key is picked by kid). For HS256, the shared secret.'));
  const dzSig = el('p', 'jl-status mono');
  dzSig.setAttribute('role', 'status');
  dzView.append(dzToken, dzDecoded, el('h4', 'jl-h', 'Claims'), dzClaimsWrap, dzTime, dzKeyLabel, dzSig);
  dz.append(dzTitle, dzNote, dzInput, dzError, dzView);

  let decodeSeq = 0;
  async function runDecoder() {
    const seq = ++decodeSeq;
    const d = decodeToken(dzInput.value);
    if ('error' in d) {
      dzView.hidden = true;
      dzError.textContent = d.error;
      dzError.hidden = !d.error;
      return;
    }
    dzError.hidden = true;
    dzView.hidden = false;
    const [h, pl, sg] = d.parts;
    dzToken.replaceChildren(el('span', 'head', h), '.', el('span', 'pay', pl), '.', el('span', 'sig', sg || '(no signature)'));
    dzHeader.textContent = JSON.stringify(d.header, null, 2);
    dzPayload.textContent = JSON.stringify(d.payload, null, 2);

    const head = el('tr');
    head.append(el('th', undefined, 'Claim'), el('th', undefined, 'Value'), el('th', undefined, 'Meaning'));
    const rows = Object.entries(d.payload).map(([k, v]) => {
      const tr = el('tr');
      let shown = typeof v === 'string' ? v : JSON.stringify(v);
      if (TIME_CLAIMS.has(k) && typeof v === 'number') shown = `${v} · ${new Date(v * 1000).toISOString().replace('.000Z', 'Z')} (${relativeTime(v)})`;
      tr.append(el('td', 'mono', k), el('td', 'mono', shown), el('td', undefined, CLAIM_INFO[k] ?? 'Custom claim'));
      return tr;
    });
    dzClaims.replaceChildren(head, ...rows);

    const now = Date.now() / 1000;
    const { exp, nbf } = d.payload as { exp?: unknown; nbf?: unknown };
    if (typeof exp !== 'number') {
      dzTime.dataset.state = 'warn';
      dzTime.textContent = 'No exp claim: this token never expires. APIs should reject that.';
    } else if (exp <= now) {
      dzTime.dataset.state = 'bad';
      dzTime.textContent = `Expired ${relativeTime(exp)}.`;
    } else if (typeof nbf === 'number' && nbf > now) {
      dzTime.dataset.state = 'bad';
      dzTime.textContent = `Not valid yet: usable ${relativeTime(nbf)}.`;
    } else {
      dzTime.dataset.state = 'ok';
      dzTime.textContent = `Within its lifetime: expires ${relativeTime(exp)}.`;
    }

    const alg = String(d.header.alg ?? '');
    const imported = await importVerifyKey(dzKey.value, alg, typeof d.header.kid === 'string' ? d.header.kid : undefined);
    if (seq !== decodeSeq) return; // a newer edit is already being decoded
    if ('error' in imported) {
      dzSig.dataset.state = alg === 'none' ? 'bad' : dzKey.value.trim() ? 'bad' : '';
      dzSig.textContent = imported.error;
      return;
    }
    const ok = await verifyWith(dzInput.value.trim().replace(/^Bearer\s+/i, ''), alg, imported.key);
    if (seq !== decodeSeq) return;
    dzSig.dataset.state = ok ? 'ok' : 'bad';
    dzSig.textContent = ok
      ? `Signature verified (${alg}, ${imported.source}). Nobody changed this token since it was signed.`
      : `Invalid signature (${alg}, ${imported.source}): the token was altered, or this isn't the signer's key.`;
  }
  dzInput.addEventListener('input', runDecoder);
  dzKey.addEventListener('input', runDecoder);
  dzView.hidden = true;
  dzError.hidden = true;

  host.append(form, out, dz);

  // ---- state ----
  let keys: Keys | null = null;
  let current = '';
  let expected = { iss: '', aud: '' };

  const syncVisibility = () => {
    const isId = kind.value === 'id';
    idOnly.hidden = !isId;
    accessOnly.hidden = isId;
    secretField.hidden = alg.value !== 'HS256';
  };
  kind.addEventListener('change', () => {
    if (aud.value === DEFAULTS.idAud || aud.value === DEFAULTS.accessAud) {
      aud.value = kind.value === 'id' ? DEFAULTS.idAud : DEFAULTS.accessAud;
    }
    syncVisibility();
  });
  alg.addEventListener('change', syncVisibility);
  syncVisibility();

  function renderToken(token: string) {
    const [h, p, s] = token.split('.');
    tokenBox.replaceChildren(el('span', 'head', h), '.', el('span', 'pay', p), '.', el('span', 'sig', s));
    headerPre.textContent = JSON.stringify(decodePart(h), null, 2);
    payloadPre.textContent = JSON.stringify(decodePart(p), null, 2);
  }

  async function renderChecks(token: string) {
    const [h, p] = token.split('.');
    const header = decodePart(h) ?? {};
    const claims = decodePart(p) ?? {};
    const now = Math.floor(Date.now() / 1000);
    const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const sigOk = keys ? await verifyJwt(token, keys) : false;
    const rows: [boolean, string][] = [
      [header.alg === keys?.alg, `alg is on the allowlist (${String(header.alg)}), never "none"`],
      [sigOk, sigOk ? 'Signature verifies with the issuer’s key' : 'Signature does NOT verify: the token was changed after signing'],
      [claims.iss === expected.iss, `iss is exactly ${expected.iss}`],
      [audList.includes(expected.aud), `aud contains ${expected.aud}`],
      [typeof claims.exp === 'number' && claims.exp > now, typeof claims.exp === 'number' && claims.exp > now ? `exp is in the future (${Math.round((claims.exp - now) / 60)} min left)` : 'exp has passed: the token is expired'],
    ];
    if (kind.value === 'id') rows.push([typeof claims.nonce === 'string', 'nonce is present (the app compares it with the one it sent, which stops replayed ID tokens)']);
    checks.replaceChildren(...rows.map(([ok, label]) => {
      const li = el('li', ok ? 'ok' : 'bad');
      li.append(el('span', 'mark', ok ? '✓' : '✗'), label);
      return li;
    }));
    const valid = rows.every(([ok]) => ok);
    status.dataset.state = valid ? 'ok' : 'bad';
    status.textContent = valid ? 'Valid: an API would accept this token.' : 'Rejected: an API must refuse this token.';
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    generate.disabled = true;
    try {
      const a = alg.value as Alg;
      if (a === 'RS256' && (!keys || keys.alg !== 'RS256')) {
        const rsa = (await crypto.subtle.generateKey(
          { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
          true,
          ['sign', 'verify'],
        )) as CryptoKeyPair;
        keys = { alg: a, secret: '', rsa, kid: randomId(8) };
      } else if (a === 'HS256') {
        keys = { alg: a, secret: secret.value || randomId(32), kid: 'shared-secret' };
        secret.value = keys.secret;
      }
      const k = keys!;
      const now = Math.floor(Date.now() / 1000);
      const mins = Number.parseInt(minutes.value, 10);
      const isId = (kind.value as Kind) === 'id';
      const header: Json = { alg: k.alg, typ: isId ? 'JWT' : 'at+jwt', kid: k.kid };
      const payload: Json = {
        iss: iss.value.trim(),
        sub: sub.value.trim(),
        aud: aud.value.trim(),
        iat: now,
        exp: now + (Number.isFinite(mins) ? mins : 15) * 60,
        jti: randomId(12),
      };
      if (isId) {
        Object.assign(payload, { auth_time: now - 5, nonce: randomId(12), name: name.value.trim() });
      } else {
        Object.assign(payload, {
          client_id: DEFAULTS.idAud,
          scope: scope.value.trim(),
          roles: roles.value.split(',').map((r) => r.trim()).filter(Boolean),
        });
      }
      expected = { iss: String(payload.iss), aud: String(payload.aud) };
      current = await signJwt(header, payload, k);
      renderToken(current);

      if (k.alg === 'RS256') {
        keyTitle.textContent = 'Public key (paste into jwt.io to verify the signature)';
        keyHelp.textContent = 'The private key never left this page and is gone when you reload. Anyone can verify with the public key; only the issuer can sign.';
        keyPre.textContent = pem(await crypto.subtle.exportKey('spki', k.rsa!.publicKey), 'PUBLIC KEY');
        const jwk = (await crypto.subtle.exportKey('jwk', k.rsa!.publicKey)) as JsonWebKey;
        jwksPre.textContent = JSON.stringify({ keys: [{ kty: jwk.kty, use: 'sig', alg: 'RS256', kid: k.kid, n: jwk.n, e: jwk.e }] }, null, 2);
        jwksTitle.hidden = jwksPre.hidden = false;
      } else {
        keyTitle.textContent = 'Shared secret (paste into jwt.io to verify the signature)';
        keyHelp.textContent = 'With HS256 the same secret signs and verifies, so every verifier could also mint tokens. That is why OIDC providers sign with RS256 or ES256.';
        keyPre.textContent = k.secret;
        jwksTitle.hidden = jwksPre.hidden = true;
      }
      out.hidden = false;
      await renderChecks(current);
    } finally {
      generate.disabled = false;
    }
  });

  toDecoder.addEventListener('click', () => {
    dzInput.value = current;
    dzKey.value = keyPre.textContent ?? '';
    runDecoder();
    dz.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(current);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Select and copy the token above';
    }
    setTimeout(() => (copy.textContent = 'Copy token'), 2000);
  });

  tamper.addEventListener('click', async () => {
    const [h, p, s] = current.split('.');
    const claims = decodePart(p);
    if (!claims) return;
    if (kind.value === 'id') claims.sub = 'someone-else';
    else claims.roles = ['admin'];
    current = `${h}.${b64json(claims)}.${s}`;
    renderToken(current);
    await renderChecks(current);
  });
}
