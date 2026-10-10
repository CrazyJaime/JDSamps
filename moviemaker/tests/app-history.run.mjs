// Back button / history regression checks for the app bucket (dialogs.js back stack + app menu),
// on a phone profile (Playwright Chromium, touch emulation). Each check prints PASS/FAIL; exit 1
// if any fails.
//
//   NODE_PATH=/opt/node22/lib/node_modules node tests/app-history.run.mjs
//   BASE_URL=http://127.0.0.1:8143/ …   (use a running server; otherwise one is started on $PORT or 8143)
//
// The user "arrives" from another page (icons/icon.svg), so a history.back() that lands one entry
// too far shows up as leaving index.html.

import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIX = join(HERE, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const PHONE = { viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: UA };

let server = null;
async function base() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/?$/, '/');
  const port = process.env.PORT || '8143';
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
  if (from) await page.goto(`${BASE}icons/icon.svg`);
  await page.goto(`${BASE}index.html?nosw`);
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
/** On index.html, on the app's own entry (no back-catching entry left), nothing open. */
async function state(page) {
  const url = page.url();
  if (!/index\.html/.test(url)) return { inApp: false, url };
  return page.evaluate(() => ({
    inApp: true,
    url: location.pathname,
    base: !(history.state && history.state.mmDialog),
    open: window.app.dialogs.isModalOpen,
  }));
}
const clean = (s) => s.inApp && s.base && !s.open;
async function menu(page, label) {
  await page.locator('#app-menu-btn').tap(); await sleep(350);
  await page.locator('.app-menu .app-menu-item', { hasText: label }).first().tap(); await sleep(500);
}
const btn = (page, label) => page.locator('#dialog-root .dlg-buttons button', { hasText: label }).last();
async function back(page) { await page.goBack({ timeout: 1500 }).catch(() => {}); await sleep(500); }

async function run() {
  const BASE = await base();
  const browser = await chromium.launch();

  // 1. every app-menu dialog, closed with its own button / X, keeps the user in the app
  {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await boot(page, BASE);
    const flows = [
      ['Help', async () => btn(page, 'OK').tap()],
      ['About Movie Maker', async () => page.locator('#dialog-root .dlg-close').last().tap()],
      ['Open project', async () => btn(page, 'Close').tap()],
      ['Options', async () => btn(page, 'Cancel').tap()],
      ['Save project as', async () => btn(page, 'Save').tap()],
    ];
    for (const [label, close] of flows) {
      await menu(page, label);
      const opened = await page.evaluate(() => window.app.dialogs.openCount > 0);
      await close(); await sleep(900);
      const s = await state(page);
      record(`menu › ${label} › close stays in the app`, opened && clean(s), JSON.stringify(s));
      if (!s.inApp) { await boot(page, BASE); }
    }

    // New project with something in it asks first: Cancel, then OK.
    await importVia(page, ['photo1.jpg']);
    await menu(page, 'New project');
    const asked = await page.evaluate(() => window.app.dialogs.openCount > 0);
    await btn(page, 'Cancel').tap(); await sleep(900);
    let s = await state(page);
    record('menu › New project › Cancel stays in the app', asked && clean(s) && (await page.evaluate(() => window.app.store.project.items.length)) === 1, JSON.stringify(s));
    await menu(page, 'New project');
    await btn(page, 'New project').tap(); await sleep(900);
    s = await state(page);
    record('menu › New project › confirm stays in the app', clean(s) && (await page.evaluate(() => window.app.store.project.items.length)) === 0, JSON.stringify(s));

    // Back while a menu dialog is open closes it (and only it).
    await menu(page, 'Help');
    await back(page);
    s = await state(page);
    record('menu › Help, then Back closes Help and stays', clean(s), JSON.stringify(s));

    // Back while the menu itself is open.
    await page.locator('#app-menu-btn').tap(); await sleep(350);
    await back(page);
    s = await state(page);
    record('menu open, then Back closes the menu and stays', clean(s), JSON.stringify(s));

    // Nested: Open project › Delete › Cancel, then Close.
    await page.evaluate(async () => { const a = window.app; await a.persist.saveProject(a.store.project, a.store.media); });
    await menu(page, 'Open project');
    await page.locator('.mmd-proj-del').first().tap(); await sleep(500);
    const nested = await page.evaluate(() => window.app.dialogs.openCount);
    await btn(page, 'Cancel').tap(); await sleep(700);
    const mid = await page.evaluate(() => ({ n: window.app.dialogs.openCount, depth: history.state && history.state.mmDepth }));
    await btn(page, 'Close').tap(); await sleep(900);
    s = await state(page);
    record('Open project › Delete › Cancel › Close stays in the app', nested === 2 && mid.n === 1 && mid.depth === 1 && clean(s), JSON.stringify({ nested, mid, s }));

    // Nested + Back twice.
    await menu(page, 'Open project');
    await page.locator('.mmd-proj-del').first().tap(); await sleep(500);
    await back(page);
    const one = await page.evaluate(() => window.app.dialogs.openCount);
    await back(page);
    s = await state(page);
    record('Open project › Delete, then Back twice closes both and stays', one === 1 && clean(s), JSON.stringify({ one, s }));

    // Forward onto a stale entry steps back again without reopening anything.
    await menu(page, 'Help');
    await btn(page, 'OK').tap(); await sleep(900);
    await page.goForward({ timeout: 1500 }).catch(() => {}); await sleep(900);
    s = await state(page);
    record('Forward onto a closed dialog’s entry returns to the app’s entry', clean(s), JSON.stringify(s));

    // After all of that, a single Back leaves Movie Maker (no leftover entries below).
    await back(page);
    record('one Back from the app’s entry leaves to the previous page', /icon\.svg$/.test(page.url()), page.url().replace(BASE, ''));
    await ctx.close();
  }

  // 2. fresh tab (no previous page): Help › OK must not navigate to about:blank
  {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await boot(page, BASE, { from: false });
    await menu(page, 'Help');
    await btn(page, 'OK').tap(); await sleep(900);
    const s = await state(page);
    record('fresh tab: menu › Help › OK stays on index.html', clean(s), JSON.stringify(s));
    await ctx.close();
  }

  // 3. programmatic stress: open/close/hand over in one task, then Back closes the right one
  {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await boot(page, BASE);
    const r = await page.evaluate(async () => {
      const d = window.app.dialogs;
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const mk = (t) => d.open({ title: t, body: t, buttons: [{ label: 'OK', value: true, primary: true }] });
      const a = mk('A');
      const b = mk('B');
      b.close(true);                                   // B closes …
      const c = mk('C');                // … and C takes its entry in the same task
      await wait(300);
      const depth1 = history.state && history.state.mmDepth;
      history.back();                                  // closes C only
      await c;
      await wait(300);
      const afterC = d.openCount;
      const depth2 = history.state && history.state.mmDepth;
      a.close(true);
      await a;
      await wait(300);
      return { depth1, afterC, depth2, base: !(history.state && history.state.mmDialog), open: d.openCount };
    });
    record('hand-over in one task keeps one entry per open dialog', r.depth1 === 2 && r.afterC === 1 && r.depth2 === 1 && r.base && r.open === 0, JSON.stringify(r));
    record('…and the app is still open', /index\.html/.test(page.url()), page.url().replace(BASE, ''));
    await ctx.close();
  }

  // 4. finding a project again: recent rows have pictures; rename from the menu and the Open list
  {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await boot(page, BASE, { from: false });
    await importVia(page, ['photo1.jpg', 'photo2.png']);
    await page.evaluate(async () => { const a = window.app; await a.persist.saveProject(a.store.project, a.store.media); });
    const firstId = await page.evaluate(() => window.app.store.project.id);
    await page.evaluate(() => window.app.dialogs.newProject());
    await importVia(page, ['photo2.png']);
    await page.evaluate(async () => { const a = window.app; await a.persist.saveProject(a.store.project, a.store.media); });
    await page.locator('#app-menu-btn').tap(); await sleep(600);
    const rows = await page.evaluate(() => [...document.querySelectorAll('.app-menu-side .app-menu-recent')].map((b) => ({
      img: !!b.querySelector('img'), text: b.textContent,
    })));
    record('recent projects show a picture and the item count', rows.length >= 2 && rows.every((r) => r.img) && rows.some((r) => /2 items/.test(r.text)) && rows.some((r) => /1 item\b/.test(r.text)), JSON.stringify(rows));
    // menu › Rename project (the open one)
    await page.locator('.app-menu .app-menu-item', { hasText: 'Rename project' }).first().tap(); await sleep(400);
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
    await page.locator('#dialog-root .dlg input').fill('Second trip');
    await btn(page, 'Rename').tap(); await sleep(900);
    let s = await state(page);
    const curName = await page.evaluate(() => window.app.store.project.name);
    record('menu › Rename project renames the open project', focused === 'INPUT' && curName === 'Second trip' && clean(s), JSON.stringify({ focused, curName, s }));
    // Open project › rename the other (not open) project
    await menu(page, 'Open project');
    await page.waitForSelector('.mmd-proj');
    const row = page.locator('.mmd-proj:not(.is-current)').first();
    await row.locator('.mmd-proj-ren').tap(); await sleep(400);
    await page.locator('#dialog-root .dlg input').last().fill('First trip');
    await btn(page, 'Rename').tap(); await sleep(1200);
    const names = await page.evaluate(() => [...document.querySelectorAll('.mmd-proj-name')].map((n) => n.textContent));
    const saved = await page.evaluate(async (id) => (await window.app.persist.listProjects()).find((p) => p.id === id), firstId);
    await btn(page, 'Close').tap(); await sleep(900);
    s = await state(page);
    record('Open project › Rename renames a saved project that isn’t open', names.includes('First trip') && names.includes('Second trip') && saved && saved.name === 'First trip' && saved.itemCount === 2 && clean(s), JSON.stringify({ names, saved: saved && saved.name, s }));
    await ctx.close();
  }

  // 5. keyboard (desktop): Ctrl+B / Ctrl+I on a selected caption, I / O set start / end point
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await boot(page, BASE, { from: false });
    const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => { window.app.commands.run('addMedia'); })]);
    await ch.setFiles([join(FIX, 'clip1.webm')]);
    await page.waitForFunction(() => window.app.store.project.items.length === 1, null, { timeout: 30000 });
    await sleep(500);
    await page.evaluate(async () => { await window.app.player.seek(1); window.app.commands.run('addCaption'); });
    await sleep(300);
    await page.keyboard.press('Escape'); // leave the inline editor
    await sleep(200);
    await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
    const style = () => page.evaluate(() => { const t = window.app.store.project.texts[0]; return { bold: !!t.style.bold, italic: !!t.style.italic, sel: window.app.store.selection.type }; });
    const s0 = await style();
    await page.keyboard.press('Control+b'); await sleep(150);
    const s1 = await style();
    await page.keyboard.press('Control+i'); await sleep(150);
    const s2 = await style();
    await page.keyboard.press('Control+b'); await sleep(150);
    const s3 = await style();
    record('Ctrl+B / Ctrl+I toggle bold and italic on the selected caption', s0.sel === 'text' && s1.bold !== s0.bold && s2.italic !== s1.italic && s3.bold === s0.bold, JSON.stringify([s0, s1, s2, s3]));
    // Inline editing: Ctrl+B works there too and editing continues.
    const editing = await page.evaluate(() => { window.app.commands.run('textEdit'); return !!window.app.preview.editingTextId; });
    await sleep(200);
    await page.keyboard.press('Control+b'); await sleep(150);
    const s4 = await style();
    const still = await page.evaluate(() => !!window.app.preview.editingTextId && document.activeElement === window.app.preview.editor);
    record('Ctrl+B while editing a caption inline makes it bold and keeps editing', editing && s4.bold !== s3.bold && still, JSON.stringify({ editing, s4, still }));
    await page.keyboard.press('Escape'); await sleep(200);
    // I / O on the selected video at the playhead.
    await page.evaluate(async () => { const v = window.app.store.project.items[0]; window.app.store.select('item', v.id); await window.app.player.seek(1); document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
    await sleep(200);
    await page.keyboard.press('i'); await sleep(300);
    const ts = await page.evaluate(() => window.app.store.project.items[0].trimStart);
    await page.evaluate(async () => { await window.app.player.seek(2); });
    await sleep(200);
    await page.keyboard.press('o'); await sleep(300);
    const te = await page.evaluate(() => window.app.store.project.items[0].trimEnd);
    record('I / O set the start / end point of the selected video at the playhead', Math.abs(ts - 1) < 0.05 && te > ts + 0.5 && te < 3.2, JSON.stringify({ ts, te }));
    // In the Trim tool, I sets the tool's start point.
    await page.evaluate(() => { window.app.dialogs.openTrim(window.app.store.project.items[0].id); });
    await sleep(600);
    const before = await page.evaluate(() => window.app.dialogs.trimState.start);
    await page.evaluate(async () => { const st = window.app.dialogs.trimState; await window.app.player.seek(window.app.player.currentTime + 0.4); return st; });
    await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
    await page.keyboard.press('i'); await sleep(200);
    const afterI = await page.evaluate(() => window.app.dialogs.trimState.start);
    await page.keyboard.press('Escape'); await sleep(300);
    record('I in the Trim tool sets its start point', afterI > before + 0.2 && !(await page.evaluate(() => window.app.dialogs.trimActive)), JSON.stringify({ before, afterI }));
    await ctx.close();
  }

  // 6. text prompts take focus inside the opening tap (iOS only shows the keyboard then)
  for (const [label, opts] of [['phone', PHONE], ['desktop', { viewport: { width: 1280, height: 800 } }]]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await boot(page, BASE, { from: false });
    const r = await page.evaluate(() => {
      const p = window.app.dialogs.promptText('Rename project', 'Holiday');
      const el = document.activeElement;
      const res = { tag: el && el.tagName, start: el && el.selectionStart, end: el && el.selectionEnd };
      window.app.dialogs.closeAll();
      return p.then(() => res);
    });
    record(`${label}: promptText focuses and selects its field synchronously`, r.tag === 'INPUT' && r.start === 0 && r.end === 7, JSON.stringify(r));
    // The title-bar rename: the field has focus before the tap's click event has finished.
    await page.evaluate(() => {
      window.__clickFocus = null;
      window.addEventListener('click', () => { const a = document.activeElement; window.__clickFocus = a && a.tagName; }, { once: true });
    });
    if (label === 'phone') await page.locator('#doc-title').tap(); else await page.locator('#doc-title').click();
    await sleep(300);
    const inTap = await page.evaluate(() => window.__clickFocus);
    record(`${label}: tapping the title focuses the Rename field within the tap`, inTap === 'INPUT', String(inTap));
    await page.evaluate(() => window.app.dialogs.closeAll());
    await ctx.close();
  }

  await browser.close();
}

try { await run(); } catch (e) { console.error(e); results.push(false); } finally { if (server) server.kill(); }
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
