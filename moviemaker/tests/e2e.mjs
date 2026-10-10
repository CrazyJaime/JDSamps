// End-to-end test of the whole Movie Maker app (real index.html → app.js, real modules) in
// headless Chromium, driven through the UI the way a person would use it.
//
//   NODE_PATH=/opt/node22/lib/node_modules node tests/e2e.mjs            # desktop + phone + landscape
//   NODE_PATH=/opt/node22/lib/node_modules node tests/e2e.mjs --phone    # phone portrait + landscape
//   ... --desktop | --landscape | --profile=desktop,phone                # pick profiles
//   ... --no-export                                                      # skip the (real-time) movie export
//
// Environment:
//   BASE_URL   use an already running server (e.g. http://127.0.0.1:8110/); otherwise the script
//              starts http-server for the moviemaker folder itself and stops it afterwards.
//   E2E_OUT    output folder for screenshots (shots/) and exported movies (default: <tmp>/moviemaker-e2e)
//
// Each profile runs in a fresh browser context (fresh IndexedDB):
//   load (no console/page errors) → layout checks → import 4 files through the real file chooser →
//   add music, title, caption, credits → transition / pan & zoom / effect from the ribbon galleries →
//   aspect 9:16 and back → play (clock advances, canvas changes) → scrub → split → trim tool →
//   drag-reorder (mouse, or touch long-press on phones) → undo/redo → AutoMovie → Save movie
//   ('For email') → ffprobe the file → reload and check the project was restored.
// Exit code 0 only when every step of every profile passed.

import { createRequire } from 'module';
import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import os from 'os';
import net from 'net';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIX = join(HERE, 'fixtures');
const OUT = process.env.E2E_OUT || join(os.tmpdir(), 'moviemaker-e2e');
const SHOTS = join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
let profiles = ['desktop', 'phone', 'landscape'];
if (has('--phone')) profiles = ['phone', 'landscape'];
if (has('--desktop')) profiles = ['desktop'];
if (has('--landscape')) profiles = ['landscape'];
const pArg = argv.find((a) => a.startsWith('--profile='));
if (pArg) profiles = pArg.slice(10).split(',').filter(Boolean);
const DO_EXPORT = !has('--no-export');

const IPHONE_UA = (devices['iPhone 13'] && devices['iPhone 13'].userAgent)
  || 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';
const PROFILES = {
  desktop: { viewport: { width: 1366, height: 768 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: IPHONE_UA },
  landscape: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: IPHONE_UA },
};

// ---------------------------------------------------------------------------
// server

function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function reachable(url) {
  try { const r = await fetch(url, { method: 'GET' }); return r.ok; } catch (_) { return false; }
}
let serverProc = null;
async function ensureServer() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/?$/, '/');
  for (let port = 8110; port < 8130; port++) {
    const url = `http://127.0.0.1:${port}/`;
    // Reuse a server that already serves this folder.
    if (!(await portFree(port))) {
      if (await reachable(`${url}js/app.js`) && await reachable(`${url}tests/fixtures/clip1.webm`)) return url;
      continue;
    }
    const bin = existsSync('/opt/node22/bin/http-server') ? '/opt/node22/bin/http-server' : 'http-server';
    serverProc = spawn(bin, [ROOT, '-p', String(port), '-a', '127.0.0.1', '-c-1', '-s'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      if (await reachable(`${url}js/app.js`)) return url;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('http-server did not start');
  }
  throw new Error('no free port for http-server');
}
function stopServer() { if (serverProc) { try { serverProc.kill(); } catch (_) { /* ignore */ } serverProc = null; } }

// ---------------------------------------------------------------------------
// results

const results = [];
function record(profile, step, ok, detail = '') {
  results.push({ profile, step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${profile}] ${step}${detail ? ` — ${detail}` : ''}`);
}
class StepError extends Error {}
function assert(cond, msg) { if (!cond) throw new StepError(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// one profile

async function runProfile(browser, base, name) {
  const opts = PROFILES[name];
  const touch = !!opts.hasTouch;
  const context = await browser.newContext({ ...opts, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  const warnings = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') errors.push(`console.error: ${m.text()}`);
    else if (t === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // blob:/data: loads are aborted routinely when a media element's src changes; only real
  // network files (the app's own modules, styles, icons) count.
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!/^https?:/.test(u)) return;
    const why = (r.failure() && r.failure().errorText) || '';
    if (/ERR_ABORTED/.test(why) && /\.(webm|mp4|ogg|mp3|m4a)(\?|$)/.test(u)) return;
    errors.push(`requestfailed: ${u} ${why}`);
  });
  page.on('response', (r) => { if (r.status() >= 400 && /^https?:/.test(r.url())) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  const cdp = touch ? await context.newCDPSession(page) : null;

  // Remove this profile's screenshots from an earlier run.
  for (const f of readdirSync(SHOTS)) if (new RegExp(`^${name}-\\d\\d-.*\\.png$`).test(f)) { try { unlinkSync(join(SHOTS, f)); } catch (_) { /* ignore */ } }
  let shotN = 0;
  const shot = async (label) => {
    shotN += 1;
    const file = join(SHOTS, `${name}-${String(shotN).padStart(2, '0')}-${label}.png`);
    try { await page.screenshot({ path: file }); } catch (_) { /* ignore */ }
    return file;
  };

  const step = async (label, fn, { critical = false } = {}) => {
    const errBefore = errors.length;
    try {
      const detail = await fn();
      const newErr = errors.slice(errBefore);
      if (newErr.length) throw new StepError(`errors during step: ${newErr.join(' | ')}`);
      record(name, label, true, typeof detail === 'string' ? detail : '');
      return true;
    } catch (err) {
      record(name, label, false, err && err.message ? err.message.split('\n')[0] : String(err));
      await shot(`FAIL-${label.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}`);
      if (critical) throw err;
      return false;
    }
  };

  // ---- small helpers bound to this page
  const act = async (locator, o = {}) => {
    await locator.waitFor({ state: 'visible', timeout: o.timeout || 8000 });
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    if (touch) await locator.tap({ timeout: o.timeout || 8000 });
    else await locator.click({ timeout: o.timeout || 8000 });
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = (fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  const project = () => ev(() => {
    const s = window.app.store;
    const p = s.project;
    return {
      items: p.items.map((i) => ({ id: i.id, kind: i.kind, mediaId: i.mediaId, text: i.text, trimStart: i.trimStart, trimEnd: i.trimEnd, duration: i.duration, transition: i.transition, panZoom: i.panZoom, effect: i.effect })),
      texts: p.texts.map((t) => ({ id: t.id, kind: t.kind, text: t.text, start: t.start, duration: t.duration })),
      music: p.music.map((m) => ({ id: m.id, kind: m.kind, start: m.start })),
      aspect: p.aspect, duration: s.timeline.duration, name: p.name,
      selection: { type: s.selection.type, ids: s.selection.ids.slice() },
      canUndo: s.canUndo, canRedo: s.canRedo,
    };
  });
  const tab = async (id) => {
    const btn = page.locator(`#ribbon .rb-tab[data-tab="${id}"]`);
    await act(btn);
    await waitFor((i) => { const p = document.querySelector(`#ribbon .rb-panel[data-tab="${i}"]`); return p && !p.hidden; }, id, 4000);
  };
  const ribbonBtn = (tabId, sel) => page.locator(`#ribbon .rb-panel[data-tab="${tabId}"] ${sel}`).first();
  /** Pick a gallery entry: the expanded gallery (desktop) or the bottom sheet (phones). */
  const pickGallery = async (tabId, label, id) => {
    const panel = `#ribbon .rb-panel[data-tab="${tabId}"]`;
    const launch = page.locator(`${panel} .rb-gal-launch[aria-label="${label}"]`);
    if (await launch.isVisible().catch(() => false)) {
      await act(launch);
    } else {
      await act(page.locator(`${panel} .rb-gallery[aria-label="${label}"] button[aria-haspopup="dialog"]`));
    }
    const tile = page.locator(`.rb-gal-full .rb-gal-item[data-id="${id}"]`).first();
    await tile.waitFor({ state: 'visible', timeout: 5000 });
    await tile.scrollIntoViewIfNeeded();
    await act(tile);
    await page.locator('.rb-gal-full').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  };
  /** The storyboard element for a visual item (first piece when split across rows). */
  const sbItem = (id) => page.locator(`#storyboard-pane [data-sb="item"][data-id="${id}"]`).first();
  const selectItem = async (id, { additive = false } = {}) => {
    const el = sbItem(id);
    await el.scrollIntoViewIfNeeded().catch(() => {});
    if (touch) await el.tap();
    else await el.click({ modifiers: additive ? ['Control'] : [] });
    await waitFor((i) => window.app.store.selection.ids.includes(i), id, 4000);
  };
  const seekTo = async (t) => {
    await ev((tt) => window.app.player.seek(tt), t);
    await waitFor((tt) => Math.abs(window.app.player.currentTime - tt) < 0.05, t, 5000);
  };
  const touchDrag = async (pts, { holdMs = 0, stepMs = 16 } = {}) => {
    const [x0, y0] = pts[0];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
    if (holdMs) await sleep(holdMs);
    for (let i = 1; i < pts.length; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pts[i][0], y: pts[i][1], id: 1 }] });
      await sleep(stepMs);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const lerp = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * (i / n), a[1] + (b[1] - a[1]) * (i / n)]);
  const canvasStats = () => ev(() => {
    const c = window.app.player.canvas || document.querySelector('#preview-pane canvas');
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    let sum = 0, nonBlack = 0, hash = 0, n = 0;
    const stride = Math.max(1, Math.floor((w * h) / 4000)) * 4;
    for (let i = 0; i < d.length; i += stride) {
      const v = d[i] + d[i + 1] + d[i + 2];
      sum += v; n++;
      if (v > 45) nonBlack++;
      hash = (hash * 31 + (d[i] >> 3) * 7 + (d[i + 1] >> 3) * 3 + (d[i + 2] >> 3)) >>> 0;
    }
    return { w, h, mean: sum / n / 3, nonBlack: nonBlack / n, hash };
  });
  const dialogButton = (label) => page.locator(`#dialog-root .dlg-buttons button:has-text("${label}")`).last();

  let files = null;
  let expectedItems = 0;
  try {
    // ------------------------------------------------------------------ load
    await step('load app (no console/page errors)', async () => {
      await page.goto(`${base}index.html`, { waitUntil: 'load' });
      await waitFor(() => window.app && window.app.store && window.app.commands && document.querySelector('#ribbon .rb-tab'), null, 15000);
      await page.waitForSelector('#boot-splash', { state: 'detached', timeout: 15000 });
      await sleep(800);
      await shot('empty');
      return `${warnings.length} console warnings`;
    }, { critical: true });

    const layoutCheck = async (label) => {
      await step(`layout: ${label}`, async () => {
        const r = await ev((isTouch) => {
          const vis = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return { sel, ok: false, why: 'missing' };
            const b = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const ok = b.width > 20 && b.height > 10 && cs.visibility !== 'hidden' && cs.display !== 'none'
              && b.left >= -1 && b.top >= -1 && b.right <= innerWidth + 1 && b.top < innerHeight;
            return { sel, ok, why: `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}` };
          };
          const regions = ['#titlebar', '#ribbon', '#preview-pane', '#preview-pane canvas', '#preview-pane .pv-play', '#storyboard-pane'];
          const out = regions.map(vis);
          if (!isTouch) out.push(vis('#statusbar'));
          // No pane may be scrolled out of place (e.g. by focus() on an overflowing child).
          for (const sel of ['#app', '#main', '#preview-pane']) {
            const el = document.querySelector(sel);
            if (el && (el.scrollLeft || el.scrollTop)) out.push({ sel: `${sel} scrolled`, ok: false, why: `${el.scrollLeft},${el.scrollTop}` });
          }
          const se = document.scrollingElement;
          // Every visible button must be inside the viewport horizontally or inside a scroller.
          return { sw: se.scrollWidth, iw: innerWidth, sh: se.scrollHeight, ih: innerHeight, regions: out };
        }, touch);
        assert(r.sw <= r.iw, `horizontal page overflow: scrollWidth ${r.sw} > ${r.iw}`);
        const bad = r.regions.filter((x) => !x.ok);
        assert(!bad.length, `regions not visible: ${bad.map((b) => `${b.sel} (${b.why})`).join(', ')}`);
        if (touch) assert(r.sh <= r.ih + 1, `vertical page overflow on phone: ${r.sh} > ${r.ih}`);
        return `scrollWidth ${r.sw}/${r.iw}`;
      });
    };
    await layoutCheck('empty project');

    // ------------------------------------------------------------------ import
    await step('import 4 files via file chooser', async () => {
      const trigger = page.locator('#storyboard-pane .sb-empty-btn').first();
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }),
        act(trigger),
      ]);
      assert(chooser.isMultiple(), 'file chooser should allow several files');
      await chooser.setFiles(['clip1.webm', 'photo1.jpg', 'photo2.png', 'portrait.webm'].map((f) => join(FIX, f)));
      await waitFor(() => window.app.store.project.items.length === 4, null, 30000);
      await waitFor(() => window.app.store.project.items.every((i) => { const m = window.app.store.getMedia(i.mediaId); return m && (m.type === 'image' || m.duration > 0); }), null, 10000);
      await sleep(400);
      const p = await project();
      const kinds = p.items.map((i) => i.kind).join(',');
      assert(kinds === 'video,image,image,video', `item kinds ${kinds}`);
      const expected = 4.025 + 7 + 7 + 3.008;
      assert(Math.abs(p.duration - expected) < 0.25, `timeline duration ${p.duration.toFixed(2)} ≠ ~${expected.toFixed(2)}`);
      const sbIds = await ev(() => [...new Set([...document.querySelectorAll('#storyboard-pane [data-sb="item"]')].map((e) => e.getAttribute('data-id')))]);
      assert(sbIds.length === 4, `storyboard shows ${sbIds.length} items`);
      files = p.items.map((i) => i.id);
      await shot('imported');
      return `duration ${p.duration.toFixed(2)}s`;
    }, { critical: true });
    await layoutCheck('after import');

    // ------------------------------------------------------------------ music, title, caption, credits
    await step('add music (Home › Add music)', async () => {
      await tab('home');
      const btn = ribbonBtn('home', 'button.rb-split-main[aria-label="Add music"]');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), act(btn)]);
      await chooser.setFiles([join(FIX, 'music.ogg')]);
      await waitFor(() => window.app.store.project.music.length === 1, null, 20000);
      await waitFor(() => document.querySelector('#storyboard-pane [data-sb="music"]'), null, 5000);
      const p = await project();
      assert(p.music[0].start === 0, `music start ${p.music[0].start}`);
      return 'music bar shown';
    });

    await step('add title + inline edit', async () => {
      await selectItem(files[0]);   // selecting a clip opens Video Tools › Edit (as in WLMM)
      await tab('home');
      await act(ribbonBtn('home', 'button[data-cmd="addTitle"]'));
      const ed = page.locator('#preview-pane .pv-text-editor');
      await ed.waitFor({ state: 'visible', timeout: 5000 });
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.type('Summer Trip');
      await page.keyboard.press('Enter');
      await waitFor(() => window.app.store.project.items[0].kind === 'title' && window.app.store.project.items[0].text === 'Summer Trip', null, 5000);
      await shot('title');
    });

    await step('add caption at playhead + inline edit', async () => {
      const p0 = await project();
      const seg = await ev((id) => { const s = window.app.store.timeline.segments.find((x) => x.item.id === id); return { start: s.start, end: s.end }; }, files[1]);
      await selectItem(files[1]);
      await seekTo(seg.start + 1);
      await tab('home');
      await act(ribbonBtn('home', 'button[data-cmd="addCaption"]'));
      await waitFor((n) => window.app.store.project.texts.length === n + 1, p0.texts.length, 5000);
      const ed = page.locator('#preview-pane .pv-text-editor');
      if (await ed.isVisible().catch(() => false)) {
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.type('Day one');
        await page.keyboard.press('Enter');
      } else {
        // Fall back to the command (some layouts may not open the editor automatically).
        await ev(() => window.app.commands.run('textEdit', 'Day one'));
      }
      await waitFor(() => window.app.store.project.texts.some((t) => t.kind === 'caption' && t.text === 'Day one'), null, 5000);
      const cap = (await project()).texts.find((t) => t.kind === 'caption');
      assert(Math.abs(cap.start - (seg.start + 1)) < 0.15, `caption start ${cap.start} vs playhead ${seg.start + 1}`);
      await waitFor(() => document.querySelector('#storyboard-pane [data-sb="text"]'), null, 4000);
    });

    await step('add credits', async () => {
      await tab('home');
      const n = (await project()).texts.length;
      await act(ribbonBtn('home', 'button[data-cmd="addCredits"]'));
      await waitFor((k) => window.app.store.project.texts.length === k + 1, n, 5000);
      // Close the inline editor if it opened.
      if (await page.locator('#preview-pane .pv-text-editor').isVisible().catch(() => false)) await page.keyboard.press('Escape');
      const cr = (await project()).texts.find((t) => t.kind === 'credits');
      assert(cr, 'no credits item');
      await shot('texts');
    });

    // ------------------------------------------------------------------ animations / effects
    await step('transition from Animations gallery', async () => {
      const id1 = files[1];
      await selectItem(id1);
      await tab('animations');
      if (!touch) {
        // A tile visible in the ribbon row itself (hovered first: it animates).
        const inline = page.locator('#ribbon .rb-panel[data-tab="animations"] .rb-gallery[aria-label="Transitions"] .rb-gal-item:not([disabled])').nth(1);
        const tid = await inline.getAttribute('data-id');
        await inline.hover();
        await sleep(300);
        await inline.click();
        await waitFor(([i, t]) => window.app.store.find(i).obj.transition.type === t, [id1, tid], 4000);
      }
      await pickGallery('animations', 'Transitions', 'crossfade');
      await waitFor((i) => window.app.store.find(i).obj.transition.type === 'crossfade', id1, 4000);
      const ov = await ev((i) => { const s = window.app.store.timeline.segments.find((x) => x.item.id === i); return s.transitionIn && s.transitionIn.duration; }, id1);
      assert(ov > 0, 'crossfade overlap not in timeline');
      return `overlap ${ov}s`;
    });

    await step('pan & zoom on a photo', async () => {
      await selectItem(files[2]);
      await tab('animations');
      await pickGallery('animations', 'Pan and zoom', 'zoom-in');
      await waitFor((id) => window.app.store.find(id).obj.panZoom === 'zoom-in', files[2], 4000);
    });

    await step('visual effect on a video', async () => {
      await selectItem(files[0]);
      await tab('effects');
      await pickGallery('effects', 'Visual effects', 'sepia');
      await waitFor((id) => window.app.store.find(id).obj.effect === 'sepia', files[0], 4000);
      await shot('effects');
    });

    await step('photo durations via Edit › Duration', async () => {
      for (const id of [files[1], files[2]]) {
        await selectItem(id);
        await tab('ctx-video');
        const input = ribbonBtn('ctx-video', 'input[aria-label="Duration"]');
        await input.waitFor({ state: 'visible', timeout: 4000 });
        await input.scrollIntoViewIfNeeded();
        await input.click();
        await input.fill('3');
        await input.press('Enter');
        await waitFor((i) => window.app.store.find(i).obj.duration === 3, id, 4000);
      }
      return `timeline ${(await project()).duration.toFixed(2)}s`;
    });

    await step('aspect 9:16 and back (Project tab)', async () => {
      await tab('project');
      await act(ribbonBtn('project', 'button[data-cmd="setAspect"][aria-label="Portrait (9:16)"]'));
      await waitFor(() => window.app.store.project.aspect === '9:16', null, 4000);
      await sleep(500);
      const r = await ev(() => { const b = window.app.player.frameRect || document.querySelector('#preview-pane canvas').getBoundingClientRect(); return { w: b.width, h: b.height }; });
      assert(Math.abs(r.w / r.h - 9 / 16) < 0.05, `9:16 frame is ${r.w.toFixed(0)}x${r.h.toFixed(0)}`);
      await layoutCheck('9:16 project');
      await shot('aspect-9x16');
      await tab('project');
      await act(ribbonBtn('project', 'button[data-cmd="setAspect"][aria-label="Widescreen (16:9)"]'));
      await waitFor(() => window.app.store.project.aspect === '16:9', null, 4000);
      await sleep(400);
      const r2 = await ev(() => { const b = window.app.player.frameRect || document.querySelector('#preview-pane canvas').getBoundingClientRect(); return { w: b.width, h: b.height }; });
      assert(Math.abs(r2.w / r2.h - 16 / 9) < 0.05, `16:9 frame is ${r2.w.toFixed(0)}x${r2.h.toFixed(0)}`);
      // Emphasize narration (a toggle; must survive a reload — checked at the end).
      const emph = ribbonBtn('project', 'button[data-cmd="emphasize"][aria-label="Emphasize narration"]');
      await act(emph);
      await waitFor(() => window.app.store.project.emphasize === 'narration', null, 4000);
      await waitFor(() => { const b = document.querySelector('#ribbon .rb-panel[data-tab="project"] button[data-cmd="emphasize"][aria-label="Emphasize narration"]'); return b && b.getAttribute('aria-pressed') === 'true'; }, null, 4000);
      return `9:16 ${r.w.toFixed(0)}x${r.h.toFixed(0)}, 16:9 ${r2.w.toFixed(0)}x${r2.h.toFixed(0)}`;
    });

    // ------------------------------------------------------------------ playback
    await step('play ~1.5s: clock advances, picture changes', async () => {
      // Start inside the first video clip (a title is mostly black by design).
      const clipStart = await ev((i) => window.app.store.timeline.segments.find((x) => x.item.id === i).start, files[0]);
      await seekTo(clipStart + 0.3);
      await sleep(300);
      const t0 = await ev(() => window.app.player.currentTime);
      const s0 = await canvasStats();
      await act(page.locator('#preview-pane .pv-play'));
      await waitFor(() => window.app.player.playing, null, 3000);
      const samples = [];
      for (let i = 0; i < 5; i++) { await sleep(300); samples.push(await canvasStats()); }
      const t1 = await ev(() => window.app.player.currentTime);
      await shot('playing');
      await act(page.locator('#preview-pane .pv-play'));
      await waitFor(() => !window.app.player.playing, null, 3000);
      const adv = t1 - t0;
      assert(adv > 0.9 && adv < 2.6, `clock advanced ${adv.toFixed(2)}s in ~1.5s`);
      const hashes = new Set([s0, ...samples].map((s) => s.hash));
      assert(hashes.size >= 3, `only ${hashes.size} distinct frames while playing`);
      const lit = samples.filter((s) => s.nonBlack > 0.1).length;
      assert(lit >= 3, `frames mostly black (non-black share ${samples.map((s) => s.nonBlack.toFixed(2)).join(',')})`);
      const paneScroll = await ev(() => { const p = document.getElementById('preview-pane'); return p.scrollLeft + p.scrollTop; });
      assert(paneScroll === 0, `preview pane scrolled by ${paneScroll}px after Play/Pause`);
      const time = await page.locator('#preview-pane .pv-time').first().textContent();
      assert(/\d\d:\d\d\.\d\d\s*\/\s*\d\d:\d\d\.\d\d/.test(time || ''), `time readout "${time}"`);
      return `advanced ${adv.toFixed(2)}s, ${hashes.size} distinct frames, readout ${time}`;
    });

    if (!touch) {
      await step('keyboard shortcuts (Space after clicking an item, Delete, Ctrl+Z)', async () => {
        await selectItem(files[1]);
        await page.keyboard.press('Space');
        await waitFor(() => window.app.player.playing, null, 3000);
        await sleep(300);
        await page.keyboard.press('Space');
        await waitFor(() => !window.app.player.playing, null, 3000);
        const n = (await project()).items.length;
        await page.keyboard.press('Delete');
        await waitFor((k) => window.app.store.project.items.length === k - 1, n, 3000);
        await page.keyboard.press('Control+z');
        await waitFor((k) => window.app.store.project.items.length === k, n, 3000);
        // Tab to a ribbon button: Space must activate the button, not play.
        await page.locator('#ribbon .rb-tab[data-tab="home"]').click();
        await page.keyboard.press('Tab');
        const focused = await ev(() => { const a = document.activeElement; return a && a.closest('#ribbon') && a.matches('button') ? (a.getAttribute('aria-label') || a.textContent).trim() : ''; });
        if (focused) {
          await page.keyboard.press('Space');
          await sleep(400);
          assert(!(await ev(() => window.app.player.playing)), `Space on keyboard-focused "${focused}" started playback`);
          await page.keyboard.press('Escape');
          // Undo whatever the button did (e.g. "Minimize the ribbon") so later steps see the normal layout.
          if (await ev(() => document.getElementById('app').classList.contains('is-ribbon-min'))) {
            await page.keyboard.press('Space');
            await waitFor(() => !document.getElementById('app').classList.contains('is-ribbon-min'), null, 3000);
          }
          await ev(() => { window.app.dialogs.closeAll && window.app.dialogs.closeAll(); document.activeElement && document.activeElement.blur(); });
        }
        return focused ? `Tab-focused "${focused}" kept Space` : 'no ribbon button after Tab';
      });
    }

    await step('scrub the seek bar', async () => {
      const bar = page.locator('#preview-pane .pv-seek-track').first();
      const b = await bar.boundingBox();
      assert(b && b.width > 50, 'seek bar too small');
      const dur = (await project()).duration;
      // Diagnostics: who seeks during the scrub (printed if the step fails).
      await ev(() => {
        window.__seekLog = [];
        const pl = window.app.player;
        if (!pl.__origSeek) pl.__origSeek = pl.seek;
        const pane = document.getElementById('preview-pane');
        const sb = pane.querySelector('.pv-seekbar');
        for (const ty of ['pointercancel', 'lostpointercapture']) sb.addEventListener(ty, () => window.__seekLog.push(`${Math.round(performance.now())} ${ty}`), true);
        window.__seekLog.push(`pane scroll ${pane.scrollLeft},${pane.scrollTop} size ${pane.scrollWidth}/${pane.clientWidth}`);
      });
      const y = b.y + b.height / 2;
      const xa = b.x + b.width * 0.2, xb = b.x + b.width * 0.6;
      if (touch) {
        await touchDrag(lerp([xa, y], [xb, y], 12));
      } else {
        await page.mouse.move(xa, y);
        await page.mouse.down();
        for (let i = 1; i <= 12; i++) { await page.mouse.move(xa + ((xb - xa) * i) / 12, y); await sleep(16); }
        await page.mouse.up();
      }
      await sleep(400);
      const t = await ev(() => window.app.player.currentTime);
      const seekLog = await ev(() => { const l = window.__seekLog; const pl = window.app.player; pl.seek = pl.__origSeek; delete pl.__origSeek; return l.slice(-8); });
      assert(Math.abs(t / dur - 0.6) < 0.06, `after scrub time ${t.toFixed(2)} of ${dur.toFixed(2)} (expected ~60%); last seeks: ${seekLog.join(' ; ')}`);
      const s = await canvasStats();
      assert(s.nonBlack > 0.05 || t > (await ev(() => { const segs = window.app.store.timeline.segments; return segs[segs.length - 1].end; })), 'scrubbed frame is black');
      return `t=${t.toFixed(2)}`;
    });

    await step('split the video at the playhead (Edit › Split)', async () => {
      const vid = files[0];
      const seg = await ev((id) => { const s = window.app.store.timeline.segments.find((x) => x.item.id === id); return { start: s.start, end: s.end }; }, vid);
      await selectItem(vid);
      await seekTo(seg.start + (seg.end - seg.start) / 2);
      await tab('ctx-video');
      const n = (await project()).items.length;
      await act(ribbonBtn('ctx-video', 'button[data-cmd="split"]'));
      await waitFor((k) => window.app.store.project.items.length === k + 1, n, 4000);
      const p = await project();
      const halves = p.items.filter((i) => i.mediaId && i.mediaId === p.items.find((x) => x.id === vid).mediaId);
      assert(halves.length === 2, 'split did not produce two halves');
      assert(Math.abs(halves[0].trimEnd - halves[1].trimStart) < 0.01, `halves don't meet: ${halves[0].trimEnd} / ${halves[1].trimStart}`);
      expectedItems = p.items.length;
      return `split at source ${halves[1].trimStart.toFixed(2)}s`;
    });

    await step('trim tool (Edit › Trim tool)', async () => {
      const vid = files[3];
      await selectItem(vid);
      await tab('ctx-video');
      await act(ribbonBtn('ctx-video', 'button[data-cmd="trimTool"]'));
      const panel = page.locator('.trim-panel');
      await panel.waitFor({ state: 'visible', timeout: 6000 });
      await shot('trim');
      const startIn = panel.locator('input[type="number"]').nth(0);
      const endIn = panel.locator('input[type="number"]').nth(1);
      await startIn.fill('0.5'); await startIn.press('Enter');
      await endIn.fill('2.5'); await endIn.press('Enter');
      await act(panel.locator('button.mmd-trim-save'));
      await panel.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      await waitFor((id) => { const o = window.app.store.find(id).obj; return Math.abs(o.trimStart - 0.5) < 0.02 && Math.abs(o.trimEnd - 2.5) < 0.02; }, vid, 4000);
      const inert = await ev(() => document.getElementById('ribbon').inert || document.getElementById('app').classList.contains('mmd-trim-mode'));
      assert(!inert, 'ribbon still locked after Save trim');
      // End credits stay right after the last picture (captions move with their clip).
      const gap = await ev(() => {
        const tl = window.app.store.timeline;
        const end = tl.segments[tl.segments.length - 1].end;
        const cr = tl.texts.find((x) => x.item.kind === 'credits');
        return cr ? cr.start - end : 0;
      });
      assert(Math.abs(gap) < 0.06, `credits start ${gap.toFixed(2)}s away from the end of the pictures after trimming`);
    });

    await step(touch ? 'reorder by long-press drag (touch)' : 'reorder by mouse drag', async () => {
      // Zoom the storyboard out so the whole movie fits (phones show one lane).
      await tab('view');
      for (let i = 0; i < 3; i++) await act(ribbonBtn('view', 'button[data-cmd="zoomOut"]'));
      await sleep(300);
      const before = (await project()).items.map((i) => i.id);
      const mover = before[before.length - 1];        // portrait video
      const target = before[1];                         // drop in front of the first clip half
      const mb = await sbItem(mover).boundingBox();
      const tb = await sbItem(target).boundingBox();
      assert(mb && tb, 'items not on screen');
      const from = [mb.x + mb.width / 2, mb.y + mb.height / 2];
      const to = [tb.x + Math.min(6, tb.width / 4), tb.y + tb.height / 2];
      if (touch) {
        await touchDrag(lerp(from, to, 20), { holdMs: 520, stepMs: 24 });
      } else {
        await page.mouse.move(from[0], from[1]);
        await page.mouse.down();
        for (let i = 1; i <= 20; i++) { await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 20, from[1] + ((to[1] - from[1]) * i) / 20); await sleep(16); }
        await page.mouse.up();
      }
      await sleep(400);
      // Close the action popover that a long-press may leave open.
      if (await page.locator('.sb-pop').isVisible().catch(() => false)) await page.keyboard.press('Escape');
      const after = (await project()).items.map((i) => i.id);
      assert(after.indexOf(mover) === 1, `item now at ${after.indexOf(mover)} (order ${after.join(',')})`);
      return `moved to index 1`;
    });

    await step('undo / redo (quick access toolbar)', async () => {
      const before = (await project()).items.map((i) => i.id).join(',');
      await act(page.locator('#qat button[data-cmd="undo"]'));
      await sleep(200);
      const undone = (await project()).items.map((i) => i.id).join(',');
      assert(undone !== before, 'undo changed nothing');
      await act(page.locator('#qat button[data-cmd="redo"]'));
      await sleep(200);
      const redone = (await project()).items.map((i) => i.id).join(',');
      assert(redone === before, 'redo did not restore the order');
    });

    await step('AutoMovie theme (Home gallery)', async () => {
      await tab('home');
      const n0 = await ev(() => window.app.store._undo ? window.app.store._undo.length : null);
      await pickGallery('home', 'AutoMovie themes', 'contemporary');
      await sleep(600);
      const p = await project();
      const withTrans = p.items.slice(1).filter((i) => i.transition && i.transition.type !== 'none').length;
      assert(withTrans >= p.items.length - 2, `AutoMovie set transitions on ${withTrans}/${p.items.length - 1}`);
      assert(p.items[0].kind === 'title', 'AutoMovie lost the opening title');
      assert(p.texts.some((t) => t.kind === 'credits'), 'AutoMovie lost the credits');
      const n1 = await ev(() => window.app.store._undo ? window.app.store._undo.length : null);
      if (n0 != null && n1 != null) assert(n1 - n0 <= 1, `AutoMovie made ${n1 - n0} undo steps`);
      expectedItems = p.items.length;
      await shot('automovie');
      return `${p.items.length} items, ${p.duration.toFixed(2)}s`;
    });

    // ------------------------------------------------------------------ export
    if (DO_EXPORT) {
      await step('Save movie (For email) and ffprobe it', async () => {
        await ev(() => window.app.player.pause());
        const dur = (await project()).duration;
        if (!touch) {
          // Desktop Chromium asks where to save first: stand in for the native picker.
          await ev(() => {
            window.__savedMovie = null;
            window.showSaveFilePicker = async (o) => ({
              name: (o && o.suggestedName) || 'movie',
              createWritable: async () => { const parts = []; return { write: async (b) => { parts.push(b); }, close: async () => { window.__savedMovie = new Blob(parts); } }; },
            });
          });
          await tab('home');
          await act(ribbonBtn('home', 'button.rb-split-menu[aria-label="Save movie options"]'));
          await act(page.locator('.menu .menu-item:has-text("For email")').first());
        } else {
          await act(page.locator('#qat button[data-cmd="saveMovie"]'));
        }
        const dlg = page.locator('#dialog-root .mmd-export-dlg');
        await dlg.waitFor({ state: 'visible', timeout: 6000 });
        const email = dlg.locator('input[type="radio"][value="email"]');
        if (!(await email.isChecked())) await act(dlg.locator('label.mmd-preset:has(input[value="email"])'));
        assert(await email.isChecked(), '"For email" not selected');
        await shot('export-settings');
        await act(dialogButton('Save'));
        await sleep(Math.min(4000, dur * 300));
        await shot('export-running');
        await page.locator('#dialog-root :text("Your movie has been saved.")').waitFor({ state: 'visible', timeout: (dur * 2 + 45) * 1000 });
        await shot('export-done');
        let buf;
        if (!touch) {
          const b64 = await ev(async () => {
            const b = window.__savedMovie;
            if (!b) return null;
            const ab = await b.arrayBuffer();
            let s = ''; const u = new Uint8Array(ab);
            for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
            return btoa(s);
          });
          assert(b64, 'nothing was written to the chosen file');
          buf = Buffer.from(b64, 'base64');
        } else {
          const btn = dialogButton('Save / Share');
          const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), act(btn)]);
          const path = join(OUT, `${name}-download-${dl.suggestedFilename()}`);
          await dl.saveAs(path);
          buf = require('fs').readFileSync(path);
        }
        const line = await page.locator('#dialog-root .mmd-file-line').textContent().catch(() => '');
        const ext = /\.mp4\b/.test(line || '') ? 'mp4' : 'webm';
        const file = join(OUT, `${name}-movie.${ext}`);
        writeFileSync(file, buf);
        await act(dialogButton('Close'));
        await dlg.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
        const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
        const v = probe.streams.find((s) => s.codec_type === 'video');
        const a = probe.streams.find((s) => s.codec_type === 'audio');
        const fdur = Number(probe.format.duration);
        assert(v, 'no video stream');
        assert(a, 'no audio stream');
        assert(Math.abs(fdur - dur) <= 1.5, `file duration ${fdur} vs movie ${dur.toFixed(2)}`);
        assert(v.height <= 240 + 1, `email preset height ${v.height}`);
        // Decode it fully to be sure the file isn't truncated / corrupt.
        execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { stdio: 'pipe' });
        return `${file.split('/').pop()}: ${v.codec_name} ${v.width}x${v.height} + ${a.codec_name}, ${fdur.toFixed(2)}s (movie ${dur.toFixed(2)}s), ${buf.length} bytes`;
      });
    }

    // ------------------------------------------------------------------ reload / restore
    await step('reload restores the project from IndexedDB', async () => {
      const p = await project();
      await ev(async () => { if (window.app.autosave && window.app.autosave.flush) await window.app.autosave.flush(); });
      await sleep(300);
      await page.reload({ waitUntil: 'load' });
      await waitFor(() => window.app && window.app.store, null, 15000);
      await waitFor((n) => window.app.store.project.items.length === n, p.items.length, 15000);
      await sleep(800);
      const q = await project();
      assert(q.items.length === p.items.length, `items ${q.items.length} vs ${p.items.length}`);
      assert(q.texts.length === p.texts.length, `texts ${q.texts.length} vs ${p.texts.length}`);
      assert(q.music.length === p.music.length, `music ${q.music.length} vs ${p.music.length}`);
      assert(Math.abs(q.duration - p.duration) < 0.05, `duration ${q.duration} vs ${p.duration}`);
      assert(await ev(() => window.app.store.project.emphasize === 'narration'), '"Emphasize narration" was lost on reload');
      const sbIds = await ev(() => new Set([...document.querySelectorAll('#storyboard-pane [data-sb="item"]')].map((e) => e.getAttribute('data-id'))).size);
      assert(sbIds === p.items.length, `storyboard shows ${sbIds} items after reload`);
      await seekTo(Math.min(5, q.duration / 2));
      await sleep(500);
      const s = await canvasStats();
      assert(s.nonBlack > 0.05, 'restored project renders black');
      await shot('restored');
      await layoutCheck('restored project');
      return `${q.items.length} items, ${q.duration.toFixed(2)}s`;
    });

    // ------------------------------------------------------------------ extra looks for review
    await step('screens for review (tabs, menu)', async () => {
      for (const t of ['animations', 'effects', 'project', 'view']) { await tab(t); await sleep(250); await shot(`tab-${t}`); }
      await selectItem((await project()).items[1].id);
      await tab('ctx-video'); await sleep(250); await shot('tab-edit');
      const cap = (await project()).texts.find((x) => x.kind === 'caption');
      if (cap) {
        const bar = page.locator(`#storyboard-pane [data-sb="text"][data-id="${cap.id}"]`).first();
        if (touch) await bar.tap(); else await bar.click();
        await waitFor((id) => window.app.store.selection.ids.includes(id), cap.id, 4000);
        await sleep(250);
        await shot('tab-format');
      }
      await act(page.locator('#app-menu-btn'));
      await sleep(400);
      await shot('app-menu');
      await page.keyboard.press('Escape');
      await sleep(300);
    });
  } catch (err) {
    if (!(err instanceof StepError)) record(name, 'unexpected exception', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : String(err));
  } finally {
    if (errors.length) console.log(`[${name}] all errors:\n  ${errors.join('\n  ')}`);
    if (warnings.length) console.log(`[${name}] ${warnings.length} console warnings, e.g.:\n  ${[...new Set(warnings)].slice(0, 8).join('\n  ')}`);
    await context.close();
  }
}

// ---------------------------------------------------------------------------

const base = await ensureServer();
console.log(`Movie Maker e2e — ${base} — profiles: ${profiles.join(', ')} — output: ${OUT}`);
const browser = await chromium.launch();
try {
  for (const p of profiles) await runProfile(browser, base, p);
} finally {
  await browser.close();
  stopServer();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log(`  FAIL [${f.profile}] ${f.step}: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
