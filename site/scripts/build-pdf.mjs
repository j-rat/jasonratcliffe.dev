#!/usr/bin/env node
// Renders dist/resume/index.html to dist/resume.pdf with headless Chromium.
// Serves dist over a throwaway local HTTP server so absolute /_astro/ asset paths resolve.

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const OUT = join(DIST, 'resume.pdf');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

if (!existsSync(join(DIST, 'resume', 'index.html'))) {
  console.error('build-pdf: dist/resume/index.html not found – run astro build first.');
  process.exit(2);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!p.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/resume/`, { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: OUT,
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: true,
    tagged: true,
    outline: true,
  });
  console.log(`build-pdf: wrote ${OUT}`);
} finally {
  await browser.close();
  server.close();
}
