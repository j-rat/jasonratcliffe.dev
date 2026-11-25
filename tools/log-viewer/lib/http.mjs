// Tiny HTTP helpers: security headers on every response, cookies, form bodies, HTML escaping.
import fs from 'node:fs';
import path from 'node:path';

export const CSP = (formAction = "'self'") => [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", `form-action ${formAction}`, "frame-ancestors 'none'",
].join('; ');

export function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': extra.csp ?? CSP(),
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'csp')),
  });
  res.end(body);
}

export const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json', extra);
export const redirect = (res, location, extra = {}) => send(res, 302, '', 'text/plain', { Location: location, ...extra });

/**
 * Cookie header -> { name: value }. The result has no prototype, so a cookie named `__proto__` or
 * `constructor` is just a key; values that aren't valid percent-encoding are skipped instead of throwing.
 */
export function parseCookies(req) {
  const out = Object.create(null);
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // malformed %-encoding: ignore this cookie
    }
  }
  return out;
}

/** Local prototype: no `Secure` (plain http://localhost). Production sets Secure and the __Host- prefix. */
export const cookie = (name, value, { maxAge, sameSite = 'Strict' } = {}) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}${maxAge !== undefined ? `; Max-Age=${maxAge}` : ''}`;

export function readBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const readForm = async (req) => Object.fromEntries(new URLSearchParams(await readBody(req)));

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

export function serveFile(res, file, extra) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, TYPES[path.extname(file)] ?? 'application/octet-stream', extra);
  });
}

/** One JSON line per security-relevant event, like the site's Lambdas. Never logs passwords, codes or tokens. */
export const audit = (event, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
