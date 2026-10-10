// Headless Chromium check of the rendering engine (B-render modules).
// Usage: start `npx http-server /home/user/JDSamps/moviemaker -p 8102 -c-1 --silent` then
//   NODE_PATH=/opt/node22/lib/node_modules node tests/render.test.mjs [outDir]
// Renders tests/render.html with ctx.filter on, forced off, and forced off without
// OffscreenCanvas (iOS Safari-like); saves full-page screenshots,
// fails on page errors / console errors.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright'); // resolved through NODE_PATH

const outDir = process.argv[2] || path.join(os.tmpdir(), 'moviemaker-render');
fs.mkdirSync(outDir, { recursive: true });
const base = process.env.BASE_URL || 'http://127.0.0.1:8102';

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failures = 0;
for (const [name, query] of [['filter', ''], ['nofilter', '?nofilter=1'], ['legacy', '?legacy=1']]) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (m) => {
    // The harness itself reads pixels back from GPU canvases (perf flush + assertions).
    if (m.type() === 'warning' && m.text().includes('willReadFrequently')) return;
    if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.type() + ': ' + m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  await page.goto(base + '/tests/render.html' + query);
  await page.waitForFunction(() => window.__done === true, null, { timeout: 60000 });
  const result = await page.evaluate(() => window.__result);
  const file = path.join(outDir, 'render-' + name + '.png');
  await page.screenshot({ path: file, fullPage: true });
  console.log('[' + name + '] ctx.filter=' + result.filter + ' assertions=' + result.checks + ' screenshot=' + file);
  console.log('  timings', JSON.stringify(result.timings));
  if (result.errors && result.errors.length) { failures++; console.log('  page errors:', result.errors); }
  if (consoleErrors.length) { failures++; console.log('  console:', consoleErrors); }
  await page.close();
}
await browser.close();
console.log(failures ? 'FAIL (' + failures + ')' : 'PASS');
process.exit(failures ? 1 : 0);
