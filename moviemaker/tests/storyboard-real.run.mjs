// Integration check (owner: E): Preview + Storyboard with the real Store/Player/renderer/media import.
//   npx http-server moviemaker -p 8105 -c-1 --silent &
//   node moviemaker/tests/storyboard-real.run.mjs [outDir]
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/opt/node22/lib/node_modules/playwright'); }
const { chromium, devices } = playwright;
const URL = process.env.SB_REAL_URL || 'http://127.0.0.1:8105/tests/storyboard-real.html';
const OUT = process.argv[2] || join(os.tmpdir(), 'storyboard-shots');
mkdirSync(OUT, { recursive: true });
let fails = 0, passes = 0;
const check = (c, m, x) => { if (c) { passes++; console.log('  ok  ', m); } else { fails++; console.log('  FAIL', m, x === undefined ? '' : JSON.stringify(x)); } };

async function run(browser, name, opts) {
  console.log(`\n# ${name}`);
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => window.T && window.T.ready, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => {
    const c = T.app.preview.canvas; const r = c.getBoundingClientRect(); const fr = T.app.player.frameRect;
    return {
      css: [r.width, r.height], backing: [c.width, c.height], fr,
      tiles: document.querySelectorAll('.sb-item[data-id="clip-1"] img.sb-tile').length,
      filmstrip: (T.app.store.getMedia(T.ids.clip).filmstrip || []).length,
      waves: document.querySelectorAll('.sb-bar[data-id="mus-1"] .sb-wave').length,
      peaks: !!T.app.store.getMedia(T.ids.music).peaks,
      time: document.querySelector('.pv-time').textContent,
    };
  });
  check(Math.abs(info.css[0] / info.css[1] - 16 / 9) < 0.02, 'preview canvas at project aspect', info.css);
  check(info.backing[0] >= Math.round(info.css[0]) && Math.abs(info.backing[0] / info.backing[1] - info.css[0] / info.css[1]) < 0.02, 'player sized the backing store from the CSS box', info.backing);
  check(info.fr && Math.abs(info.fr.width - info.css[0]) < 1.5 && Math.abs(info.fr.x) < 1, 'player frameRect fills the canvas (no double letterbox)', info.fr);
  check(info.filmstrip > 1 && info.tiles >= 2, 'real video filmstrip tiles', info);
  check(info.peaks && info.waves >= 1, 'music waveform from real peaks', info);
  check(/^00:00\.00\/00:\d\d\.\d\d$/.test(info.time) && info.time !== '00:00.00/00:00.00', 'time readout shows the real duration', info.time);

  // caption visible at 5s; inline editing hides it from the real renderer
  await page.evaluate(() => T.app.player.seek(5));
  await page.waitForTimeout(500);
  const box = await page.evaluate(() => {
    const pv = T.app.preview; const fr = pv._frameRect(); const o = T.app.store.find('cap-1').obj; const b = pv._textBox(o.text, o.style, fr);
    const c = pv.canvas.getBoundingClientRect();
    return { x: c.x + fr.x - (c.x - pv.stage.getBoundingClientRect().x - pv.stage.clientLeft) + b.x, y: c.y + b.y + fr.y - (c.y - pv.stage.getBoundingClientRect().y - pv.stage.clientTop), w: b.width, h: b.height };
  });
  const textPixels = () => page.evaluate((b) => {
    const pv = T.app.preview; const c = pv.canvas; const r = c.getBoundingClientRect(); const s = c.width / r.width;
    const g = c.getContext('2d'); const d = g.getImageData(Math.round((b.x - r.x) * s), Math.round((b.y - r.y) * s), Math.max(1, Math.round(b.w * s)), Math.max(1, Math.round(b.h * s))).data;
    let white = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
    return white;
  }, box);
  const before = await textPixels();
  await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
  await page.waitForTimeout(400);
  await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
  await page.waitForTimeout(500);
  const editing = await page.evaluate(() => T.app.preview.editingTextId);
  const during = await textPixels();
  await page.screenshot({ path: join(OUT, `real-${name}-editing.png`) });
  check(editing === 'cap-1', 'tap-tap edits the caption over the real player', editing);
  check(before > 20 && during < before * 0.3, 'real renderer skips the text being edited', { before, during });
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const after = await textPixels();
  check((await page.evaluate(() => T.app.store.find('cap-1').obj.text)) === 'Hello from the beach!' && after > 20, 'commit updates the store and the text is drawn again', after);

  // play through the real player for a moment
  await page.click('.pv-play');
  await page.waitForTimeout(900);
  const t = await page.evaluate(() => { const t = T.app.player.currentTime; T.app.player.pause(); return t; });
  check(t > 5.3, 'play button drives the real player', t);
  await page.screenshot({ path: join(OUT, `real-${name}.png`) });
  check(errs.length === 0, 'no console errors', errs);
  await ctx.close();
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  await run(browser, 'desktop', { viewport: { width: 1280, height: 760 } });
  const d = { ...devices['iPhone 13'] }; delete d.defaultBrowserType;
  await run(browser, 'phone', d);
} catch (e) { fails++; console.error(e); } finally { await browser.close(); }
console.log(`\n${passes} passed, ${fails} failed`);
process.exitCode = fails ? 1 : 0;
