// PLAY is one engine-side toggle, so a UI acting on a stale snapshot can never send the wrong one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Deck } from '../../engine/deck.js';
import { Timeshift } from '../../engine/timeshift.js';
import { MasterClock } from '../../engine/sync.js';
import { validateUiMessage } from '../../shared/protocol.js';

function makeDeck() {
  const clock = { t: 10 };
  const engine = {
    ctx: { get currentTime() { return clock.t; }, sampleRate: 48000 },
    params: { 'buffer.capSec': 240, 'assist.on': true, 'bpm.range': 'AUTO', 'rec.format': 'wav' },
    clock: new MasterClock(),
  };
  const d = new Deck(engine, { id: 1, slot: 1, tabId: 10, stream: null, meta: {}, params: { pitch: 0, range: 0.1, keyLock: true, syncMode: 'BEAT' } });
  d.ts = new Timeshift({ schedule() {}, addBuffers() {} }, { sampleRate: 48000, latency: 0.1, outLatency: 0.05 });
  d.ts.liveEdge = 30;
  return d;
}

test('playToggle is a valid deck action', () => {
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'playToggle' }).ok, true);
  assert.equal(validateUiMessage({ t: 'act', deck: null, a: 'playToggle' }).ok, false);
});

test('playToggle starts a paused deck and pauses a playing one', async () => {
  const d = makeDeck();
  assert.deepEqual(await d.act('playToggle'), { ok: true });
  assert.equal(d.wantPlay, true);
  assert.deepEqual(await d.act('playToggle'), { ok: true });
  assert.equal(d.wantPlay, false);
});

test('playToggle during a CUE preview keeps the deck playing, like PLAY', async () => {
  const d = makeDeck();
  await d.act('cueDown'); // paused at the cue point: preview starts
  assert.equal(d.previewing, true);
  await d.act('playToggle');
  assert.equal(d.wantPlay, true);
  assert.equal(d.previewing, false);
  await d.act('cueUp');
  assert.equal(d.wantPlay, true);
});
