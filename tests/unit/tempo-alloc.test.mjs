// The tempo tracker runs on the engine's main thread for every deck: in steady state (optimized
// code) it must not churn the heap. Measured with V8's sampling heap profiler, including objects
// already collected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { OdfCore } from '../../worklets/odf-core.js';
import { DeckTempo } from '../../engine/tempo.js';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

test('DeckTempo allocates under 100 KB per second of audio once warmed up', async () => {
  const { x } = synth({ ...PATTERNS.house, bars: 64 });
  const frames = [];
  const odf = new OdfCore(FS, (full, low, t) => frames.push([full, low, t]));
  for (let s = 0; s + 128 <= x.length; s += 128) odf.push(x.subarray(s, s + 128), s);
  const deck = new DeckTempo({ sampleRate: FS, fps: odf.fps });
  const half = frames.length >> 1, secs = (frames.length - half) / odf.fps;
  for (let i = 0; i < half; i++) deck.pushFrame(...frames[i]); // warm-up: the hot loops get optimized
  const session = new Session();
  session.connect();
  try {
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = half; i < frames.length; i++) deck.pushFrame(...frames[i]);
    const { profile } = await session.post('HeapProfiler.stopSampling');
    let bytes = 0;
    const walk = (n) => { bytes += n.selfSize; for (const c of n.children) walk(c); };
    walk(profile.head);
    const g = deck.get();
    assert.equal(g.state, 'LOCKED');
    assert.ok(Math.abs(g.inBpm - 124) < 0.1, `bpm ${g.inBpm}`);
    assert.ok(bytes / 1024 / secs < 100, `${(bytes / 1024 / secs).toFixed(0)} KB allocated per audio-second`);
  } finally { session.disconnect(); }
});
