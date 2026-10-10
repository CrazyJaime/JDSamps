// Playwright runner for tests/core-media.html.
// Usage: NODE_PATH=/opt/node22/lib/node_modules node tests/core-media.run.mjs
// (starts http-server on port $CORE_PORT, default 8101, serving the moviemaker directory)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.CORE_PORT) || 8101;

const server = spawn('npx', ['http-server', root, '-p', String(PORT), '-c-1', '--silent'], { stdio: 'ignore', detached: true });
const stop = () => { try { process.kill(-server.pid); } catch (_) { /* ignore */ } };
process.on('exit', stop);

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/tests/core-media.html`);
      if (r.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('http-server did not start');
}

let code = 1;
try {
  await waitForServer();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/tests/core-media.html`);
  await page.waitForFunction(() => window.__harnessReady === true);
  const summary = await page.evaluate(() => window.runCoreTests());
  for (const r of summary.results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} - ${r.name}${r.ok ? ` (${r.ms}ms)` : `\n       ${r.error.split('\n').slice(0, 3).join('\n       ')}`}`);
  }

  // Real user-gesture file picking through the native chooser.
  let pickOk = false;
  try {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#pick')]);
    if (!chooser.isMultiple()) throw new Error('chooser should allow multiple files');
    await chooser.setFiles([path.join(root, 'tests/fixtures/clip1.webm'), path.join(root, 'tests/fixtures/photo1.jpg')]);
    await page.waitForFunction(() => Array.isArray(window.__pickImported), null, { timeout: 30000 });
    const picked = await page.evaluate(() => ({ picked: window.__picked, imported: window.__pickImported }));
    pickOk = picked.picked.length === 2 && picked.imported.length === 2 && picked.imported[0].type === 'video';
    console.log(`${pickOk ? 'ok  ' : 'FAIL'} - pickFiles via native chooser: ${JSON.stringify(picked)}`);
  } catch (err) {
    console.log(`FAIL - pickFiles via native chooser: ${err.message}`);
  }
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || os.tmpdir(), 'core-media.png'), fullPage: true }).catch(() => {});
  if (consoleErrors.length) console.log('console errors:\n  ' + consoleErrors.join('\n  '));
  console.log(`\n${summary.passed + (pickOk ? 1 : 0)} passed, ${summary.failed + (pickOk ? 0 : 1)} failed`);
  code = summary.failed === 0 && pickOk ? 0 : 1;
  await browser.close();
} catch (err) {
  console.error(err);
} finally {
  stop();
  process.exit(code);
}
