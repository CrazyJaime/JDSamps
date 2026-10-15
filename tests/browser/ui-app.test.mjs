import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUi } from './ui-harness.mjs';
import { threeDecks, makeState, makeWave } from './fixtures/mock-state.mjs';

const ART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
const SOURCES = {
  ok: true,
  tabs: [
    { id: 101, title: 'Daft Punk — One More Time', url: 'https://www.youtube.com/watch?v=x', favIconUrl: '', audible: true, granted: true, deckSlot: 1 },
    { id: 201, title: 'Mixcloud — Friday set', url: 'https://www.mixcloud.com/x/', favIconUrl: 'javascript:alert(1)', audible: true, granted: true, deckSlot: null },
    { id: 202, title: 'SoundCloud — Track', url: 'https://soundcloud.com/a/b', favIconUrl: '', audible: false, granted: false, deckSlot: null },
  ],
};

// Every persisted master key, stored with a value the engine does not have, except assist.on
// (stored equal to the engine's, so it must not be sent).
const STORED = {
  'master.limiter': false, 'xfader.curve': 'SHARP', 'rec.format': 'webm', 'bpm.range': '88-175', 'buffer.capSec': 480, 'assist.on': true, 'pitch.defaultRange': 0.16,
};
let ui, page;
const acts = async (filter) => (await ui.sent()).filter((m) => m.t === 'act' && (!filter || filter(m)));
const sets = async (filter) => (await ui.sent()).filter((m) => m.t === 'set' && (!filter || filter(m)));
const deckEl = (slot) => page.locator('.deck').nth(slot - 1);

before(async () => {
  ui = await openUi({ state: threeDecks(), hubReplies: { LIST_SOURCES: SOURCES, LOAD_TAB: { ok: true } }, storage: STORED });
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
  const sent = (await sets((m) => m.deck === null)).filter((m) => m.key in STORED);
  const differ = Object.fromEntries(Object.entries(STORED).filter(([k]) => k !== 'assist.on'));
  assert.deepEqual(Object.fromEntries(sent.map((m) => [m.key, m.value])), differ);
  assert.equal(sent.length, Object.keys(differ).length, JSON.stringify(sent));
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
