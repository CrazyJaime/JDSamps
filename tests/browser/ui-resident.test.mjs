// The deck page for the three kinds of deck: a whole track (TRACK: elapsed and remaining time, no LIVE,
// seek anywhere in the track, the analysis's bar 1 offered), a live tab (LIVE, as before), and one still
// loading (LOADING · n % and what it is doing, inert but for eject and cancel; a failed load says why and
// copies its load report). Fake engine and hub.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUi } from './ui-harness.mjs';
import { deck, makeState, makeWave, residentDeck, loadingDeck } from './fixtures/mock-state.mjs';

const ART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
const REPORT = 'JD Samps load report\nsource: https://example.com/slow.wav\ntried: direct fetch\nfirst failure: HTTP 404';
const ERROR = 'Could not fetch that link: HTTP 404';
let ui, page;
const wait = (ms) => page.waitForTimeout(ms);
const sent = async (t, filter) => (await ui.sent()).filter((m) => m.t === t && (!filter || filter(m)));
const deckEl = (slot) => page.locator('.deck').nth(slot - 1);
const row = (slot) => page.locator('.wave-row').nth(slot - 1);
const toasts = () => page.locator('.toast').allTextContents();
const clearToasts = () => page.evaluate(() => document.getElementById('toasts').replaceChildren());
const text = async (loc) => (await loc.textContent()).trim();

/** Deck 1 live and playing, deck 2 a whole track paused at 1:23 of 4:04, deck 3 loading (42 %). */
function kinds(edit) {
  const s = makeState({ decks: [deck(), residentDeck(), loadingDeck()] });
  if (edit) edit(s);
  return s;
}
const failed = (edit) => kinds((s) => {
  s.decks[2].load = { state: 'error', progress: 0.42, strategy: null, error: ERROR, report: REPORT };
  if (edit) edit(s);
});

async function show(state, { width = 1280, height = 720 } = {}) {
  await page.setViewportSize({ width, height });
  await ui.push({ t: 'state', s: { ...state, wallMs: Date.now() } });
  await page.waitForFunction((n) => document.querySelectorAll('.deck').length === n, state.decks.length);
  await wait(80);
}

/** navigator.clipboard.writeText, recorded in window.__copied. */
const stubClipboard = () => page.evaluate(() => {
  window.__copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } });
});
const copied = () => page.evaluate(() => window.__copied);

before(async () => {
  ui = await openUi({ state: kinds(), hubReplies: { LIST_SOURCES: { ok: true, tabs: [] } }, viewport: { width: 1280, height: 720 } });
  page = ui.page;
  await page.waitForSelector('.deck >> nth=2');
  await ui.push(makeWave(1, 63, 124));
  await ui.push(makeWave(2, 244.9, 124));
  await wait(150);
});
after(async () => { await ui?.close(); });

// ---------------------------------------------------------------- what each deck is
test('each deck says what it is in its header: TRACK, LIVE, or LOADING with its progress, and what the load is doing beside it', async () => {
  await show(kinds());
  const head = (slot) => deckEl(slot).locator('.deck-head');
  assert.equal(await text(head(1).locator('[data-kind]')), 'LIVE');
  assert.equal(await text(head(2).locator('[data-kind]')), 'TRACK');
  assert.equal(await text(head(3).locator('[data-kind]')), 'LOADING · 42%');
  assert.equal(await deckEl(3).locator('[data-load-line]').textContent(), 'fetching the link');
  for (const slot of [1, 2]) assert.equal(await deckEl(slot).locator('[data-load-line]').isHidden(), true, `deck ${slot}`);
  // Progress and strategy follow the snapshot.
  await show(kinds((s) => { Object.assign(s.decks[2].load, { progress: 0.8, strategy: 'finding the beat' }); }));
  assert.equal(await text(head(3).locator('[data-kind]')), 'LOADING · 80%');
  assert.equal(await deckEl(3).locator('[data-load-line]').textContent(), 'finding the beat');
  // A deck with no tab and no title is named after its slot, never "Tab null".
  await show(kinds((s) => { s.decks[1].title = ''; }));
  assert.equal(await deckEl(2).locator('[data-title]').textContent(), 'Deck 2');
});

test('a whole-track deck shows elapsed and remaining time in place of the reserve, and no LIVE; a live deck is unchanged', async () => {
  await show(kinds());
  const live = deckEl(1), track = deckEl(2);
  assert.equal(await track.locator('[data-time]').textContent(), '1:23 / -2:41');
  assert.equal(await track.locator('[data-act="live"]').isHidden(), true);
  assert.equal(await track.locator('.reserve').isHidden(), true);
  assert.equal(await live.locator('[data-act="live"]').isVisible(), true);
  assert.equal(await live.locator('.reserve').isVisible(), true);
  assert.equal(await live.locator('[data-time]').isHidden(), true);
  // Playing, it runs with the playhead.
  await show(kinds((s) => Object.assign(s.decks[1], { playing: true, engineRate: 1, playhead: 61.2 })));
  assert.equal(await track.locator('[data-time]').textContent(), '1:01 / -3:03');
});

test('a whole-track deck that has played to its end says END', async () => {
  await show(kinds((s) => Object.assign(s.decks[1], { playhead: 244.9, reserve: 0 })));
  const t = deckEl(2).locator('[data-time]');
  assert.equal(await t.textContent(), '4:04 / END');
  assert.match(await t.getAttribute('class'), /\bend\b/);
});

// ---------------------------------------------------------------- loading: inert, cancel
test('a loading deck is inert but for eject and cancel: the rest is dimmed and aria-disabled, and pressing it sends nothing', async () => {
  await show(kinds());
  await clearToasts();
  const d3 = deckEl(3);
  const r = await d3.evaluate((el) => {
    const all = [...el.querySelectorAll('button, [role="slider"], [role="button"]')].filter((x) => !x.closest('[hidden]'));
    const off = all.filter((x) => x.getAttribute('aria-disabled') === 'true');
    return {
      active: all.filter((x) => !off.includes(x)).map((x) => x.dataset.act || x.className).sort(),
      dimmed: off.every((x) => Number(getComputedStyle(x).opacity) < 0.6),
      n: off.length,
    };
  });
  assert.deepEqual(r.active, ['eject', 'loadCancel']);
  assert.ok(r.dimmed && r.n > 40, JSON.stringify(r));
  for (const slot of [1, 2]) assert.equal(await deckEl(slot).locator('[aria-disabled="true"]').count(), 0, `deck ${slot}`);
  assert.equal(await row(3).locator('[data-overview]').getAttribute('aria-disabled'), 'true');
  // Its A/THRU/B and REC give their place to what the load is doing.
  for (const sel of ['[data-seg="xf"] button[data-v="A"]', '[data-act="rec"]']) assert.equal(await d3.locator(sel).isVisible(), false, sel);

  // Each press is checked right after it, before the next one could undo what it did (a later click closes a tempo
  // entry the last one opened): nothing sent for the deck, no tempo entry, no toast, and the deck looks the same.
  const look = () => d3.evaluate((el) => [el.textContent, ...[...el.querySelectorAll('[aria-pressed], [aria-valuenow], [data-bpm], [data-native]')]
    .map((x) => `${x.getAttribute('aria-pressed')}|${x.getAttribute('aria-valuenow')}|${x.hidden}`)].join('\n'));
  const before = await look();
  const press = async (what, fn) => {
    await ui.clearSent();
    await fn();
    await wait(40); // a slider's value goes out on the next frame
    assert.deepEqual((await ui.sent()).filter((m) => (m.t === 'act' || m.t === 'set') && m.deck === 3), [], `${what}: sent to the engine`);
    assert.equal(await page.locator('input.tempo-edit').count(), 0, `${what}: a tempo entry opened`);
    assert.deepEqual(await toasts(), [], `${what}: toast`);
    assert.ok((await look()) === before, `${what}: the deck changed`);
  };
  for (const sel of ['[data-act="playToggle"]', '[data-act="sync"]', '[data-act="master"]', '[data-act="syncPlay"]', '[data-act="live"]', '[data-act="half"]',
    '[data-act="tap"]', '[data-act="gridFwd"]', '[data-act="keyLock"]', '[data-act="syncMode"]', '[data-act="jumpFwd"]', '[data-act="jumpSize"]', '[data-act="range"]',
    '[data-seg="fx.type"] button[data-v="GATE"]', '[data-kill="low"]', '[data-pad="fx.on"]', '[data-roll="0.5"]',
    '[data-hold="cue"]', '[data-hold="nudge+"]', '[data-bpm]', '[data-native]', '[data-act="clipReset"]']) {
    await press(sel, () => d3.locator(sel).click({ force: true })); // past Playwright's own aria-disabled check: the page must ignore it
  }
  for (const ctl of ['[data-ctl="eq.hi"] svg', '[data-ctl="pitch"]', '[data-ctl="fader"]']) {
    const b = await d3.locator(ctl).boundingBox();
    await press(`drag ${ctl}`, async () => {
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2 - 30, { steps: 4 });
      await page.mouse.up();
    });
    await press(`wheel ${ctl}`, () => page.mouse.wheel(0, -120));
  }
  const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
  await blur();
  for (const k of ['Digit3', 'Space', 'KeyS', 'Shift+KeyS', 'KeyQ', 'KeyF', 'KeyT', 'Shift+KeyT', 'KeyK', 'ArrowUp', 'Comma', 'Period', 'KeyV', 'KeyC', 'ArrowRight', 'KeyR']) {
    await press(k, () => page.keyboard.press(k));
  }
  // A focused control's own keys.
  for (const [sel, k] of [['[data-bpm]', 'Enter'], ['[data-ctl="eq.hi"]', 'ArrowUp'], ['[data-kill="low"]', 'Enter']]) {
    await press(`${k} on ${sel}`, async () => { await d3.locator(sel).focus(); await page.keyboard.press(k); });
  }
  await blur();
  await press('click the overview', async () => {
    const ov = await row(3).locator('[data-overview]').boundingBox();
    await page.mouse.click(ov.x + ov.width / 2, ov.y + ov.height / 2);
  });
  await press('drag the waveform', async () => {
    const wv = await row(3).locator('[data-wave]').boundingBox();
    await page.mouse.move(wv.x + wv.width / 2, wv.y + wv.height / 2);
    await page.mouse.down();
    await page.mouse.move(wv.x + wv.width / 2 - 100, wv.y + wv.height / 2, { steps: 4 });
    await page.mouse.up();
  });
});

test('the cancel ✕ sends loadCancel at once; a held eject still ejects a loading deck', async () => {
  await show(kinds());
  for (const slot of [1, 2]) assert.equal(await deckEl(slot).locator('[data-act="loadCancel"]').isHidden(), true, `deck ${slot}`);
  await ui.clearSent();
  const x = deckEl(3).locator('[data-act="loadCancel"]');
  assert.match(await x.getAttribute('aria-label'), /cancel/i);
  await x.click();
  await wait(50);
  assert.deepEqual((await sent('act', (m) => m.deck === 3)).map((m) => [m.a, m.arg]), [['loadCancel', {}]]);
  // That deck is gone now; the next loading deck takes a held eject.
  await show(kinds((s) => { s.decks[2].id = 9; }));
  await ui.clearSent();
  const b = await deckEl(3).locator('[data-act="eject"]').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await wait(600);
  await page.mouse.up();
  assert.deepEqual((await sent('act', (m) => m.deck === 9)).map((m) => m.a), ['eject']);
});

// ---------------------------------------------------------------- failed loads, load reports
test('a failed load says why in one line and copies its load report', async () => {
  await stubClipboard();
  await clearToasts();
  await show(failed());
  const d3 = deckEl(3);
  assert.equal(await text(d3.locator('[data-kind]')), 'FAILED');
  assert.equal(await d3.locator('[data-load-line]').textContent(), ERROR);
  const btn = d3.locator('.deck-status [data-copy-report]');
  assert.equal(await btn.isVisible(), true);
  assert.equal(await text(btn), 'Copy load report');
  assert.equal(await btn.getAttribute('aria-disabled'), null, 'not inert');
  assert.equal(await d3.locator('.jump').isHidden(), true);
  assert.equal(await d3.locator('[data-act="loadCancel"]').isVisible(), true, 'the ✕ clears a failed deck away');
  await btn.click();
  await wait(50);
  assert.deepEqual(await copied(), [REPORT]);
  assert.match((await toasts()).join('|'), /report copied/i);
  // An engine that gave no report: the button still copies what the deck knows.
  await show(failed((s) => { s.decks[2].load.report = null; }));
  await btn.click();
  await wait(50);
  const last = (await copied()).at(-1);
  for (const want of [ERROR, 'slow', 'https://example.com/slow.wav']) assert.ok(last.includes(want), `${want} in ${JSON.stringify(last)}`);
  for (const slot of [1, 2]) assert.equal(await deckEl(slot).locator('[data-copy-report]').first().isVisible(), false, `deck ${slot}`);
});

test('any deck with a load report offers Copy load report from its ⓘ menu', async () => {
  await stubClipboard();
  await show(kinds((s) => { s.decks[1].load.report = REPORT; }));
  assert.equal(await deckEl(1).locator('[data-report-btn]').isHidden(), true, 'no report, no ⓘ');
  const info = deckEl(2).locator('[data-report-btn]'), menu = deckEl(2).locator('[data-report-menu]');
  assert.equal(await info.isVisible(), true);
  assert.equal(await menu.isHidden(), true);
  await info.click();
  assert.equal(await menu.isVisible(), true);
  assert.equal(await info.getAttribute('aria-expanded'), 'true');
  await menu.getByRole('button', { name: 'Copy load report' }).click();
  await wait(50);
  assert.deepEqual(await copied(), [REPORT]);
  assert.equal(await menu.isHidden(), true, 'closes once used');
  assert.equal(await info.getAttribute('aria-expanded'), 'false');
  await info.click();
  await page.keyboard.press('Escape');
  assert.equal(await menu.isHidden(), true, 'Escape closes it');
  await info.click();
  await deckEl(1).locator('[data-title]').click();
  assert.equal(await menu.isHidden(), true, 'a click elsewhere closes it');
  assert.equal(await menu.locator('[data-record-whole]').isHidden(), true, 'a whole-track deck has nothing to record');
});

test('a live deck whose whole-track load failed offers to record the whole track at 2× from its ⓘ menu', async () => {
  await show(kinds((s) => { s.decks[0].load.report = REPORT; }));
  await ui.clearSent();
  const menu = deckEl(1).locator('[data-report-menu]');
  await deckEl(1).locator('[data-report-btn]').click();
  const rec = menu.getByRole('button', { name: 'Record whole track (2×, reduced highs)' });
  assert.equal(await rec.isVisible(), true);
  await rec.click();
  await wait(50);
  assert.deepEqual((await sent('act', (m) => m.deck === 1)).map((m) => m.a), ['recordWhole']);
  assert.equal(await menu.isHidden(), true);
});

test('the ⓘ menu is a plain list of buttons, like the rest of the page: used from the keyboard, focus goes back to the ⓘ; Tab out closes it', async () => {
  await stubClipboard();
  await show(kinds((s) => { s.decks[0].load.report = REPORT; }));
  const info = deckEl(1).locator('[data-report-btn]'), menu = deckEl(1).locator('[data-report-menu]');
  assert.equal(await page.locator('[role="menu"], [role="menuitem"], [aria-haspopup="menu"], [aria-haspopup="true"]').count(), 0, 'no menu roles anywhere');
  const focused = (loc) => loc.evaluate((el) => document.activeElement === el);
  for (const [name, tabs] of [['Copy load report', 0], ['Record whole track (2×, reduced highs)', 1]]) {
    await info.focus();
    await page.keyboard.press('Enter');
    assert.equal(await menu.isVisible(), true, name);
    for (let i = 0; i < tabs; i++) await page.keyboard.press('Tab');
    assert.equal(await focused(menu.getByRole('button', { name })), true, `${name} focused`);
    await page.keyboard.press('Enter');
    await wait(50);
    assert.equal(await menu.isHidden(), true, `${name}: closed once used`);
    assert.equal(await focused(info), true, `${name}: focus back on the ⓘ`);
  }
  await info.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await menu.isHidden(), true, 'Tab past its last button closes it');
  assert.equal(await info.getAttribute('aria-expanded'), 'false');
});

test('the ⓘ menu opens inside the window on the leftmost and the rightmost of six decks at 1280×720', async () => {
  const decks = [1, 2, 3, 4, 5, 6].map((i) => deck({ id: i, slot: i, tabId: 100 + i, title: `Track number ${i} with a fairly long title here`, load: { report: REPORT } }));
  await show(makeState({ decks }), { width: 1280, height: 720 });
  for (const slot of [1, 6]) {
    await deckEl(slot).locator('[data-report-btn]').click();
    const menu = deckEl(slot).locator('[data-report-menu]');
    assert.equal(await menu.isVisible(), true, `deck ${slot}`);
    const out = await menu.evaluate((m) => {
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, b = m.getBoundingClientRect(), o = [];
      if (b.left < 0 || b.top < 0 || b.right > vw || b.bottom > vh) o.push(`menu ${Math.round(b.left)}..${Math.round(b.right)} x ${Math.round(b.top)}..${Math.round(b.bottom)} outside ${vw}x${vh}`);
      // Each item whole and on top, at both ends: not cut off by the deck row's scroll box either.
      for (const it of m.querySelectorAll('button')) {
        if (it.hidden) continue;
        const r = it.getBoundingClientRect(), y = (r.top + r.bottom) / 2;
        for (const x of [r.left + 2, r.right - 2]) if (!it.contains(document.elementFromPoint(x, y))) o.push(`"${it.textContent}" cut off at x=${Math.round(x)}`);
      }
      const d = document.getElementById('decks');
      if (d.scrollWidth > d.clientWidth + 1) o.push(`decks scroll horizontally ${d.scrollWidth} > ${d.clientWidth}`);
      return o;
    });
    assert.deepEqual(out, [], `deck ${slot}`);
    await page.keyboard.press('Escape');
    assert.equal(await menu.isHidden(), true);
  }
});

// ---------------------------------------------------------------- bar 1, navigation
test('a whole-track deck offers the analysis\'s bar 1 as a "Bar 1?" chip that marks it there', async () => {
  await show(kinds());
  const chip = deckEl(2).locator('[data-act="bar1"]');
  assert.equal(await chip.isVisible(), true);
  assert.match(await text(chip), /^bar 1\?$/i);
  for (const slot of [1, 3]) assert.equal(await deckEl(slot).locator('[data-act="bar1"]').isHidden(), true, `deck ${slot}`);
  await ui.clearSent();
  await chip.click();
  await wait(50);
  assert.deepEqual((await sent('act', (m) => m.deck === 2)).map((m) => [m.a, m.arg]), [['tap1', { t: 2.34 }]]);
  await show(kinds((s) => { s.decks[1].grid.bar1 = 2.34; }));
  assert.equal(await chip.isHidden(), true, 'bar 1 is set');
  await show(kinds((s) => { s.decks[1].analysis.bar1 = null; }));
  assert.equal(await chip.isHidden(), true, 'nothing suggested');
});

test('on a whole-track deck the overview spans the whole track, and a seek reaches anywhere in it', async () => {
  await show(kinds());
  for (const f of [0.02, 0.5, 0.98]) {
    await ui.clearSent();
    const b = await row(2).locator('[data-overview]').boundingBox();
    await page.mouse.click(b.x + f * b.width, b.y + b.height / 2);
    await wait(60);
    const s = await sent('act', (m) => m.deck === 2 && m.a === 'seek');
    assert.equal(s.length, 1, JSON.stringify(s));
    assert.ok(Math.abs(s[0].arg.pos - f * 244.9) < 1.5, `seek to ${s[0].arg.pos}, expected ~${f * 244.9}`);
  }
  // Dragging the zoomed waveform of a paused deck stops at either end of the track.
  for (const [at, dir, lo, hi] of [[240, -1, 244.8, 244.9], [3, 1, 0, 0.1]]) {
    await wait(200); // the last drag's playhead has settled: the snapshot's takes over again
    await show(kinds((s) => Object.assign(s.decks[1], { playhead: at, reserve: 244.9 - at })));
    await ui.clearSent();
    const b = await row(2).locator('[data-wave]').boundingBox();
    const y = b.y + b.height / 2, x0 = dir < 0 ? b.x + b.width - 5 : b.x + 5;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x0 + dir * (b.width - 10), y, { steps: 8 });
    await page.mouse.up();
    await wait(60);
    const p = (await sent('act', (m) => m.deck === 2 && m.a === 'seek')).at(-1).arg.pos;
    assert.ok(p >= lo - 1e-9 && p <= hi + 1e-9, `drag from ${at} ended at ${p}`);
  }
});

// ---------------------------------------------------------------- layout
/** Every visible control in the board and crossfader bar that is off-screen or covered by something else. */
const offenders = () => page.evaluate(() => {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const out = [];
  for (const el of document.querySelectorAll('.board [data-act], .board button, .board [role="slider"], .xfader-bar button, .xfader-bar [role="slider"]')) {
    if (el.closest('[hidden]') || getComputedStyle(el).visibility === 'hidden') continue;
    const b = el.getBoundingClientRect();
    const name = `${el.closest('.deck') ? `deck${[...document.querySelectorAll('.deck')].indexOf(el.closest('.deck')) + 1} ` : ''}${el.dataset.act || el.dataset.ctl || el.dataset.v || el.className}`;
    if (b.width < 1 || b.height < 1) { out.push(`${name}: not rendered`); continue; }
    if (b.left < -0.5 || b.top < -0.5 || b.right > vw + 0.5 || b.bottom > vh + 0.5) { out.push(`${name}: outside viewport`); continue; }
    const t = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
    if (!t || !(t === el || el.contains(t))) out.push(`${name}: covered by ${t ? t.className || t.tagName : 'nothing'}`);
  }
  const d = document.getElementById('decks');
  if (d.scrollHeight > d.clientHeight + 1) out.push(`decks scroll vertically ${d.scrollHeight} > ${d.clientHeight}`);
  if (d.scrollWidth > d.clientWidth + 1) out.push(`decks scroll horizontally ${d.scrollWidth} > ${d.clientWidth}`);
  // The kind badge sits inside the header, whose two lines are no taller than its buttons; the load line takes the A/THRU/B and REC row.
  for (const [i, dk] of [...document.querySelectorAll('.deck')].entries()) {
    const ej = dk.querySelector('[data-act="eject"]').getBoundingClientRect();
    const lines = dk.querySelector('.head-text').getBoundingClientRect();
    if (lines.height > ej.height + 0.5) out.push(`deck${i + 1} header text ${lines.height.toFixed(1)} px, taller than its buttons (${ej.height.toFixed(1)})`);
    for (const [sel, box] of [['[data-kind]', '.deck-head'], ['[data-load-line]', '.deck-assign']]) {
      const el = dk.querySelector(sel), r = dk.querySelector(box).getBoundingClientRect();
      if (el.closest('[hidden]')) continue;
      const b = el.getBoundingClientRect();
      if (b.top < r.top - 0.5 || b.bottom > r.bottom + 0.5 || b.left < r.left - 0.5 || b.right > r.right + 0.5) out.push(`deck${i + 1} ${sel} outside ${box}`);
    }
  }
  return out;
});
const smallTargets = () => page.evaluate(() => [...document.querySelectorAll('.deck .btn.sm, .deck [data-act="eject"]')]
  .filter((el) => !el.closest('[hidden]')).map((el) => [el.dataset.act || el.className, el.getBoundingClientRect()])
  .filter(([, b]) => b.height < 32 - 0.01 || b.width < 20).map(([n, b]) => `${n}: ${b.width.toFixed(1)}x${b.height.toFixed(1)}`));
/** New labels: at least 0.75rem and 4.5:1 against what is behind them. */
const badLabels = () => page.evaluate(() => {
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return 'rgb(7, 8, 11)'; };
  const out = [];
  for (const el of document.querySelectorAll('.deck [data-kind], .deck [data-load-line], .deck [data-time], .deck [data-copy-report], .deck [data-act="bar1"]')) {
    if (el.closest('[hidden]') || !el.textContent.trim()) continue;
    const cs = getComputedStyle(el), px = parseFloat(cs.fontSize), fg = lum(cs.color), bg = lum(bgOf(el));
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    if (px < root * 0.75 - 0.01) out.push(`${el.className}: ${px.toFixed(2)}px`);
    if (ratio < 4.5) out.push(`${el.className}: contrast ${ratio.toFixed(2)}`);
  }
  return [...new Set(out)];
});

test('six decks of every kind fit at laptop sizes: nothing off screen, covered or under 32 px, the badge in the header and the load line in its row', async () => {
  const long = (i) => `Track number ${i} with a fairly long title here`;
  const six = makeState({
    decks: [
      deck({ id: 1, slot: 1, tabId: 101, title: long(1) }),
      residentDeck({ id: 2, slot: 2, title: long(2), load: { report: REPORT } }),
      loadingDeck({ id: 3, slot: 3, title: long(3), load: { strategy: 'fast-forwarding the player' } }),
      loadingDeck({ id: 4, slot: 4, title: long(4), load: { state: 'error', error: ERROR, report: REPORT } }),
      residentDeck({ id: 5, slot: 5, title: long(5), playing: true, engineRate: 1.02, rec: { state: 'recording', format: 'wav', seconds: 73.4 } }),
      deck({ id: 6, slot: 6, tabId: 106, title: long(6), starved: true, reserve: 0.4, load: { report: REPORT } }),
    ],
  });
  await wait(200); // a seek made by an earlier test has settled
  for (const [w, h] of [[1280, 720], [1440, 900], [1920, 1080]]) {
    await show(six, { width: w, height: h });
    fs.mkdirSync(ART, { recursive: true });
    await page.screenshot({ path: path.join(ART, `deck-ui-resident-${w}x${h}-6.png`) });
    assert.deepEqual(await offenders(), [], `${w}x${h}`);
    assert.deepEqual(await smallTargets(), [], `${w}x${h}`);
    assert.deepEqual(await badLabels(), [], `${w}x${h}`);
    // What a loading deck is doing stays readable beside its badge.
    const line = await deckEl(3).locator('[data-load-line]').boundingBox();
    assert.ok(line.width >= 40, `${w}x${h}: load line ${line.width.toFixed(1)} px wide`);
  }
  for (const n of [3, 4]) {
    await show(makeState({ decks: six.decks.slice(0, n) }));
    assert.deepEqual(await offenders(), [], `${n} decks`);
  }
});

/** The last deck's badge and load line: the badge clear of every button and unclipped, the line's width and what is on top of it. */
const loadGeometry = () => page.evaluate(() => {
  const dk = [...document.querySelectorAll('.deck')].at(-1), kind = dk.querySelector('[data-kind]'), b = kind.getBoundingClientRect();
  const out = [];
  for (const el of dk.querySelectorAll('button')) {
    if (el.closest('[hidden]') || getComputedStyle(el).visibility === 'hidden') continue;
    const r = el.getBoundingClientRect(), ox = Math.min(b.right, r.right) - Math.max(b.left, r.left), oy = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
    if (ox > 0.5 && oy > 0.5) out.push(`badge under ${el.getAttribute('aria-label') || el.dataset.act || el.className} by ${ox.toFixed(1)} px`);
  }
  const shown = [...kind.children].filter((s) => s.getClientRects().length);
  for (const s of [kind, ...shown]) if (s.scrollWidth > s.clientWidth + 0.5) out.push(`badge text "${s.textContent}" clipped`);
  const hit = document.elementFromPoint(b.right - 3, (b.top + b.bottom) / 2);
  if (!kind.contains(hit)) out.push(`badge end covered by ${hit ? (hit.closest('button') || hit).getAttribute('aria-label') || hit.getAttribute('class') : 'nothing'}`);
  const ln = dk.querySelector('[data-load-line]'), l = ln.getBoundingClientRect();
  if (l.width < 40) out.push(`load line "${ln.textContent}" ${l.width.toFixed(1)} px wide`);
  else if (!ln.contains(document.elementFromPoint(l.left + 20, (l.top + l.bottom) / 2))) out.push('load line covered');
  return { out, badge: shown.map((s) => s.textContent).join('') };
});

test('with one to six decks, a loading or failed deck says what it is doing in at least 40 px, its badge clear of its buttons', async () => {
  const long = (i) => `Track number ${i} with a fairly long title here`;
  const others = [deck({ id: 1, tabId: 101 }), residentDeck({ id: 2 }), deck({ id: 4, tabId: 104 }), residentDeck({ id: 5 }), deck({ id: 6, tabId: 106 })];
  const states = {
    loading: { strategy: 'reading the file' },
    'loading with a report': { strategy: 'reading the file', report: REPORT },
    failed: { state: 'error', strategy: null, error: ERROR, report: REPORT },
  };
  const problems = [];
  for (const [w, h] of [[1280, 720], [1440, 900], [1920, 1080]]) {
    for (const [name, load] of Object.entries(states)) {
      for (let n = 1; n <= 6; n++) {
        const decks = [...others.slice(0, n - 1), loadingDeck({ id: 3, load })].map((d, i) => ({ ...d, slot: i + 1, title: long(i + 1) }));
        await show(makeState({ decks }), { width: w, height: h });
        const g = await loadGeometry();
        const want = name === 'failed' ? ['FAILED'] : ['LOADING · 42%', '42%'];
        if (!want.includes(g.badge)) g.out.push(`badge shows "${g.badge}"`);
        for (const o of [...g.out, ...await offenders()]) problems.push(`${w}x${h} ${name}, ${n} deck${n > 1 ? 's' : ''}: ${o}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------- drop a file, load a link
/** Drop files ({name, type}) on the element matching sel, as a drag from the desktop does. over: dragenter/dragover only. */
const drop = (sel, files, { over = false } = {}) => page.evaluate(([s, list, o]) => {
  const dt = new DataTransfer();
  for (const f of list) dt.items.add(new File([new Uint8Array(64)], f.name, { type: f.type || '' }));
  const el = document.querySelector(s);
  for (const type of o ? ['dragenter', 'dragover'] : ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [sel, files, over]);
/** URL.revokeObjectURL, recorded in window.__revoked. */
const spyRevoke = () => page.evaluate(() => {
  window.__revoked = [];
  if (!window.__revokeSpied) { window.__revokeSpied = true; const rv = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = (u) => { window.__revoked.push(u); rv(u); }; }
});
const revoked = () => page.evaluate(() => window.__revoked);
/** The fake engine answers only when told (reply). */
const manual = (on) => page.evaluate((v) => { window.__fake.autoReply = !v; }, on);
const reply = (id, ok, error) => page.evaluate(([i, o, e]) => window.__fake.reply(i, o, e), [id, ok, error]);
const loadActs = (a) => sent('act', (m) => m.a === a);

test('an audio file dropped on the board loads onto a whole-track deck; its blob: URL lives until the load settles', async () => {
  await show(kinds());
  await spyRevoke();
  await manual(true);
  await ui.clearSent();
  await clearToasts();
  try {
    await drop('.board', [{ name: 'kick.mp3', type: 'audio/mpeg' }], { over: true });
    assert.equal(await page.evaluate(() => document.body.classList.contains('dropping')), true, 'the page shows where a drop goes');
    await drop('.board', [{ name: 'kick.mp3', type: 'audio/mpeg' }]);
    await wait(50);
    assert.equal(await page.evaluate(() => document.body.classList.contains('dropping')), false);
    const [m, more] = await loadActs('loadFile');
    assert.equal(more, undefined);
    assert.equal(m.deck, null);
    assert.equal(m.arg.name, 'kick.mp3');
    assert.match(m.arg.blobUrl, /^blob:/);
    // The engine answers once the track is decoded and analysed (seconds): no time-out meanwhile, and the blob stays readable.
    await wait(4300);
    assert.deepEqual(await revoked(), []);
    assert.ok(!(await toasts()).some((t) => /did not answer/.test(t)), (await toasts()).join('|'));
    assert.equal(await page.evaluate((u) => fetch(u).then((r) => r.ok), m.arg.blobUrl), true);
    await reply(m.id, true);
    await wait(50);
    assert.deepEqual(await revoked(), [m.arg.blobUrl]);
  } finally { await manual(false); }
});

test('files dropped on a deck load too, each onto its own deck; a refused load is said; anything not audio is refused in the page', async () => {
  await show(kinds());
  await spyRevoke();
  await manual(true);
  await ui.clearSent();
  await clearToasts();
  try {
    await drop('#decks section.deck:nth-of-type(2)', [{ name: 'Mix.FLAC', type: '' }, { name: 'b.ogg', type: 'audio/ogg' }]);
    await wait(50);
    const acts = await loadActs('loadFile');
    assert.deepEqual(acts.map((m) => m.arg.name), ['Mix.FLAC', 'b.ogg'], 'known by its extension when the system gives no type');
    await reply(acts[0].id, false, '“Mix” is not audio this browser can play.');
    await reply(acts[1].id, true);
    await wait(50);
    assert.match((await toasts()).join('|'), /not audio this browser can play/);
    assert.deepEqual((await revoked()).sort(), acts.map((m) => m.arg.blobUrl).sort());
    await ui.clearSent();
    await clearToasts();
    await drop('.board', [{ name: 'notes.txt', type: 'text/plain' }, { name: 'cover.jpg', type: 'image/jpeg' }]);
    await wait(50);
    assert.deepEqual(await loadActs('loadFile'), []);
    assert.match((await toasts()).join('|'), /not an audio file: “notes\.txt”, “cover\.jpg”/i);
  } finally { await manual(false); }
});

test('the Sources drawer loads a link to an audio file; anything but a web link is refused', async () => {
  await show(kinds());
  await ui.clearSent();
  await clearToasts();
  await page.locator('#sourcesBtn').click();
  const field = page.locator('#loadLink'), go = page.locator('#loadLinkBtn');
  assert.equal(await field.isVisible(), true);
  assert.equal(await text(go), 'Load link');
  for (const bad of ['javascript:alert(1)', 'ftp://example.com/a.mp3', 'example.com/a.mp3', '']) {
    await field.fill(bad);
    await go.click();
  }
  await wait(50);
  assert.deepEqual(await loadActs('loadUrl'), []);
  assert.match((await toasts()).join('|'), /web link/i);
  await field.fill('  https://example.com/a.mp3  ');
  await field.press('Enter');
  await wait(50);
  assert.deepEqual((await loadActs('loadUrl')).map((m) => [m.deck, m.arg]), [[null, { url: 'https://example.com/a.mp3' }]]);
  assert.equal(await field.inputValue(), '', 'cleared once sent');
  await page.locator('#sources [data-close]').click();
});

/** A link loaded from the Sources drawer: its loadUrl act. */
async function loadLink(url) {
  await page.locator('#sourcesBtn').click();
  await page.locator('#loadLink').fill(url);
  await page.locator('#loadLink').press('Enter');
  await page.locator('#sources [data-close]').click();
  await wait(30);
  return (await loadActs('loadUrl')).find((m) => m.arg.url === url);
}
/** kinds() with more decks after the first three, each loading the way loadFile/loadUrl's deck does (no tab). Engine
 *  deck ids only ever rise, so theirs are above any an earlier test showed. */
const withLoading = (...more) => kinds((s) => { s.decks.push(...more.map((o) => loadingDeck({ title: 'long', url: '', ...o }))); });
const lastAct = async (a, deckId) => (await sent('act', (m) => m.a === a && m.deck === deckId)).at(-1);

test('a cancel the DJ asked for is not an error: no warning after ✕, a held eject or STOP ALL, and a second ✕ is ignored', async () => {
  await show(kinds());
  await spyRevoke();
  await manual(true);
  await ui.clearSent();
  await clearToasts();
  try {
    // ✕, twice in quick succession: one loadCancel, and the link's "Loading was cancelled." says nothing.
    const link = await loadLink('https://example.com/long.mp3');
    await show(withLoading({ id: 91, slot: 4, url: 'https://example.com/long.mp3' }));
    await deckEl(4).locator('[data-act="loadCancel"]').dblclick();
    await wait(50);
    const cancels = await sent('act', (m) => m.a === 'loadCancel');
    assert.deepEqual(cancels.map((m) => m.deck), [91], 'one loadCancel');
    await reply(cancels[0].id, true);
    await show(kinds());
    await reply(link.id, false, 'Loading was cancelled.');
    await wait(50);
    assert.deepEqual(await toasts(), []);
    // A held eject on a dropped file's loading deck.
    await drop('.board', [{ name: 'b.mp3', type: 'audio/mpeg' }]);
    await wait(30);
    const file = (await loadActs('loadFile')).at(-1);
    await show(withLoading({ id: 92, slot: 4 }));
    const b = await deckEl(4).locator('[data-act="eject"]').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await wait(600);
    await page.mouse.up();
    await reply((await lastAct('eject', 92)).id, true);
    await show(kinds());
    await reply(file.id, false, 'Loading was cancelled.');
    await wait(50);
    assert.deepEqual(await toasts(), []);
    assert.deepEqual(await revoked(), [file.arg.blobUrl]);
    // STOP ALL, confirmed.
    const all = await loadLink('https://example.com/all.mp3');
    await show(withLoading({ id: 93, slot: 4, url: 'https://example.com/all.mp3' }));
    page.once('dialog', (d) => d.accept());
    await page.locator('#stopAllBtn').click();
    await wait(50);
    await reply((await lastAct('stopAll', null)).id, true);
    await show(kinds());
    await reply(all.id, false, 'Loading was cancelled.');
    await wait(50);
    assert.deepEqual(await toasts(), []);
    // A load nobody cancelled still says why it failed.
    const bad = await loadLink('https://example.com/missing.mp3');
    await show(withLoading({ id: 94, slot: 4, url: 'https://example.com/missing.mp3' }));
    await show(kinds());
    await reply(bad.id, false, ERROR);
    await wait(50);
    assert.deepEqual(await toasts(), [ERROR]);
  } finally { await manual(false); }
});

test('a load still loading after the engine\'s answer time keeps waiting, and settles from its deck: resident is done, gone is settled', async () => {
  // The answer time of a load (120 s) is cut to 300 ms here.
  const answerMs = (v) => page.evaluate(async (x) => {
    const { ACT_MS } = await import('/ui/connection.js');
    const old = ACT_MS.loadFile;
    ACT_MS.loadFile = ACT_MS.loadUrl = x;
    return old;
  }, v);
  const late = 700; // past the answer time, twice over
  await show(kinds());
  await spyRevoke();
  await manual(true);
  await ui.clearSent();
  await clearToasts();
  const was = await answerMs(300);
  const resident = (o) => kinds((s) => { s.decks.push(residentDeck({ title: 'long', ...o })); });
  try {
    // A link whose deck loads past the answer time, then turns into a whole track: never a warning.
    const link = await loadLink('https://example.com/slow-link.mp3');
    await show(withLoading({ id: 101, slot: 4, url: 'https://example.com/slow-link.mp3' }));
    await wait(late);
    assert.deepEqual(await toasts(), [], 'no time-out while its deck loads');
    await show(resident({ id: 101, slot: 4 }));
    await reply(link.id, true);
    await wait(50);
    assert.deepEqual(await toasts(), []);
    // A dropped file: its blob: URL lives while the deck loads, and goes once the deck holds the track, answer or not.
    await drop('.board', [{ name: 'long.mp3', type: 'audio/mpeg' }]);
    await wait(30);
    const file = (await loadActs('loadFile')).at(-1);
    await show(withLoading({ id: 102, slot: 5 }));
    await wait(late);
    assert.deepEqual(await revoked(), [], 'still loading');
    await show(resident({ id: 102, slot: 5 }));
    await wait(50);
    assert.deepEqual(await revoked(), [file.arg.blobUrl], 'resident: done');
    await reply(file.id, true); // a late answer changes nothing
    // Its deck gone: settled, quietly, once its answer has had a moment to say why.
    await drop('.board', [{ name: 'gone.mp3', type: 'audio/mpeg' }]);
    await wait(30);
    const gone = (await loadActs('loadFile')).at(-1);
    await show(withLoading({ id: 103, slot: 4 }));
    await wait(late);
    await show(kinds());
    await wait(2200);
    assert.deepEqual((await revoked()).at(-1), gone.arg.blobUrl, 'gone: settled');
    // A deck gone with its answer close behind: the answer says why.
    const bad = await loadLink('https://example.com/bad.mp3');
    await show(withLoading({ id: 104, slot: 4, url: 'https://example.com/bad.mp3' }));
    await wait(late);
    await show(kinds());
    await reply(bad.id, false, '“bad” is not audio this browser can play.');
    await wait(50);
    assert.deepEqual(await toasts(), ['“bad” is not audio this browser can play.']);
    // No deck ever came: the engine did not answer, and the blob goes.
    await clearToasts();
    await drop('.board', [{ name: 'lost.mp3', type: 'audio/mpeg' }]);
    await wait(30);
    const lost = (await loadActs('loadFile')).at(-1);
    await wait(late);
    assert.deepEqual(await toasts(), ['The audio engine did not answer']);
    assert.deepEqual((await revoked()).at(-1), lost.arg.blobUrl);
  } finally {
    await answerMs(was);
    await manual(false);
  }
});

/** A paste (Ctrl/Cmd+V) of text on the element matching sel, or on the page itself. */
const paste = (sel, t) => page.evaluate(([s, x]) => {
  const dt = new DataTransfer();
  dt.setData('text/plain', x);
  (s ? document.querySelector(s) : document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, [sel, t]);

test('a link pasted on the board is offered for loading; a paste into a text field, or of other text, is not', async () => {
  await show(kinds());
  await ui.clearSent();
  await clearToasts();
  await paste(null, 'hello there');
  await paste(null, 'javascript:alert(1)');
  await page.locator('#sourcesBtn').click();
  await paste('#loadLink', 'https://example.com/in-the-field.mp3');
  await page.locator('#sources [data-close]').click();
  await wait(50);
  assert.deepEqual(await toasts(), []);
  await paste(null, 'https://example.com/b.mp3');
  await wait(50);
  const offer = page.locator('.toast', { hasText: 'Load this link?' });
  assert.equal(await offer.count(), 1);
  assert.match(await offer.textContent(), /https:\/\/example\.com\/b\.mp3/);
  assert.deepEqual(await loadActs('loadUrl'), [], 'nothing loads until asked');
  await offer.getByRole('button', { name: 'Load' }).click();
  await wait(50);
  assert.deepEqual((await loadActs('loadUrl')).map((m) => m.arg), [{ url: 'https://example.com/b.mp3' }]);
  assert.equal(await offer.count(), 0, 'the offer goes once taken');
});

// ---------------------------------------------------------------- settings, memory
test('the settings drawer sets and keeps the resident track limit and 2× whole-track recording', async () => {
  await show(kinds());
  await ui.clearSent();
  await page.locator('#settingsBtn').click();
  const settings = page.locator('#settings');
  for (const label of ['Resident track limit (minutes)', 'Record whole track at 2× when bytes are unavailable']) assert.equal(await settings.getByText(label, { exact: true }).isVisible(), true, label);
  const limit = page.locator('#residentLimit');
  assert.equal(await limit.inputValue(), '15');
  const lastSet = async (key) => (await sent('set', (m) => m.deck === null && m.key === key)).map((m) => m.value);
  await limit.fill('20');
  await limit.press('Enter');
  await wait(50);
  assert.deepEqual(await lastSet('resident.limitMin'), [20]);
  assert.equal(await page.evaluate(() => window.__fake.storage['resident.limitMin']), 20, 'kept for the next start');
  // Whole minutes, 1 to 60.
  for (const [typed, want] of [['0', 1], ['99', 60], ['7.6', 8]]) {
    await ui.clearSent();
    await limit.fill(typed);
    await limit.press('Enter');
    await wait(50);
    assert.deepEqual(await lastSet('resident.limitMin'), [want], typed);
    assert.equal(await limit.inputValue(), String(want));
  }
  // The engine's value shows once it changes, unless the field is being edited.
  await show(kinds((s) => { s.master.params['resident.limitMin'] = 30; }));
  assert.equal(await limit.inputValue(), '30');
  await ui.clearSent();
  await settings.locator('[data-setting="resident.recordWhole"] button[data-v="true"]').click();
  await wait(50);
  assert.deepEqual(await lastSet('resident.recordWhole'), [true]);
  assert.equal(await page.evaluate(() => window.__fake.storage['resident.recordWhole']), true);
  await show(kinds((s) => { s.master.params['resident.recordWhole'] = true; }));
  assert.equal(await settings.locator('[data-setting="resident.recordWhole"] button[data-v="true"]').getAttribute('aria-pressed'), 'true');
  // "Load tabs as whole tracks" appears once the engine has that setting.
  const auto = page.locator('#residentAutoSetting');
  assert.equal(await auto.isHidden(), true);
  await show(kinds((s) => { s.master.params['resident.auto'] = true; }));
  assert.equal(await auto.isVisible(), true);
  assert.equal(await auto.getByText('Load tabs as whole tracks', { exact: true }).isVisible(), true);
  assert.equal(await auto.locator('button[data-v="true"]').getAttribute('aria-pressed'), 'true');
  await ui.clearSent();
  await auto.locator('button[data-v="false"]').click();
  await wait(50);
  assert.deepEqual(await lastSet('resident.auto'), [false]);
  await page.locator('#settings [data-close]').click();
});

test('Escape closes the Sources or Settings drawer from its text field too; a tempo entry keeps Escape to itself', async () => {
  await show(kinds());
  await page.locator('#sourcesBtn').click();
  await page.locator('#loadLink').fill('https://exa');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sources').isHidden(), true, 'from the Load link field');
  await page.locator('#settingsBtn').click();
  await page.locator('#residentLimit').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings').isHidden(), true, 'from the limit field');
  await page.locator('#sourcesBtn').click();
  await deckEl(1).locator('[data-bpm]').click();
  assert.equal(await page.locator('input.tempo-edit').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('input.tempo-edit').count(), 0, 'the entry closed');
  assert.equal(await page.locator('#sources').isVisible(), true, 'the drawer stays');
  await page.locator('#sources [data-close]').click();
  await page.locator('#loadLink').evaluate((el) => { el.value = ''; });
});

test('the top bar warns quietly once decks hold more than 1.5 GiB of audio', async () => {
  const warn = page.locator('#memWarn');
  await show(kinds((s) => { s.master.residentBytes = 1.5 * 2 ** 30; }));
  assert.equal(await warn.isHidden(), true);
  await show(kinds((s) => { s.master.residentBytes = 1.7e9; }));
  assert.equal(await warn.isVisible(), true);
  assert.equal(await text(warn), 'Decks hold 1.7 GB of audio; eject some to free memory');
  await show(kinds());
  assert.equal(await warn.isHidden(), true);
});

test('no console errors', () => { assert.deepEqual(ui.errors, []); });
