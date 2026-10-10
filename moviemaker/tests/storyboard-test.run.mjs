// Storyboard + preview self-test (owner: E). Drives tests/storyboard-test.html (fake store/player/
// commands with generated filmstrips, real renderer) in headless Chromium: desktop (mouse) and an
// iPhone-sized touch device (touch input through CDP). Asserts behaviour and writes screenshots.
//
//   npx http-server moviemaker -p 8105 -c-1 --silent &
//   node moviemaker/tests/storyboard-test.run.mjs [outDir]

import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/opt/node22/lib/node_modules/playwright'); }
const { chromium, devices } = playwright;

const URL = process.env.SB_TEST_URL || 'http://127.0.0.1:8105/tests/storyboard-test.html';
const OUT = process.argv[2] || join(os.tmpdir(), 'storyboard-shots');
mkdirSync(OUT, { recursive: true });

let failures = 0, passes = 0;
function check(cond, msg, extra) {
  if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}${extra !== undefined ? ` -- ${JSON.stringify(extra)}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(URL);
  await page.waitForFunction(() => window.T && window.T.ready);
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

const rectOf = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }, sel);
const lastLog = (page, name) => page.evaluate((n) => { const l = T.log.filter((x) => x[0] === n); return l.length ? l[l.length - 1][1] : undefined; }, name);
const logCount = (page, name) => page.evaluate((n) => T.log.filter((x) => x[0] === n).length, name);
const sel = (page) => page.evaluate(() => ({ type: T.store.selection.type, ids: T.store.selection.ids.slice() }));
const time = (page) => page.evaluate(() => T.player.currentTime);
const resetProject = (page) => page.evaluate(() => { T.store.replaceProject(T.buildProject()); T.log.length = 0; T.store.setView({ zoom: 40 }); });

// ------------------------------------------------------------------------------------------ desktop
async function desktop(browser) {
  console.log('\n# desktop 1280x760 (mouse)');
  const { ctx, page, errors } = await open(browser, { viewport: { width: 1280, height: 760 } });

  // ---- layout
  const L = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.sb-item')];
    return {
      focusable: document.querySelectorAll('.sb-item[role=button]').length,
      pieces: items.length,
      tops: [...new Set(items.map((e) => Math.round(e.getBoundingClientRect().top)))].length,
      musicPieces: document.querySelectorAll('.sb-bar[data-id="music-a1"]').length,
      trans: document.querySelectorAll('.sb-trans').length,
      pz: document.querySelectorAll('.sb-item[data-id="item-p1"] .sb-pz').length,
      missing: document.querySelectorAll('.sb-item[data-id="item-missing"] .sb-missing').length,
      waves: document.querySelectorAll('.sb-wave').length,
      tip: (document.querySelector('.sb-item[data-id="item-v1"]') || {}).title,
      aria: (document.querySelector('.sb-item[data-id="item-p1"]') || { getAttribute: () => '' }).getAttribute('aria-label'),
      narration: document.querySelectorAll('.sb-narration').length,
      credits: document.querySelectorAll('.sb-credits').length,
      firstTile: (document.querySelector('.sb-item[data-id="item-v1"] img.sb-tile') || {}).src || '',
      phone: document.querySelector('.sb-root').classList.contains('is-phone'),
    };
  });
  check(!L.phone, 'desktop layout mode');
  check(L.focusable === 6, '6 focusable storyboard items', L.focusable);
  check(L.tops >= 2, 'items wrap onto several rows', L.tops);
  check(L.musicPieces >= 2, 'long music bar wraps across rows', L.musicPieces);
  check(L.trans === 3, 'transition markers on the 3 items with transitions', L.trans);
  check(L.pz === 1, 'pan & zoom marker on the photo');
  check(L.missing === 1, 'missing media shows a placeholder');
  check(L.waves >= 2, 'waveforms drawn into music bars', L.waves);
  check(/Beach walk\.mp4\nDuration: 00:08\.00/.test(L.tip || ''), 'desktop tooltip has name + duration', L.tip);
  check(/Photo 2 of 6: Sunset\.jpg, 00:07\.00, transition crossfade, pan and zoom/.test(L.aria || ''), 'aria-label describes the item', L.aria);
  check(L.narration === 1 && L.credits === 1, 'narration and credits bars styled');
  check(L.firstTile.startsWith('blob:'), 'filmstrip tiles use cached object URLs');
  await page.screenshot({ path: join(OUT, 'desktop-storyboard.png') });

  // ---- click selects + seeks
  const p1 = await rectOf(page, '.sb-item[data-id="item-p1"]');
  await page.mouse.click(p1.x + p1.w * 0.6, p1.cy);
  let s = await sel(page);
  check(s.type === 'item' && s.ids.join() === 'item-p1', 'click selects the item', s);
  const segP1 = await page.evaluate(() => { const g = T.store.timeline.segments[1]; return [g.start, g.end]; });
  let t = await time(page);
  check(t > segP1[0] && t < segP1[1], 'click moves the playhead inside the clicked item', { t, segP1 });
  const ph = await page.evaluate(() => { const m = /translate3d\(([\d.]+)px,\s*([\d.]+)px/.exec(document.querySelector('.sb-playhead').style.transform); return m ? [+m[1], +m[2]] : null; });
  const content = await rectOf(page, '.sb-content');
  check(ph && Math.abs(content.x + ph[0] - (p1.x + p1.w * 0.6)) < 3, 'playhead drawn at the click position', { ph, x: p1.x + p1.w * 0.6 - content.x });
  check(await page.evaluate(() => document.querySelector('.sb-item[data-id="item-p1"]').classList.contains('is-selected')), 'selected item highlighted');

  // ---- ctrl / shift multi-select
  const t1 = await rectOf(page, '.sb-item[data-id="item-t1"]');
  await page.keyboard.down('Control');
  await page.mouse.click(t1.cx, t1.cy);
  await page.keyboard.up('Control');
  s = await sel(page);
  check(s.ids.join() === 'item-p1,item-t1', 'ctrl+click adds to the selection', s);
  const v2 = await rectOf(page, '.sb-item[data-id="item-v2"]');
  await page.keyboard.down('Shift');
  await page.mouse.click(v2.cx, v2.cy);
  await page.keyboard.up('Shift');
  s = await sel(page);
  check(s.ids.join() === 'item-t1,item-p2,item-v2', 'shift+click selects a range', s);

  // ---- keyboard: arrows move the selection
  const v1 = await rectOf(page, '.sb-item[data-id="item-v1"]');
  await page.mouse.click(v1.cx, v1.cy);
  await page.keyboard.press('ArrowRight');
  s = await sel(page);
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.dataset.id);
  check(s.ids.join() === 'item-p1' && focused === 'item-p1', 'ArrowRight moves selection + focus to the next item', { s, focused });
  const tabStops = await page.evaluate(() => [...document.querySelectorAll('.sb-item[tabindex="0"]')].map((e) => e.dataset.id));
  check(tabStops.join() === 'item-p1', 'roving tabindex follows the selection', tabStops);

  // ---- blank click: deselect + seek
  const sc = await rectOf(page, '.sb-scroll');
  await page.mouse.click(sc.x + sc.w - 40, sc.y + sc.h - 30);
  s = await sel(page);
  check(s.type === null, 'clicking empty storyboard clears the selection', s);

  // ---- drag reorder (mouse)
  await resetProject(page);
  await page.waitForTimeout(100);
  const a = await rectOf(page, '.sb-item[data-id="item-v1"]');
  const b = await rectOf(page, '.sb-item[data-id="item-t1"]');
  await page.mouse.move(a.cx, a.cy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.cx + (b.x + b.w * 0.8 - a.cx) * i / 12, a.cy + (b.cy - a.cy) * i / 12);
  const mid = await page.evaluate(() => ({ caret: !document.querySelector('.sb-caret').hidden, ghost: !!document.querySelector('.sb-ghost'), dragging: document.querySelectorAll('.sb-item.is-dragging').length }));
  await page.screenshot({ path: join(OUT, 'desktop-drag.png') });
  await page.mouse.up();
  check(mid.caret && mid.ghost && mid.dragging > 0, 'drag shows ghost + insertion caret', mid);
  const mv = await lastLog(page, 'moveItem');
  check(mv && mv.id === 'item-v1' && mv.toIndex === 2, 'drop runs moveItem with the final index', mv);
  const order = await page.evaluate(() => T.store.project.items.map((i) => i.id).join());
  check(order.startsWith('item-p1,item-t1,item-v1'), 'storyboard re-rendered in the new order', order);
  check(!(await page.evaluate(() => !!document.querySelector('.sb-ghost'))), 'ghost removed after drop');

  // ---- small mouse jitter is a click, not a drag
  await resetProject(page);
  const c1 = await rectOf(page, '.sb-item[data-id="item-p2"]');
  await page.mouse.move(c1.cx, c1.cy); await page.mouse.down(); await page.mouse.move(c1.cx + 3, c1.cy + 1); await page.mouse.up();
  check((await logCount(page, 'moveItem')) === 0 && (await sel(page)).ids.join() === 'item-p2', '3px jitter selects instead of dragging');

  // ---- drag a narration bar (with snapping)
  const nb = await rectOf(page, '.sb-bar[data-id="music-n1"]');
  await page.mouse.move(nb.x + 10, nb.cy); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(nb.x + 10 + i * 6, nb.cy);
  const tip = await page.evaluate(() => { const e = document.querySelector('.sb-tip'); return e && !e.hidden ? e.textContent : null; });
  await page.mouse.up();
  const mm = await lastLog(page, 'moveMusic');
  check(mm && mm.id === 'music-n1' && mm.start > 6.5 && mm.start < 8, 'dragging a narration bar runs moveMusic', mm);
  check(/^Start: \d\d:\d\d\.\d\d$/.test(tip || ''), 'start-time tip shown while dragging a bar', tip);
  // snapping: drag the caption so its start lands within 8px of the boundary at 8s (video end)
  await resetProject(page);
  const cb = await rectOf(page, '.sb-bar[data-id="text-c1"]');
  const zoom = await page.evaluate(() => T.store.view.zoom);
  // caption starts at 2s; move ~ (8 - 2) s minus 5px: should snap to a boundary
  const dx = await page.evaluate(() => {
    const sb = T.app.storyboard; const L = sb._m.L;
    return L.timeToX(8) - L.timeToX(2) - 5;
  });
  await page.mouse.move(cb.x + 6, cb.cy); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cb.x + 6 + dx * i / 10, cb.cy);
  await page.mouse.up();
  const mt = await lastLog(page, 'moveText');
  const bounds = await page.evaluate(() => T.store.timeline.segments.flatMap((g) => [g.start, g.end]));
  check(mt && mt.id === 'text-c1' && bounds.some((x) => Math.abs(x - mt.start) < 1e-3), 'caption drag snaps to an item boundary', { mt, zoom });

  // ---- double-click → contextual tab
  await resetProject(page);
  const p2 = await rectOf(page, '.sb-item[data-id="item-p2"]');
  await page.mouse.dblclick(p2.cx, p2.cy);
  await page.waitForTimeout(80);
  let tabs = await page.evaluate(() => T.ribbonTabs.slice());
  check(tabs.length && tabs[tabs.length - 1].tab === 'edit', 'double-click on a photo opens the Edit tab', tabs);
  const mb = await rectOf(page, '.sb-bar[data-id="music-a1"]');
  await page.mouse.dblclick(mb.x + 30, mb.cy);
  tabs = await page.evaluate(() => T.ribbonTabs.slice());
  check(tabs[tabs.length - 1].tab === 'music', 'double-click on music opens the Music tab', tabs[tabs.length - 1]);
  const capb = await rectOf(page, '.sb-bar[data-id="text-c1"]');
  await page.mouse.dblclick(capb.x + 20, capb.cy);
  await page.waitForTimeout(80);
  tabs = await page.evaluate(() => T.ribbonTabs.slice());
  const editing = await page.evaluate(() => T.app.preview.editingTextId);
  check(tabs[tabs.length - 1].tab === 'text' && editing === 'text-c1', 'double-click on a caption opens Text tab + inline editing', { tab: tabs[tabs.length - 1], editing });
  await page.keyboard.press('Escape');
  check(!(await page.evaluate(() => T.app.preview.editingTextId)), 'Escape ends inline editing');

  // ---- context menu
  const vv = await rectOf(page, '.sb-item[data-id="item-v2"]');
  await page.mouse.click(vv.cx, vv.cy, { button: 'right' });
  await page.waitForTimeout(50);
  const pop = await page.evaluate(() => [...document.querySelectorAll('.sb-pop .sb-pop-item')].map((b) => b.textContent + (b.disabled ? '(off)' : '')));
  check(pop.join() === 'Edit,Trim,Split,Duplicate,Remove', 'right-click shows the action popover', pop);
  await page.screenshot({ path: join(OUT, 'desktop-popover.png') });
  await page.evaluate(() => [...document.querySelectorAll('.sb-pop .sb-pop-item')].find((b) => b.textContent === 'Remove').click());
  const removed = await page.evaluate(() => !T.store.project.items.some((i) => i.id === 'item-v2'));
  check(removed && !(await page.evaluate(() => !!document.querySelector('.sb-pop'))), 'popover Remove runs remove and closes');
  await page.mouse.click(p2.cx, p2.cy, { button: 'right' });
  await page.mouse.click(5, 5);
  check(!(await page.evaluate(() => !!document.querySelector('.sb-pop'))), 'popover closes on outside click');

  // ---- ctrl+wheel zoom
  await resetProject(page);
  const z0 = await page.evaluate(() => T.store.view.zoom);
  await page.mouse.move(sc.cx, sc.cy);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await page.waitForTimeout(100);
  const z1 = await page.evaluate(() => T.store.view.zoom);
  check(z1 > z0, 'ctrl+wheel zooms in', { z0, z1 });
  await page.evaluate(() => T.store.setView({ zoom: 40 }));
  await page.waitForTimeout(50);

  // ---- thumb size changes row height
  const h0 = (await rectOf(page, '.sb-item[data-id="item-v1"]')).h;
  await page.evaluate(() => T.store.setView({ thumbSize: 'large' }));
  await page.waitForTimeout(60);
  const h1 = (await rectOf(page, '.sb-item[data-id="item-v1"]')).h;
  check(h1 > h0, 'thumbSize large makes items taller', { h0, h1 });
  await page.evaluate(() => T.store.setView({ thumbSize: 'medium' }));
  await page.waitForTimeout(60);

  // ---- playhead handle drag
  await page.evaluate(() => T.player.seek(1));
  await page.waitForTimeout(30);
  const hd = await rectOf(page, '.sb-ph-handle');
  await page.mouse.move(hd.cx, hd.cy); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(hd.cx + i * 20, hd.cy + 10);
  await page.mouse.up();
  t = await time(page);
  check(t > 3.5 && t < 5, 'dragging the playhead handle scrubs', t);

  // ---- playback follows across rows
  await page.evaluate(() => { T.store.setView({ zoom: 160 }); });
  await page.waitForTimeout(60);
  const st0 = await page.evaluate(() => { const s = document.querySelector('.sb-scroll'); s.scrollTop = 0; return s.scrollTop; });
  await page.evaluate(() => { window.__speed = 12; T.player.seek(0); T.player.play(); });
  await page.waitForTimeout(1600);
  const st1 = await page.evaluate(() => { T.player.pause(); window.__speed = 1; return document.querySelector('.sb-scroll').scrollTop; });
  check(st1 > st0, 'storyboard scrolls to follow the playhead during playback', { st0, st1 });
  await page.evaluate(() => T.store.setView({ zoom: 40 }));

  // ---- empty state
  await page.evaluate(() => { T.store.replaceProject({ ...T.buildProject(), items: [], texts: [], music: [] }); });
  await page.waitForTimeout(60);
  const empty = await page.evaluate(() => { const b = document.querySelector('.sb-empty-btn'); return b ? b.textContent : null; });
  check(empty && empty.includes('Click here to browse for videos and photos') && empty.includes('or drag them here'), 'empty state text (desktop)', empty);
  await page.screenshot({ path: join(OUT, 'desktop-empty.png') });
  await page.click('.sb-empty-btn');
  check((await logCount(page, 'addMedia')) === 1, 'empty state click runs addMedia');
  await resetProject(page);
  await page.waitForTimeout(60);
  check(!(await page.evaluate(() => !!document.querySelector('.sb-empty'))), 'empty state removed when content returns');

  await previewDesktop(page);
  check(errors.length === 0, 'no console errors (desktop)', errors);
  await ctx.close();
}

async function previewDesktop(page) {
  console.log('\n# preview (desktop)');
  const pv = await page.evaluate(() => {
    const c = T.app.preview.canvas.getBoundingClientRect();
    const s = document.querySelector('.pv-stage').getBoundingClientRect();
    return { cw: c.width, ch: c.height, sw: s.width, sh: s.height, cx: c.x + c.width / 2 - (s.x + s.width / 2), cy: c.y + c.height / 2 - (s.y + s.height / 2) };
  });
  check(Math.abs(pv.cw / pv.ch - 16 / 9) < 0.02 && Math.abs(pv.cx) < 2 && Math.abs(pv.cy) < 2, 'canvas keeps 16:9 and is centered (letterboxed)', pv);
  await page.evaluate(() => T.store.update((p) => { p.aspect = '9:16'; }));
  await page.waitForTimeout(80);
  const pv2 = await page.evaluate(() => { const c = T.app.preview.canvas.getBoundingClientRect(); return c.width / c.height; });
  check(Math.abs(pv2 - 9 / 16) < 0.02, 'canvas follows a portrait project aspect', pv2);
  await page.evaluate(() => T.store.update((p) => { p.aspect = '16:9'; }));
  await page.waitForTimeout(80);

  const txt = await page.textContent('.pv-time');
  check(/^\d\d:\d\d\.\d\d\/\d\d:\d\d\.\d\d$/.test(txt), 'time readout format', txt);

  // play / pause
  await page.click('.pv-play');
  await page.waitForTimeout(250);
  const playing = await page.evaluate(() => ({ p: T.player.playing, label: document.querySelector('.pv-play').getAttribute('aria-label'), log: T.log.some((l) => l[0] === 'togglePlay') }));
  check(playing.p && playing.label === 'Pause' && playing.log, 'play button runs togglePlay and shows Pause', playing);
  const tPlaying = await page.textContent('.pv-time');
  await page.click('.pv-play');
  check(!(await page.evaluate(() => T.player.playing)) && tPlaying !== '00:00.00/00:31.00', 'second click pauses; time readout advanced', tPlaying);

  // seek slider
  const sk = await rectOf(page, '.pv-seekbar');
  await page.mouse.move(sk.x + sk.w * 0.25, sk.cy); await page.mouse.down();
  await page.mouse.move(sk.x + sk.w * 0.5, sk.cy, { steps: 5 });
  await page.mouse.up();
  let t = await time(page);
  const dur = await page.evaluate(() => T.player.duration);
  check(Math.abs(t - dur / 2) < dur * 0.02, 'seek slider scrubs the player', { t, dur });
  const fill = await page.evaluate(() => document.querySelector('.pv-seek-fill').style.transform);
  check(/scaleX\(0\.4\d|scaleX\(0\.5/.test(fill), 'slider fill follows the time', fill);
  // keyboard on slider
  await page.focus('.pv-seekbar');
  await page.keyboard.press('Home');
  check((await time(page)) === 0, 'Home on the slider seeks to the start');

  // next / previous frame
  await page.click('.pv-next');
  t = await time(page);
  check(Math.abs(t - 1 / 30) < 1e-6, 'next frame steps 1/30 s', t);
  await page.click('.pv-prev');
  check((await time(page)) === 0, 'previous frame steps back');

  // caption: tap selects, second tap edits
  await page.evaluate(() => T.player.seek(3));
  await page.waitForTimeout(50);
  const box = await page.evaluate(() => {
    const pv = T.app.preview; const fr = pv._frameRect(); const it = T.store.find('text-c1').obj; const b = pv._textBox(it.text, it.style, fr);
    const s = document.querySelector('.pv-stage').getBoundingClientRect();
    return { x: s.x + pv.stage.clientLeft + fr.x + b.x, y: s.y + pv.stage.clientTop + fr.y + b.y, w: b.width, h: b.height };
  });
  await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
  let s = await sel(page);
  check(s.type === 'text' && s.ids[0] === 'text-c1', 'tapping a caption in the preview selects it', s);
  const selBox = await rectOf(page, '.pv-text-sel');
  check(selBox && Math.abs(selBox.x - box.x) < 2 && Math.abs(selBox.w - box.w) < 2, 'dashed selection box drawn around the caption', { selBox, box });
  await page.waitForTimeout(400);
  await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
  const ed = await page.evaluate(() => {
    const e = document.querySelector('.pv-text-editor'); if (!e) return null;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { x: r.x, y: r.y, w: r.width, h: r.height, value: e.value, focused: document.activeElement === e, hidden: T.player.hideTextIds && [...T.player.hideTextIds], color: cs.color, align: cs.textAlign };
  });
  check(ed && ed.focused && ed.value === 'Hello world', 'second tap opens the inline editor with the text', ed);
  check(ed && Math.abs(ed.y - box.y) < 2 && Math.abs(ed.h - box.h) < 4 && Math.abs((ed.x + ed.w / 2) - (box.x + box.w / 2)) < 3, 'editor sits over the text box', { ed, box });
  check(ed && ed.hidden && ed.hidden.join() === 'text-c1', 'renderer told to hide the edited text', ed && ed.hidden);
  await page.screenshot({ path: join(OUT, 'desktop-inline-edit.png') });
  await page.keyboard.press('End');
  await page.keyboard.type(' there');
  const grow = await page.evaluate(() => document.querySelector('.pv-text-editor').getBoundingClientRect().width);
  check(grow > ed.w + 10, 'editor grows while typing', { before: ed.w, after: grow });
  await page.keyboard.press('Enter');
  const te = await lastLog(page, 'textEdit');
  const stored = await page.evaluate(() => T.store.find('text-c1').obj.text);
  check(te === 'Hello world there' && stored === 'Hello world there', 'Enter commits through textEdit', { te, stored });
  check(await page.evaluate(() => !document.querySelector('.pv-text-editor') && !T.player.hideTextIds && !T.app.preview.editingTextId), 'editor closed and text shown again');

  // Shift+Enter inserts a newline; blur commits
  await page.evaluate(() => T.app.preview.editText('text-c1'));
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line 2');
  const sc = await rectOf(page, '.sb-scroll');
  await page.mouse.click(sc.x + sc.w - 30, sc.y + sc.h - 20);
  await page.waitForTimeout(50);
  const stored2 = await page.evaluate(() => T.store.find('text-c1').obj.text);
  check(stored2 === 'Hello world there\nline 2', 'Shift+Enter newline; clicking elsewhere commits', stored2);

  // title: Escape cancels
  const nLogs = await logCount(page, 'textEdit');
  await page.evaluate(() => T.app.preview.editText('item-t1'));
  await page.waitForTimeout(50);
  const tEd = await page.evaluate(() => { const e = document.querySelector('.pv-text-editor'); return e && { v: e.value, caretEnd: e.selectionStart === e.value.length, t: T.player.currentTime }; });
  check(tEd && tEd.v === 'My Holiday' && tEd.caretEnd, 'editText(title) opens with the caret after the text', tEd);
  const seg = await page.evaluate(() => { const g = T.store.timeline.segments.find((x) => x.item.id === 'item-t1'); return [g.start, g.end]; });
  check(tEd && tEd.t >= seg[0] && tEd.t < seg[1], 'editText seeks to where the title is visible', { t: tEd && tEd.t, seg });
  await page.keyboard.type('Something else');
  await page.keyboard.press('Escape');
  check((await logCount(page, 'textEdit')) === nLogs && (await page.evaluate(() => T.store.find('item-t1').obj.text)) === 'My Holiday', 'Escape cancels without saving');

  // a new caption with the default text opens with everything selected (type to replace)
  await page.evaluate(() => { T.store.update((p) => { p.texts.push({ ...T.store.find('text-c2').obj, id: 'text-new', text: 'Enter text here', start: 9, duration: 3 }); }); });
  await page.evaluate(() => T.app.preview.editText('text-new'));
  const dflt = await page.evaluate(() => { const e = document.querySelector('.pv-text-editor'); return e && e.selectionStart === 0 && e.selectionEnd === e.value.length; });
  check(dflt, 'default caption text is pre-selected for typing over');
  await page.keyboard.type('Brand new');
  await page.keyboard.press('Enter');
  check((await page.evaluate(() => T.store.find('text-new').obj.text)) === 'Brand new', 'typing replaces the default text');

  // ribbon formatting keeps the editor open (soft commit)
  await page.evaluate(() => T.player.seek(3));
  await page.evaluate(() => T.app.preview.editText('text-c1'));
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.click('#ribbon [data-act="textBold"]');
  await page.waitForTimeout(80);
  const soft = await page.evaluate(() => ({ editing: T.app.preview.editingTextId, text: T.store.find('text-c1').obj.text, bold: T.store.find('text-c1').obj.style.bold, fw: getComputedStyle(document.querySelector('.pv-text-editor')).fontWeight }));
  check(soft.editing === 'text-c1' && soft.text.endsWith('!') && soft.bold && soft.fw === '700', 'ribbon click saves text, keeps editing, restyles editor', soft);
  check(await page.evaluate(() => document.activeElement === document.querySelector('.pv-text-editor')), 'caret returns to the editor after a ribbon button');
  await page.keyboard.type('?');
  await page.keyboard.press('Escape');
  check(!(await page.evaluate(() => T.app.preview.editingTextId)), 'Escape ends editing after ribbon formatting');

  // double-click on the picture (no text there) toggles playback
  await page.evaluate(() => T.player.seek(0.5));
  const cv = await rectOf(page, '.pv-canvas');
  await page.mouse.dblclick(cv.x + 20, cv.y + 20);
  await page.waitForTimeout(60);
  const pl = await page.evaluate(() => T.player.playing);
  await page.evaluate(() => T.player.pause());
  check(pl, 'double-click on the picture plays');

  // fullscreen: real API
  await page.click('.pv-fs');
  await page.waitForTimeout(300);
  const fs1 = await page.evaluate(() => ({ real: document.fullscreenElement === document.getElementById('preview-pane'), pseudo: document.getElementById('app').classList.contains('is-pseudo-fullscreen'), label: document.querySelector('.pv-fs').getAttribute('aria-label') }));
  check((fs1.real || fs1.pseudo) && fs1.label === 'Exit full screen', 'full screen button enters full screen', fs1);
  await page.click('.pv-fs');
  await page.waitForTimeout(300);
  const fs2 = await page.evaluate(() => ({ real: !!document.fullscreenElement, pseudo: document.getElementById('app').classList.contains('is-pseudo-fullscreen') }));
  check(!fs2.real && !fs2.pseudo, 'full screen button exits again', fs2);
  // fullscreen: iPhone-like (no element full screen) → CSS pseudo full screen
  await page.evaluate(() => { for (const k of ['fullscreenEnabled', 'webkitFullscreenEnabled']) Object.defineProperty(document, k, { value: false, configurable: true }); });
  await page.click('.pv-fs');
  await page.waitForTimeout(200);
  const ps = await page.evaluate(() => { const c = T.app.preview.canvas.getBoundingClientRect(); return { pseudo: document.getElementById('app').classList.contains('is-pseudo-fullscreen'), exit: !!document.querySelector('.pv-fs-exit'), cw: c.width, ch: c.height }; });
  check(ps.pseudo && ps.exit && ps.cw > 1000, 'pseudo full screen overlay when element full screen is unavailable', ps);
  await page.screenshot({ path: join(OUT, 'desktop-pseudo-fullscreen.png') });
  await page.click('.pv-fs-exit');
  await page.waitForTimeout(150);
  check(!(await page.evaluate(() => document.getElementById('app').classList.contains('is-pseudo-fullscreen') || !!document.querySelector('.pv-fs-exit'))), 'exit button leaves pseudo full screen');
}

// ------------------------------------------------------------------------------------------ phone
async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i, radiusX: 4, radiusY: 4, force: 1 })) });
}
async function swipe(cdp, x0, y0, x1, y1, steps = 10, holdMs = 0) {
  await touch(cdp, 'touchStart', [[x0, y0]]);
  if (holdMs) await sleep(holdMs);
  for (let i = 1; i <= steps; i++) { await touch(cdp, 'touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); await sleep(16); }
  await touch(cdp, 'touchEnd', []);
}

async function phone(browser) {
  console.log('\n# phone (iPhone 13 emulation, touch)');
  const dev = { ...devices['iPhone 13'] };
  delete dev.defaultBrowserType;
  const { ctx, page, errors } = await open(browser, dev);
  const cdp = await ctx.newCDPSession(page);

  const info = await page.evaluate(() => ({
    phone: document.querySelector('.sb-root').classList.contains('is-phone'),
    fixed: getComputedStyle(document.querySelector('.sb-fixed-ph')).display,
    chip: document.querySelector('.sb-ph-time').textContent,
    rows: [...new Set([...document.querySelectorAll('.sb-item')].map((e) => Math.round(e.getBoundingClientRect().top)))].length,
    add: !!document.querySelector('.sb-add-tile'),
    timeInSeekRow: !!document.querySelector('.pv-seekrow .pv-time'),
    timeFits: (() => { const e = document.querySelector('.pv-time'); return e.scrollWidth <= e.clientWidth + 1; })(),
    sl: document.querySelector('.sb-scroll').scrollLeft,
  }));
  check(info.phone && info.fixed === 'block', 'phone filmstrip mode with fixed centered playhead', info);
  check(info.rows === 1, 'single horizontal lane', info.rows);
  check(info.add, "'+' tile at the end of the strip");
  check(info.timeInSeekRow && info.timeFits, 'time readout moved next to the seek bar and not clipped', info);
  await page.screenshot({ path: join(OUT, 'phone-storyboard.png') });

  // scrolling seeks (user scroll)
  const sc = await rectOf(page, '.sb-scroll');
  const lane = await rectOf(page, '.sb-item[data-id="item-v1"]');
  await swipe(cdp, sc.x + sc.w * 0.8, lane.cy, sc.x + sc.w * 0.2, lane.cy, 12);
  await page.waitForTimeout(400);
  const scr = await page.evaluate(() => ({ sl: document.querySelector('.sb-scroll').scrollLeft, t: T.player.currentTime, x: T.app.storyboard._m.L.timeToX(T.player.currentTime), chip: document.querySelector('.sb-ph-time').textContent }));
  check(scr.sl > 100 && scr.t > 1 && Math.abs(scr.x - scr.sl) < 4, 'swiping the strip scrolls it and seeks the player to the centre', scr);

  // tap selects (no seek on phone)
  await page.evaluate(() => { T.player.seek(0); });
  await page.waitForTimeout(350);
  const it = await rectOf(page, '.sb-item[data-id="item-v1"]');
  await page.touchscreen.tap(it.x + Math.min(it.w - 10, 60), it.cy);
  await page.waitForTimeout(50);
  let s = await sel(page);
  check(s.ids.join() === 'item-v1' && (await time(page)) === 0, 'tap selects without moving the fixed playhead', s);

  // double tap → contextual tab
  await page.touchscreen.tap(it.x + 40, it.cy);
  await page.waitForTimeout(60);
  await page.touchscreen.tap(it.x + 40, it.cy);
  await page.waitForTimeout(80);
  const tabs = await page.evaluate(() => T.ribbonTabs.slice());
  check(tabs.length && tabs[tabs.length - 1].tab === 'edit', 'double-tap opens the Edit tab', tabs);

  // long press (no move) → popover
  await page.waitForTimeout(450);
  await touch(cdp, 'touchStart', [[it.x + 40, it.cy]]);
  await sleep(500);
  const armed = await page.evaluate(() => document.querySelectorAll('.sb-item.is-armed').length);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(60);
  const pop = await page.evaluate(() => [...document.querySelectorAll('.sb-pop .sb-pop-item')].map((b) => b.textContent));
  check(armed > 0, 'long-press arms the item (visual feedback)');
  check(pop.join() === 'Edit,Trim,Split,Duplicate,Remove', 'long-press without moving shows the action popover', pop);
  await page.screenshot({ path: join(OUT, 'phone-popover.png') });
  await page.touchscreen.tap(10, 300);
  await page.waitForTimeout(50);
  check(!(await page.evaluate(() => !!document.querySelector('.sb-pop'))), 'tapping elsewhere closes the popover');

  // long press + move → drag reorder
  await page.evaluate(() => { T.log.length = 0; });
  const t1 = await page.evaluate(() => { const L = T.app.storyboard._m.L; return L.timeToX(10); });
  await page.evaluate(() => T.player.seek(0));
  await page.waitForTimeout(350);
  const a = await rectOf(page, '.sb-item[data-id="item-v1"]');
  await touch(cdp, 'touchStart', [[a.x + 30, a.cy]]);
  await sleep(450);
  for (let i = 1; i <= 15; i++) { await touch(cdp, 'touchMove', [[a.x + 30 + i * 14, a.cy]]); await sleep(16); }
  const mid = await page.evaluate(() => ({ caret: !document.querySelector('.sb-caret').hidden, ghost: !!document.querySelector('.sb-ghost') }));
  await page.screenshot({ path: join(OUT, 'phone-drag.png') });
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(80);
  const mv = await lastLog(page, 'moveItem');
  check(mid.caret && mid.ghost, 'touch drag shows ghost + caret', mid);
  check(mv && mv.id === 'item-v1' && mv.toIndex >= 1, 'long-press + drag reorders (moveItem)', { mv, t1 });

  // quick swipe starting on an item must scroll, not drag
  await page.evaluate(() => { T.log.length = 0; T.player.seek(0); });
  await page.waitForTimeout(350);
  const b0 = await rectOf(page, '.sb-item');
  await swipe(cdp, Math.min(b0.x + b0.w - 10, 360), b0.cy, Math.min(b0.x + b0.w - 10, 360) - 160, b0.cy, 8);
  await page.waitForTimeout(300);
  const qs = { moves: await logCount(page, 'moveItem'), sl: await page.evaluate(() => document.querySelector('.sb-scroll').scrollLeft), b0 };
  check(qs.moves === 0 && qs.sl > 50, 'a quick swipe on an item scrolls instead of dragging', qs);

  // pinch to zoom
  const z0 = await page.evaluate(() => T.store.view.zoom);
  const cy = lane.cy, cx = sc.cx;
  await touch(cdp, 'touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 10; i++) { await touch(cdp, 'touchMove', [[cx - 40 - i * 8, cy], [cx + 40 + i * 8, cy]]); await sleep(20); }
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(150);
  const z1 = await page.evaluate(() => T.store.view.zoom);
  check(z1 > z0 * 1.5, 'pinch-out zooms the strip in', { z0, z1 });
  const centred = await page.evaluate(() => { const sb = T.app.storyboard; return Math.abs(sb._m.L.timeToX(T.player.currentTime) - document.querySelector('.sb-scroll').scrollLeft); });
  check(centred < 4, 'current time stays under the playhead after zooming', centred);
  const pinchState = await page.evaluate(() => ({ pinch: T.app.storyboard._pinch, stale: document.querySelectorAll('.sb-layer.is-stale').length }));
  check(pinchState.pinch === null && pinchState.stale === 0, 'pinch over items ends cleanly (touch targets kept alive during re-render)', pinchState);
  await page.evaluate(() => T.store.setView({ zoom: 40 }));
  await page.waitForTimeout(80);

  // playback scrolls the strip
  await page.evaluate(() => { T.player.seek(0); });
  await page.waitForTimeout(350);
  await page.evaluate(() => { window.__speed = 4; T.player.play(); });
  await page.waitForTimeout(700);
  const pb = await page.evaluate(() => { const r = { sl: document.querySelector('.sb-scroll').scrollLeft, x: T.app.storyboard._m.L.timeToX(T.player.currentTime) }; T.player.pause(); window.__speed = 1; return r; });
  check(pb.sl > 40 && Math.abs(pb.sl - pb.x) < 30, 'playback scrolls the strip under the fixed playhead', pb);
  // touching the strip while playing pauses
  await page.evaluate(() => T.player.play());
  await page.waitForTimeout(100);
  await page.touchscreen.tap(sc.x + 20, sc.y + sc.h - 10);
  await page.waitForTimeout(60);
  check(!(await page.evaluate(() => T.player.playing)), 'touching the strip pauses playback');

  // '+' tile
  await page.evaluate(() => { T.log.length = 0; const s = document.querySelector('.sb-scroll'); T.player.seek(T.player.duration); s.scrollLeft = s.scrollWidth; });
  await page.waitForTimeout(400);
  const add = await rectOf(page, '.sb-add-tile');
  await page.touchscreen.tap(add.cx, add.cy);
  await page.waitForTimeout(50);
  check((await logCount(page, 'addMedia')) === 1, "'+' tile runs addMedia", add);

  // bar long-press drag (caption)
  await page.evaluate(() => { T.log.length = 0; T.player.seek(2); });
  await page.waitForTimeout(400);
  const cb = await rectOf(page, '.sb-bar[data-id="text-c1"]');
  await touch(cdp, 'touchStart', [[cb.x + 20, cb.cy]]);
  await sleep(450);
  for (let i = 1; i <= 8; i++) { await touch(cdp, 'touchMove', [[cb.x + 20 + i * 10, cb.cy]]); await sleep(16); }
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(60);
  const mt = await lastLog(page, 'moveText');
  check(mt && mt.id === 'text-c1' && mt.start > 2, 'long-press + drag moves a caption bar', mt);

  // inline editing on phone: font size never below 16px (no iOS zoom), scaled visually
  await page.evaluate(() => { T.store.replaceProject(T.buildProject()); T.player.seek(3); });
  await page.waitForTimeout(300);
  await page.evaluate(() => T.app.preview.editText('text-c1'));
  await page.waitForTimeout(80);
  const ed = await page.evaluate(() => { const e = document.querySelector('.pv-text-editor'); const cs = getComputedStyle(e); return { fs: parseFloat(cs.fontSize), tr: cs.transform, focused: document.activeElement === e }; });
  check(ed.fs >= 16 && ed.tr !== 'none', 'phone editor keeps font-size >= 16px and scales down', ed);
  await page.screenshot({ path: join(OUT, 'phone-inline-edit.png') });
  await page.evaluate(() => T.app.preview.finishEditing(false));

  // empty state on phone
  await page.evaluate(() => { T.store.replaceProject({ ...T.buildProject(), items: [], texts: [], music: [] }); });
  await page.waitForTimeout(80);
  const emp = await page.evaluate(() => { const b = document.querySelector('.sb-empty-btn'); return b && b.textContent; });
  check(emp && emp.includes('Click here to browse for videos and photos') && !emp.includes('drag them'), 'phone empty state (no drag hint)', emp);
  await page.screenshot({ path: join(OUT, 'phone-empty.png') });

  check(errors.length === 0, 'no console errors (phone)', errors);
  await ctx.close();
}

async function phoneLandscape(browser) {
  console.log('\n# phone landscape + orientation change');
  const dev = { ...devices['iPhone 13 landscape'] };
  delete dev.defaultBrowserType;
  const { ctx, page, errors } = await open(browser, dev);
  const info = await page.evaluate(() => ({ phone: document.querySelector('.sb-root').classList.contains('is-phone'), items: document.querySelectorAll('.sb-item[role=button]').length }));
  check(info.phone && info.items === 6, 'landscape phone uses the filmstrip lane', info);
  await page.screenshot({ path: join(OUT, 'phone-landscape.png') });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => document.querySelector('.sb-root').classList.contains('is-phone'));
  // (pointer: coarse) stays on in a touch emulation; a 1200px wide viewport is no longer phone-sized.
  check(after === false, 're-layout on resize switches to the wrapped timeline', after);
  check(errors.length === 0, 'no console errors (landscape)', errors);
  await ctx.close();
}

async function narrowDesktop(browser) {
  console.log('\n# narrow desktop window 700x800 (mouse): filmstrip lane');
  const { ctx, page, errors } = await open(browser, { viewport: { width: 700, height: 800 } });
  check(await page.evaluate(() => document.querySelector('.sb-root').classList.contains('is-phone')), 'narrow window uses the single-lane strip');
  const sc = await rectOf(page, '.sb-scroll');
  const it = await rectOf(page, '.sb-item[data-id="item-v1"]');
  // drag the empty area left of the strip start to pan
  await page.mouse.move(sc.x + 40, it.cy); await page.mouse.down();
  await page.mouse.move(sc.x + 40 - 150, it.cy, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(150);
  const pan = await page.evaluate(() => ({ sl: document.querySelector('.sb-scroll').scrollLeft, t: T.player.currentTime, sel: T.store.selection.type }));
  check(pan.sl > 100 && pan.t > 1, 'mouse drag on empty strip area pans and seeks', pan);
  await page.mouse.move(sc.cx, it.cy);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(200);
  const wh = await page.evaluate(() => document.querySelector('.sb-scroll').scrollLeft);
  check(wh > pan.sl + 100, 'vertical mouse wheel scrolls the strip sideways', { before: pan.sl, after: wh });
  check(errors.length === 0, 'no console errors (narrow)', errors);
  await ctx.close();
}

const browser = await chromium.launch();
try {
  await desktop(browser);
  await phone(browser);
  await phoneLandscape(browser);
  await narrowDesktop(browser);
} catch (err) {
  failures++;
  console.error('test crashed:', err);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed. Screenshots: ${OUT}`);
process.exitCode = failures ? 1 : 0;
