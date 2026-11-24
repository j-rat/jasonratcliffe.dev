// JWT (RS256), TOTP (RFC 6238) and password hashing with node:crypto only: no third-party crypto code.
import crypto from 'node:crypto';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// ---- JWT ----

export function signJwt(header, payload, privateKeyPem) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), privateKeyPem);
  return `${input}.${b64url(sig)}`;
}

/**
 * Verify a JWT the way a resource server must: pinned algorithm, key chosen by our own JWKS (never by
 * the token), then iss / aud / exp / nbf. Throws with a short reason on any failure.
 */
export function verifyJwt(token, { jwks, issuer, audience, typ, now = Date.now() / 1000, skew = 60 }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed');
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch {
    throw new Error('malformed');
  }
  if (header.alg !== 'RS256') throw new Error('alg not allowed');
  if (typ && header.typ !== typ) throw new Error('wrong token type');
  const jwk = jwks.keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw new Error('unknown kid');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad signature');
  if (payload.iss !== issuer) throw new Error('wrong issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw new Error('wrong audience');
  if (typeof payload.exp !== 'number' || payload.exp < now - skew) throw new Error('expired');
  if (typeof payload.nbf === 'number' && payload.nbf > now + skew) throw new Error('not yet valid');
  return payload;
}

export function publicJwk(privateKeyPem, kid) {
  const { kty, n, e } = crypto.createPublicKey(privateKeyPem).export({ format: 'jwk' });
  return { kty, n, e, kid, use: 'sig', alg: 'RS256' };
}

// ---- passwords ----

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: b64url(salt), hash: b64url(hash) };
}

export function checkPassword(password, stored) {
  const { hash } = hashPassword(String(password), Buffer.from(stored.salt, 'base64url'));
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(stored.hash));
}

export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---- TOTP (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits) ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretB32, step = Math.floor(Date.now() / 30000)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Accept the current code or one step either side (clock drift); return the matched step to stop reuse. */
export function checkTotp(secretB32, code, now = Date.now()) {
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) if (s >= 0 && safeEqual(totp(secretB32, s), String(code).trim())) return s;
  return null;
}
