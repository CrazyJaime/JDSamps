// app.js / sw.js / manifest self-test (owner: F). Drives tests/app-test.html (real index.html
// markup + real js/app.js; js/commands.js is replaced by tests/app-test-commands.js only while the
// real one is missing) in headless Chromium.
//
//   npx http-server moviemaker -p 8106 -c-1 --silent &
//   node moviemaker/tests/app-test.run.mjs [outDir]          (APP_TEST_STUB=1 → stub commands)

import { createRequire } from 'module';
import { mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/opt/node22/lib/node_modules/playwright'); }
const { chromium } = playwright;

const ORIGIN = process.env.APP_TEST_ORIGIN || 'http://localhost:8106';
// APP_TEST_STUB=1 forces the logging stub for js/commands.js (exercises the routing checks).
const STUB_Q = process.env.APP_TEST_STUB ? '?stub' : '';
const PAGE = `${ORIGIN}/tests/app-test.html${STUB_Q}`;
const OUT = process.argv[2] || join(os.tmpdir(), 'app-shots');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.log(`  FAIL ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(context, url = PAGE) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => window.app && window.app.store && window.app.ribbon, null, { timeout: 20000 });
  return { page, errors };
}

const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('#toast-root .toast')].map((t) => t.textContent));

async function main() {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    // ------------------------------------------------------------------ desktop
    console.log('desktop');
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    let { page, errors } = await open(context);
    const info = await page.evaluate(() => ({
      stub: window.__usingStubCommands,
      keys: ['store', 'persist', 'media', 'audio', 'dialogs', 'preview', 'player', 'exporter', 'commands', 'ribbon', 'storyboard'].filter((k) => !window.app[k]),
      same: window.app === window.__appModule.default,
      title: document.title,
      docTitle: document.getElementById('doc-title').textContent,
      host: (() => { const cs = getComputedStyle(document.getElementById('media-host')); return { pos: cs.position, pe: cs.pointerEvents, ov: cs.overflow }; })(),
      autosave: !!(window.app.autosave && typeof window.app.autosave.flush === 'function'),
      options: window.app.options.photoDuration,
    }));
    console.log(`  (commands: ${info.stub ? 'logging test stub' : 'real js/commands.js'})`);
    ok(info.keys.length === 0, `app has every part (${info.keys.join(',') || 'all'})`);
    ok(info.same, 'window.app is the app object');
    ok(info.title === 'My Movie - Movie Maker' && /My Movie/.test(info.docTitle), `title “${info.title}”`);
    ok(info.host.pos === 'fixed' && info.host.pe === 'none' && info.host.ov === 'hidden', '#media-host parked (fixed, no pointer events, overflow hidden)');
    ok(info.autosave, 'autosave enabled');
    ok(info.options === 7, 'app.options.photoDuration default 7');
    await page.screenshot({ path: join(OUT, 'app-desktop.png') });

    // rename via #doc-title
    await page.click('#doc-title');
    await page.waitForSelector('.dlg input[type=text]');
    await sleep(100);
    await page.keyboard.type('Summer Trip');
    await page.keyboard.press('Enter');
    await sleep(300);
    ok(await page.evaluate(() => document.title === 'Summer Trip - Movie Maker' && window.app.store.project.name === 'Summer Trip'), 'tapping the title renames the project');
    ok(await page.evaluate(() => document.getElementById('doc-title').textContent === 'Summer Trip - Movie Maker'), '#doc-title shows the new name');

    // drag & drop files anywhere
    await page.evaluate(async () => {
      const get = async (p, type) => new File([await (await fetch(p)).blob()], p.split('/').pop(), { type });
      window.__dt = new DataTransfer();
      window.__dt.items.add(await get('fixtures/clip1.webm', 'video/webm'));
      window.__dt.items.add(await get('fixtures/photo2.png', 'image/png'));
      window.__dt.items.add(await get('fixtures/music.ogg', 'audio/ogg'));
      window.__cmdLog = window.__cmdLog || [];
      window.__cmdLog.length = 0;
      document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.__dt, bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    });
    ok(await page.evaluate(() => { const o = document.getElementById('drop-overlay'); return !o.hidden && getComputedStyle(o).display !== 'none'; }), 'drop overlay shown while dragging files');
    await page.screenshot({ path: join(OUT, 'app-drop-overlay.png') });
    const dropPrevented = await page.evaluate(() => {
      const ev = new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    ok(dropPrevented, 'drop default prevented (browser will not navigate to the file)');
    ok(await page.evaluate(() => document.getElementById('drop-overlay').hidden), 'overlay hidden after drop');
    if (info.stub) {
      await page.waitForFunction(() => window.app.store.project.music.length > 0, null, { timeout: 20000 });
      const log = await page.evaluate(() => window.__cmdLog);
      const add = log.find((l) => l[0] === 'addMedia');
      const mus = log.find((l) => l[0] === 'addMusic');
      ok(add && add[1].join(',') === 'clip1.webm,photo2.png', `drop → addMedia(visual files) ${JSON.stringify(add)}`);
      ok(mus && mus[1].join(',') === 'music.ogg', `drop → addMusic(audio files) ${JSON.stringify(mus)}`);
    } else {
      await sleep(4000);
      ok(await page.evaluate(() => window.app.store.project.items.length >= 2), 'drop added the videos and photos');
    }

    // paste an image
    await page.evaluate(async () => {
      window.__cmdLog = window.__cmdLog || [];
      window.__cmdLog.length = 0;
      const blob = await (await fetch('fixtures/photo1.jpg')).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'image.jpg', { type: 'image/jpeg' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await sleep(200);
    if (info.stub) {
      const log = await page.evaluate(() => window.__cmdLog);
      ok(log.length && log[0][0] === 'addMedia' && /^Pasted image \d{4}-\d\d-\d\d .*\.jpg$/.test(log[0][1][0]), `paste of an image → addMedia (${JSON.stringify(log[0])})`);
    }
    await page.waitForFunction(() => window.app.store.project.items.length >= 3, null, { timeout: 20000 }).catch(() => {});

    // keyboard shortcuts
    if (info.stub) {
      await page.evaluate(() => { window.__cmdLog.length = 0; document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
      await page.keyboard.press('Space');
      await page.keyboard.press('Space');
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+y');
      await page.keyboard.press('Control+Shift+Z');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Home');
      await page.keyboard.press('End');
      await page.keyboard.press('m');
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await page.keyboard.press('Control+s');
      await sleep(500);
      const names = (await page.evaluate(() => window.__cmdLog)).map((l) => l[0]);
      const want = ['togglePlay', 'togglePlay', 'undo', 'redo', 'redo', 'nextFrame', 'prevFrame', 'goStart', 'goEnd', 'split', 'selectAll', 'remove', 'saveProject'];
      ok(JSON.stringify(names) === JSON.stringify(want), `shortcuts → ${names.join(' ')}`);
      await page.evaluate(() => window.app.dialogs.closeAll());
      await sleep(300);
      // typing in a text field is left alone
      await page.evaluate(() => {
        window.__cmdLog.length = 0;
        const i = document.createElement('input'); i.id = 't-input'; document.body.appendChild(i); i.focus();
      });
      await page.keyboard.press('Space');
      await page.keyboard.press('Delete');
      await page.keyboard.press('Control+z');
      ok((await page.evaluate(() => window.__cmdLog.length)) === 0, 'shortcuts ignored while typing in an input');
      await page.evaluate(() => document.getElementById('t-input').remove());
      // Ctrl+V with nothing on the clipboard → Movie Maker's own paste
      await page.evaluate(() => { window.__cmdLog.length = 0; document.body.focus(); });
      await page.keyboard.press('Control+v');
      await sleep(250);
      ok((await page.evaluate(() => window.__cmdLog.map((l) => l[0]))).includes('paste'), 'Ctrl+V → paste command');
      // shortcuts suspended while a dialog is open
      await page.evaluate(() => { window.__cmdLog.length = 0; window.app.dialogs.openAbout(); });
      await page.waitForSelector('.dlg');
      await page.keyboard.press('Delete');
      ok((await page.evaluate(() => window.__cmdLog.length)) === 0, 'shortcuts suspended while a dialog is open');
      await page.keyboard.press('Escape');
      await sleep(250);
    }

    // global errors → toast; AbortError ignored
    await page.evaluate(() => { document.querySelectorAll('#toast-root .toast').forEach((t) => t.remove()); });
    await page.evaluate(() => {
      setTimeout(() => { throw new Error('boom'); }, 0);
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    await sleep(400);
    let t = await toasts(page);
    ok(t.length === 1 && /Something went wrong/.test(t[0]), `uncaught error → one friendly toast (${t.join(' | ')})`);
    await page.evaluate(() => { const e = new Error('Your video file is too large for this device.'); e.friendly = true; Promise.reject(e); });
    await sleep(300);
    t = await toasts(page);
    ok(t.some((x) => /too large for this device/.test(x)), 'friendly rejection message shown as is');

    // visibility hidden pauses playback
    const paused = await page.evaluate(async () => {
      await window.app.player.play();
      await new Promise((r) => setTimeout(r, 300));
      const was = window.app.player.playing;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      const now = window.app.player.playing;
      delete document.hidden; delete document.visibilityState;
      return { was, now };
    });
    ok(paused.was && !paused.now, `hidden page pauses playback (${JSON.stringify(paused)})`);

    // service worker
    const sw = await page.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 15000))]);
      if (!reg) return { reg: false };
      await new Promise((r) => setTimeout(r, 1500));
      const keys = await caches.keys();
      const shell = keys.find((k) => k.startsWith('movie-maker-shell-'));
      const c = shell ? await caches.open(shell) : null;
      const has = async (p) => !!(c && await c.match(new URL(p, location.href).href));
      return { reg: true, scope: reg.scope, shell, index: await has('../index.html'), app: await has('../js/app.js'), dialogs: await has('../js/ui/dialogs.js'), css: await has('../css/moviemaker.css'), icon: await has('../icons/icon-192.png'), tests: await has('app-test.html') };
    });
    ok(sw.reg && sw.scope === `${ORIGIN}/`, `service worker registered for the app scope (${sw.scope})`);
    ok(sw.shell && sw.index && sw.app && sw.dialogs && sw.css && sw.icon, `app shell precached (${JSON.stringify(sw)})`);
    ok(!sw.tests, 'test pages are not cached');

    // persisted project survives a reload (restore last project)
    await page.evaluate(() => window.app.autosave.flush());
    await sleep(500);
    const before = await page.evaluate(() => ({ id: window.app.store.project.id, n: window.app.store.project.items.length, name: window.app.store.project.name }));
    await page.reload();
    await page.waitForFunction(() => window.app && window.app.store && window.app.ribbon);
    await page.waitForFunction((id) => window.app.store.project.id === id, before.id, { timeout: 10000 }).catch(() => {});
    const after = await page.evaluate(() => ({ id: window.app.store.project.id, n: window.app.store.project.items.length, name: window.app.store.project.name, controlled: !!navigator.serviceWorker.controller, title: document.title }));
    ok(after.id === before.id && after.n === before.n && after.name === 'Summer Trip', `last project restored after reload (${JSON.stringify(after)})`);
    ok(after.title === 'Summer Trip - Movie Maker', 'title restored');
    ok(after.controlled, 'page controlled by the service worker after reload');
    await page.screenshot({ path: join(OUT, 'app-restored.png') });

    // offline: shell files come from the cache
    await context.setOffline(true);
    const offline = await page.evaluate(async () => {
      const r1 = await fetch('../js/app.js').then((r) => r.status, () => 0);
      const r2 = await fetch('../index.html').then((r) => r.status, () => 0);
      const r3 = await fetch('../manifest.webmanifest').then((r) => r.status, () => 0);
      return [r1, r2, r3];
    });
    ok(offline.every((s) => s === 200), `offline: shell served from cache (${offline})`);
    const navOffline = await context.newPage();
    const resp = await navOffline.goto(`${ORIGIN}/?utm=offline`).catch(() => null);
    ok(!!resp && resp.status() === 200 && /Movie Maker$/.test(await navOffline.title()), 'offline: navigating to the app returns the cached page');
    const bootedOffline = await navOffline.waitForFunction(() => window.app && window.app.store && window.app.ribbon, null, { timeout: 15000 }).then(() => true, () => false);
    ok(bootedOffline || info.stub, `offline: the real app (index.html) starts from the cache${info.stub ? ' (skipped: commands.js missing)' : ''}`);
    await navOffline.close();
    await context.setOffline(false);

    // Web Share Target: POST → SW parks the files → app imports them
    const shared = await page.evaluate(async () => {
      const fd = new FormData();
      fd.append('title', 'From gallery');
      fd.append('media', new File([await (await fetch('fixtures/photo1.jpg')).blob()], 'IMG_0001.jpg', { type: 'image/jpeg' }));
      const r = await fetch('../share-target', { method: 'POST', body: fd });
      const c = await caches.open('movie-maker-share');
      return { redirected: r.redirected, url: r.url, parked: (await c.keys()).length };
    });
    ok(/\?share-target=files$/.test(shared.url) && shared.parked === 1, `share target parks files and redirects (${JSON.stringify(shared)})`);
    const itemsBeforeShare = await page.evaluate(() => window.app.store.project.items.length);
    await page.goto(`${PAGE}${STUB_Q ? '&' : '?'}share-target=files`);
    await page.waitForFunction(() => window.app && window.app.store && window.app.ribbon);
    await page.waitForFunction((n) => window.app.store.project.items.length > n, itemsBeforeShare, { timeout: 20000 }).catch(() => {});
    const afterShare = await page.evaluate(async () => ({ n: window.app.store.project.items.length, search: location.search, parked: (await (await caches.open('movie-maker-share')).keys()).length }));
    ok(afterShare.n === itemsBeforeShare + 1 && !/share-target/.test(afterShare.search) && afterShare.parked === 0, `shared photo imported, URL cleaned, cache emptied (${JSON.stringify(afterShare)})`);

    // SW update → "Update available — tap to reload". A new script URL for the same scope is a
    // new version as far as the browser is concerned (no need to touch sw.js on disk).
    // (let the app's own registration on this page load settle first)
    await page.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active && !r.installing && !r.waiting); }, null, { timeout: 10000 }).catch(() => {});
    await sleep(1500);
    await page.evaluate(() => { navigator.serviceWorker.register('../sw.js?v=test-update', { scope: '/' }).catch((e) => { window.__swErr = String(e); }); });
    const gotToast = await page.waitForFunction(() => [...document.querySelectorAll('#toast-root .toast')].some((x) => /Update available/.test(x.textContent)), null, { timeout: 15000 }).then(() => true, () => false);
    ok(gotToast, `new service worker → “Update available — tap to reload” toast ${await page.evaluate(() => window.__swErr || '')}`);
    await page.screenshot({ path: join(OUT, 'app-update-toast.png') });
    if (gotToast) {
      const nav = page.waitForNavigation({ timeout: 15000 }).then(() => true, () => false);
      const before = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); navigator.serviceWorker.addEventListener('controllerchange', () => console.log('DBG controllerchange')); return { active: r.active && r.active.scriptURL, waiting: r.waiting && r.waiting.scriptURL, installing: r.installing && r.installing.scriptURL }; });
      console.log('  (sw before tap)', JSON.stringify(before));
      page.on('console', (m) => { if (/DBG/.test(m.text())) console.log('  (page)', m.text()); });
      const t0 = Date.now();
      await page.click('#toast-root .toast:has-text("Update available")');
      ok(await nav, 'tapping the update toast reloads the page');
      console.log(`  (reload after ${Date.now() - t0} ms)`);
      await page.waitForFunction(() => window.app && window.app.store && window.app.ribbon);
      const v = await page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return { ctl: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : '', active: r && r.active && r.active.scriptURL, waiting: r && r.waiting && r.waiting.scriptURL };
      });
      ok(/\?v=test-update$/.test(v.ctl), `the new worker controls the reloaded page (${JSON.stringify(v)})`);
    }

    // a broken last-project id → new project + toast
    await page.evaluate(() => localStorage.setItem('wlmm-web:lastProjectId', 'proj-does-not-exist'));
    await page.reload();
    await page.waitForFunction(() => window.app && window.app.store && window.app.ribbon);
    await sleep(800);
    t = await toasts(page);
    ok(t.some((x) => /last project couldn’t be opened/.test(x)), `missing last project → toast (${t.join(' | ')})`);
    ok(await page.evaluate(() => window.app.store.project.items.length === 0), 'a new empty project was started');

    const bad = errors.filter((e) => !/favicon|Error: boom|too large for this device/.test(e));
    ok(bad.length === 0, `no unexpected page errors (${bad.join(' | ')})`);
    await context.close();

    // ------------------------------------------------------------------ no MediaRecorder / no IndexedDB
    console.log('old browser');
    const ctx2 = await browser.newContext({ viewport: { width: 1024, height: 700 } });
    await ctx2.addInitScript(() => { delete window.MediaRecorder; Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); });
    const r2 = await open(ctx2);
    await sleep(1800);
    t = await toasts(r2.page);
    ok(t.some((x) => /Saving movies isn’t supported/.test(x)), 'warns when MediaRecorder is missing');
    ok(t.some((x) => /can’t save projects/.test(x)), 'warns when IndexedDB is missing');
    await r2.page.screenshot({ path: join(OUT, 'app-old-browser.png') });
    await ctx2.close();

    // ------------------------------------------------------------------ phone
    console.log('phone');
    const ctx3 = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
    });
    const r3 = await open(ctx3);
    await sleep(800);
    await r3.page.screenshot({ path: join(OUT, 'app-phone.png') });
    await r3.page.tap('#app-menu-btn');
    await r3.page.waitForSelector('.app-menu');
    await sleep(300);
    await r3.page.screenshot({ path: join(OUT, 'app-phone-menu.png') });
    ok(true, 'phone: app menu opens from the app button');
    await ctx3.close();

    // ------------------------------------------------------------------ manifest
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
    ok(manifest.name === 'Movie Maker' && manifest.short_name === 'Movie Maker' && manifest.display === 'standalone'
      && manifest.start_url === './' && manifest.scope === './' && manifest.orientation === 'any', 'manifest basics');
    ok(manifest.icons.some((i) => i.purpose === 'maskable') && manifest.icons.some((i) => i.sizes === '512x512') && manifest.icons.some((i) => i.sizes === '192x192'), 'manifest icons incl. maskable');
  } finally {
    await browser.close();
  }
}

try { await main(); } catch (err) { failures += 1; console.error('FATAL', err); }
console.log(failures ? `\n${failures} failure(s). Screenshots: ${OUT}` : `\nAll app checks passed. Screenshots: ${OUT}`);
process.exit(failures ? 1 : 0);
