#!/usr/bin/env node
// Fails (exit 1) if personal contact details or AWS identifiers leak into the
// built site, the PDF, or files tracked in git.
//
// Known personal values are matched by salted SHA-256 so the values themselves
// never live in this repo. Generic patterns catch anything new.
//
// Usage: node scripts/pii-scan.mjs [--dist-only | --repo-only]

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const SITE = resolve(here, '..');
const REPO = resolve(SITE, '..');
const DIST = join(SITE, 'dist');

const SALT = 'resume-pii:';
const DENY_HASHES = new Set([
  '74e674534c6e69b7cd097773f559c2512faee55f77d6f2ce0c2afc3fe3666adf', // phone (digits only)
  '943c91c3c311b88893f3f1a1f9c670259de54744a51fa7e2abec4348156a30e1', // ZIP
  '4f278e66ed3f36efc6554c8b14ce80b812a1e423836eb2ea393aac1e27deaf16', // personal email
  'c87508f375ed50dd2a82fcd67f873771f70a32a6cd2363041d8abb6592ba43aa', // personal email local part
]);
const sha = (v) => createHash('sha256').update(SALT + v).digest('hex');

// Addresses that are fine to appear in the repo (never in the built site):
// a couple of fixed tool addresses, and RFC 2606/6761 reserved test domains.
const REPO_EMAIL_ALLOW = new Set(['git@github.com', 'noreply@anthropic.com']);
const RESERVED_DOMAIN = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|example|invalid))$/;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?<![\w.])\(?\d{3}\)?[ \t]*[-.– ][ \t]*\d{3}[ \t]*[-.– ][ \t]*\d{4}(?![\w])/g;
const ACCOUNT_ID = /(?<![\w.-])\d{12}(?![\w.-])/g;
const ARN = /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/g;
const STREET = /\b\d{2,6}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Ct|Court|Way|Trail|Pkwy)\b/g;

const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.cjs', '.ts', '.astro', '.css', '.json', '.xml', '.txt', '.md', '.tf', '.hcl', '.py', '.yml', '.yaml', '.sh', '.svg', '.toml', '']);
const SKIP_REPO = [/^site\/node_modules\//, /^site\/dist\//, /\.terraform\//, /package-lock\.json$/, /\.docx$/i, /^spec\//];

const findings = [];
const report = (file, kind, sample) => findings.push({ file, kind, sample: String(sample).slice(0, 60) });

function scanText(file, text, { dist }) {
  for (const m of text.matchAll(EMAIL)) {
    const e = m[0].toLowerCase();
    if (DENY_HASHES.has(sha(e)) || DENY_HASHES.has(sha(e.split('@')[0]))) report(file, 'known personal email', redact(e));
    else if (dist || !(REPO_EMAIL_ALLOW.has(e) || RESERVED_DOMAIN.test(e))) report(file, 'email address', redact(e));
  }
  for (const m of text.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, '');
    report(file, DENY_HASHES.has(sha(digits)) ? 'known personal phone' : 'phone-like number', redact(m[0]));
  }
  for (const m of text.matchAll(/\b\d{5}\b/g)) {
    if (DENY_HASHES.has(sha(m[0]))) report(file, 'known personal ZIP', '*****');
  }
  for (const m of text.matchAll(STREET)) report(file, 'street address', redact(m[0]));
  for (const m of text.matchAll(ARN)) report(file, 'ARN with account ID', m[0].replace(/\d{12}/, '************'));
  if (dist) for (const m of text.matchAll(ACCOUNT_ID)) report(file, '12-digit number (AWS account ID?)', '************');
}

function redact(s) {
  return s.length <= 4 ? '****' : `${s.slice(0, 2)}…${s.slice(-2)}`;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

async function pdfText(path) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

async function scanDist() {
  if (!existsSync(DIST)) {
    console.error('pii-scan: site/dist does not exist – run the build first.');
    process.exit(2);
  }
  let pdfSeen = false;
  for (const f of walk(DIST)) {
    const rel = relative(REPO, f);
    const ext = extname(f).toLowerCase();
    if (ext === '.pdf') {
      pdfSeen = true;
      scanText(rel, await pdfText(f), { dist: true });
    } else if (TEXT_EXT.has(ext)) {
      scanText(rel, readFileSync(f, 'utf8'), { dist: true });
    }
  }
  if (!pdfSeen) report('site/dist', 'missing resume.pdf', 'run npm run pdf');
}

function scanRepo() {
  let files;
  try {
    // Tracked + untracked-but-not-ignored: exactly what a commit could include.
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {
    files = walk(REPO).map((f) => relative(REPO, f)).filter((f) => !f.startsWith('.git/'));
  }
  for (const rel of files) {
    if (SKIP_REPO.some((r) => r.test(rel))) continue;
    if (/\.docx$/i.test(rel)) continue;
    const abs = join(REPO, rel);
    if (!existsSync(abs) || !TEXT_EXT.has(extname(rel).toLowerCase())) continue;
    scanText(rel, readFileSync(abs, 'utf8'), { dist: false });
  }
  // The source resume must never be committable.
  const docx = files.filter((f) => /\.docx$/i.test(f));
  docx.forEach((f) => report(f, 'resume source document is not git-ignored', f));
}

const mode = process.argv[2];
if (mode !== '--repo-only') await scanDist();
if (mode !== '--dist-only') scanRepo();

if (findings.length) {
  console.error(`pii-scan: ${findings.length} finding(s)`);
  for (const f of findings) console.error(`  ✗ ${f.kind.padEnd(36)} ${f.file}  [${f.sample}]`);
  process.exit(1);
}
console.log(`pii-scan: clean (${mode ?? 'dist + repo'})`);
