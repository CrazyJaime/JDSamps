// Waveform memory stays bounded by what the engine still buffers (final review engine/F15), and the
// UI store accepts data from before its first chunk (ui/M2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveStore } from '../../ui/waveform.js';
import { makeEngine, makeDeck } from './fixtures/deck-harness.mjs';

const HOP = 512 / 48000, BATCH = 8;
/** Deterministic band bytes for hop i (so content can be checked after moves). */
const band = (i, b) => (i * 7 + b * 31) % 251;
const batch = (i0) => Uint8Array.from({ length: BATCH * 3 }, (_, j) => band(i0 + Math.floor(j / 3), j % 3));

test('a deck left loaded for 10 minutes keeps only the waveform it still buffers', async () => {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  const d = makeDeck(engine, clock, { liveEdge: 0 });
  d.setCue(2);
  let i = 0;
  // Paused deck, audio arriving in real time; the buffer cap (240 s) moves historyStart.
  for (let sec = 2; sec <= 600; sec += 2) {
    for (; (i + BATCH) * HOP <= sec; i += BATCH) d.appendWave(i * HOP, HOP, batch(i));
    d.ts.liveEdge = sec;
    clock.t = 100 + sec;
    await d.trim(clock.t, d.ts.posAt(clock.t));
  }
  const hs = d.ts.historyStart, w = d.wave;
  assert.ok(hs > 300, `historyStart ${hs}`);
  const held = (600 - hs) / HOP;
  assert.ok(w.n <= held + BATCH + 1, `${w.n} hops held, ${Math.round(held)} buffered`);
  assert.ok(w.data.length <= 2 * 3 * (240 / HOP + 2 * BATCH), `wave array ${w.data.length} bytes`);
  // The backlog still starts at historyStart with the right bytes.
  const b = d.waveBacklog();
  const k = Math.round(b.tStart / HOP);
  assert.ok(b.tStart <= hs + 1e-9 && b.tStart > hs - HOP, `backlog from ${b.tStart}, historyStart ${hs}`);
  assert.equal(b.data.length / 3, i - k);
  for (const j of [0, 1, 500, i - k - 1]) assert.deepEqual(b.data.slice(j * 3, j * 3 + 3), [0, 1, 2].map((x) => band(k + j, x)), `hop ${k + j}`);
});

test('WaveStore: a backlog that starts before the first live chunk is kept (re-based at the front)', () => {
  const s = new WaveStore();
  const out = [0, 0, 0];
  s.add({ tStart: 400 * HOP, hop: HOP, data: Array.from(batch(400)) }); // live chunk first (reload race)
  const rev = s.rev;
  s.add({ tStart: 0, hop: HOP, data: Array.from({ length: 408 * 3 }, (_, j) => band(Math.floor(j / 3), j % 3)) });
  assert.deepEqual(s.at(10.25 * HOP, HOP / 2, out), [band(10, 0), band(10, 1), band(10, 2)]);
  assert.deepEqual(s.at(403.25 * HOP, HOP / 2, out), [band(403, 0), band(403, 1), band(403, 2)]);
  assert.ok(s.rev > rev, 'cached tiles are dropped');
  assert.equal(s.at(408.25 * HOP, HOP / 2, out), null, 'nothing past the data');
});

test('WaveStore: compacting to historyStart bounds its memory and keeps later data and the tile origin', () => {
  const s = new WaveStore();
  const out = [0, 0, 0];
  const t0 = 3 * HOP;
  for (let i = 0; i * HOP < 600; i += BATCH) {
    s.add({ tStart: t0 + i * HOP, hop: HOP, data: Array.from(batch(i)) });
    s.compact(Math.max(0, i * HOP - 240));
  }
  assert.ok(s.data.length <= 2 * 3 * (240 / HOP + 2 * BATCH), `store array ${s.data.length} bytes`);
  assert.equal(s.t0, t0, 'the tile origin does not move');
  const i = 50000; // ~533 s
  assert.deepEqual(s.at(t0 + (i + 0.25) * HOP, HOP / 2, out), [band(i, 0), band(i, 1), band(i, 2)]);
  assert.equal(s.at(t0 + 100.25 * HOP, HOP / 2, out), null, 'compacted audio is gone');
  // Data again from before the compacted start (a reconnect backlog from an older historyStart).
  const j = Math.round((s.t0 + s.start * HOP - 10 * HOP - t0) / HOP);
  s.add({ tStart: t0 + j * HOP, hop: HOP, data: Array.from(batch(j)) });
  assert.deepEqual(s.at(t0 + (j + 2.25) * HOP, HOP / 2, out), [band(j + 2, 0), band(j + 2, 1), band(j + 2, 2)]);
});
