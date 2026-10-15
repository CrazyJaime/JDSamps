// Layout, hit-target, toast and small-control tests for deck.html at the spec's laptop sizes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUi } from './ui-harness.mjs';
import { deck, makeState, threeDecks } from './fixtures/mock-state.mjs';

/** n decks with a realistic mix of states (the widest status rows, a running recording). */
function nDecks(n) {
  const decks = Array.from({ length: n }, (_, i) => deck({
    id: i + 1, slot: i + 1, tabId: 100 + i, title: `Track number ${i + 1} with a fairly long title here`,
    ...(i === 1 ? { sync: { on: false, mode: 'BEAT', isMaster: true, outOfRange: false, phaseMs: null }, rec: { state: 'recording', format: 'wav', seconds: 73.4 } } : {}),
    ...(i === 2 ? { starved: true, reserve: 0.4, engineRate: 1.06, assist: { available: true, active: true, sourceRate: 1.06 } } : {}),
  }));
  return makeState({ decks });
}

const ART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
let ui, page;
const sent = async (t, filter) => (await ui.sent()).filter((m) => m.t === t && (!filter || filter(m)));

async function show(width, height, state) {
  await page.setViewportSize({ width, height });
  await ui.push({ t: 'state', s: { ...state, wallMs: Date.now() } });
  await page.waitForFunction((n) => document.querySelectorAll('.deck').length === n, state.decks.length);
  await page.waitForTimeout(80);
}

/** Every visible control in the board and crossfader bar that is off-screen or covered by something else. */
const offenders = () => page.evaluate(() => {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const out = [];
  const els = document.querySelectorAll('.board [data-act], .board button, .board [role="slider"], .xfader-bar button, .xfader-bar [role="slider"]');
  for (const el of els) {
    if (el.closest('[hidden]')) continue;
    const b = el.getBoundingClientRect();
    const name = `${el.closest('.deck') ? `deck${[...document.querySelectorAll('.deck')].indexOf(el.closest('.deck')) + 1} ` : ''}${el.dataset.act || el.dataset.ctl || el.dataset.v || el.dataset.roll || el.dataset.kill || el.dataset.hold || el.dataset.pad || el.id || el.className}`;
    if (b.width < 1 || b.height < 1) { out.push(`${name}: not rendered`); continue; }
    if (b.left < -0.5 || b.top < -0.5 || b.right > vw + 0.5 || b.bottom > vh + 0.5) { out.push(`${name}: outside viewport ${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.right)},${Math.round(b.bottom)}`); continue; }
    const t = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
    if (!t || !(t === el || el.contains(t))) out.push(`${name}: covered by ${t ? t.className || t.tagName : 'nothing'}`);
  }
  const d = document.getElementById('decks');
  if (d.scrollHeight > d.clientHeight + 1) out.push(`decks scroll vertically ${d.scrollHeight} > ${d.clientHeight}`);
  if (d.scrollWidth > d.clientWidth + 1) out.push(`decks scroll horizontally ${d.scrollWidth} > ${d.clientWidth}`);
  return out;
});

const TARGETS = '.btn.sm, .kill, .seg button, .clip, [data-hold^="nudge"], [data-act="eject"], [data-seg="fx.beats"] button, [data-seg="xf"] button, #xfCurve button';
const smallTargets = (minW = 32, minH = 32) => page.evaluate(([sel, minW, minH]) => {
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[hidden]')) continue;
    const b = el.getBoundingClientRect();
    if (b.width < minW - 0.01 || b.height < minH - 0.01) out.push(`${el.dataset.act || el.dataset.v || el.dataset.kill || el.dataset.hold || el.id || el.className}: ${b.width.toFixed(1)}x${b.height.toFixed(1)}`);
  }
  return out;
}, [TARGETS, minW, minH]);

before(async () => {
  ui = await openUi({ state: threeDecks(), viewport: { width: 1280, height: 720 } });
  page = ui.page;
  await page.waitForSelector('.deck >> nth=2');
});
after(async () => { await ui?.close(); });

for (const [w, h, n] of [[1280, 720, 4], [1280, 720, 6], [1920, 1080, 4], [1920, 1080, 6], [1440, 900, 4]]) {
  test(`every control is on screen and uncovered at ${w}x${h} with ${n} decks`, async () => {
    await show(w, h, nDecks(n));
    fs.mkdirSync(ART, { recursive: true });
    await page.screenshot({ path: path.join(ART, `deck-ui-${w}x${h}-${n}.png`) });
    assert.deepEqual(await offenders(), []);
  });
}

test('the deck count drives a compact variant above three decks', async () => {
  await show(1280, 720, threeDecks());
  assert.equal(await page.evaluate(() => document.body.classList.contains('compact')), false);
  await show(1280, 720, nDecks(4));
  assert.equal(await page.evaluate(() => document.body.dataset.decks), '4');
  assert.equal(await page.evaluate(() => document.body.classList.contains('compact')), true);
  const tall = await page.evaluate(() => document.querySelector('.wave-row').getBoundingClientRect().height);
  await show(1280, 720, nDecks(6));
  const short = await page.evaluate(() => document.querySelector('.wave-row').getBoundingClientRect().height);
  assert.ok(short < tall, `waveform rows shrink with more decks: ${short} vs ${tall}`);
});

test('three decks still fit at 1280x720 and 1440x900', async () => {
  for (const [w, h] of [[1280, 720], [1440, 900]]) {
    await show(w, h, threeDecks());
    assert.deepEqual(await offenders(), [], `${w}x${h}`);
  }
});

test('hit targets are at least 32 px at 1280x720', async () => {
  for (const n of [3, 4]) {
    await show(1280, 720, n === 3 ? threeDecks() : nDecks(n));
    assert.deepEqual(await smallTargets(), [], `${n} decks`);
  }
  // Six columns at 1280 px: every target keeps its 32 px height; the eight FX beat buttons share one row.
  await show(1280, 720, nDecks(6));
  assert.deepEqual(await smallTargets(20, 32), [], '6 decks');
  assert.deepEqual((await smallTargets(32, 32)).filter((s) => !/^(0\.0625|0\.125|0\.25|0\.5|0\.75|1|2|4): /.test(s)), [], '6 decks, all but FX beats');
});

test('small labels are at least 0.75rem and reach 4.5:1 contrast', async () => {
  await show(1280, 720, threeDecks());
  const bad = await page.evaluate(() => {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return 'rgb(7, 8, 11)'; };
    const out = [];
    const sel = '.deck .k-label, .deck .k-value, .deck .kill:not([aria-pressed="true"]), .deck .bpm-unit, .deck .hslider .readout, .deck .native, .deck .reserve, .deck .reserve .label, .deck [data-seg] button:not([aria-pressed="true"]), .clip, .gr, #xfCurve button:not([aria-pressed="true"]), .clock-label, .tag';
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('[hidden]') || !el.textContent.trim()) continue;
      const cs = getComputedStyle(el), px = parseFloat(cs.fontSize);
      const fg = lum(cs.color), bg = lum(bgOf(el));
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      if (px < root * 0.75 - 0.01) out.push(`${el.className}: ${px.toFixed(2)}px`);
      if (ratio < 4.5) out.push(`${el.className}: contrast ${ratio.toFixed(2)}`);
    }
    return [...new Set(out)];
  });
  assert.deepEqual(bad, []);
});

test('toasts never cover a control, let clicks through, de-duplicate and cap at three', async () => {
  const LONG = `Loaded “${'A very long page title with many words '.repeat(4)}” on deck 2. It is cued: press PLAY when you're ready.`;
  const configs = [[1280, 720, 1], [1280, 720, 2], [1280, 720, 3], [1280, 720, 4], [1280, 720, 6], [1440, 900, 2], [1440, 900, 4], [1920, 1080, 2], [1920, 1080, 6]];
  for (const [w, h, n] of configs) {
    for (const drawer of [false, true]) {
      await show(w, h, n === 3 ? threeDecks() : nDecks(n));
      await page.evaluate((open) => { document.getElementById('sources').hidden = !open; for (const t of document.querySelectorAll('.toast')) t.remove(); }, drawer);
      for (let i = 0; i < 3; i++) await ui.push({ t: 'event', level: 'warn', text: `Deck ${i + 1}: reserve empty, playing at the source's speed until it refills.` });
      await ui.push({ t: 'event', level: 'error', text: LONG });
      await page.waitForTimeout(40);
      const r = await page.evaluate(() => {
        const pts = [[0.5, 0.5], [0.5, 0.15], [0.5, 0.85], [0.15, 0.5], [0.85, 0.5]];
        const under = [];
        const sel = '.topbar button, .board button, .board [role="slider"], .xfader-bar button, .xfader-bar [role="slider"], .drawer:not([hidden]) button';
        for (const el of document.querySelectorAll(sel)) {
          if (el.closest('[hidden]')) continue;
          const b = el.getBoundingClientRect();
          if (pts.some(([fx, fy]) => { const t = document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy); return t && t.closest('.toast'); })) under.push(el.id || el.dataset.act || el.dataset.ctl || el.dataset.v || el.className);
        }
        return {
          count: document.querySelectorAll('.toast').length,
          under,
          containerPE: getComputedStyle(document.getElementById('toasts')).pointerEvents,
        };
      });
      assert.deepEqual(r, { count: 3, under: [], containerPE: 'none' }, `${w}x${h} ${n} decks${drawer ? ', sources open' : ''}`);
    }
  }
  await page.evaluate(() => { document.getElementById('sources').hidden = true; });
  // A repeated text bumps a counter on the existing toast instead of stacking.
  await page.evaluate(() => { for (const t of document.querySelectorAll('.toast')) t.remove(); });
  for (let i = 0; i < 3; i++) await ui.push({ t: 'event', level: 'info', text: 'Deck 1: sync off (tempo moved by hand).' });
  await page.waitForTimeout(40);
  const toasts = page.locator('.toast');
  assert.equal(await toasts.count(), 1);
  assert.match(await toasts.first().textContent(), /sync off.*×3/);
  // Click to dismiss.
  await toasts.first().click();
  assert.equal(await page.locator('.toast').count(), 0);
});

test('RES knob sets filter.res and follows the engine', async () => {
  await show(1280, 720, threeDecks());
  const res = page.locator('.deck').first().locator('[data-ctl="filter.res"]');
  assert.equal(await res.getAttribute('role'), 'slider');
  assert.equal(await res.getAttribute('aria-valuenow'), '0.300');
  await ui.clearSent();
  const b = await res.locator('svg').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 36, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(60);
  const s = await sent('set', (m) => m.deck === 1 && m.key === 'filter.res');
  assert.ok(s.length >= 1 && s.at(-1).value > 0.45, JSON.stringify(s));
  const st = threeDecks();
  st.decks[0].params['filter.res'] = 0.8;
  await ui.push({ t: 'state', s: st });
  await page.waitForTimeout(60);
  assert.equal(await res.getAttribute('aria-valuenow'), '0.800');
});

test('Shift on the on-screen nudge buttons sends the fine nudge', async () => {
  await show(1280, 720, threeDecks());
  const acts = async () => (await sent('act', (m) => m.deck === 1 && m.a === 'nudge')).map((m) => m.arg);
  for (const [shift, sel, dir] of [[false, 'nudge+', 1], [true, 'nudge+', 1], [true, 'nudge-', -1]]) {
    await ui.clearSent();
    const b = await page.locator('.deck').first().locator(`[data-hold="${sel}"]`).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.waitForTimeout(40);
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
    await page.waitForTimeout(40);
    assert.deepEqual(await acts(), [{ dir, fine: shift }, { dir: 0 }], `${sel} shift=${shift}`);
  }
});

test('clicking a deck meter clears that deck\'s clip light', async () => {
  await show(1280, 720, threeDecks());
  await ui.clearSent();
  await page.locator('.deck').nth(1).locator('[data-meter]').click();
  await page.waitForTimeout(40);
  const a = await sent('act', (m) => m.a === 'clipReset');
  assert.deepEqual(a.map((m) => [m.deck, m.arg]), [[2, {}]]);
});

test('no console errors', () => { assert.deepEqual(ui.errors, []); });
