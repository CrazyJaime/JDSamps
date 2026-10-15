// Keyboard map and hold gestures: focused sliders keep their arrows, '?' on any layout,
// roll stacking, TAP timing, hold-to-eject and the recording stop guard.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openUi } from './ui-harness.mjs';
import { threeDecks } from './fixtures/mock-state.mjs';

let ui, page;
const acts = async (filter) => (await ui.sent()).filter((m) => m.t === 'act' && (!filter || filter(m)));
const sets = async (filter) => (await ui.sent()).filter((m) => m.t === 'set' && (!filter || filter(m)));
const deckEl = (slot) => page.locator('.deck').nth(slot - 1);
const toasts = () => page.locator('.toast').allTextContents();
const wait = (ms) => page.waitForTimeout(ms);
const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
const clearToasts = () => page.evaluate(() => document.getElementById('toasts').replaceChildren());

/** Push a fresh three-deck snapshot, optionally edited. */
async function setState(edit) {
  const s = threeDecks();
  if (edit) edit(s);
  await ui.push({ t: 'state', s });
  await wait(30);
}
async function hold(locator, ms, opts) {
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down(opts);
  await wait(ms);
  await page.mouse.up(opts);
}
async function holdKey(key, ms) { await page.keyboard.down(key); await wait(ms); await page.keyboard.up(key); }

before(async () => {
  ui = await openUi({ state: threeDecks() });
  page = ui.page;
  await page.waitForSelector('.deck >> nth=2');
  await wait(100);
});
after(async () => { await ui?.close(); });

test('arrow keys on a focused knob or fader adjust that control, not the selected deck', async () => {
  await blur();
  await page.keyboard.press('Digit1');
  await ui.clearSent();
  const gain = deckEl(3).locator('[data-ctl="trim"]');
  await gain.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.down('ArrowLeft'); await wait(30); await page.keyboard.up('ArrowLeft');
  await wait(60);
  assert.equal(await gain.getAttribute('aria-valuenow'), '0.470');
  await page.locator('#crossfader').focus();
  await page.keyboard.down('ArrowRight'); await wait(30); await page.keyboard.up('ArrowRight');
  await page.keyboard.press('End');
  await page.locator('#masterVol').focus();
  await page.keyboard.press('ArrowUp');
  await wait(60);
  assert.deepEqual(await acts(), []);
  const s = await sets();
  assert.ok(!s.some((m) => m.key === 'pitch'), `no pitch set: ${JSON.stringify(s)}`);
  assert.ok(s.some((m) => m.deck === 3 && m.key === 'trim' && Math.abs(m.value - 0.47) < 1e-9));
  assert.ok(s.some((m) => m.deck === null && m.key === 'xfader.pos' && m.value === 1));
  assert.ok(s.some((m) => m.deck === null && m.key === 'master.volume' && m.value > 0.5));
  // With nothing focused the arrows still drive the selected deck.
  await blur();
  await ui.clearSent();
  await page.keyboard.press('ArrowUp');
  await wait(60);
  assert.ok((await sets()).some((m) => m.deck === 1 && m.key === 'pitch'));
});

test("'?' opens help on any layout and never rolls (AZERTY: Shift+KeyM)", async () => {
  await blur();
  await page.keyboard.press('Digit1');
  await ui.clearSent();
  await page.evaluate(() => {
    for (const type of ['keydown', 'keyup']) document.body.dispatchEvent(new KeyboardEvent(type, { key: '?', code: 'KeyM', shiftKey: true, bubbles: true, cancelable: true }));
  });
  await wait(60);
  assert.equal(await page.locator('#help').isVisible(), true);
  assert.deepEqual(await acts(), []);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#help').isHidden(), true);
});

test('the help dialog takes focus, keeps Tab inside, closes on Escape and gives focus back', async () => {
  const inside = () => page.evaluate(() => document.getElementById('help').contains(document.activeElement));
  const helpBtn = page.locator('#helpBtn');
  await helpBtn.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.getElementById('help').hidden);
  assert.equal(await inside(), true, 'focus moved into the dialog');
  for (const k of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(k);
    assert.equal(await inside(), true, `focus stays inside after ${k}`);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#help').isHidden(), true);
  assert.equal(await helpBtn.evaluate((el) => document.activeElement === el), true, 'focus back on the help button');
  // Opened with '?' from a deck control: focus returns there.
  const gain = deckEl(1).locator('[data-ctl="trim"]');
  await gain.focus();
  await page.keyboard.press('Shift+Slash');
  await page.waitForFunction(() => !document.getElementById('help').hidden);
  assert.equal(await inside(), true);
  await page.locator('#help [data-close]').click();
  assert.equal(await page.locator('#help').isHidden(), true);
  assert.equal(await gain.evaluate((el) => document.activeElement === el), true, 'focus back on the knob');
  await blur();
});

test('releasing one roll falls back to the newest roll still held (keys and pads)', async () => {
  await blur();
  await page.keyboard.press('Digit1');
  const rolls = async () => (await acts((m) => m.deck === 1 && /^roll/.test(m.a))).map((m) => [m.a, m.arg.beats ?? null]);
  // 1/2 then 1/4, release 1/2: the 1/4 roll keeps going.
  await ui.clearSent();
  await page.keyboard.down('KeyN'); await wait(30);
  await page.keyboard.down('KeyB'); await wait(30);
  await page.keyboard.up('KeyN'); await wait(40);
  assert.deepEqual(await rolls(), [['rollStart', 0.5], ['rollStart', 0.25]]);
  await page.keyboard.up('KeyB'); await wait(40);
  assert.deepEqual(await rolls(), [['rollStart', 0.5], ['rollStart', 0.25], ['rollEnd', null]]);
  // 1/2 then 1/4, release 1/4: back to 1/2.
  await ui.clearSent();
  await page.keyboard.down('KeyN'); await wait(30);
  await page.keyboard.down('KeyB'); await wait(30);
  await page.keyboard.up('KeyB'); await wait(40);
  await page.keyboard.up('KeyN'); await wait(40);
  assert.deepEqual(await rolls(), [['rollStart', 0.5], ['rollStart', 0.25], ['rollStart', 0.5], ['rollEnd', null]]);
  // Pad 1/2 held with the mouse, key V (1/8) pressed and released, then the pad released.
  await ui.clearSent();
  const pad = deckEl(1).locator('[data-roll="0.5"]');
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + 5, b.y + 5);
  await page.mouse.down(); await wait(30);
  await page.keyboard.down('KeyV'); await wait(30);
  await page.keyboard.up('KeyV'); await wait(30);
  await page.mouse.up(); await wait(40);
  assert.deepEqual(await rolls(), [['rollStart', 0.5], ['rollStart', 0.125], ['rollStart', 0.5], ['rollEnd', null]]);
});

test('TAP is stamped at the press, not the release (pointer and keyboard)', async () => {
  await page.evaluate(() => { window.addEventListener('pointerdown', (e) => { window.__downAt = performance.timeOrigin + e.timeStamp; }, true); });
  const tap = deckEl(1).locator('[data-act="tap"]');
  const b = await tap.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await ui.clearSent();
  await page.mouse.down(); await wait(110);
  const early = await acts((m) => m.a === 'tap');
  await page.mouse.up(); await wait(40);
  const all = await acts((m) => m.a === 'tap');
  const downAt = await page.evaluate(() => window.__downAt);
  assert.equal(early.length, 1, 'tap sent on press');
  assert.equal(all.length, 1, 'release adds no second tap');
  assert.ok(Math.abs(all[0].arg.wallMs - downAt) < 1, `wallMs ${all[0].arg.wallMs - downAt} ms after the press`);
  // Shift-press marks beat 1 at the press; the right button does nothing.
  await ui.clearSent();
  await page.keyboard.down('Shift'); await page.mouse.down(); await wait(60);
  const tap1 = await acts((m) => m.a === 'tap1');
  await page.mouse.up(); await page.keyboard.up('Shift');
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
  await wait(40);
  assert.equal(tap1.length, 1);
  assert.deepEqual((await acts()).map((m) => m.a), ['tap1']);
  // Enter on the focused TAP button taps once.
  await ui.clearSent();
  await tap.focus();
  await page.keyboard.press('Enter');
  await wait(40);
  assert.equal((await acts((m) => m.a === 'tap' && m.deck === 1)).length, 1);
  // Keyboard T uses the event's own timestamp (here 30 ms before dispatch).
  await blur();
  await page.keyboard.press('Digit1');
  await ui.clearSent();
  const evAt = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true, cancelable: true });
    const t0 = performance.now();
    while (performance.now() - t0 < 30);
    document.body.dispatchEvent(ev);
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 't', code: 'KeyT', bubbles: true, cancelable: true }));
    return performance.timeOrigin + ev.timeStamp;
  });
  await wait(40);
  const kt = await acts((m) => m.a === 'tap');
  assert.equal(kt.length, 1);
  assert.ok(Math.abs(kt[0].arg.wallMs - evAt) < 1, `keyboard tap ${kt[0].arg.wallMs - evAt} ms off the key event`);
});

test('eject: primary-button hold only, cancelled by pointercancel/lost capture, keyboard Enter hold', async () => {
  const ej = deckEl(3).locator('[data-act="eject"]');
  const ejects = () => acts((m) => m.a === 'eject');
  await ui.clearSent();
  // Right button held: nothing, and no context menu.
  await hold(ej, 650, { button: 'right' });
  assert.equal((await ejects()).length, 0, 'right-button hold must not eject');
  assert.equal(await ej.evaluate((el) => !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))), true, 'context menu suppressed');
  // Primary press shows progress; losing pointer capture cancels it.
  const b = await ej.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await wait(50);
  assert.equal(await ej.evaluate((el) => el.classList.contains('holding')), true, 'hold progress shown');
  await ej.evaluate((el) => el.releasePointerCapture(1));
  await page.mouse.move(b.x + b.width / 2 + 1, b.y + b.height / 2); // lostpointercapture fires before the next pointer event
  await wait(600);
  await page.mouse.up();
  assert.equal((await ejects()).length, 0, 'lostpointercapture must cancel');
  assert.equal(await ej.evaluate((el) => el.classList.contains('holding')), false);
  // pointercancel (a touch turning into a pan) cancels too.
  await page.mouse.down();
  await wait(50);
  await ej.evaluate((el) => el.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
  await wait(600);
  await page.mouse.up();
  assert.equal((await ejects()).length, 0, 'pointercancel must cancel');
  // Dragging off the button still cancels.
  await page.mouse.down();
  await page.mouse.move(b.x + 300, b.y + 300, { steps: 3 });
  await wait(600);
  await page.mouse.up();
  assert.equal((await ejects()).length, 0, 'dragging off must cancel');
  // Keyboard: a short Enter only hints, a 500 ms Enter hold ejects.
  await clearToasts();
  await ej.focus();
  await holdKey('Enter', 100);
  await wait(50);
  assert.equal((await ejects()).length, 0);
  assert.ok((await toasts()).some((t) => /Hold the eject/.test(t)));
  await holdKey('Enter', 650);
  await wait(50);
  assert.equal((await acts((m) => m.a === 'eject' && m.deck === 3)).length, 1, 'Enter hold ejects');
  await blur();
});

test('mix recording: one press starts, stopping needs a hold, REC shows SAVING while finalizing', async () => {
  const btn = page.locator('#mixRecBtn');
  const mix = () => acts((m) => m.deck === null && /^mixRec/.test(m.a));
  await setState((s) => { s.master.rec = { state: 'recording', format: 'wav', seconds: 3600 }; });
  await blur();
  await ui.clearSent();
  await clearToasts();
  await btn.click();
  await page.keyboard.press('Shift+KeyR');
  await wait(60);
  assert.deepEqual(await mix(), [], 'a tap must not stop the mix recording');
  assert.ok((await toasts()).some((t) => /Hold REC MIX/i.test(t)));
  const b = await btn.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await wait(100);
  assert.equal(await btn.evaluate((el) => el.classList.contains('holding')), true, 'hold progress shown');
  await wait(600);
  await page.mouse.up();
  await wait(40);
  assert.deepEqual((await mix()).map((m) => m.a), ['mixRecStop']);
  await ui.clearSent();
  await page.keyboard.down('Shift'); await holdKey('KeyR', 700); await page.keyboard.up('Shift');
  await wait(40);
  assert.deepEqual((await mix()).map((m) => m.a), ['mixRecStop'], 'Shift+R held stops');
  // Finalizing: disabled and labelled, and Shift+R does not try to start.
  await setState((s) => { s.master.rec = { state: 'finalizing', format: 'wav', seconds: 3600 }; });
  await ui.clearSent();
  assert.equal(await btn.isDisabled(), true);
  assert.match(await btn.textContent(), /SAVING/);
  await page.keyboard.press('Shift+KeyR');
  await wait(40);
  assert.deepEqual(await mix(), []);
  // Idle: a single press starts.
  await setState();
  assert.equal(await btn.isDisabled(), false);
  assert.match(await btn.textContent(), /REC MIX/);
  await btn.click();
  await page.keyboard.press('Shift+KeyR');
  await wait(40);
  assert.deepEqual((await mix()).map((m) => m.a), ['mixRecStart', 'mixRecStart']);
});

test('deck recording: one press starts, stopping needs a hold, REC shows SAVING while finalizing', async () => {
  await setState();
  const rec = deckEl(2).locator('[data-act="rec"]');
  const recActs = (deck) => acts((m) => m.deck === deck && /^rec/.test(m.a));
  await blur();
  await page.keyboard.press('Digit2');
  await ui.clearSent();
  await clearToasts();
  await rec.click();
  await page.keyboard.press('KeyR');
  await wait(60);
  assert.deepEqual(await recActs(2), [], 'a tap must not stop the deck recording');
  assert.ok((await toasts()).some((t) => /Hold REC/i.test(t)));
  await hold(rec, 700);
  await wait(40);
  assert.deepEqual((await recActs(2)).map((m) => m.a), ['recStop']);
  await ui.clearSent();
  await blur();
  await holdKey('KeyR', 700);
  await wait(40);
  assert.deepEqual((await recActs(2)).map((m) => m.a), ['recStop'], 'R held stops');
  // Finalizing deck 2: disabled, labelled, and R does not try to start.
  await setState((s) => { s.decks[1].rec = { state: 'finalizing', format: 'wav', seconds: 80 }; });
  await ui.clearSent();
  assert.equal(await rec.isDisabled(), true);
  assert.match(await rec.textContent(), /SAVING/);
  await page.keyboard.press('KeyR');
  await wait(40);
  assert.deepEqual(await recActs(2), []);
  // Idle deck 3: one press starts.
  await setState();
  await deckEl(3).locator('[data-act="rec"]').click();
  await wait(40);
  assert.deepEqual((await recActs(3)).map((m) => m.a), ['recStart']);
});

test('no console errors', () => { assert.deepEqual(ui.errors, []); });
