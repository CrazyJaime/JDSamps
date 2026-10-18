// Deck navigation on the deck page: the whole-buffer overview (click or drag: seek), the zoomed
// waveform with CDJ jog semantics (paused: move the playhead; playing: bend the tempo), search on
// a paused deck, beat jump buttons and keys, and the layout still fitting at laptop sizes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openUi } from './ui-harness.mjs';
import { deck, makeState, makeWave } from './fixtures/mock-state.mjs';

let ui, page;
const wait = (ms) => page.waitForTimeout(ms);
const acts = async (a, deckId) => (await ui.sent()).filter((m) => m.t === 'act' && m.a === a && (deckId == null || m.deck === deckId));
const row = (slot) => page.locator('.wave-row').nth(slot - 1);
const deckEl = (slot) => page.locator('.deck').nth(slot - 1);
const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());

/** Deck 1 playing (10 s to 70 s buffered), deck 2 paused at 20 s with a grid, deck 3 paused with no grid. */
function navState(edit) {
  const s = makeState({
    decks: [
      deck({ historyStart: 10, liveEdge: 70, playhead: 41.3, cue: 12 }),
      deck({ id: 2, slot: 2, tabId: 102, playing: false, playhead: 20, cue: 20, historyStart: 0, liveEdge: 50, engineRate: 0, sync: { on: false, mode: 'BEAT', isMaster: false, outOfRange: false, phaseMs: null } }),
      deck({ id: 3, slot: 3, tabId: 103, playing: false, playhead: 2, cue: 2, historyStart: 0, liveEdge: 36, engineRate: 0, grid: null, sync: { on: false, mode: 'BEAT', isMaster: false, outOfRange: false, phaseMs: null } }),
    ],
  });
  if (edit) edit(s);
  return s;
}
async function show(state, { width = 1280, height = 720 } = {}) {
  await page.setViewportSize({ width, height });
  await ui.push({ t: 'state', s: { ...state, wallMs: Date.now() } });
  await page.waitForFunction((n) => document.querySelectorAll('.deck').length === n, state.decks.length);
  await wait(80);
}

before(async () => {
  ui = await openUi({ state: navState(), viewport: { width: 1280, height: 720 } });
  page = ui.page;
  await page.waitForSelector('.deck >> nth=2');
  for (const [id, sec] of [[1, 70], [2, 50], [3, 36]]) await ui.push(makeWave(id, sec, 124));
  await wait(150);
});
after(async () => { await ui?.close(); });

// ---------------------------------------------------------------- overview
test('each waveform row has a whole-buffer overview that draws the buffer, and it fits at 1280x720 with six decks', async () => {
  const six = makeState({ decks: Array.from({ length: 6 }, (_, i) => deck({ id: i + 1, slot: i + 1, tabId: 100 + i, title: `Track ${i + 1}`, historyStart: 0, liveEdge: 60 + i, playhead: 20 + i })) });
  for (const [w, h, st] of [[1280, 720, navState()], [1280, 720, six], [1920, 1080, six]]) {
    await show(st, { width: w, height: h });
    for (let i = 1; i <= st.decks.length; i++) await ui.push(makeWave(i, 60, 124));
    await wait(120);
    const r = await page.evaluate(() => [...document.querySelectorAll('.wave-row')].map((rowEl) => {
      const c = rowEl.querySelector('[data-overview]'), b = c.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const colours = new Set();
      for (let i = 0; i < px.length; i += 4 * 7) colours.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
      return { w: Math.round(b.width), h: Math.round(b.height), hit: hit === c, colours: colours.size, inView: b.bottom <= innerHeight && b.right <= innerWidth };
    }));
    for (const [i, o] of r.entries()) {
      assert.ok(o.w >= 150 && o.h >= 12, `${w}x${h} ${st.decks.length} decks, row ${i + 1}: overview ${o.w}x${o.h}`);
      assert.ok(o.hit && o.inView, `row ${i + 1}: overview on screen and uncovered ${JSON.stringify(o)}`);
      assert.ok(o.colours >= 4, `row ${i + 1}: the overview drew the buffer (${o.colours} colours)`);
    }
  }
  await show(navState());
});

test('clicking the overview seeks to that point of the buffer (historyStart at the left, the live edge at the right)', async () => {
  await show(navState());
  for (const f of [0.25, 0.8]) {
    await ui.clearSent();
    const b = await row(1).locator('[data-overview]').boundingBox();
    await page.mouse.click(b.x + f * b.width, b.y + b.height / 2);
    await wait(60);
    const s = await acts('seek', 1);
    assert.equal(s.length, 1, JSON.stringify(s));
    const want = 10 + f * (70 - 10);
    assert.ok(Math.abs(s[0].arg.pos - want) < 0.5, `seek to ${s[0].arg.pos}, expected ~${want}`);
    assert.equal(s[0].arg.quantize, undefined, 'the engine quantizes a synced deck by itself');
  }
});

test('dragging on the overview streams seeks (at most one per frame) and ends at the release point', async () => {
  await show(navState());
  await ui.clearSent();
  const b = await row(2).locator('[data-overview]').boundingBox();
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + 0.1 * b.width, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(b.x + (0.1 + 0.06 * i) * b.width, y); await wait(20); }
  await page.mouse.up();
  await wait(60);
  const s = (await acts('seek', 2)).map((m) => m.arg.pos);
  assert.ok(s.length >= 4 && s.length <= 12, `seeks: ${s.length}`);
  assert.ok(s.every((p, i) => i === 0 || p >= s[i - 1]), `in drag order: ${s}`);
  assert.ok(Math.abs(s.at(-1) - 0.7 * 50) < 0.5, `ends at the release point: ${s.at(-1)}`);
});

test('a refused seek is toasted with the engine\'s reason', async () => {
  await show(navState());
  await page.evaluate(() => { window.__fake.autoReply = false; document.getElementById('toasts').replaceChildren(); });
  try {
    await ui.clearSent();
    const b = await row(1).locator('[data-overview]').boundingBox();
    await page.mouse.click(b.x + 2, b.y + b.height / 2);
    await wait(60);
    const [m] = await acts('seek', 1);
    await page.evaluate((id) => window.__fake.reply(id, false, 'Only 12 s buffered behind the playhead.'), m.id);
    await wait(60);
    assert.match((await page.locator('.toast').allTextContents()).join('|'), /Only 12 s buffered behind the playhead/);
  } finally { await page.evaluate(() => { window.__fake.autoReply = true; }); }
});

// ---------------------------------------------------------------- waveform drag (jog)
test('the waveform says what a drag will do: move the playhead when paused, bend the tempo when playing', async () => {
  await show(navState());
  const jog = (slot) => row(slot).locator('[data-wave]').getAttribute('data-jog');
  assert.equal(await jog(1), 'bend');
  assert.equal(await jog(2), 'seek');
  const b = await row(2).locator('[data-wave]').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await wait(40);
  const hint = row(2).locator('[data-jog-hint]');
  assert.equal(await hint.isVisible(), true);
  assert.match(await hint.textContent(), /MOVE PLAYHEAD/);
  assert.match(await row(1).locator('[data-jog-hint]').textContent(), /BEND TEMPO/);
});

test('dragging a paused deck\'s waveform seeks: the waveform follows the hand', async () => {
  await show(navState());
  await ui.clearSent();
  const b = await row(3).locator('[data-wave]').boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 11; i++) { await page.mouse.move(x - 10 * i, y); await wait(16); }
  await page.mouse.up();
  await wait(60);
  const s = (await acts('seek', 3)).map((m) => m.arg.pos);
  assert.ok(s.length >= 3, `seeks: ${s}`);
  // No grid: 110 px per second. Dragged 110 px left: one second later in the track.
  assert.ok(Math.abs(s.at(-1) - 3) < 0.03, `ends at ${s.at(-1)}, expected 3`);
  assert.deepEqual(await acts('nudge', 3), []);
  // With a grid the scale is 56 px per beat.
  await ui.clearSent();
  const b2 = await row(2).locator('[data-wave]').boundingBox();
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) { await page.mouse.move(b2.x + b2.width / 2 + 28 * i, b2.y + b2.height / 2); await wait(16); }
  await page.mouse.up();
  await wait(60);
  const s2 = (await acts('seek', 2)).map((m) => m.arg.pos);
  assert.ok(Math.abs(s2.at(-1) - (20 - 2 * (60 / 124))) < 0.02, `two beats back: ${s2.at(-1)}`);
});

test('dragging a playing deck\'s waveform bends its tempo with the drag speed (nudge path), and lets go when the hand stops', async () => {
  await show(navState());
  await ui.clearSent();
  const b = await row(1).locator('[data-wave]').boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x - 12 * i, y); await wait(10); } // with the scroll: faster
  const during = await row(1).locator('[data-jog-hint]').textContent();
  await wait(250); // the hand stops
  await page.mouse.up();
  await wait(60);
  const n = (await acts('nudge', 1)).map((m) => m.arg);
  assert.ok(n.length >= 2, JSON.stringify(n));
  assert.equal(n[0].dir, 1, `dragging left speeds up: ${JSON.stringify(n)}`);
  assert.ok(n[0].amt > 0.02 && n[0].amt <= 0.1, `bend sized by the drag: ${JSON.stringify(n)}`);
  assert.deepEqual(n.at(-1), { dir: 0 }, 'back to normal once the hand stops');
  assert.match(during, /BEND \+/);
  assert.deepEqual(await acts('seek', 1), [], 'a playing deck is not seeked by the waveform');
  // Against the scroll: slower.
  await ui.clearSent();
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x + 12 * i, y); await wait(10); }
  await page.mouse.up();
  await wait(60);
  const m = (await acts('nudge', 1)).map((a) => a.arg);
  assert.equal(m[0].dir, -1, JSON.stringify(m));
  assert.deepEqual(m.at(-1), { dir: 0 }, 'letting go ends the bend');
});

// ---------------------------------------------------------------- search
test('on a paused deck the nudge buttons and arrow keys search (hold), and say so', async () => {
  await show(navState());
  const back = deckEl(2).locator('[data-hold="nudge-"]');
  assert.match(await back.getAttribute('aria-label'), /^Search back/);
  assert.match(await deckEl(1).locator('[data-hold="nudge-"]').getAttribute('aria-label'), /^Nudge back/);
  await ui.clearSent();
  const b = await back.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await wait(200);
  await page.mouse.up();
  await blur();
  await page.keyboard.press('Digit2');
  await page.keyboard.down('ArrowRight');
  await wait(150);
  await page.keyboard.up('ArrowRight');
  await wait(60);
  assert.deepEqual((await acts('nudge', 2)).map((m) => m.arg.dir), [-1, 0, 1, 0]);
});

// ---------------------------------------------------------------- beat jump
test('beat jump buttons jump by the size set on the deck; the size steps through 1, 4, 8, 16, 32', async () => {
  await show(navState());
  await ui.clearSent();
  const d = deckEl(1), size = d.locator('[data-act="jumpSize"]');
  assert.equal(await size.textContent(), '4');
  await d.locator('[data-act="jumpFwd"]').click();
  await size.click();
  assert.equal(await size.textContent(), '8');
  assert.match(await d.locator('[data-act="jumpBack"]').getAttribute('aria-label'), /8 beats/);
  await d.locator('[data-act="jumpBack"]').click();
  await size.click(); await size.click(); await size.click(); // 16, 32, then round to 1
  assert.equal(await size.textContent(), '1');
  await size.click({ modifiers: ['Shift'] }); // smaller: round to 32
  assert.equal(await size.textContent(), '32');
  await d.locator('[data-act="jumpFwd"]').click();
  await wait(60);
  assert.deepEqual((await acts('beatJump', 1)).map((m) => m.arg.beats), [4, -8, 32]);
});

test('beat jump keys: , and . jump; Shift+, and Shift+. change the size (stopping at the ends)', async () => {
  await show(navState());
  await blur();
  await page.keyboard.press('Digit3');
  await ui.clearSent();
  const size = deckEl(3).locator('[data-act="jumpSize"]');
  await page.keyboard.press('Period');
  await page.keyboard.press('Shift+Period');
  assert.equal(await size.textContent(), '8');
  await page.keyboard.press('Comma');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+Comma');
  assert.equal(await size.textContent(), '1', 'stops at 1');
  await page.keyboard.press('Period');
  await wait(60);
  const sent = (await ui.sent()).filter((m) => m.t === 'act');
  assert.deepEqual(sent.map((m) => [m.deck, m.a, m.arg.beats]), [[3, 'beatJump', 4], [3, 'beatJump', -8], [3, 'beatJump', 1]]);
});

test('the help lists the navigation keys, and they are bound to nothing else', async () => {
  const text = await page.locator('#help').textContent();
  assert.match(text, /Beat jump back \/ forward/);
  assert.match(text, /Beat jump size/);
  assert.match(text, /search when paused/);
  const kbds = await page.locator('#help kbd').allTextContents();
  assert.equal(kbds.filter((k) => k === ',').length, 2);
  assert.equal(kbds.filter((k) => k === '.').length, 2);
});

test('no console errors', () => { assert.deepEqual(ui.errors, []); });
