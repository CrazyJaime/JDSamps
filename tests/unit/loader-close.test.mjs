// The tab closed once every byte of its track is in: the load goes on to a resident deck. The hub's EJECT for
// the closed tab reaches the engine (tests/unit/fixtures/loader-harness.mjs hubEject, the engine's handler) while
// the track decodes, while its beat is found or while the resident deck lets go of the tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, rendition, file, settle, decoders, SR } from './fixtures/loader-harness.mjs';

const called = (engine, fn) => engine.calls.filter((c) => c.fn === fn);
const MSE = { kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true };
const LINK = 'https://site.example/t.mp3';
const PROGRESSIVE = { kind: 'progressive', src: LINK, files: { [LINK]: file('t', 120.0065) } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [what, page, before] of [
  ['while the beat is found (every piece fetched)', MSE,
    ({ tab, engine }) => { const f = engine.analyse.bind(engine); engine.analyse = async (p, s) => { tab.close(engine, { endAfter: 10, ejectAfter: 30 }); await wait(60); return f(p, s); }; }],
  ['while the page\'s file decodes', PROGRESSIVE,
    ({ tab, engine, loader }) => { loader.d.decodeFile = async (ctx, buf) => { tab.close(engine, { endAfter: 10, ejectAfter: 30 }); await wait(60); return decoders.decodeFile(ctx, buf); }; }],
  ['once it is resident, while its tab is let go', MSE,
    ({ tab, engine }) => { const s = engine.stopTab.bind(engine); engine.stopTab = (d, o = {}) => { if (o.release) { tab.close(engine, { endAfter: 0, ejectAfter: null }); engine.hubEject(tab.tabId); } return s(d, o); }; }],
]) {
  test(`the tab closed ${what}: the deck goes resident, with no error, and lets go of the tab`, async () => {
    const { result, engine, deck } = await load(page, { before });
    await settle(30);
    await wait(60);
    assert.equal(result.kind, 'resident', JSON.stringify([result, engine.events]));
    assert.equal(called(engine, 'startResidentDeck').length, 1);
    assert.ok(Math.abs(called(engine, 'startResidentDeck')[0].frames / SR - 120) < 0.02);
    assert.deepEqual(called(engine, 'eject'), [], 'the deck was ejected');
    assert.equal(engine.decks.get(deck.id), deck, 'the deck is still on');
    assert.equal(deck.tabId, null, 'released');
    assert.deepEqual(engine.events.filter((e) => e.level === 'error'), []);
  });
}

test('the tab closed while a link it gave decodes badly: the deck goes with one error, saying the tab was closed', async () => {
  const { result, engine } = await load(PROGRESSIVE, {
    before: ({ tab, engine: e, loader }) => { loader.d.decodeFile = async () => { tab.close(e, { endAfter: 10, ejectAfter: 30 }); await wait(60); throw new Error('Unable to decode audio data'); }; },
  });
  await settle(30);
  assert.equal(result.ok, false);
  assert.deepEqual(called(engine, 'failLoadingToLive'), []);
  assert.deepEqual(called(engine, 'startResidentDeck'), []);
  assert.equal(engine.decks.size, 0);
  assert.deepEqual(engine.events.filter((e) => /^Deck 1: /.test(e.text)), [{ level: 'error', text: 'Deck 1: the tab was closed before the track was in.' }]);
});
