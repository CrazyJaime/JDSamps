// Shell / ribbon self-test (owner: D). Drives tests/shell-test.html (real index.html markup +
// real Store + mock commands) in headless Chromium at desktop, narrow-desktop, phone portrait
// and phone landscape sizes. Asserts behaviour, writes screenshots for visual review.
//
//   npx http-server moviemaker -p 8104 -c-1 --silent &
//   node moviemaker/tests/shell-test.run.mjs [outDir]
//
// Playwright is resolved from NODE_PATH or /opt/node22/lib/node_modules.

import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/opt/node22/lib/node_modules/playwright'); }
const { chromium } = playwright;

const BASE = process.env.SHELL_TEST_URL || 'http://localhost:8104/tests/shell-test.html';
const OUT = process.argv[2] || join(os.tmpdir(), 'shell-shots');
mkdirSync(OUT, { recursive: true });

let failures = 0;
let passes = 0;
function check(cond, msg) {
  if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); }
}

// Every ribbon-facing command of the contract's command table.
const RIBBON_COMMANDS = [
  'addMedia', 'addMusic', 'addMusicAtPlayhead', 'webcam', 'narration', 'snapshot', 'addTitle', 'addCaption', 'addCredits',
  'autoMovie', 'cut', 'copy', 'paste', 'remove', 'selectAll', 'rotateLeft', 'rotateRight',
  'setTransition', 'setTransitionDuration', 'applyTransitionAll', 'setPanZoom', 'applyPanZoomAll', 'setEffect', 'applyEffectAll',
  'setBrightness', 'setAspect', 'setAudioMix', 'emphasize', 'fitToMusic', 'zoomIn', 'zoomOut', 'setThumbSize', 'toggleWaveforms',
  'setPreviewSize', 'setVolume', 'setFadeIn', 'setFadeOut', 'setSpeed', 'setDuration', 'split', 'trimTool', 'setStartPoint',
  'setEndPoint', 'setBackground', 'musicVolume', 'musicFadeIn', 'musicFadeOut', 'musicStartTime', 'musicSetStartPoint',
  'musicSetEndPoint', 'musicSplit', 'textSet', 'textEdit', 'textDuration', 'textStartTime', 'textEffect', 'undo', 'redo',
  'saveProject', 'saveMovie', 'help',
];

async function open(browser, { width, height, mobile = false, scale = 1 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // The mock's addMedia rejects on purpose (to test the error toast); ignore that one.
  page.on('console', (m) => { if (m.type() === 'error' && !/No files were added/.test(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.goto(BASE);
  await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}

const setState = (page, type, key) => page.evaluate(([t, k]) => {
  mock.store.select(t, t ? mock.ids[k] : null);
}, [type, key]);

// Exercise every enabled control in the active panel; returns nothing (commands land in mock.log).
async function exercisePanel(page, restore) {
  const count = await page.evaluate(() => document.querySelectorAll('.rb-panel:not([hidden]) .rb-btn, .rb-panel:not([hidden]) select, .rb-panel:not([hidden]) input, .rb-panel:not([hidden]) .rb-gal-item').length);
  for (let i = 0; i < count; i++) {
    await restore();
    const kind = await page.evaluate((idx) => {
      const els = document.querySelectorAll('.rb-panel:not([hidden]) .rb-btn, .rb-panel:not([hidden]) select, .rb-panel:not([hidden]) input, .rb-panel:not([hidden]) .rb-gal-item');
      const el = els[idx];
      if (!el || el.disabled || !el.offsetParent) return 'skip';
      if (el.matches('.rb-gal-launch')) return 'skip';
      if (el.tagName === 'SELECT') {
        const opts = [...el.options].filter((o) => !o.disabled && o.value !== el.value);
        if (!opts.length) return 'skip';
        el.value = opts[opts.length - 1].value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'select';
      }
      if (el.tagName === 'INPUT' && el.type === 'range') {
        el.value = String((Number(el.min) + Number(el.max)) / 2 + Number(el.step || 1));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'range';
      }
      if (el.tagName === 'INPUT') {
        el.focus();
        el.value = '4.25';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'input';
      }
      if (el.getAttribute('aria-haspopup')) {
        el.click();
        return 'popup';
      }
      el.click();
      return 'click';
    }, i);
    if (process.env.SHELL_DEBUG) console.log('      control', i, kind, JSON.stringify(await page.evaluate(() => mock.log.slice(-2))));
    if (kind === 'popup') {
      await page.waitForTimeout(60);
      // click every item of the popup (re-open between items)
      const n = await page.evaluate(() => document.querySelectorAll('.rb-popup-layer .menu-item:not(:disabled), .rb-popup-layer .rb-swatch, .rb-popup-layer .rb-gal-item:not(:disabled)').length);
      const limit = Math.min(n, 12);
      for (let j = 0; j < limit; j++) {
        if (j > 0) {
          await restore();
          await page.evaluate((idx) => {
            const els = document.querySelectorAll('.rb-panel:not([hidden]) .rb-btn, .rb-panel:not([hidden]) select, .rb-panel:not([hidden]) input, .rb-panel:not([hidden]) .rb-gal-item');
            els[idx].click();
          }, i);
          await page.waitForTimeout(60);
        }
        await page.evaluate((jdx) => {
          const items = document.querySelectorAll('.rb-popup-layer .menu-item:not(:disabled), .rb-popup-layer .rb-swatch, .rb-popup-layer .rb-gal-item:not(:disabled)');
          if (items[jdx]) items[jdx].click();
        }, j);
      }
      await page.evaluate(() => mock.ribbon.popups.close());
    }
  }
}

const browser = await chromium.launch();
try {
  // =========================================================== desktop
  console.log('Desktop 1366x768');
  {
    const { page, errors } = await open(browser, { width: 1366, height: 768 });
    check(await page.evaluate(() => window.__shellIds.length === 0), 'index.html contains every contract DOM id');
    check(await page.evaluate(() => document.querySelectorAll('.rb-tabs > .rb-tab').length === 5), 'five regular tabs');
    check(await page.evaluate(() => [...document.querySelectorAll('.rb-ctx')].every((g) => g.hidden)), 'contextual tabs hidden without a selection');
    check(await page.evaluate(() => document.querySelector('.rb-tabrow').firstElementChild.id === 'app-menu-btn'), 'app button sits at the left of the tab row on desktop');
    check(await page.evaluate(() => document.title === 'Summer Trip - Movie Maker' && document.getElementById('doc-title').textContent === 'Summer Trip - Movie Maker'), 'document title follows the project name');
    await page.screenshot({ path: join(OUT, 'desktop-home.png') });

    // galleries disabled without selection
    await page.evaluate(() => mock.ribbon.activateTab('animations'));
    check(await page.evaluate(() => [...document.querySelectorAll('#rb-panel-animations .rb-gallery .rb-gal-item')].every((b) => b.disabled)), 'transition tiles disabled without a selection');

    // contextual tab auto-activation
    await setState(page, 'item', 'img2');
    await page.waitForTimeout(50);
    check(await page.evaluate(() => mock.ribbon.activeTab === 'animations'), 'selecting a clip keeps the Animations tab');
    check(await page.evaluate(() => !document.querySelector('.rb-ctx-video').hidden), 'Video Tools tab appears for a clip');
    check(await page.evaluate(() => document.querySelector('#rb-panel-animations .rb-gal-item.is-checked')?.dataset.id === 'crossfade'), 'current transition highlighted via commands.isChecked');
    check(await page.evaluate(() => document.querySelector('#rb-panel-animations .rb-combo-field input').value === '1.50'), 'transition duration shows the selected value');
    await page.click('#rb-panel-animations .rb-gal-item[data-id="wipe-left"]');
    await page.waitForTimeout(80);
    check(await page.evaluate(() => mock.log.some(([n, a]) => n === 'setTransition' && a === 'wipe-left')), 'clicking a gallery tile runs setTransition(id)');
    check(await page.evaluate(() => document.querySelector('#rb-panel-animations .rb-gal-item.is-checked')?.dataset.id === 'wipe-left'), 'highlight moves to the applied transition');

    // hover animation changes pixels
    // hover a tile on the currently visible gallery row (not the checked one)
    await page.waitForTimeout(250);
    const hoverSel = await page.evaluate(() => {
      for (const [gi, g] of [...document.querySelectorAll('#rb-panel-animations .rb-gallery')].entries()) {
        const view = g.querySelector('.rb-gal-view').getBoundingClientRect();
        const t = [...g.querySelectorAll('.rb-gal-item:not(.is-checked)')].find((b) => {
          const r = b.getBoundingClientRect();
          return r.top >= view.top - 1 && r.bottom <= view.bottom + 1 && r.left >= view.left && r.right <= view.right;
        });
        if (t) return `#rb-panel-animations .rb-gallery:nth-of-type(1) .rb-gal-item[data-id="${t.dataset.id}"]|${gi}|${t.dataset.id}`;
      }
      return null;
    });
    const [, gIdx, hoverId] = hoverSel.split('|');
    const tileSel = `#rb-panel-animations .rb-group:nth-child(${Number(gIdx) + 1}) .rb-gallery .rb-gal-item[data-id="${hoverId}"]`;
    const before = await page.evaluate((s) => document.querySelector(`${s} canvas`).toDataURL(), tileSel);
    await page.hover(tileSel);
    await page.waitForTimeout(500);
    const during = await page.evaluate((s) => document.querySelector(`${s} canvas`).toDataURL(), tileSel);
    check(before !== during, 'hovering a gallery tile animates its preview');
    await page.mouse.move(5, 700);

    // expand gallery
    await page.click('#rb-panel-animations .rb-gal-scroll button:last-child');
    await page.waitForTimeout(250);
    check(await page.evaluate(() => document.querySelectorAll('.rb-popup .rb-gal-full-heading').length >= 5), 'expanded gallery is grouped by catalog group');
    await page.screenshot({ path: join(OUT, 'desktop-gallery-expanded.png') });
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => !document.querySelector('.rb-popup')), 'Escape closes the expanded gallery');

    await setState(page, 'item', 'vid');
    await page.waitForTimeout(50);
    check(await page.evaluate(() => mock.ribbon.activeTab === 'animations'), 'switching clips on Animations stays on Animations');
    await page.evaluate(() => mock.ribbon.activateTab('home'));
    await setState(page, null);
    await page.waitForTimeout(30);
    await setState(page, 'item', 'vid');
    await page.waitForTimeout(50);
    check(await page.evaluate(() => mock.ribbon.activeTab === 'ctx-video'), 'Video Tools › Edit auto-activates for a clip');
    check(await page.evaluate(() => document.querySelector('#rb-panel-ctx-video .rb-value').textContent === '100%'), 'video volume shows 100%');
    await page.screenshot({ path: join(OUT, 'desktop-video-tools.png') });
    await setState(page, 'item', 'ttl');
    await page.waitForTimeout(50);
    check(await page.evaluate(() => mock.ribbon.activeTab === 'ctx-text'), 'Text Tools › Format auto-activates for a title');
    check(await page.evaluate(() => !document.querySelector('.rb-ctx-video').hidden && !document.querySelector('.rb-ctx-text').hidden), 'title shows both Video Tools and Text Tools');
    await page.screenshot({ path: join(OUT, 'desktop-text-tools.png') });
    await setState(page, 'text', 'cap');
    await page.waitForTimeout(50);
    check(await page.evaluate(() => document.querySelectorAll('#rb-panel-ctx-text select')[1].value === '6'), 'caption size select shows the caption style');
    await setState(page, 'music', 'mus');
    await page.waitForTimeout(50);
    check(await page.evaluate(() => mock.ribbon.activeTab === 'ctx-music'), 'Music Tools › Options auto-activates for music');
    await page.screenshot({ path: join(OUT, 'desktop-music-tools.png') });
    await setState(page, null);
    await page.waitForTimeout(50);
    check(await page.evaluate(() => mock.ribbon.activeTab === 'home'), 'clearing the selection returns to the last regular tab');

    // split menu (Save movie)
    await page.click('#rb-panel-home .rb-split:last-of-type .rb-split-menu, #rb-panel-home [aria-label="Save movie options"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => document.querySelectorAll('.rb-popup .menu-item').length >= 6), 'Save movie menu lists the export presets');
    await page.screenshot({ path: join(OUT, 'desktop-save-movie-menu.png') });
    await page.click('.rb-popup .menu-item >> nth=2');
    check(await page.evaluate(() => mock.log.some(([n, a]) => n === 'saveMovie' && a === 'hd720')), 'choosing a preset runs saveMovie(presetId)');

    // QAT + app menu + status
    await page.click('#qat [data-cmd="undo"]');
    check(await page.evaluate(() => mock.log.some(([n]) => n === 'undo')), 'QAT undo runs the undo command');
    await page.click('#app-menu-btn');
    check(await page.evaluate(() => mock.log.some(([n]) => n === 'openAppMenu')), 'app button opens dialogs.openAppMenu()');
    check(await page.evaluate(() => /^Item \d of 4/.test(document.getElementById('status-text').textContent)), 'status bar shows "Item x of N"');
    await page.evaluate(() => { const r = document.querySelector('#status-controls .rb-range'); r.value = '80'; r.dispatchEvent(new Event('input')); });
    check(await page.evaluate(() => mock.store.view.zoom > 100), 'status bar zoom slider changes view.zoom');

    // failing async command → friendly toast
    await page.evaluate(() => mock.ribbon.activateTab('home'));
    await page.click('#rb-panel-home [data-cmd="addMedia"]');
    await page.waitForTimeout(100);
    check(await page.evaluate(() => mock.toasts.some(([m, t]) => t === 'error' && /No files/.test(m))), 'rejected command shows an error toast');

    // keyboard tab navigation
    await page.focus('#rb-tab-home');
    await page.keyboard.press('ArrowRight');
    check(await page.evaluate(() => mock.ribbon.activeTab === 'animations' && document.activeElement.id === 'rb-tab-animations'), 'ArrowRight moves to the next tab');

    // full screen preview toggles and restores
    await page.evaluate(() => mock.ribbon.activateTab('view'));
    await page.click('#rb-panel-view [data-cmd="fullscreen"]');
    await page.waitForTimeout(300);
    const fsOn = await page.evaluate(() => !!(document.fullscreenElement || document.getElementById('app').classList.contains('is-pseudo-fullscreen')));
    check(fsOn, 'Preview full screen enters full screen (API or fallback)');
    await page.evaluate(() => mock.ribbon._toggleFullscreen());
    await page.waitForTimeout(300);
    check(await page.evaluate(() => !document.fullscreenElement && !document.getElementById('app').classList.contains('is-pseudo-fullscreen')), 'second press exits full screen');

    // command coverage: exercise every control in every tab for each selection type
    await page.evaluate(() => { mock.log.length = 0; });
    const states = [[null, null], ['item', 'img2'], ['item', 'vid'], ['item', 'ttl'], ['text', 'cap'], ['music', 'mus']];
    const tabs = ['home', 'animations', 'effects', 'project', 'view', 'ctx-video', 'ctx-music', 'ctx-text'];
    for (const [t, k] of states) {
      for (const tab of tabs) {
        const restore = async () => {
          await page.evaluate(([tt, kk, tb]) => {
            mock.ribbon.popups.close();
            mock.store.select(tt, tt ? mock.ids[kk] : null);
            mock.ribbon.refresh();
            mock.ribbon.activateTab(tb);
          }, [t, k, tab]);
        };
        await restore();
        if (await page.evaluate((tb) => mock.ribbon.activeTab !== tb, tab)) continue;
        await exercisePanel(page, restore);
      }
    }
    // the QAT and help button
    await page.evaluate(() => {
      document.querySelector('#qat [data-cmd="saveProject"]').click();
      for (const c of ['undo', 'redo']) { const b = document.querySelector(`#qat [data-cmd="${c}"]`); b.disabled = false; b.click(); }
    });
    await page.click('.rb-tabrow-end [aria-label="Help"]');
    const used = new Set(await page.evaluate(() => mock.log.map(([n]) => n)));
    const missing = RIBBON_COMMANDS.filter((c) => !used.has(c));
    check(missing.length === 0, `every ribbon-facing command is reachable from the UI${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    check(errors.length === 0, `no console errors on desktop${errors.length ? `: ${errors.slice(0, 5).join(' | ')}` : ''}`);
    await page.context().close();
  }

  // =========================================================== narrow desktop
  console.log('Narrow desktop 820x600');
  {
    const { page, errors } = await open(browser, { width: 820, height: 600 });
    for (const tab of ['home', 'animations', 'effects', 'project', 'view']) {
      await page.evaluate((tb) => mock.ribbon.activateTab(tb), tab);
      await page.waitForTimeout(50);
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(ov <= 0, `no page-level horizontal overflow on the ${tab} tab (${ov}px)`);
    }
    await page.evaluate(() => mock.ribbon.activateTab('home'));
    await page.screenshot({ path: join(OUT, 'narrow-home.png') });
    check(errors.length === 0, `no console errors (narrow)${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.context().close();
  }

  // =========================================================== tablet (touch, desktop layout)
  console.log('Tablet 1180x820 (touch, desktop layout)');
  {
    const { page, errors } = await open(browser, { width: 1180, height: 820, mobile: true });
    check(await page.evaluate(() => !mock.isPhone()), 'tablet keeps the desktop ribbon');
    for (const [t, k, tab] of [[null, null, 'home'], ['item', 'img2', 'animations'], ['text', 'cap', 'ctx-text'], ['music', 'mus', 'ctx-music']]) {
      await page.evaluate(([tt, kk, tb]) => { mock.store.select(tt, tt ? mock.ids[kk] : null); mock.ribbon.refresh(); mock.ribbon.activateTab(tb); }, [t, k, tab]);
      await page.waitForTimeout(60);
      const r = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        small: [...document.querySelectorAll('.rb-panel:not([hidden]) .rb-btn, .rb-tab')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 27).length,
        fonts: [...document.querySelectorAll('.rb-panel:not([hidden]) select, .rb-panel:not([hidden]) input:not([type=range])')].filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).length,
      }));
      check(r.overflow <= 0, `tablet ${tab}: no horizontal page overflow`);
      check(r.small === 0, `tablet ${tab}: touch-sized ribbon buttons`);
      check(r.fonts === 0, `tablet ${tab}: 16px inputs (no zoom on focus)`);
    }
    await page.screenshot({ path: join(OUT, 'tablet-music-tools.png') });
    check(errors.length === 0, `no console errors (tablet)${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.context().close();
  }

  // =========================================================== phone portrait
  console.log('Phone 390x844 (touch)');
  {
    const { page, errors } = await open(browser, { width: 390, height: 844, mobile: true, scale: 2 });
    check(await page.evaluate(() => mock.isPhone()), 'isPhone() is true');
    check(await page.evaluate(() => document.getElementById('titlebar').firstElementChild.id === 'app-menu-btn'), 'app button moves back into the title bar');
    check(await page.evaluate(() => getComputedStyle(document.getElementById('statusbar')).display === 'none'), 'status bar hidden on phones');
    await page.screenshot({ path: join(OUT, 'phone-home.png') });
    const tabsAll = ['home', 'animations', 'effects', 'project', 'view'];
    for (const tab of tabsAll) {
      await page.evaluate((tb) => mock.ribbon.activateTab(tb), tab);
      await page.waitForTimeout(40);
      const res = await page.evaluate(() => {
        const out = { overflow: document.documentElement.scrollWidth - innerWidth, small: [] };
        const sel = '.rb-panel:not([hidden]) button, .rb-panel:not([hidden]) select, .rb-panel:not([hidden]) input, #titlebar button, .rb-tab';
        for (const el of document.querySelectorAll(sel)) {
          if (!el.offsetParent) continue;
          const r = el.getBoundingClientRect();
          if (el.matches('input[type=range]')) { if (r.height < 28) out.small.push(`range ${r.height}`); continue; }
          if (el.matches('.rb-combo input, .rb-combo button, select')) { if (r.height < 34) out.small.push(`${el.tagName} ${Math.round(r.height)}`); continue; }
          if (r.height < 40 || r.width < 40) out.small.push(`${el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)} "${el.textContent.trim().slice(0, 16)}"`);
        }
        out.inputs = [...document.querySelectorAll('.rb-panel:not([hidden]) select, .rb-panel:not([hidden]) input:not([type=range])')]
          .filter((e) => e.offsetParent).map((e) => parseFloat(getComputedStyle(e).fontSize)).filter((f) => f < 16);
        return out;
      });
      check(res.overflow <= 0, `phone ${tab}: no horizontal page overflow`);
      check(res.small.length === 0, `phone ${tab}: tap targets >= 40px${res.small.length ? ` (${res.small.slice(0, 4).join('; ')})` : ''}`);
      check(res.inputs.length === 0, `phone ${tab}: inputs use >= 16px text (no zoom on focus)`);
    }
    check(await page.evaluate(() => { const t = document.querySelector('.rb-tabs'); return getComputedStyle(t).overflowX === 'auto'; }), 'tab strip scrolls horizontally');
    // contextual tabs + gallery sheet
    await setState(page, 'item', 'img2');
    await page.evaluate(() => mock.ribbon.activateTab('animations'));
    await page.waitForTimeout(80);
    await page.screenshot({ path: join(OUT, 'phone-animations.png') });
    await page.tap('#rb-panel-animations .rb-gal-launch');
    await page.waitForTimeout(400);
    check(await page.evaluate(() => !!document.querySelector('.rb-sheet .rb-gal-full-items')), 'gallery opens as a bottom sheet on phones');
    await page.screenshot({ path: join(OUT, 'phone-gallery-sheet.png') });
    const ov2 = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(ov2 <= 0, 'gallery sheet causes no horizontal overflow');
    await page.tap('.rb-sheet .rb-gal-item[data-id="diamond"]');
    await page.waitForTimeout(350);
    check(await page.evaluate(() => mock.log.some(([n, a]) => n === 'setTransition' && a === 'diamond') && !document.querySelector('.rb-sheet')), 'tapping a sheet tile applies it and closes the sheet');
    await setState(page, 'item', 'ttl');
    await page.waitForTimeout(80);
    await page.screenshot({ path: join(OUT, 'phone-text-tools.png') });
    for (const tab of ['ctx-video', 'ctx-text']) {
      await page.evaluate((tb) => mock.ribbon.activateTab(tb), tab);
      await page.waitForTimeout(40);
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(ov <= 0, `phone ${tab}: no horizontal page overflow`);
    }
    await setState(page, 'music', 'mus');
    await page.waitForTimeout(80);
    await page.screenshot({ path: join(OUT, 'phone-music-tools.png') });
    // Save movie from the title bar + split menu as a sheet
    await page.evaluate(() => { mock.store.select(null); mock.ribbon.activateTab('home'); });
    await page.tap('#qat .qat-save-movie');
    check(await page.evaluate(() => mock.log.some(([n]) => n === 'saveMovie')), 'title bar Save button runs saveMovie');
    await page.evaluate(() => { const p = document.getElementById('rb-panel-home'); p.scrollLeft = p.scrollWidth; });
    await page.tap('#rb-panel-home [aria-label="Save movie options"]');
    await page.waitForTimeout(400);
    check(await page.evaluate(() => !!document.querySelector('.rb-sheet .menu-item')), 'split-button menu opens as a bottom sheet');
    await page.screenshot({ path: join(OUT, 'phone-save-sheet.png') });
    check(errors.length === 0, `no console errors on phone${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.context().close();
  }

  // =========================================================== phone landscape
  console.log('Phone landscape 844x390 (touch)');
  {
    const { page, errors } = await open(browser, { width: 844, height: 390, mobile: true, scale: 2 });
    const r = await page.evaluate(() => {
      const pv = document.getElementById('preview-pane').getBoundingClientRect();
      const sb = document.getElementById('storyboard-pane').getBoundingClientRect();
      return { pvRight: pv.right, sbLeft: sb.left, pvH: pv.height, overflow: document.documentElement.scrollWidth - innerWidth, vOverflow: document.documentElement.scrollHeight - innerHeight };
    });
    check(r.pvRight <= r.sbLeft + 1, 'landscape: preview on the left, storyboard on the right');
    check(r.overflow <= 0 && r.vOverflow <= 0, 'landscape: no page overflow');
    check(r.pvH > 180, `landscape: preview gets usable height (${Math.round(r.pvH)}px)`);
    await page.screenshot({ path: join(OUT, 'phone-landscape.png') });
    check(errors.length === 0, `no console errors (landscape)${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.context().close();
  }
  // =========================================================== resilience
  console.log('Resilience: gallery.js / exporter.js unavailable, no commands');
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await ctx.route('**/js/gallery.js', (r) => r.fulfill({ status: 404, body: 'missing' }));
    await ctx.route('**/js/exporter.js', (r) => r.fulfill({ status: 404, body: 'missing' }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE);
    await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 15000 });
    await page.waitForTimeout(600);
    await page.evaluate(() => { mock.store.select('item', mock.ids.img2); mock.ribbon.activateTab('animations'); });
    await page.waitForTimeout(500);
    const painted = await page.evaluate(() => {
      const cv = document.querySelector('#rb-panel-animations .rb-gal-item canvas');
      const d = cv.getContext('2d').getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data;
      return d[0] + d[1] + d[2] > 0;
    });
    check(painted, 'gallery tiles fall back to labelled tiles when gallery.js is unavailable');
    await page.click('#rb-panel-animations .rb-gal-item[data-id="wipe-left"]').catch(() => {});
    await page.evaluate(() => mock.ribbon.activateTab('home'));
    await page.click('[aria-label="Save movie options"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => document.querySelectorAll('.rb-popup .menu-item').length === 6), 'Save movie menu falls back to the contract presets');
    check(errors.length === 0, `no page errors when optional modules fail${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await ctx.close();

    const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page2 = await ctx2.newPage();
    const errors2 = [];
    page2.on('pageerror', (e) => errors2.push(e.message));
    await page2.goto(`${BASE}?nocommands=1`);
    await page2.waitForFunction(() => document.body.dataset.ready, null, { timeout: 15000 });
    await page2.waitForTimeout(300);
    check(await page2.evaluate(() => [...document.querySelectorAll('#rb-panel-home [data-cmd]')].every((b) => b.disabled)), 'without commands every command button is disabled');
    check(errors2.length === 0, `no page errors without app.commands${errors2.length ? `: ${errors2.join(' | ')}` : ''}`);
    await ctx2.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${passes} passed, ${failures} failed. Screenshots: ${OUT}`);
process.exit(failures ? 1 : 0);
