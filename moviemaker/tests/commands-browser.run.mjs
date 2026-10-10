// Integration check (owner: G): js/commands.js + js/automovie.js inside the real app (index.html)
// with real media import, dialogs, ribbon, storyboard, player and persistence, in headless Chromium.
//   npx http-server moviemaker -p 8107 -c-1 --silent &
//   NODE_PATH=/opt/node22/lib/node_modules node moviemaker/tests/commands-browser.run.mjs [outDir]
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/opt/node22/lib/node_modules/playwright'); }
const { chromium, devices } = playwright;
const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CMD_URL || 'http://127.0.0.1:8107/';
const OUT = process.argv[2] || join(os.tmpdir(), 'commands-shots');
mkdirSync(OUT, { recursive: true });
const FIX = join(HERE, 'fixtures');

let fails = 0;
let passes = 0;
const check = (c, m, x) => {
  if (c) { passes++; console.log('  ok  ', m); } else { fails++; console.log('  FAIL', m, x === undefined ? '' : JSON.stringify(x)); }
};

async function boot(browser, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}index.html?nosw`);
  await page.waitForFunction(() => window.app && window.app.commands && window.app.ribbon && window.app.storyboard, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  // Helper inside the page: fixtures as File objects.
  await page.evaluate(() => {
    window.fx = async (name, type) => {
      const r = await fetch(`tests/fixtures/${name}`);
      return new File([await r.blob()], name, { type });
    };
    window.toasts = () => Array.from(document.querySelectorAll('#toast-root .toast')).map((t) => t.textContent.trim());
  });
  return { ctx, page, errs };
}

async function desktop(browser) {
  console.log('\n# desktop (1366x800)');
  const { ctx, page, errs } = await boot(browser, { viewport: { width: 1366, height: 800 } });

  // --- addMedia through the real file picker
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    page.evaluate(() => { window.__p = window.app.commands.run('addMedia'); }),
  ]);
  check(chooser.isMultiple(), 'picker allows several files');
  await chooser.setFiles([join(FIX, 'clip1.webm'), join(FIX, 'photo1.jpg'), join(FIX, 'portrait.webm'), join(FIX, 'photo2.png')]);
  await page.evaluate(() => window.__p);
  let s = await page.evaluate(() => {
    const st = app.store;
    return {
      kinds: st.project.items.map((i) => i.kind),
      sel: st.selection.ids.length,
      durs: st.timeline.segments.map((x) => +x.duration.toFixed(2)),
      label: st.undoLabel,
      tiles: document.querySelectorAll('#storyboard-pane .sb-item').length,
    };
  });
  check(s.kinds.join() === 'video,image,video,image', 'four items imported in order', s.kinds);
  check(s.sel === 4, 'new items selected', s.sel);
  check(Math.abs(s.durs[0] - 4) < 0.15 && s.durs[1] === 7 && Math.abs(s.durs[2] - 3) < 0.15, 'real durations (video 4s, photo 7s, video 3s)', s.durs);
  check(s.label === 'Add videos and photos', 'one labelled undo step', s.label);
  check(s.tiles >= 4, 'storyboard shows the items', s.tiles);

  // --- addMusic with File objects (drag & drop path)
  const music = await page.evaluate(async () => {
    const f = await fx('music.ogg', 'audio/ogg');
    const ids = await app.commands.run('addMusic', [f]);
    await new Promise((r) => setTimeout(r, 300));
    const m = app.store.find(ids[0]).obj;
    const media = app.store.getMedia(m.mediaId);
    return { start: m.start, dur: +app.store.timeline.music[0].end.toFixed(2), peaks: !!(media.peaks && media.peaks.length), sel: app.store.selection.type };
  });
  check(music.start === 0 && Math.abs(music.dur - 8) < 0.2, 'music at the start, 8s long', music);
  check(music.peaks, 'music waveform peaks computed');
  check(music.sel === 'music', 'music selected (Music Tools tab)');
  const ctxTab = await page.evaluate(() => {
    const t = document.querySelector('[role="tab"][aria-selected="true"]');
    return t ? t.textContent.trim() : '';
  });
  check(/Options/.test(ctxTab), 'contextual Music Tools › Options tab active', ctxTab);

  // --- split the first video at 1.5s (real player clock)
  const split = await page.evaluate(async () => {
    const st = app.store;
    st.select('item', st.project.items[0].id);
    await app.player.seek(1.5);
    const id = app.commands.run('split');
    const a = st.project.items[0];
    const b = st.find(id).obj;
    return { aEnd: a.trimEnd, bStart: b.trimStart, n: st.project.items.length, d0: +st.timeline.segments[0].duration.toFixed(3), d1: +st.timeline.segments[1].duration.toFixed(3) };
  });
  check(Math.abs(split.aEnd - 1.5) < 1e-6 && Math.abs(split.bStart - 1.5) < 1e-6 && split.n === 5, 'video split at the playhead', split);
  check(Math.abs(split.d0 - 1.5) < 0.01 && Math.abs(split.d0 + split.d1 - 4) < 0.15, 'halves add up', split);

  // --- title with inline editing on the preview
  const title = await page.evaluate(async () => {
    const st = app.store;
    st.select('item', st.project.items[1].id);
    const id = app.commands.run('addTitle');
    await new Promise((r) => setTimeout(r, 200));
    const ae = document.activeElement;
    return { id, idx: st.project.items.findIndex((i) => i.id === id), editing: !!(ae && (ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.tagName === 'INPUT')), editingId: app.preview.editingTextId };
  });
  check(title.idx === 1, 'title inserted before the selected item', title);
  check(title.editing && title.editingId === title.id, 'inline text editor opened on the preview', title);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Summer 2026');
  await page.evaluate(() => app.preview.finishEditing(true));
  const titleText = await page.evaluate((id) => app.store.find(id).obj.text, title.id);
  check(titleText === 'Summer 2026', 'typed text committed through textEdit', titleText);

  // --- caption + text tools
  const cap = await page.evaluate(async () => {
    app.preview.finishEditing && app.preview.finishEditing(true);
    await app.player.seek(9);
    const id = app.commands.run('addCaption');
    app.preview.finishEditing && app.preview.finishEditing(true);
    app.commands.run('textSet', { key: 'color', value: '#ffcc00' });
    app.commands.run('textEffect', 'fly-left');
    const c = app.store.find(id).obj;
    return { start: c.start, color: c.style.color, effect: c.effect, checked: app.commands.isChecked('textEffect', 'fly-left') };
  });
  check(Math.abs(cap.start - 9) < 1e-6 && cap.color === '#ffcc00' && cap.effect === 'fly-left' && cap.checked, 'caption at the playhead, formatted', cap);

  // --- AutoMovie and undo
  const am = await page.evaluate(async () => {
    const st = app.store;
    const before = st.project.items.length;
    const res = app.commands.run('autoMovie', 'cinematic');
    await new Promise((r) => setTimeout(r, 100));
    const after = {
      n: st.project.items.length,
      trans: st.project.items.slice(1).every((i) => i.transition.type === 'fade-black'),
      credits: st.project.texts.filter((t) => t.kind === 'credits').length,
      label: st.undoLabel,
      firstTitle: st.project.items[0].kind === 'title' && st.project.items[0].text === st.project.name,
    };
    app.commands.run('undo');
    return { before, res: !!(res && res.ok), after, undone: st.project.items.length, credits: st.project.texts.filter((t) => t.kind === 'credits').length };
  });
  check(am.res && am.after.trans && am.after.credits === 1, 'AutoMovie applied transitions and credits', am);
  check(am.after.n === am.before + 1 && am.after.firstTitle, 'opening title (project name) added because the movie starts with a video', am);
  check(am.credits === 0, 'one undo step reverts AutoMovie', am);

  // --- copy / paste / remove / undo
  const cp = await page.evaluate(() => {
    const st = app.store;
    const id = st.project.items[2].id;
    st.select('item', id);
    app.commands.run('copy');
    const [nid] = app.commands.run('paste');
    const n1 = st.project.items.length;
    app.commands.run('remove');
    const n2 = st.project.items.length;
    app.commands.run('undo');
    return { pastedAfter: st.project.items.findIndex((i) => i.id === nid) === 3, n1, n2, n3: st.project.items.length };
  });
  check(cp.pastedAfter && cp.n2 === cp.n1 - 1 && cp.n3 === cp.n1, 'copy/paste/remove/undo', cp);

  // --- effects & ribbon state
  const fx = await page.evaluate(async () => {
    const st = app.store;
    st.select('item', st.project.items[2].id);
    app.commands.run('setEffect', 'sepia');
    app.commands.run('setTransition', 'crossfade');
    await new Promise((r) => setTimeout(r, 250));
    const btn = document.querySelector('.rb-gallery [data-id="sepia"], [data-cmd="setEffect"] [data-id="sepia"]');
    return { effect: st.project.items[2].effect, checked: app.commands.isChecked('setEffect', 'sepia'), trans: st.project.items[2].transition.type };
  });
  check(fx.effect === 'sepia' && fx.checked && fx.trans === 'crossfade', 'effect + transition applied', fx);

  // --- playback through commands
  const pb = await page.evaluate(async () => {
    await app.commands.run('goStart');
    await app.commands.run('play');
    await new Promise((r) => setTimeout(r, 1200));
    const t = app.player.currentTime;
    app.commands.run('pause');
    return { t, playing: app.player.playing };
  });
  check(pb.t > 0.5 && !pb.playing, 'play advances the clock, pause stops', pb);

  // --- snapshot inserts a real PNG photo
  const snap = await page.evaluate(async () => {
    await app.player.seek(0.5);
    const st = app.store;
    st.select(null, []);
    const n = st.project.items.length;
    const id = await app.commands.run('snapshot');
    const it = id && st.find(id);
    const m = it && st.getMedia(it.obj.mediaId);
    return { added: st.project.items.length === n + 1, kind: it && it.obj.kind, w: m && m.width, idx: it && it.index };
  });
  check(snap.added && snap.kind === 'image' && snap.w > 0 && snap.idx === 1, 'snapshot added as a photo after the item under the playhead', snap);

  // --- fit to music, emphasize, aspect
  const proj = await page.evaluate(async () => {
    app.commands.run('fitToMusic');
    const tl = app.store.timeline;
    const t1 = toasts();
    app.commands.run('emphasize', 'narration');
    app.commands.run('setAspect', '9:16');
    return { aspect: app.store.project.aspect, emph: app.store.project.emphasize, msgs: t1, visEnd: tl.segments.at(-1).end };
  });
  check(proj.aspect === '9:16' && proj.emph === 'narration', 'aspect + emphasize narration', proj);
  check(proj.msgs.some((m) => /shorter than your videos/.test(m)), 'fit to music explains why it cannot fit (8s music < videos)', proj.msgs);

  // --- save project (dialogs helper) and list it
  const saved = await page.evaluate(async () => {
    await app.commands.run('saveProject');
    const list = await app.persist.listProjects();
    return { found: list.some((p) => p.id === app.store.project.id), toasts: toasts() };
  });
  check(saved.found, 'project saved to IndexedDB', saved);

  // --- busy guard while exporting
  const busy = await page.evaluate(() => {
    app.exporting = true;
    const en = app.commands.isEnabled('remove');
    const r = app.commands.run('addTitle');
    app.exporting = false;
    return { en, r: r === undefined };
  });
  check(!busy.en && busy.r, 'editing blocked while a movie is being saved', busy);

  await page.screenshot({ path: join(OUT, 'commands-desktop.png') });
  check(!errs.length, 'no console errors', errs.slice(0, 5));
  await ctx.close();
}

async function phone(browser) {
  console.log('\n# phone (Pixel-like, touch)');
  const desc = devices['Pixel 7'] || devices['Pixel 5'] || { viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const { ctx, page, errs } = await boot(browser, { ...desc });
  const r = await page.evaluate(async () => {
    const files = [await fx('portrait.webm', 'video/webm'), await fx('photo2.png', 'image/png')];
    const ids = await app.commands.run('addMedia', files);
    app.commands.run('setAspect', '9:16');
    await app.player.seek(1);
    app.store.select(null, []);
    const sid = app.commands.run('split');
    app.commands.run('addCaption');
    app.preview.finishEditing && app.preview.finishEditing(true);
    const res = app.commands.run('autoMovie', 'contemporary');
    return { ids: ids.length, split: !!sid, items: app.store.project.items.length, auto: !!(res && res.ok), dur: app.store.timeline.duration };
  });
  check(r.ids === 2 && r.split && r.auto && r.items === 4, 'phone: import, split at playhead, caption, AutoMovie', r);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'commands-phone.png') });
  check(!errs.length, 'phone: no console errors', errs.slice(0, 5));
  await ctx.close();
}

const browser = await chromium.launch();
try {
  await desktop(browser);
  await phone(browser);
} catch (err) {
  fails++;
  console.log('  FAIL (exception)', err && err.stack ? err.stack : err);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${fails} failed  (screenshots in ${OUT})`);
process.exitCode = fails ? 1 : 0;
