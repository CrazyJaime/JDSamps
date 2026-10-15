import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUi } from './ui-harness.mjs';
import { deck, threeDecks, makeState, makeWave } from './fixtures/mock-state.mjs';

const ART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
const SOURCES = {
  ok: true,
  tabs: [
    { id: 101, title: 'Daft Punk — One More Time', url: 'https://www.youtube.com/watch?v=x', favIconUrl: '', audible: true, granted: true, deckSlot: 1 },
    { id: 201, title: 'Mixcloud — Friday set', url: 'https://www.mixcloud.com/x/', favIconUrl: 'javascript:alert(1)', audible: true, granted: true, deckSlot: null },
    { id: 202, title: 'SoundCloud — Track', url: 'https://soundcloud.com/a/b', favIconUrl: '', audible: false, granted: false, deckSlot: null },
  ],
};

let ui, page;
const acts = async (filter) => (await ui.sent()).filter((m) => m.t === 'act' && (!filter || filter(m)));
const sets = async (filter) => (await ui.sent()).filter((m) => m.t === 'set' && (!filter || filter(m)));
const deckEl = (slot) => page.locator('.deck').nth(slot - 1);

before(async () => {
  ui = await openUi({ state: threeDecks(), hubReplies: { LIST_SOURCES: SOURCES, LOAD_TAB: { ok: true } }, storage: { 'xfader.curve': 'SHARP' } });
  page = ui.page;
  await page.waitForSelector('.deck >> nth=2');
  for (const id of [1, 2, 3]) await ui.push(makeWave(id, 60, id === 2 ? 128 : 124));
  await page.waitForTimeout(150);
});
after(async () => { await ui?.close(); });

test('renders three decks and waveform rows in slot order', async () => {
  assert.equal(await page.locator('.deck').count(), 3);
  assert.equal(await page.locator('.wave-row').count(), 3);
  assert.equal(await page.locator('#empty').isHidden(), true);
  assert.equal((await deckEl(2).locator('[data-title]').textContent()).trim(), 'Peggy Gou — (It Goes Like) Nanana');
  assert.equal(await deckEl(1).locator('[data-bpm]').textContent(), '128.0');
  assert.equal(await deckEl(3).locator('[data-bpm]').textContent(), '—');
  assert.equal(await page.locator('#clockBpm').textContent(), '128.0');
  assert.equal(await page.locator('#clockMode').textContent(), 'DECK 2');
});

test('hostile page titles render as text', async () => {
  const t = deckEl(3).locator('[data-title]');
  assert.equal(await t.textContent(), '<img src=x onerror="window.pwned=1"> Bandcamp exclusive');
  assert.equal(await t.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
});

test('stored settings are restored into the engine on connect', async () => {
  assert.ok((await sets((m) => m.deck === null && m.key === 'xfader.curve' && m.value === 'SHARP')).length >= 1);
});

test('transport and sync buttons send actions', async () => {
  await ui.clearSent();
  await deckEl(3).locator('[data-act="playToggle"]').click();
  await deckEl(1).locator('[data-act="sync"]').click();
  await page.waitForTimeout(50);
  const a = await acts();
  assert.ok(a.some((m) => m.deck === 3 && m.a === 'playToggle'));
  assert.ok(a.some((m) => m.deck === 1 && m.a === 'sync' && m.arg.on === false));
});

test('knob, FX pad, crossfader assign send parameter sets', async () => {
  await ui.clearSent();
  const k = deckEl(1).locator('[data-ctl="eq.hi"] svg');
  const b = await k.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 40, { steps: 4 });
  await page.mouse.up();
  await deckEl(1).locator('[data-pad="fx.on"]').click();
  await deckEl(1).locator('[data-seg="xf"] button[data-v="A"]').click();
  await page.waitForTimeout(60);
  const s = await sets((m) => m.deck === 1);
  assert.ok(s.some((m) => m.key === 'eq.hi' && m.value > 0.6));
  assert.ok(s.some((m) => m.key === 'fx.on' && m.value === true));
  assert.ok(s.some((m) => m.key === 'xf' && m.value === 'A'));
});

test('roll pads are momentary', async () => {
  await ui.clearSent();
  const pad = deckEl(1).locator('[data-roll="0.25"]');
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + 5, b.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(50);
  const a = (await acts((m) => m.deck === 1)).map((m) => [m.a, m.arg]);
  assert.deepEqual(a, [['rollStart', { beats: 0.25 }], ['rollEnd', {}]]);
});

test('eject needs a hold', async () => {
  await ui.clearSent();
  const ej = deckEl(3).locator('[data-act="eject"]');
  await ej.click();
  await page.waitForTimeout(50);
  assert.equal((await acts((m) => m.a === 'eject')).length, 0);
  assert.ok((await page.locator('.toast').allTextContents()).some((t) => /Hold the eject/.test(t)));
  const b = await ej.boundingBox();
  await page.mouse.move(b.x + 5, b.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  assert.equal((await acts((m) => m.a === 'eject' && m.deck === 3)).length, 1);
});

test('keyboard shortcuts drive the selected deck and the mixer', async () => {
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await ui.clearSent();
  await page.keyboard.press('Digit2');
  assert.equal(await deckEl(2).evaluate((e) => e.classList.contains('selected')), true);
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('BracketLeft');
  await page.keyboard.press('Shift+KeyS');
  await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(40); await page.keyboard.up('ArrowLeft');
  await page.keyboard.down('KeyV'); await page.waitForTimeout(40); await page.keyboard.up('KeyV');
  await page.waitForTimeout(60);
  const a = (await acts((m) => m.deck === 2)).map((m) => [m.a, m.arg]);
  assert.deepEqual(a, [['playToggle', {}], ['master', {}], ['nudge', { dir: -1, fine: false }], ['nudge', { dir: 0 }], ['rollStart', { beats: 0.125 }], ['rollEnd', {}]]);
  const s = await sets();
  assert.ok(s.some((m) => m.deck === 2 && m.key === 'kill.hi' && m.value === true));
  assert.ok(s.some((m) => m.deck === null && m.key === 'xfader.pos' && Math.abs(m.value - 0.45) < 1e-9));
});

// The engine lets go of a press tagged hold:true if the page goes away before its release.
test('kill and FX pads tag a press as held until its release decides (off, or latched on)', async () => {
  const at = async (sel, slot) => { const b = await deckEl(slot).locator(sel).boundingBox(); await page.mouse.move(b.x + 5, b.y + 5); };
  const press = async (ms) => { await page.mouse.down(); await page.waitForTimeout(ms); await page.mouse.up(); await page.waitForTimeout(30); };
  const got = async (slot, key) => (await sets((m) => m.deck === slot && m.key === key)).map((m) => [m.value, m.hold === true]);
  await at('[data-kill="mid"]', 1);
  await ui.clearSent();
  await press(350); // held: momentary
  assert.deepEqual(await got(1, 'kill.mid'), [[true, true], [false, false]]);
  await ui.clearSent();
  await press(40); // tapped: latched on, no longer held
  assert.deepEqual(await got(1, 'kill.mid'), [[true, true], [true, false]]);
  await ui.clearSent();
  await press(40); // tapped again: off
  assert.deepEqual(await got(1, 'kill.mid'), [[false, false]]);
  await at('[data-pad="fx.on"]', 3);
  await ui.clearSent();
  await press(40);
  assert.deepEqual(await got(3, 'fx.on'), [[true, true], [true, false]]);
  await at('[data-kill="low"]', 3); // already latched on: a press holds nothing new
  await ui.clearSent();
  await press(350);
  assert.deepEqual(await got(3, 'kill.low'), [[false, false]]);
});

test('kill and FX keys tag a press as held until its release decides', async () => {
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Digit1');
  await ui.clearSent();
  await page.keyboard.down('KeyZ'); await page.waitForTimeout(300); await page.keyboard.up('KeyZ');
  await page.keyboard.down('KeyF'); await page.waitForTimeout(30); await page.keyboard.up('KeyF');
  await page.waitForTimeout(30);
  const got = (await sets((m) => m.deck === 1)).map((m) => [m.key, m.value, m.hold === true]);
  assert.deepEqual(got, [['kill.low', true, true], ['kill.low', false, false], ['fx.on', true, true], ['fx.on', true, false]]);
});

test('channel faders and the crossfader ignore the wheel and double-click; the tempo fader still wheels', async () => {
  const at = async (loc) => { const b = await loc.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); };
  await ui.clearSent();
  await at(deckEl(1).locator('[data-ctl="fader"]'));
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100);
  await at(page.locator('#crossfader'));
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(60);
  assert.deepEqual(await sets((m) => m.key === 'fader' || m.key === 'xfader.pos'), []);
  // A deliberate double-click is not a reset for faders that are on air.
  const f = deckEl(1).locator('[data-ctl="fader"]');
  const b = await f.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + 20);
  await page.mouse.down(); await page.mouse.move(b.x + b.width / 2, b.y + 60, { steps: 4 }); await page.mouse.up();
  const lowered = Number(await f.getAttribute('aria-valuenow'));
  assert.ok(lowered < 0.9, `fader at ${lowered}`);
  await page.waitForTimeout(600);
  await f.dblclick();
  await page.locator('#crossfader').dblclick();
  await page.waitForTimeout(60);
  assert.equal(Number(await f.getAttribute('aria-valuenow')), lowered);
  assert.equal(Number(await page.locator('#crossfader').getAttribute('aria-valuenow')), 0.45);
  await ui.clearSent();
  await at(deckEl(1).locator('[data-ctl="pitch"]'));
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(60);
  assert.equal((await sets((m) => m.deck === 1 && m.key === 'pitch')).length, 1);
});

test('sources drawer lists tabs with the right action per state', async () => {
  await page.locator('#sourcesBtn').click();
  await page.waitForSelector('#sourceList li >> nth=2');
  const rows = page.locator('#sourceList li');
  assert.equal(await rows.nth(0).locator('[data-ondeck]').textContent(), 'ON DECK 1');
  assert.equal(await rows.nth(1).locator('[data-load]').isVisible(), true);
  assert.equal(await rows.nth(1).locator('[data-fav]').isVisible(), false);
  assert.equal(await rows.nth(2).locator('[data-goto]').isVisible(), true);
  await rows.nth(1).locator('[data-load]').click();
  await page.waitForTimeout(50);
  assert.ok((await ui.hubCalls()).some((c) => c.type === 'LOAD_TAB' && c.tabId === 201));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sources').isHidden(), true);
});

test('settings change the engine and persist', async () => {
  await ui.clearSent();
  await page.locator('#settingsBtn').click();
  await page.locator('[data-setting="rec.format"] button[data-v="webm"]').click();
  await page.waitForTimeout(50);
  assert.ok((await sets((m) => m.deck === null && m.key === 'rec.format' && m.value === 'webm')).length === 1);
  assert.equal(await page.evaluate(() => window.__fake.storage['rec.format']), 'webm');
  await page.keyboard.press('Escape');
});

test('engine disconnect shows the banner and reconnect clears it', async () => {
  await page.evaluate(() => window.__fake.disconnect());
  await page.waitForSelector('#banner:not([hidden])', { timeout: 1000 });
  await page.waitForSelector('#banner[hidden]', { state: 'attached', timeout: 3000 });
});

test('layout fits 1440x900 without scrolling and a screenshot is saved', async () => {
  const fit = await page.evaluate(() => { const d = document.getElementById('decks'); return { sh: d.scrollHeight, ch: d.clientHeight, sw: d.scrollWidth, cw: d.clientWidth }; });
  assert.ok(fit.sh <= fit.ch + 2, `vertical overflow ${JSON.stringify(fit)}`);
  assert.ok(fit.sw <= fit.cw + 2, `horizontal overflow ${JSON.stringify(fit)}`);
  fs.mkdirSync(ART, { recursive: true });
  await page.screenshot({ path: path.join(ART, 'deck-ui-1440x900.png') });
});

test('during a CUE preview the PLAY button offers Play, not Pause', async () => {
  const s = threeDecks();
  Object.assign(s.decks[2], { playing: true, previewing: true });
  await ui.push({ t: 'state', s });
  await page.waitForTimeout(80);
  const play = deckEl(3).locator('[data-act="playToggle"]');
  assert.equal(await play.locator('use').getAttribute('href'), '#i-play');
  assert.equal(await play.getAttribute('aria-label'), 'Play');
  assert.equal(await play.getAttribute('aria-pressed'), 'false');
  await ui.push({ t: 'state', s: threeDecks() });
  await page.waitForTimeout(50);
});

test('the track-title tooltip sits on the title only, not over the whole deck', async () => {
  assert.equal(await deckEl(1).getAttribute('title'), null);
  assert.equal(await deckEl(1).locator('[data-title]').getAttribute('title'), 'Daft Punk — One More Time');
  assert.equal(await deckEl(1).locator('[data-ctl="fader"]').evaluate((e) => e.closest('[title]')), null);
});

test('screen readers get deck-specific names: sections, kills, knobs and faders; labelled canvases are images', async () => {
  assert.equal(await deckEl(1).getAttribute('aria-label'), 'Deck 1: Daft Punk — One More Time');
  assert.equal(await deckEl(3).getAttribute('aria-label'), 'Deck 3: <img src=x onerror="window.pwned=1"> Bandcamp exclusive');
  const kills = await deckEl(2).locator('[data-kill]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  assert.deepEqual(kills, ['Kill high', 'Kill mid', 'Kill low']);
  const sliders = await deckEl(2).locator('[role="slider"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  assert.ok(sliders.length >= 9, JSON.stringify(sliders));
  for (const name of sliders) assert.match(name, /^Deck 2 \S/);
  assert.ok(sliders.includes('Deck 2 tempo') && sliders.includes('Deck 2 channel fader'), JSON.stringify(sliders));
  assert.equal(await deckEl(2).locator('[data-ctl="trim"] .k-label').textContent(), 'GAIN', 'the visible label is unchanged');
  const canvases = await page.locator('canvas[aria-label]').evaluateAll((els) => els.map((e) => [e.id, e.getAttribute('role')]));
  assert.ok(canvases.length >= 2);
  for (const [id, role] of canvases) assert.equal(role, 'img', id);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
});

test('hold pads take no touch panning (CUE, rolls, KILL, FX ON, nudge, eject, REC)', async () => {
  const sel = '[data-hold="cue"], [data-roll], [data-kill], [data-pad="fx.on"], [data-hold^="nudge"], [data-act="eject"], [data-act="rec"], #mixRecBtn';
  const r = await page.locator(sel).evaluateAll((els) => els.map((e) => [e.dataset.hold || e.dataset.roll || e.dataset.kill || e.dataset.pad || e.dataset.act || e.id, getComputedStyle(e).touchAction]));
  assert.ok(r.length >= 3 * 13 + 1, `found ${r.length}`);
  assert.deepEqual(r.filter(([, ta]) => ta !== 'none'), []);
});

test('the CUE light follows the engine only: lit while previewing or paused at the cue, never painted by the press', async () => {
  const cue = deckEl(3).locator('[data-hold="cue"]');
  const lit = () => cue.evaluate((e) => e.classList.contains('on'));
  const push = async (over) => { const s = threeDecks(); Object.assign(s.decks[2], over); await ui.push({ t: 'state', s }); await page.waitForTimeout(30); };
  await push({ playing: true, previewing: true, playhead: 2.4 });
  assert.equal(await lit(), true, 'previewing from the cue');
  await push({ playing: true, previewing: false, playhead: 10 });
  assert.equal(await lit(), false, 'playing');
  const b = await cue.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(30);
  assert.equal(await lit(), false, 'the press alone does not light CUE');
  await push({ playing: true, previewing: true, playhead: 2.1 });
  assert.equal(await lit(), true, 'held and previewing');
  await push({ playing: true, previewing: true, playhead: 2.5 });
  assert.equal(await lit(), true, 'still held and previewing');
  await page.mouse.up();
  await push({ playing: false, previewing: false, playhead: 2.0 });
  assert.equal(await lit(), true, 'back at the cue');
  await push({ playing: false, previewing: false, playhead: 7 });
  assert.equal(await lit(), false, 'paused away from the cue');
  await ui.push({ t: 'state', s: threeDecks() });
  await page.waitForTimeout(30);
});

test('during a roll the extrapolated playhead stays inside the loop', async () => {
  // Snapshots stalled: the UI extrapolates the full 250 ms. A 1/8-beat loop in beat 0 of a bar.
  const T = 60 / 124, start = 2.0 + 40.5 * T, L = T / 8;
  const litLed = async (loop) => {
    const s = threeDecks();
    s.wallMs = Date.now() - 1000;
    Object.assign(s.decks[0], { playhead: start + 0.01, loop, roll: loop ? 0.125 : null });
    await ui.push({ t: 'state', s });
    await page.waitForTimeout(80);
    return deckEl(1).locator('[data-leds] i').evaluateAll((els) => els.findIndex((e) => e.classList.contains('on')));
  };
  assert.equal(await litLed(null), 1, 'without a loop the extrapolation crosses into the next beat');
  assert.equal(await litLed({ start, end: start + L }), 0, 'with a loop it wraps back into the loop');
  await ui.push({ t: 'state', s: threeDecks() });
  await page.waitForTimeout(30);
});

test('while the page is hidden snapshots touch no deck or master DOM; showing the page applies the latest one', async () => {
  const setVis = (hidden) => page.evaluate((h) => {
    if (h) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    } else { delete document.visibilityState; delete document.hidden; }
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setVis(true);
  try {
    await page.evaluate(() => {
      window.__recs = [];
      window.__mo = new MutationObserver((r) => window.__recs.push(...r));
      for (const el of document.querySelectorAll('.deck, .wave-row, #master, .xfader-bar, #mixRecBtn, .clock')) window.__mo.observe(el, { subtree: true, attributes: true, childList: true, characterData: true });
    });
    for (let i = 0; i < 5; i++) {
      const s = threeDecks();
      s.decks[0].title = `Hidden update ${i}`;
      s.decks[0].bpm = { ...s.decks[0].bpm, out: 130 + i };
      s.decks[1].params.trim = 0.2;
      s.decks[2].rec = { state: 'recording', format: 'wav', seconds: 10 + i };
      s.master.params['master.volume'] = 0.8;
      s.clock = { mode: 'deck', deckId: 1, bpm: 130 + i };
      await ui.push({ t: 'state', s });
    }
    await page.waitForTimeout(60);
    const writes = await page.evaluate(() => {
      const r = [...window.__recs, ...window.__mo.takeRecords()];
      window.__mo.disconnect();
      return [...new Set(r.map((m) => `${m.type} ${m.target.nodeName}.${m.target.getAttribute ? m.target.getAttribute('class') || '' : ''} ${m.attributeName || ''}`))];
    });
    assert.deepEqual(writes, [], 'no DOM writes while hidden');
  } finally { await setVis(false); }
  await page.waitForTimeout(30);
  assert.equal(await deckEl(1).locator('[data-title]').textContent(), 'Hidden update 4');
  assert.equal(await deckEl(1).locator('[data-bpm]').textContent(), '134.0');
  assert.equal(await deckEl(2).locator('[data-ctl="trim"]').getAttribute('aria-valuenow'), '0.200');
  assert.equal(await deckEl(3).locator('[data-rec-time]').textContent(), '00:14');
  assert.equal(await page.locator('#masterVol').getAttribute('aria-valuenow'), '0.800');
  assert.equal(await page.locator('#clockBpm').textContent(), '134.0');
  await ui.push({ t: 'state', s: threeDecks() });
  await page.waitForTimeout(30);
});

test('no console errors', () => { assert.deepEqual(ui.errors, []); });

test('empty state is shown with no decks', async () => {
  const u2 = await openUi({ state: makeState({ decks: [], clock: { mode: 'none', deckId: null, bpm: null } }) });
  try {
    await u2.page.waitForFunction(() => document.getElementById('engineStatus').dataset.status === 'up');
    assert.equal(await u2.page.locator('#empty').isVisible(), true);
    assert.equal(await u2.page.locator('.deck').count(), 0);
    fs.mkdirSync(ART, { recursive: true });
    await u2.page.screenshot({ path: path.join(ART, 'deck-ui-empty.png') });
  } finally { await u2.close(); }
});

test('settings are restored again when the engine is re-created while the page stays open', async () => {
  const st = (engineId) => ({ ...makeState({ decks: [], clock: { mode: 'none', deckId: null, bpm: null } }), engineId });
  const u = await openUi({ state: st('e1'), storage: { 'pitch.defaultRange': 0.16 } });
  try {
    const restores = async () => (await u.sent()).filter((m) => m.t === 'set' && m.deck === null && m.key === 'pitch.defaultRange' && m.value === 0.16).length;
    await u.page.waitForFunction(() => window.__fake.sent.some((m) => m.t === 'set' && m.key === 'pitch.defaultRange'));
    assert.equal(await restores(), 1);
    await u.push({ t: 'state', s: st('e1') });
    await u.page.waitForTimeout(80);
    assert.equal(await restores(), 1, 'same engine: restored once');
    await u.push({ t: 'state', s: st('e2') }); // a new engine instance, back at its defaults
    await u.page.waitForTimeout(80);
    assert.equal(await restores(), 2, 'new engine: restored again');
    assert.deepEqual(u.errors, []);
  } finally { await u.close(); }
});

// Spec §3.9: DOM nodes are updated only when their values change.
test('six decks: an unchanged snapshot writes nothing to the deck or master DOM', async () => {
  const decks = Array.from({ length: 6 }, (_, i) => deck({
    id: i + 1, slot: i + 1, tabId: 100 + i, title: `Track ${i + 1}`, favIconUrl: i === 0 ? 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' : '',
    ...(i === 1 ? { sync: { on: false, mode: 'BEAT', isMaster: true, outOfRange: false, phaseMs: null }, rec: { state: 'recording', format: 'wav', seconds: 73.4 } } : {}),
    ...(i === 2 ? { starved: true, reserve: 0.4, engineRate: 1.06, assist: { available: true, active: true, sourceRate: 1.06 } } : {}),
    ...(i === 3 ? { playing: false, playhead: 2.0, sync: { on: true, mode: 'BEAT', isMaster: false, outOfRange: true, phaseMs: null } } : {}),
    ...(i === 4 ? { bpm: { state: 'SEARCH', native: null, out: null, conf: 0.1, mult: 1, tapped: false }, params: { 'kill.low': true, 'fx.on': true } } : {}),
  }));
  const state = makeState({ decks });
  const u = await openUi({ state, viewport: { width: 1920, height: 1080 } });
  try {
    await u.page.waitForSelector('.deck >> nth=5');
    await u.page.waitForTimeout(100);
    const r = await u.page.evaluate((s) => {
      const mo = new MutationObserver(() => {});
      for (const el of document.querySelectorAll('.deck, .wave-row, #master, .xfader-bar, #mixRecBtn, .clock')) mo.observe(el, { subtree: true, attributes: true, childList: true, characterData: true });
      window.__fake.push({ t: 'state', s });
      mo.takeRecords();
      const N = 10;
      for (let i = 0; i < N; i++) window.__fake.push({ t: 'state', s });
      const recs = mo.takeRecords();
      mo.disconnect();
      const what = [...new Set(recs.map((m) => `${m.type} ${m.target.nodeName}.${m.target.getAttribute ? m.target.getAttribute('class') || '' : ''} ${m.attributeName || ''}`))];
      return { perSnapshot: recs.length / N, what };
    }, state);
    console.log(`DOM writes per unchanged 6-deck snapshot: ${r.perSnapshot}`);
    assert.deepEqual(r, { perSnapshot: 0, what: [] });
    assert.deepEqual(u.errors, []);
  } finally { await u.close(); }
});

describe('sources drawer refresh', () => {
  let su, sp;
  const list = (over = {}) => ({ ok: true, tabs: SOURCES.tabs.map((t) => ({ ...t, ...(over[t.id] || {}) })) });
  const setReply = (r) => sp.evaluate((x) => { window.__fake.hubReplies.LIST_SOURCES = x; }, r);
  const listCalls = async () => (await su.hubCalls()).filter((c) => c.type === 'LIST_SOURCES').length;
  const clearCalls = () => sp.evaluate(() => { window.__fake.hubCalls.length = 0; });
  const setVis = (hidden) => sp.evaluate((h) => {
    if (h) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    else delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

  before(async () => {
    su = await openUi({ state: threeDecks(), hubReplies: { LIST_SOURCES: list() } });
    sp = su.page;
    await sp.waitForSelector('.deck >> nth=2');
  });
  after(async () => { await su?.close(); });

  test('rows are updated in place: the same row survives a refresh and a focused button keeps focus', async () => {
    await sp.locator('#sourcesBtn').click();
    await sp.waitForSelector('#sourceList li >> nth=2');
    await sp.evaluate(() => document.querySelectorAll('#sourceList li').forEach((li, i) => { li.__mark = i + 1; }));
    const go = sp.locator('#sourceList li').nth(2).locator('[data-goto]');
    await go.focus();
    await setReply(list({ 201: { title: 'Mixcloud — Saturday set', audible: false } }));
    await sp.waitForFunction(() => document.querySelectorAll('#sourceList li')[1].querySelector('[data-title]').textContent === 'Mixcloud — Saturday set', null, { timeout: 2500 });
    const r = await sp.evaluate(() => ({
      marks: [...document.querySelectorAll('#sourceList li')].map((li) => li.__mark),
      focus: document.activeElement === document.querySelectorAll('#sourceList li')[2].querySelector('[data-goto]'),
      audible: document.querySelectorAll('#sourceList li')[1].querySelector('[data-audible]').hidden,
    }));
    assert.deepEqual(r, { marks: [1, 2, 3], focus: true, audible: true });
    // A tab that gains a deck switches its action in place; a closed tab's row goes away.
    await setReply({ ok: true, tabs: [SOURCES.tabs[0], { ...SOURCES.tabs[1], deckSlot: 2 }] });
    await sp.waitForFunction(() => document.querySelectorAll('#sourceList li').length === 2, null, { timeout: 2500 });
    const r2 = await sp.evaluate(() => {
      const li = document.querySelectorAll('#sourceList li')[1];
      const on = li.querySelector('[data-ondeck]');
      return { mark: li.__mark, onDeck: on.hidden ? null : on.textContent, load: li.querySelector('[data-load]').hidden };
    });
    assert.deepEqual(r2, { mark: 2, onDeck: 'ON DECK 2', load: true });
    await setReply(list());
  });

  test('a failing tab list toasts once, not on every refresh', async () => {
    await sp.evaluate(() => document.getElementById('toasts').replaceChildren());
    await setReply({ ok: false });
    await sp.waitForTimeout(3400);
    const t = await sp.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => [x.dataset.text, x.dataset.count]));
    assert.deepEqual(t, [['Could not list browser tabs.', '1']]);
    await setReply(list());
  });

  test('no refresh while the page is hidden or the drawer is closed; showing the page refreshes at once', async () => {
    assert.equal(await sp.locator('#sources').isVisible(), true);
    await setVis(true);
    await clearCalls();
    await sp.waitForTimeout(1700);
    assert.equal(await listCalls(), 0, 'hidden page');
    await setVis(false);
    await sp.waitForTimeout(50);
    assert.ok((await listCalls()) >= 1, 'refreshed on show');
    await sp.locator('#sources [data-close]').click();
    await clearCalls();
    await sp.waitForTimeout(1700);
    assert.equal(await listCalls(), 0, 'closed drawer');
  });

  test('no console errors (sources)', () => { assert.deepEqual(su.errors, []); });
});

// A fake engine with a real round trip: a message is applied 2 ms after it is posted, the engine
// snapshots every 32 ms and each snapshot lands 3 ms later, so the UI always sees slightly old state.
describe('with a lagging engine', () => {
  let lu, lp;
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
  const eng = () => lp.evaluate(() => window.__eng);
  const key = (type, code, extra = {}) => ({ type, code, key: code === 'Space' ? ' ' : code, ...extra });
  const keys = (list) => lp.evaluate((l) => { for (const k of l) document.body.dispatchEvent(new KeyboardEvent(k.type, { bubbles: true, cancelable: true, ...k })); }, list);

  before(async () => {
    lu = await openUi({ state: threeDecks() });
    lp = lu.page;
    await lp.waitForSelector('.deck >> nth=2');
    await lp.evaluate(() => {
      const f = window.__fake;
      const e = JSON.parse(JSON.stringify(f.state));
      window.__eng = e;
      const push = f.sent.push.bind(f.sent);
      f.sent.push = (m) => {
        setTimeout(() => {
          const d = e.decks.find((x) => x.id === m.deck);
          if (m.t === 'set') (m.deck === null ? e.master.params : d.params)[m.key] = m.value;
          if (m.t === 'act' && d) {
            if (m.a === 'play') d.playing = true;
            else if (m.a === 'pause' || (m.a === 'cueDown' && d.playing)) d.playing = false;
            else if (m.a === 'playToggle') d.playing = !d.playing;
          }
        }, 2);
        return push(m);
      };
      setInterval(() => { const s = JSON.parse(JSON.stringify(e)); setTimeout(() => f.push({ t: 'state', s }), 3); }, 32);
    });
    await lp.waitForTimeout(150);
  });
  after(async () => { await lu?.close(); });

  test('wheel steps on a knob all land despite stale snapshots', async () => {
    const before0 = (await eng()).decks[0].params.trim;
    await lp.evaluate(() => new Promise((res) => {
      const svg = document.querySelector('.deck [data-ctl="trim"] svg');
      let k = 0;
      const id = setInterval(() => {
        svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
        if (++k >= 20) { clearInterval(id); res(); }
      }, 16);
    }));
    await lp.waitForTimeout(350);
    const after0 = (await eng()).decks[0].params.trim;
    assert.ok(near(after0 - before0, 0.2, 1e-6), `trim moved ${(after0 - before0).toFixed(3)}, not 0.200`);
  });

  test('held ↑ moves the tempo by every repeat', async () => {
    const before0 = (await eng()).decks[0].params.pitch;
    await lp.evaluate(() => new Promise((res) => {
      let k = 0;
      const id = setInterval(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', key: 'ArrowUp', repeat: k > 0, bubbles: true, cancelable: true }));
        if (++k >= 30) {
          clearInterval(id);
          document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', key: 'ArrowUp', bubbles: true, cancelable: true }));
          res();
        }
      }, 33);
    }));
    await lp.waitForTimeout(350);
    const after0 = (await eng()).decks[0].params.pitch;
    assert.ok(near(after0 - before0, 0.03, 1e-6), `tempo moved ${((after0 - before0) * 100).toFixed(2)} %, not 3.00 %`);
  });

  test('CUE then PLAY before the next snapshot starts the deck', async () => {
    assert.equal((await eng()).decks[0].playing, true);
    await keys([key('keydown', 'KeyC'), key('keyup', 'KeyC'), key('keydown', 'Space'), key('keyup', 'Space')]);
    await lp.waitForTimeout(150);
    assert.equal((await eng()).decks[0].playing, true);
  });

  test('a held kill is released at once when the page loses focus while hidden', async () => {
    await lp.evaluate(() => { window.requestAnimationFrame = () => 0; }); // hidden page: no animation frames
    await lu.clearSent();
    await keys([key('keydown', 'KeyQ')]);
    await lp.waitForTimeout(300);
    await lp.evaluate(() => window.dispatchEvent(new Event('blur')));
    const s = (await lu.sent()).filter((m) => m.t === 'set' && m.key === 'kill.hi');
    assert.deepEqual(s.map((m) => [m.deck, m.value]), [[1, true], [1, false]]);
  });

  test('pending continuous sets are coalesced, then flushed on blur and when the page is hidden', async () => {
    const turn = () => lp.evaluate(() => {
      const svg = document.querySelector('.deck [data-ctl="eq.mid"] svg');
      for (let i = 0; i < 3; i++) svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    const mids = async () => (await lu.sent()).filter((m) => m.t === 'set' && m.key === 'eq.mid');
    await lu.clearSent();
    await turn();
    assert.equal((await mids()).length, 0);
    await lp.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal((await mids()).length, 1);
    await lu.clearSent();
    await turn();
    await lp.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const m = await mids();
    assert.equal(m.length, 1);
    assert.ok(near(m[0].value, 0.56), `eq.mid ${m[0].value}`);
  });

  test('no console errors (lagging engine)', () => { assert.deepEqual(lu.errors, []); });
});
