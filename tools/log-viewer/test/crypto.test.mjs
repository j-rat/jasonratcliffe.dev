import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { checkPassword, checkTotp, hashPassword, publicJwk, signJwt, totp, verifyJwt } from '../lib/crypto.mjs';

const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const jwks = { keys: [publicJwk(pem, 'k1')] };
const now = Math.floor(Date.now() / 1000);
const opts = { jwks, issuer: 'https://op.test', audience: 'api' };
const good = { iss: 'https://op.test', aud: 'api', sub: 'u1', exp: now + 600 };
const mint = (claims = {}, header = {}) => signJwt({ alg: 'RS256', kid: 'k1', ...header }, { ...good, ...claims }, pem);

test('accepts a valid token', () => assert.equal(verifyJwt(mint(), opts).sub, 'u1'));

test('rejects tampering, wrong issuer/audience, expiry, unknown kid and alg tricks', () => {
  const [h, , s] = mint().split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...good, sub: 'admin' })).toString('base64url')}.${s}`;
  const none = `${Buffer.from('{"alg":"none","kid":"k1"}').toString('base64url')}.${Buffer.from(JSON.stringify(good)).toString('base64url')}.`;
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  for (const [token, reason] of [
    [forged, /signature/], [mint({ iss: 'https://evil.test' }), /issuer/], [mint({ aud: 'other' }), /audience/],
    [mint({ exp: now - 600 }), /expired/], [mint({}, { kid: 'nope' }), /kid/], [none, /alg/],
    [signJwt({ alg: 'RS256', kid: 'k1' }, good, other), /signature/], [mint({}, { alg: 'HS256' }), /alg/], ['a.b', /malformed/],
  ]) assert.throws(() => verifyJwt(token, opts), reason);
});

test('enforces the token type when asked', () => {
  assert.throws(() => verifyJwt(mint({}, { typ: 'JWT' }), { ...opts, typ: 'at+jwt' }), /type/);
  assert.equal(verifyJwt(mint({}, { typ: 'at+jwt' }), { ...opts, typ: 'at+jwt' }).sub, 'u1');
});

test('TOTP matches the RFC 6238 SHA-1 test vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) {
    assert.equal(totp(secret, Math.floor(t / 30)), code);
  }
  assert.notEqual(checkTotp(secret, totp(secret)), null);
  assert.equal(checkTotp(secret, '123456', 59_000) === null, totp(secret, 1) !== '123456' && totp(secret, 0) !== '123456' && totp(secret, 2) !== '123456');
});

test('passwords are salted scrypt hashes', () => {
  const stored = hashPassword('correct horse');
  assert.ok(checkPassword('correct horse', stored));
  assert.ok(!checkPassword('wrong', stored));
  assert.notEqual(hashPassword('correct horse').hash, stored.hash);
});
