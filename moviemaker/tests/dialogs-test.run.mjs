// Dialogs self-test (owner: F). Drives tests/dialogs-test.html (real shell markup, real Store /
// Player / Exporter / persist, fake commands) in headless Chromium at desktop and phone sizes.
// Exercises every dialog, asserts behaviour and writes screenshots for visual review.
//
//   npx http-server moviemaker -p 8106 -c-1 --silent &
//   node moviemaker/tests/dialogs-test.run.mjs [outDir]

import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/opt/node22/lib/node_modules/playwright'); }
const { chromium } = playwright;

const BASE = process.env.DIALOGS_TEST_URL || 'http://localhost:8106/tests/dialogs-test.html';
const OUT = process.argv[2] || join(os.tmpdir(), 'dialogs-shots');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.log(`  FAIL ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  await page.evaluate(() => document.body.classList.add('t-shots'));
  await sleep(250);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.evaluate(() => document.body.classList.remove('t-shots'));
}

async function boot(browser, ctxOpts, label) {
  const context = await browser.newContext({ ...ctxOpts, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForFunction(() => window.T && (window.T.ready || window.T.error), null, { timeout: 30000 });
  const err = await page.evaluate(() => window.T.error);
  ok(!err, `${label}: harness ready ${err || ''}`);
  return { context, page, errors };
}

async function closeAll(page) {
  await page.evaluate(() => window.app.dialogs.closeAll());
  await sleep(250);
}

async function desktop(browser) {
  console.log('desktop 1280x800');
  const { context, page, errors } = await boot(browser, { viewport: { width: 1280, height: 800 } }, 'desktop');

  // fallback style is injected and roots exist
  ok(await page.evaluate(() => !!document.getElementById('dlg-style') && !!document.getElementById('dialog-root') && !!document.getElementById('toast-root')), 'style + roots present');

  // --- toasts
  await page.evaluate(() => {
    const d = window.app.dialogs;
    d.toast('Your project has been saved on this device.', { type: 'success' });
    d.toast('Imported 3 files.');
    d.toast('That video format isn’t supported by your browser.', { type: 'error' });
    d.toast('Imported 3 files.'); // duplicate → not stacked twice
  });
  ok(await page.evaluate(() => document.querySelectorAll('#toast-root .toast').length === 3), 'toasts stacked (duplicates merged)');
  ok(await page.evaluate(() => document.querySelector('#toast-root .toast-error').getAttribute('role') === 'alert'), 'error toast role=alert');
  await shot(page, 'desktop-toasts');
  await page.evaluate(() => document.querySelectorAll('#toast-root .toast').forEach((t) => t.click()));
  await sleep(300);
  ok(await page.evaluate(() => document.querySelectorAll('#toast-root .toast').length === 0), 'toasts dismiss on tap');

  // --- confirm / prompt / focus trap / escape
  const confirmP = page.evaluate(() => window.app.dialogs.confirm('Delete “Summer Trip”?\n\nThis can’t be undone.', { okLabel: 'Delete', danger: true }));
  await page.waitForSelector('.dlg');
  ok(await page.evaluate(() => document.getElementById('app').inert === true), '#app is inert while a dialog is open');
  await shot(page, 'desktop-confirm');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  ok(await page.evaluate(() => !!document.activeElement.closest('.dlg')), 'focus trapped inside dialog');
  await page.keyboard.press('Escape');
  ok((await confirmP) === false, 'Escape cancels confirm → false');
  await sleep(250);
  ok(await page.evaluate(() => document.getElementById('app').inert === false), '#app not inert after closing');

  const promptP = page.evaluate(() => window.app.dialogs.promptText('Rename project', 'My Movie', { label: 'Project name' }));
  await page.waitForSelector('.dlg input[type=text]');
  await sleep(100);
  await page.keyboard.type('Holiday 2026');
  await shot(page, 'desktop-prompt');
  await page.keyboard.press('Enter');
  ok((await promptP) === 'Holiday 2026', 'promptText: Enter returns the typed text (selection replaced)');
  await sleep(200);

  const confirmOk = page.evaluate(() => window.app.dialogs.confirm('Continue?'));
  await page.waitForSelector('.dlg .btn-primary');
  await page.click('.dlg .btn-primary');
  ok((await confirmOk) === true, 'confirm OK → true');
  await sleep(200);

  // backdrop tap closes non-critical dialogs
  const openP = page.evaluate(() => window.app.dialogs.open({ title: 'Generic', body: 'Body text', buttons: [{ label: 'OK', value: 1, primary: true }] }));
  await page.waitForSelector('.dlg-backdrop');
  await page.mouse.click(10, 790);
  ok((await openP) === null, 'backdrop click closes a dismissible dialog → null');
  await sleep(200);

  // --- progress
  await page.evaluate(() => {
    const p = window.app.dialogs.progress('Importing', { delay: 0, text: 'Opening clip1.webm' });
    p.set(0.42, 'Making thumbnails – clip1.webm');
    window.__prog = p;
  });
  await page.waitForSelector('.dlg .progress');
  ok(await page.evaluate(() => document.querySelector('.dlg .progress').getAttribute('aria-valuenow') === '42'), 'progress value set');
  await shot(page, 'desktop-progress');
  await page.click('.dlg .dlg-buttons .btn');
  ok(await page.evaluate(() => window.__prog.signal.aborted), 'progress Cancel aborts the signal');
  await sleep(250);

  // --- app menu
  await page.evaluate(() => { window.app.dialogs.openAppMenu(); });
  await page.waitForSelector('.app-menu .app-menu-item');
  ok(await page.evaluate(() => document.getElementById('app-menu-btn').getAttribute('aria-expanded') === 'true'), 'app button aria-expanded=true');
  await sleep(300);
  await shot(page, 'desktop-appmenu');
  await page.hover('.app-menu-item.mmd-has-sub');
  await sleep(200);
  ok(await page.evaluate(() => document.querySelector('.app-menu-side .app-menu-heading').textContent === 'Save movie'), 'hovering Save movie shows the presets');
  await shot(page, 'desktop-appmenu-savemovie');
  await page.keyboard.press('Escape');
  await sleep(100);
  ok(await page.evaluate(() => !document.querySelector('.app-menu')), 'Escape closes the menu');

  // --- options
  const optP = page.evaluate(() => window.app.dialogs.openOptions());
  await page.waitForSelector('.dlg input[type=number]');
  await page.fill('.dlg input[type=number] >> nth=0', '4.5');
  await shot(page, 'desktop-options');
  await page.click('.dlg .btn-primary');
  await optP;
  ok(await page.evaluate(() => window.T.getOption('photoDuration') === 4.5), 'Options stores the photo duration');
  await page.evaluate(() => window.T.setOption('photoDuration', null));
  await sleep(200);

  // --- about / help
  const aboutP = page.evaluate(() => window.app.dialogs.openAbout());
  await page.waitForSelector('.mmd-about');
  await sleep(300);
  await shot(page, 'desktop-about');
  await page.click('.dlg .btn-primary');
  await aboutP;
  const helpP = page.evaluate(() => window.app.dialogs.openHelp());
  await page.waitForSelector('.mmd-keys');
  await shot(page, 'desktop-help');
  await page.keyboard.press('Escape');
  await helpP;
  await sleep(200);

  // --- projects (save one first)
  await page.evaluate(async () => {
    const s = window.app.store;
    await window.T.persist.saveProject(s.project, s.media);
    const other = JSON.parse(JSON.stringify(s.project));
    other.id = 'proj-other-1'; other.name = 'Beach day'; other.updatedAt = Date.now() - 86400000 * 3;
    await window.T.persist.saveProject(other, s.media);
  });
  const projP = page.evaluate(() => window.app.dialogs.openProjects());
  await page.waitForSelector('.mmd-proj');
  ok(await page.evaluate(() => document.querySelectorAll('.mmd-proj').length >= 2), 'Open project lists saved projects');
  await shot(page, 'desktop-projects');
  // delete the other project
  await page.click('.mmd-proj:not(.is-current) .mmd-proj-del');
  await page.waitForSelector('.dlg .btn-danger');
  await page.click('.dlg .btn-danger');
  await sleep(500);
  ok(await page.evaluate(() => [...document.querySelectorAll('.mmd-proj-name')].every((n) => n.textContent !== 'Beach day')), 'project deleted from the list');
  await page.keyboard.press('Escape');
  await projP;
  await sleep(200);

  // --- project helpers: export project file → save as → new → open → import
  const origId = await page.evaluate(() => window.app.store.project.id);
  const dl = page.waitForEvent('download', { timeout: 20000 });
  await page.evaluate(() => { window.app.dialogs.exportProjectFile(); });
  const download = await dl;
  const projPath = join(OUT, 'project.wlmmweb');
  await download.saveAs(projPath);
  ok(/\.wlmmweb$/.test(download.suggestedFilename()), `Export project file downloads ${download.suggestedFilename()}`);
  await sleep(300);
  const asP = page.evaluate(() => window.app.dialogs.saveProjectAs());
  await page.waitForSelector('.dlg input[type=text]');
  await sleep(100);
  await page.keyboard.type('Copy of test');
  await page.keyboard.press('Enter');
  await asP;
  const asState = await page.evaluate(async () => ({ id: window.app.store.project.id, name: window.app.store.project.name, n: window.app.store.project.items.length, list: (await window.T.persist.listProjects()).map((p) => p.name) }));
  ok(asState.id !== origId && asState.name === 'Copy of test' && asState.n === 2 && asState.list.includes('Copy of test'), `Save project as makes a saved copy (${JSON.stringify(asState)})`);
  // menu → New project (no newProject command in the fake list → built-in fallback)
  await page.evaluate(() => { window.app.dialogs.openAppMenu(); });
  await page.waitForSelector('.app-menu-item');
  await page.click('.app-menu-item:has-text("New project")');
  await sleep(400);
  ok(await page.evaluate(() => window.app.store.project.items.length === 0 && !document.querySelector('.app-menu')), 'menu › New project starts an empty project');
  ok(await page.evaluate(async () => (await window.T.persist.getLastProjectId()) === null), 'last project id cleared for the blank project');
  // menu → Open project → pick the original
  await page.evaluate(() => { window.app.dialogs.openAppMenu(); });
  await page.waitForSelector('.app-menu-item');
  await page.click('.app-menu-item:has-text("Open project")');
  await page.waitForSelector('.mmd-proj');
  await page.click(`.mmd-proj-open:has-text("Dialog test")`);
  await page.waitForFunction((id) => window.app.store.project.id === id, origId, { timeout: 10000 }).catch(() => {});
  const reopened = await page.evaluate(() => ({ name: window.app.store.project.name, n: window.app.store.project.items.length, media: window.app.store.media.size }));
  ok(reopened.name === 'Dialog test' && reopened.n === 2 && reopened.media >= 2, `Open project loads it with its media (${JSON.stringify(reopened)})`);
  // import the exported file
  const imported = await page.evaluate(async (bytes) => {
    const file = new File([new Uint8Array(bytes)], 'project.wlmmweb', { type: 'application/json' });
    const okv = await window.app.dialogs.importProjectFromFile(file);
    return { okv, name: window.app.store.project.name, n: window.app.store.project.items.length };
  }, [...(await import('fs')).readFileSync(projPath)]);
  ok(imported.okv && imported.n === 2, `Import project file (${JSON.stringify(imported)})`);
  // re-select the video for the following tests
  await page.evaluate(() => {
    const vid = window.app.store.project.items.find((i) => i.kind === 'video');
    window.T.fixture.vid = vid;
    window.app.store.select('item', [vid.id]);
  });
  await sleep(300);

  // --- trim tool
  const vid = await page.evaluate(() => window.T.fixture.vid.id);
  const undoBefore = await page.evaluate(() => window.app.store._undo ? window.app.store._undo.length : -1);
  const trimP = page.evaluate((id) => window.app.dialogs.openTrim(id).then((v) => { window.__trimResult = v; return v; }), vid);
  await page.waitForSelector('.mmd-trim .mmd-trim-handle.is-start');
  await sleep(500);
  ok(await page.evaluate(() => window.app.dialogs.trimActive), 'trim mode active');
  ok(await page.evaluate(() => document.querySelector('.mmd-trim').classList.contains('is-docked')), 'desktop: trim panel docked over the storyboard pane');
  ok(await page.evaluate(() => document.getElementById('ribbon').inert === true), 'ribbon inert during trim');
  const box = await page.locator('.mmd-trim-handle.is-start').boundingBox();
  const trackBox = await page.locator('.mmd-trim-track').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(trackBox.x + trackBox.width * 0.25, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  const startVal = await page.evaluate(() => parseFloat(document.querySelector('.mmd-trim-controls input[type=number]').value));
  ok(startVal > 0.7 && startVal < 1.3, `dragging the start handle sets ~1.00s (got ${startVal})`);
  const loop = await page.evaluate(() => window.app.player.loopRange);
  ok(!!loop && Math.abs(loop.start - startVal) < 0.05, `player.loopRange follows the range (${JSON.stringify(loop)})`);
  await page.fill('.mmd-trim-controls input[type=number] >> nth=1', '3.25');
  await page.keyboard.press('Enter');
  await sleep(200);
  await shot(page, 'desktop-trim');
  await page.click('.mmd-trim .mmd-trim-save');
  await trimP;
  await sleep(300);
  const after = await page.evaluate((id) => { const it = window.app.store.project.items.find((i) => i.id === id); return { s: it.trimStart, e: it.trimEnd, undo: window.app.store._undo.length, label: window.app.store.undoLabel }; }, vid);
  ok(Math.abs(after.s - startVal) < 0.011 && Math.abs(after.e - 3.25) < 0.011, `Save trim commits ${after.s}–${after.e}`);
  ok(after.undo === undoBefore + 1 && after.label === 'Trim', `exactly one undo step labelled Trim (${undoBefore} → ${after.undo}, ${after.label})`);
  ok(await page.evaluate(() => !window.app.dialogs.trimActive && window.app.player.loopRange === null && document.getElementById('ribbon').inert === false), 'trim mode cleaned up');
  // reopen + cancel leaves it untouched
  const trim2 = page.evaluate((id) => window.app.dialogs.openTrim(id), vid);
  await page.waitForSelector('.mmd-trim');
  await sleep(200);
  ok(await page.evaluate((id) => { const it = window.app.store.project.items.find((i) => i.id === id); return it.trimStart === 0 && it.trimEnd === null; }, vid), 'while trimming the whole clip is shown');
  await page.keyboard.press('Escape');
  await trim2;
  const after2 = await page.evaluate((id) => { const it = window.app.store.project.items.find((i) => i.id === id); return { s: it.trimStart, e: it.trimEnd, undo: window.app.store._undo.length }; }, vid);
  ok(after2.s === after.s && after2.e === after.e && after2.undo === after.undo, 'Cancel (Escape) restores the trim without an undo step');
  await sleep(200);

  // --- webcam
  const camP = page.evaluate(() => window.app.dialogs.openWebcam().then((f) => (f ? { name: f.name, size: f.size, type: f.type } : null)));
  await page.waitForSelector('.mmd-rec-btn:not([disabled])', { timeout: 15000 });
  await sleep(500);
  await shot(page, 'desktop-webcam-live');
  await page.click('.mmd-rec-btn');
  await sleep(2200);
  await shot(page, 'desktop-webcam-recording');
  await page.click('.mmd-rec-btn');
  await page.waitForSelector('.mmd-cam-review:not([hidden])', { timeout: 10000 });
  await sleep(600);
  await shot(page, 'desktop-webcam-review');
  await page.click('.dlg .btn-primary');
  const cam = await camP;
  ok(!!cam && cam.size > 1000 && /^Webcam video \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.(webm|mp4)$/.test(cam.name), `webcam returns a File (${cam && cam.name}, ${cam && cam.size} bytes)`);
  await sleep(300);
  ok(await page.evaluate(() => !document.querySelector('.mmd-cam-live')), 'webcam dialog removed');
  // camera released
  await sleep(300);

  // --- narration
  const narrP = page.evaluate(() => window.app.dialogs.openNarration().then((f) => (f ? { name: f.name, size: f.size, type: f.type, t: window.app.player.currentTime } : null)));
  await page.waitForSelector('.mmd-narr .mmd-rec-btn:not([disabled])', { timeout: 15000 });
  const startT = await page.evaluate(() => window.app.player.currentTime);
  await page.click('.mmd-narr .mmd-rec-btn');
  let level = 0;
  for (let i = 0; i < 30; i++) {
    level = Math.max(level, await page.evaluate(() => Number(document.querySelector('.mmd-meter').getAttribute('aria-valuenow') || 0)));
    await sleep(50);
  }
  ok(level > 0, `level meter moves (${level})`);
  ok(await page.evaluate(() => window.app.player.playing), 'movie plays along while recording narration');
  await shot(page, 'desktop-narration-recording');
  await page.click('.mmd-narr .mmd-rec-btn');
  await page.waitForSelector('.mmd-narr audio:not([hidden])', { timeout: 10000 });
  await shot(page, 'desktop-narration-review');
  await page.click('.dlg .btn-primary');
  const narr = await narrP;
  ok(!!narr && narr.size > 500 && /^Narration 1\.(webm|ogg|m4a)$/.test(narr.name), `narration returns a File (${narr && narr.name}, ${narr && narr.size})`);
  ok(!!narr && Math.abs(narr.t - startT) < 0.05, `playhead restored to the recording start (${startT} → ${narr && narr.t})`);

  // --- export (with a fake save-file picker, like desktop Chromium's)
  await page.evaluate(() => {
    window.__written = 0;
    window.showSaveFilePicker = async (opts) => ({
      name: opts.suggestedName,
      createWritable: async () => ({ write: async (b) => { window.__written = b.size; }, close: async () => {} }),
    });
  });
  const exportP = page.evaluate(() => window.app.dialogs.openExport().then((b) => (b ? { size: b.size, type: b.type } : null)));
  await page.waitForSelector('.mmd-presets');
  await shot(page, 'desktop-export-settings');
  ok(await page.evaluate(() => document.querySelectorAll('.mmd-preset').length === 6), 'six Save movie presets');
  await page.click('.mmd-preset >> nth=5'); // For email (small & quick)
  await page.click('.dlg .btn-primary');
  await page.waitForSelector('.mmd-export-live', { timeout: 10000 });
  ok(await page.evaluate(() => window.app.exporting === true), 'app.exporting = true during export');
  await sleep(2500);
  await shot(page, 'desktop-export-progress');
  const mirrored = await page.evaluate(() => {
    const c = document.querySelector('.mmd-export-screen canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0; for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return lit;
  });
  ok(mirrored > 20, `live mirrored preview shows frames (${mirrored} lit samples)`);
  await page.waitForSelector('.mmd-saved', { timeout: 40000 });
  ok(await page.evaluate(() => window.app.exporting === false), 'app.exporting reset');
  ok(await page.evaluate(() => /Your movie has been saved/.test(document.querySelector('.mmd-saved').textContent)), '“Your movie has been saved”');
  ok(await page.evaluate(() => window.__written > 1000), 'movie written to the picked file');
  await page.click('.dlg .dlg-buttons .btn >> nth=0'); // Play
  await sleep(1200);
  const vstate = await page.evaluate(() => { const v = document.querySelector('.mmd-saved video'); return { hidden: v.hidden, dur: v.duration, t: v.currentTime, want: window.app.store.timeline.duration }; });
  ok(!vstate.hidden && Math.abs(vstate.dur - vstate.want) < 0.4 && vstate.t > 0.3, `inline result video plays (duration ${vstate.dur} vs movie ${vstate.want}, t ${vstate.t})`);
  await shot(page, 'desktop-export-saved');
  await page.keyboard.press('Escape');
  const exp = await exportP;
  ok(!!exp && exp.size > 1000, `openExport resolves the movie blob (${exp && exp.size} bytes ${exp && exp.type})`);

  // export cancel
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  const exportP2 = page.evaluate(() => window.app.dialogs.openExport('email'));
  await page.waitForSelector('.mmd-presets');
  await page.click('.dlg .btn-primary');
  await page.waitForSelector('.mmd-export-live');
  await sleep(1200);
  await page.click('.dlg .dlg-buttons .btn');
  ok((await exportP2) === null, 'Cancel during export resolves null');
  await sleep(500);
  ok(await page.evaluate(() => !window.app.exporting && !window.app.exporter.busy), 'exporter idle after cancel');
  ok(await page.evaluate(() => [...document.querySelectorAll('#toast-root .toast')].some((t) => /canceled/.test(t.textContent))), 'cancel toast shown');

  // export error state (forced)
  await page.evaluate(() => {
    window.__origExport = window.app.exporter.exportMovie;
    window.app.exporter.exportMovie = async () => { const e = new Error('The browser stopped recording the movie (EncodingError). Try a lower resolution or another format.'); e.friendly = true; throw e; };
  });
  const exportP3 = page.evaluate(() => window.app.dialogs.openExport('hd720'));
  await page.waitForSelector('.mmd-presets');
  await page.click('.dlg .btn-primary');
  await page.waitForSelector('.mmd-error-text');
  await shot(page, 'desktop-export-error');
  await page.click('.dlg .btn-primary'); // Try again → back to settings
  await page.waitForSelector('.mmd-presets');
  ok(true, 'Try again returns to the settings');
  await page.keyboard.press('Escape');
  await exportP3;
  await page.evaluate(() => { window.app.exporter.exportMovie = window.__origExport; });

  const benign = errors.filter((e) => !/favicon|Failed to load resource/.test(e));
  ok(benign.length === 0, `no page errors (${benign.join(' | ')})`);
  await context.close();
}

async function phone(browser) {
  console.log('phone 390x844 (touch)');
  const { context, page, errors } = await boot(browser, {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  }, 'phone');

  // app menu = full-height sheet
  await page.evaluate(() => { window.app.dialogs.openAppMenu(); });
  await page.waitForSelector('.app-menu');
  await sleep(300);
  await shot(page, 'phone-appmenu');
  await page.tap('.app-menu-item.mmd-has-sub');
  await sleep(300);
  ok(await page.evaluate(() => document.querySelector('.app-menu-side .app-menu-heading').textContent === 'Save movie'), 'phone: tapping Save movie shows presets');
  await shot(page, 'phone-appmenu-savemovie');
  // Android back closes the menu
  await page.evaluate(() => history.back());
  await sleep(400);
  ok(await page.evaluate(() => !document.querySelector('.app-menu')), 'phone: Back closes the menu');

  // confirm as bottom sheet; back closes it
  const confirmP = page.evaluate(() => window.app.dialogs.confirm('Delete this clip?'));
  await page.waitForSelector('.dlg.dlg-sheet');
  await sleep(300);
  await shot(page, 'phone-confirm-sheet');
  await page.evaluate(() => history.back());
  ok((await confirmP) === false, 'phone: Back closes the sheet → false');
  await sleep(300);

  // nested: dialog closed by button keeps history consistent
  const p1 = page.evaluate(() => window.app.dialogs.notify('Movie Maker', 'Hello'));
  await page.waitForSelector('.dlg .btn-primary');
  await page.tap('.dlg .btn-primary');
  await p1;
  await sleep(400);
  const len = await page.evaluate(() => history.length);
  const p2 = page.evaluate(() => window.app.dialogs.notify('Movie Maker', 'Second'));
  await page.waitForSelector('.dlg .btn-primary');
  await page.evaluate(() => history.back());
  await p2;
  ok(true, `phone: history stays consistent (length ${len})`);
  await sleep(300);

  // export settings as a sheet with the keep-screen-on note
  const exportP = page.evaluate(() => window.app.dialogs.openExport());
  await page.waitForSelector('.mmd-presets');
  await sleep(300);
  ok(await page.evaluate(() => /Keep this screen on/.test(document.querySelector('.dlg-body').textContent)), 'phone: keep-screen-on note');
  await shot(page, 'phone-export-settings');
  await page.tap('.mmd-preset >> nth=5');
  await page.tap('.dlg .btn-primary');
  await page.waitForSelector('.mmd-export-live');
  await sleep(2000);
  await shot(page, 'phone-export-progress');
  await page.waitForSelector('.mmd-saved', { timeout: 40000 });
  await sleep(300);
  await shot(page, 'phone-export-saved');
  ok(await page.evaluate(() => [...document.querySelectorAll('.dlg-buttons .btn')].some((b) => /Save to device/.test(b.textContent))), 'phone: “Save to device” button');
  await page.evaluate(() => window.app.dialogs.closeAll());
  await exportP;
  await sleep(300);

  // trim tool as a bottom sheet
  const vid = await page.evaluate(() => window.T.fixture.vid.id);
  const trimP = page.evaluate((id) => window.app.dialogs.openTrim(id), vid);
  await page.waitForSelector('.mmd-trim');
  await sleep(500);
  ok(await page.evaluate(() => document.querySelector('.mmd-trim').classList.contains('is-sheet')), 'phone: trim tool is a bottom sheet');
  const hb = await page.locator('.mmd-trim-handle.is-end').boundingBox();
  const tb = await page.locator('.mmd-trim-track').boundingBox();
  // touch drag of the end handle via CDP touch events
  const cdp = await context.newCDPSession(page);
  const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await tp('touchStart', hb.x + hb.width / 2, hb.y + hb.height / 2);
  for (let i = 1; i <= 6; i++) await tp('touchMove', hb.x + hb.width / 2 - (hb.x - (tb.x + tb.width * 0.6)) * (i / 6), hb.y + hb.height / 2);
  await tp('touchEnd', 0, 0);
  await sleep(300);
  const endVal = await page.evaluate(() => parseFloat(document.querySelectorAll('.mmd-trim-controls input[type=number]')[1].value));
  ok(endVal > 1.9 && endVal < 2.9, `phone: dragging the end handle by touch (${endVal})`);
  await shot(page, 'phone-trim');
  await page.tap('.mmd-trim .mmd-trim-cancel');
  await trimP;
  await sleep(300);

  // webcam + narration sheets
  const camP = page.evaluate(() => window.app.dialogs.openWebcam());
  await page.waitForSelector('.mmd-rec-btn:not([disabled])', { timeout: 15000 });
  await sleep(500);
  await shot(page, 'phone-webcam');
  await page.evaluate(() => window.app.dialogs.closeAll());
  ok((await camP) === null, 'phone: closing the webcam resolves null');
  const narrP = page.evaluate(() => window.app.dialogs.openNarration());
  await page.waitForSelector('.mmd-narr .mmd-rec-btn:not([disabled])', { timeout: 15000 });
  await sleep(500);
  await shot(page, 'phone-narration');
  await page.evaluate(() => window.app.dialogs.closeAll());
  await narrP;

  // projects / about / help / prompt sheets
  const projP = page.evaluate(() => window.app.dialogs.openProjects());
  await page.waitForSelector('.mmd-projects');
  await sleep(500);
  await shot(page, 'phone-projects');
  await page.evaluate(() => window.app.dialogs.closeAll());
  await projP;
  const helpP = page.evaluate(() => window.app.dialogs.openHelp());
  await page.waitForSelector('.mmd-help');
  await sleep(300);
  await shot(page, 'phone-help');
  await page.evaluate(() => window.app.dialogs.closeAll());
  await helpP;
  const aboutP = page.evaluate(() => window.app.dialogs.openAbout());
  await page.waitForSelector('.mmd-about');
  await sleep(300);
  await shot(page, 'phone-about');
  await page.evaluate(() => window.app.dialogs.closeAll());
  await aboutP;
  const promptP = page.evaluate(() => window.app.dialogs.promptText('Rename project', 'My Movie'));
  await page.waitForSelector('.dlg input');
  const fs = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.dlg input')).fontSize));
  ok(fs >= 16, `phone: input font-size ≥ 16px (${fs})`);
  await page.evaluate(() => { document.querySelector('.dlg input').blur(); window.app.dialogs.toast('Your project has been saved on this device.', { type: 'success' }); });
  await sleep(300);
  await shot(page, 'phone-prompt-toast');
  await page.evaluate(() => window.app.dialogs.closeAll());
  await promptP;

  const benign = errors.filter((e) => !/favicon|Failed to load resource/.test(e));
  ok(benign.length === 0, `phone: no page errors (${benign.join(' | ')})`);
  await context.close();
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
try {
  await desktop(browser);
  await phone(browser);
} catch (err) {
  failures += 1;
  console.error('FATAL', err);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} failure(s). Screenshots: ${OUT}` : `\nAll dialog checks passed. Screenshots: ${OUT}`);
process.exit(failures ? 1 : 0);
