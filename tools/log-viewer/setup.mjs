// One-time local setup: an admin user (scrypt password + TOTP secret), the provider's RS256 signing key
// and the app's client secret. Everything lands in .local/ (git-ignored, mode 0600).
//   node setup.mjs            create .local/config.json (refuses to overwrite)
//   node setup.mjs --reset    start over
//   node setup.mjs --code     print the current TOTP code (local testing only)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { base32Encode, hashPassword, randomToken, totp } from './lib/crypto.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.local');
const file = process.env.LV_CONFIG || path.join(dir, 'config.json');

if (process.argv.includes('--code')) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(totp(cfg.user.totpSecret));
  process.exit(0);
}

const reset = process.argv.includes('--reset');

const username = process.env.LV_USERNAME || 'admin';
const password = process.env.LV_PASSWORD || randomToken(18);
const totpSecret = base32Encode(crypto.randomBytes(20));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const config = {
  user: { username, sub: `usr_${randomToken(9)}`, name: 'Site admin', password: hashPassword(password), totpSecret },
  signingKey: { kid: randomToken(6), pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
  client: { id: 'log-viewer', secret: randomToken(32) },
};

fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
// One step, no check-then-write gap: 'wx' fails if the file exists (refuse to overwrite), 'w' replaces it on --reset.
try {
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600, flag: reset ? 'w' : 'wx' });
} catch (err) {
  if (err.code !== 'EEXIST') throw err;
  console.error(`${file} already exists. Use --reset to create a new user, keys and secrets.`);
  process.exit(1);
}
if (reset) fs.chmodSync(file, 0o600); // an existing file keeps its old mode when replaced

const uri = `otpauth://totp/resume-site:${encodeURIComponent(username)}?secret=${totpSecret}&issuer=resume-site%20log%20viewer`;
console.log(`
Local admin created in ${file}

  username : ${username}
  password : ${process.env.LV_PASSWORD ? '(from LV_PASSWORD)' : password}
  TOTP key : ${totpSecret}

Add the TOTP key to an authenticator app (manual entry, time-based, 6 digits), or open:
  ${uri}

Save the password now; only its scrypt hash is stored.
`);
