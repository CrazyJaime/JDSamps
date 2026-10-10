// Phone-usability regression checks found in the phone review (Playwright Chromium, touch emulation).
// Each check prints PASS/FAIL; exit code 1 if any check fails.
//
//   NODE_PATH=/opt/node22/lib/node_modules node tests/phone-review.run.mjs
//   BASE_URL=http://127.0.0.1:8121/ ... (use an already running server; otherwise one is started on $PORT or 8121)
//
// Checks:
//  1. history: app menu › Help › OK (and › Open project › Close) keeps the user on index.html
//  2. history: Back with a ribbon gallery sheet open closes the sheet and stays in the app
//  3. landscape in-browser viewports (667×325, 732×304): Play button fully on screen
//  4. portrait in-browser viewports (375×553, 320×460): filmstrip, music and caption lanes visible
//  5. long-press popover › Remove right after an import removes only the pressed clip
//  6. a "hesitant" swipe (finger rests 380 ms, then moves) on a clip scrolls the strip instead of reordering

import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIX = join(HERE, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = (devices['iPhone 13'] && devices['iPhone 13'].userAgent) || 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';
const phone = (w, h) => ({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: UA });

let server = null;
async function base() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/?$/, '/');
  const port = process.env.PORT || '8121';
  const url = `http://127.0.0.1:${port}/`;
  try { if ((await fetch(`${url}js/app.js`)).ok) return url; } catch (_) { /* start one */ }
  const bin = existsSync('/opt/node22/bin/http-server') ? '/opt/node22/bin/http-server' : 'http-server';
  server = spawn(bin, [ROOT, '-p', port, '-a', '127.0.0.1', '-c-1', '-s'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${url}js/app.js`)).ok) return url; } catch (_) { /* wait */ } await sleep(100); }
  throw new Error('http-server did not start');
}

const results = [];
const record = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function boot(page, BASE, { from = true } = {}) {
  if (from) await page.goto(`${BASE}tests/app-test.html`).catch(() => {}); // a page the user "came from"
  await page.goto(`${BASE}index.html`);
  await page.waitForFunction(() => window.app && window.app.store && document.querySelector('#ribbon .rb-tab'), null, { timeout: 15000 });
  await page.waitForSelector('#boot-splash', { state: 'detached', timeout: 15000 });
  await sleep(400);
}
async function importVia(page, files) {
  const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#storyboard-pane .sb-empty-btn').tap()]);
  await ch.setFiles(files.map((f) => join(FIX, f)));
  await page.waitForFunction((n) => window.app.store.project.items.length === n, files.length, { timeout: 30000 });
  await sleep(600);
}
async function touch(page) {
  const cdp = await page.context().newCDPSession(page);
  return async (pts, holdMs = 0, stepMs = 18) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1], id: 1 }] });
    if (holdMs) await sleep(holdMs);
    for (const [x, y] of pts.slice(1)) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] }); await sleep(stepMs); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
}
const lerp = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);

async function run() {
  const BASE = await base();
  const browser = await chromium.launch();
  const fresh = async (opts) => { const ctx = await browser.newContext(opts); return { ctx, page: await ctx.newPage() }; };

  // 1. app menu dialogs must not navigate away
  for (const item of ['Help', 'Open project']) {
    const { ctx, page } = await fresh(phone(390, 664));
    await boot(page, BASE);
    await page.locator('#app-menu-btn').tap(); await sleep(400);
    await page.locator(`.app-menu button:has-text("${item}")`).first().tap(); await sleep(700);
    const close = page.locator('#dialog-root .dlg-buttons button:has-text("OK"), #dialog-root .dlg-buttons button:has-text("Close")').last();
    await close.tap().catch(() => {}); await sleep(1200);
    record(`app menu › ${item} › close keeps the app open`, page.url().endsWith('index.html'), `url ${page.url().replace(BASE, '')}`);
    await ctx.close();
  }

  // 2. Back closes a ribbon gallery sheet
  {
    const { ctx, page } = await fresh(phone(390, 664));
    await boot(page, BASE);
    await importVia(page, ['photo1.jpg', 'photo2.png']);
    await page.locator('#storyboard-pane [data-sb="item"]').nth(1).tap(); await sleep(200);
    const tab = page.locator('#ribbon .rb-tab[data-tab="animations"]'); await tab.scrollIntoViewIfNeeded(); await tab.tap(); await sleep(200);
    await page.locator('#ribbon .rb-panel[data-tab="animations"] .rb-gal-launch[aria-label="Transitions"]').tap(); await sleep(500);
    await page.goBack({ timeout: 3000 }).catch(() => {}); await sleep(800);
    const stayed = page.url().endsWith('index.html');
    const open = stayed ? await page.evaluate(() => !!document.querySelector('.rb-sheet')) : null;
    record('Back with a gallery sheet open closes it and stays in the app', stayed && open === false, `url ${page.url().replace(BASE, '')}, sheet open ${open}`);
    await ctx.close();
  }

  // 3. landscape: Play reachable
  for (const [w, h] of [[667, 325], [732, 304]]) {
    const { ctx, page } = await fresh(phone(w, h));
    await boot(page, BASE, { from: false });
    const r = await page.evaluate(() => { const b = document.querySelector('#preview-pane .pv-play').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, ih: innerHeight }; });
    record(`landscape ${w}×${h}: Play button fully visible`, r.bottom <= r.ih + 0.5, `play ${Math.round(r.top)}..${Math.round(r.bottom)}, viewport ${r.ih}`);
    await ctx.close();
  }

  // 4. portrait in-browser: strip + lanes visible
  for (const [w, h] of [[375, 553], [320, 460]]) {
    const { ctx, page } = await fresh(phone(w, h));
    await boot(page, BASE, { from: false });
    await importVia(page, ['clip1.webm', 'photo1.jpg']);
    const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => { window.app.commands.run('addMusic'); })]);
    await ch.setFiles([join(FIX, 'music.ogg')]);
    await page.waitForFunction(() => window.app.store.project.music.length === 1, null, { timeout: 20000 });
    await page.evaluate(() => window.app.player.seek(1)); await sleep(200);
    await page.evaluate(() => { window.app.commands.run('addCaption'); }); await sleep(300); await page.keyboard.press('Escape');
    await page.evaluate(() => window.app.player.seek(1)); await sleep(600);
    const r = await page.evaluate(() => {
      const pane = document.getElementById('storyboard-pane').getBoundingClientRect();
      const vis = (s) => { const e = document.querySelector(`#storyboard-pane ${s}`); if (!e) return false; const b = e.getBoundingClientRect(); return b.top >= pane.top - 0.5 && b.bottom <= pane.bottom + 0.5; };
      return { pane: Math.round(pane.height), item: vis('[data-sb="item"]'), music: vis('[data-sb="music"]'), text: vis('[data-sb="text"]') };
    });
    record(`portrait ${w}×${h}: filmstrip, music and caption visible`, r.item && r.music && r.text, JSON.stringify(r));
    await ctx.close();
  }

  // 5. popover Remove acts on the pressed clip only
  {
    const { ctx, page } = await fresh(phone(390, 844));
    await boot(page, BASE, { from: false });
    await importVia(page, ['clip1.webm', 'photo1.jpg', 'portrait.webm']);
    const drag = await touch(page);
    const b = await page.locator('#storyboard-pane [data-sb="item"]').nth(1).boundingBox();
    const x = Math.min(b.x + 40, 370), y = b.y + b.height / 2;
    await drag([[x, y], [x, y]], 650); await sleep(400);
    await page.locator('.sb-pop button:has-text("Remove")').tap(); await sleep(500);
    const kinds = await page.evaluate(() => window.app.store.project.items.map((i) => i.kind).join(','));
    record('popover › Remove after import removes only the pressed clip', kinds === 'video,video', `items left: [${kinds}]`);
    await ctx.close();
  }

  // 6. hesitant swipe scrolls instead of reordering
  {
    const { ctx, page } = await fresh(phone(390, 844));
    await boot(page, BASE, { from: false });
    await importVia(page, ['clip1.webm', 'photo1.jpg', 'photo2.png', 'portrait.webm']);
    await page.evaluate(() => { document.querySelector('#storyboard-pane .sb-scroll').scrollLeft = 300; }); await sleep(500);
    const before = await page.evaluate(() => window.app.store.project.items.map((i) => i.id).join(','));
    const b = await page.locator('#storyboard-pane [data-sb="item"]').nth(2).boundingBox();
    const x0 = Math.max(b.x + 20, 40), y = b.y + b.height / 2;
    const drag = await touch(page);
    await drag(lerp([x0, y], [x0 + 220, y], 14), 380); await sleep(700);
    const after = await page.evaluate(() => window.app.store.project.items.map((i) => i.id).join(','));
    const sl = await page.evaluate(() => document.querySelector('#storyboard-pane .sb-scroll').scrollLeft);
    record('swipe after a 380 ms rest scrolls the strip (no reorder)', after === before && sl < 300, `order ${after === before ? 'unchanged' : 'CHANGED'}, scrollLeft 300 → ${Math.round(sl)}`);
    await ctx.close();
  }

  await browser.close();
}

try { await run(); } catch (e) { console.error(e); results.push(false); } finally { if (server) server.kill(); }
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
