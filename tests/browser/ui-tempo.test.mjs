// Typed tempos, the tempo fader's BPM readout and the build stamp in the top bar.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUi } from './ui-harness.mjs';
import { deck, makeState, threeDecks } from './fixtures/mock-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

let ui, page;
const wait = (ms) => page.waitForTimeout(ms);
const deckEl = (slot) => page.locator('.deck').nth(slot - 1);
const acts = async (a) => (await ui.sent()).filter((m) => m.t === 'act' && (!a || m.a === a));
const pitchSets = async (deckId) => (await ui.sent()).filter((m) => m.t === 'set' && m.deck === deckId && m.key === 'pitch');
const toasts = () => page.locator('.toast').allTextContents();
const clearToasts = () => page.evaluate(() => document.getElementById('toasts').replaceChildren());
const editor = (slot) => deckEl(slot).locator('input.tempo-edit');
const rect = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const sameRect = (a, b, what) => {
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(a[k] - b[k]) <= 0.5, `${what}: ${k} ${a[k].toFixed(1)} became ${b[k].toFixed(1)}`);
};

async function show(state) {
  await ui.push({ t: 'state', s: { ...state, wallMs: Date.now() } });
  await page.waitForFunction((n) => document.querySelectorAll('.deck').length === n, state.decks.length);
  await wait(60);
}

before(async () => {
  ui = await openUi({ state: threeDecks(), viewport: { width: 1280, height: 720 } });
  page = ui.page;
  await page.waitForSelector('.deck >> nth=2');
  await wait(100);
});
after(async () => { await ui?.close(); });

// ------------------------------------------------------------------ the playing BPM

test('clicking the BPM opens an editor in its place without moving the layout; Enter sends setBpm', async () => {
  await show(threeDecks());
  await ui.clearSent();
  const bpm = deckEl(1).locator('[data-bpm]');
  const meta = deckEl(1).locator('.tempo-meta');
  const before = { bpm: await rect(bpm), meta: await rect(meta), deck: await rect(deckEl(1)), row: await rect(deckEl(1).locator('.tempo-row')) };
  await bpm.click();
  const ed = editor(1);
  assert.equal(await ed.count(), 1, 'an editor opened');
  assert.equal(await ed.evaluate((el) => el === document.activeElement), true, 'with the focus');
  assert.equal(await ed.inputValue(), '128.0', 'holding the tempo shown');
  assert.equal(await ed.evaluate((el) => el.selectionStart === 0 && el.selectionEnd === el.value.length), true, 'all selected, so typing replaces it');
  assert.equal(await bpm.isHidden(), true);
  sameRect(before.bpm, await rect(ed), 'the editor sits exactly where the BPM was');
  sameRect(before.meta, await rect(meta), 'the readouts beside it');
  sameRect(before.deck, await rect(deckEl(1)), 'the deck');
  sameRect(before.row, await rect(deckEl(1).locator('.tempo-row')), 'the tempo row');
  await page.keyboard.type('126');
  await page.keyboard.press('Enter');
  await wait(40);
  assert.deepEqual((await acts('setBpm')).map((m) => [m.deck, m.arg]), [[1, { bpm: 126 }]]);
  assert.equal(await editor(1).count(), 0, 'the editor closed');
  assert.equal(await bpm.isVisible(), true);
});

test('typed tempos take a comma decimal', async () => {
  await ui.clearSent();
  await deckEl(2).locator('[data-bpm]').click();
  await page.keyboard.type('128,5');
  await page.keyboard.press('Enter');
  await wait(40);
  assert.deepEqual((await acts('setBpm')).map((m) => [m.deck, m.arg]), [[2, { bpm: 128.5 }]]);
});

test('Escape and blur cancel the edit', async () => {
  await ui.clearSent();
  const bpm = deckEl(1).locator('[data-bpm]');
  await bpm.click();
  await page.keyboard.type('130');
  await page.keyboard.press('Escape');
  await wait(30);
  assert.equal(await editor(1).count(), 0, 'Escape closed it');
  assert.equal(await bpm.evaluate((el) => el === document.activeElement), true, 'focus back on the BPM');
  await bpm.click();
  await page.keyboard.type('131');
  await deckEl(1).locator('[data-title]').click(); // somewhere else
  await wait(30);
  assert.equal(await editor(1).count(), 0, 'blur closed it');
  assert.deepEqual(await acts('setBpm'), [], 'nothing sent');
  assert.equal(await bpm.textContent(), '128.0');
});

test('junk is refused with a short message, and the editor stays open to fix it', async () => {
  await ui.clearSent();
  await clearToasts();
  await deckEl(1).locator('[data-bpm]').click();
  await page.keyboard.type('12a');
  await page.keyboard.press('Enter');
  await wait(40);
  assert.deepEqual(await acts('setBpm'), []);
  assert.deepEqual(await toasts(), ['Type a tempo like 128 or 128.5.']);
  assert.equal(await editor(1).count(), 1, 'still editing');
  await page.keyboard.type('999');
  await page.keyboard.press('Enter');
  await wait(40);
  assert.ok((await toasts()).includes('Type a tempo from 20 to 400 BPM.'), JSON.stringify(await toasts()));
  assert.deepEqual(await acts('setBpm'), []);
  await page.keyboard.type('127.25');
  await page.keyboard.press('Enter');
  await wait(40);
  assert.deepEqual((await acts('setBpm')).map((m) => m.arg), [{ bpm: 127.25 }]);
});

test('Enter on the focused BPM opens the editor, and digits typed there never reach the deck keys', async () => {
  await ui.clearSent();
  const bpm = deckEl(3).locator('[data-bpm]');
  await bpm.focus();
  await page.keyboard.press('Enter');
  assert.equal(await editor(3).count(), 1, 'Enter opened the editor');
  assert.equal(await editor(3).inputValue(), '', 'a deck with no BPM yet starts empty');
  const selected = () => page.evaluate(() => [...document.querySelectorAll('.deck')].findIndex((el) => el.classList.contains('selected')));
  const sel = await selected();
  await page.keyboard.type('2 1');
  await page.keyboard.press('Escape');
  await wait(30);
  assert.deepEqual((await ui.sent()).filter((m) => m.t === 'act'), [], 'no deck key fired (Space would play, digits select decks)');
  assert.equal(await selected(), sel, 'the selected deck did not change');
});

test('a refusal from the engine is shown', async () => {
  await clearToasts();
  await page.evaluate(() => { window.__fake.autoReply = false; });
  try {
    await deckEl(3).locator('[data-bpm]').click();
    await page.keyboard.type('128');
    await page.keyboard.press('Enter');
    await wait(30);
    const m = (await acts('setBpm')).at(-1);
    await page.evaluate((id) => window.__fake.reply(id, false, 'No BPM yet. Wait for the deck to lock, or TAP the tempo.'), m.id);
    await wait(40);
    assert.ok((await toasts()).some((t) => /^No BPM yet/.test(t)), JSON.stringify(await toasts()));
  } finally { await page.evaluate(() => { window.__fake.autoReply = true; }); }
});

// ------------------------------------------------------------------ the original BPM

test('the ORIG readout takes the track’s own tempo the same way', async () => {
  await show(threeDecks());
  await ui.clearSent();
  const nat = deckEl(1).locator('[data-native]');
  assert.equal(await nat.textContent(), 'orig 124.0');
  const meta = await rect(deckEl(1).locator('.tempo-meta'));
  await nat.click();
  assert.equal(await editor(1).inputValue(), '124.0');
  sameRect(meta, await rect(deckEl(1).locator('.tempo-meta')), 'the readouts');
  await page.keyboard.type('125,5');
  await page.keyboard.press('Enter');
  await wait(40);
  assert.deepEqual((await acts('setNativeBpm')).map((m) => [m.deck, m.arg]), [[1, { bpm: 125.5 }]]);
  assert.deepEqual(await acts('setBpm'), []);
  // A deck with no BPM yet can be told one (a cued deck anchors it at its cue).
  const nat3 = deckEl(3).locator('[data-native]');
  assert.equal(await nat3.textContent(), 'orig —');
  await nat3.click();
  await page.keyboard.type('92');
  await page.keyboard.press('Enter');
  await wait(40);
  assert.deepEqual((await acts('setNativeBpm')).map((m) => [m.deck, m.arg]), [[1, { bpm: 125.5 }], [3, { bpm: 92 }]]);
});

// ------------------------------------------------------------------ the tempo fader

test('the tempo fader reads the BPM it plays at, and keeps reading it while dragged', async () => {
  await show(threeDecks());
  const f = deckEl(1).locator('[data-ctl="pitch"]');
  const readout = f.locator('.readout');
  assert.equal(await readout.textContent(), '+3.23% · 128.0');
  assert.equal(await deckEl(3).locator('[data-ctl="pitch"] .readout').textContent(), '+3.23%', 'no BPM yet: the percentage alone');
  // A new tempo reading with the fader where it was.
  const s = threeDecks();
  s.decks[0].bpm = { ...s.decks[0].bpm, native: 125, out: 125 * 1.0323 };
  await show(s);
  assert.equal(await readout.textContent(), '+3.23% · 129.0');
  // Drag: the readout follows the hand before the engine answers.
  const b = await f.locator('.thumb').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2, { steps: 5 });
  const mid = await readout.textContent();
  const pct = Number(await f.getAttribute('aria-valuenow')) * 0.1; // aria-valuenow has 3 decimals
  await page.mouse.up();
  const m = /^\+(\d+\.\d\d)% · (\d+\.\d)$/.exec(mid);
  assert.ok(m, `readout mid-drag: ${mid}`);
  assert.ok(pct > 0.04, `the drag moved the tempo (${pct})`);
  assert.ok(Math.abs(Number(m[1]) / 100 - pct) <= 0.0001, `mid-drag percentage ${m[1]} for a fader at ${pct}`);
  assert.ok(Math.abs(Number(m[2]) - 125 * (1 + Number(m[1]) / 100)) <= 0.06, `mid-drag BPM ${m[2]} for ${m[1]}% of 125`);
  await wait(300);
  await show(threeDecks());
});

test('a synced deck’s fader shows it is locked to SYNC', async () => {
  await show(threeDecks());
  const f1 = deckEl(1).locator('[data-ctl="pitch"]'), f2 = deckEl(2).locator('[data-ctl="pitch"]');
  assert.equal(await f1.evaluate((el) => el.classList.contains('synced')), true, 'deck 1 is synced');
  assert.match(await f1.getAttribute('title'), /SYNC/);
  assert.equal(await f2.evaluate((el) => el.classList.contains('synced')), false, 'deck 2 is the master');
  assert.ok(!(await f2.getAttribute('title')), 'and has no lock title');
  const s = threeDecks();
  s.decks[0].sync = { ...s.decks[0].sync, on: false };
  await show(s);
  assert.equal(await f1.evaluate((el) => el.classList.contains('synced')), false, 'SYNC off: unlocked');
  await show(threeDecks());
});

test('fine steps move a 128 BPM deck by at most 0.05 BPM in the default range, even in a narrow column', async () => {
  // Six decks at 1280 px: the narrowest tempo fader there is.
  const decks = Array.from({ length: 6 }, (_, i) => deck({
    id: i + 1, slot: i + 1, tabId: 100 + i, sync: { on: false, mode: 'BEAT', isMaster: i === 0, outOfRange: false, phaseMs: null },
    bpm: { state: 'LOCKED', native: 128, out: 128, conf: 0.9, mult: 1, tapped: false }, params: { pitch: 0, range: 0.1 },
  }));
  await show(makeState({ decks }));
  const f = deckEl(2).locator('[data-ctl="pitch"]');
  const width = (await f.boundingBox()).width;
  // Exact values, from the pitch the deck page sends (aria-valuenow is rounded).
  const last = async () => (await pitchSets(2)).at(-1).value;
  const bpmStep = (a, b) => Math.abs(b - a) * 128;
  const steps = {};
  // Shift-drag, one pixel at a time (each pixel moves the fader by the same amount).
  await ui.clearSent();
  const b = await f.locator('.thumb').boundingBox();
  const x0 = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x0, y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x0 + i, y);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await wait(60);
  const p0 = await last();
  steps.drag = bpmStep(0, p0) / 6;
  // Shift + wheel.
  await f.evaluate((el) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, shiftKey: true, bubbles: true, cancelable: true })));
  await wait(60);
  const p1 = await last();
  steps.wheel = bpmStep(p0, p1);
  // Shift + arrow on the focused fader.
  await f.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await wait(60);
  steps.key = bpmStep(p1, await last());
  await page.evaluate(() => document.activeElement.blur());
  for (const [k, s] of Object.entries(steps)) assert.ok(s > 0 && s <= 0.05, `fine ${k} step is ${s.toFixed(4)} BPM (fader ${width.toFixed(0)} px wide)`);
  await wait(300);
});

// ------------------------------------------------------------------ build stamp

test('the top bar shows the build that is loaded', async () => {
  assert.ok(MANIFEST.version_name, 'manifest.json has a version_name');
  const stamp = page.locator('.topbar #build');
  assert.equal(await stamp.textContent(), `v${MANIFEST.version_name}`);
  assert.equal(await stamp.isVisible(), true);
  // Without a version_name the version itself is shown.
  const u = await openUi({ state: threeDecks(), manifest: { ...MANIFEST, version_name: undefined } });
  try {
    await u.page.waitForSelector('.deck');
    assert.equal(await u.page.locator('#build').textContent(), `v${MANIFEST.version}`);
    assert.deepEqual(u.errors, []);
  } finally { await u.close(); }
});

test('no console errors', () => { assert.deepEqual(ui.errors, []); });
