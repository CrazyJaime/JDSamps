// Deck-level beat grid: BPM and grid follow the audio at the playhead (track changes, assist
// steps), and the manual grid tools act on what the DJ hears.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet } from './worklet-shim.mjs';
import { DeckTempo } from '../../engine/tempo.js';
import { GridMap } from '../../engine/timeshift.js';
import { makeEngine, makeDeck } from './fixtures/deck-harness.mjs';
import { synth, PATTERNS, FS, nearestBeatError } from './fixtures/synth.mjs';

const reg = await loadWorklet('worklets/deck-input.js', { sampleRate: FS });
const Input = reg['jds-deck-input'];

const bpmOf = (g) => 60 / g.T;
const gridErrMs = (g, p, truth) => nearestBeatError(g.t0 + Math.round((p - g.t0) / g.T) * g.T, truth) * 1000;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** A deck with the real tempo tracker, before any audio. */
function realDeck(opts = {}) {
  const clock = { t: 0 };
  const engine = makeEngine(clock);
  const d = makeDeck(engine, clock, { liveEdge: 0, ...opts });
  d.tempo = null;
  d.grids = new GridMap();
  return { d, clock, engine };
}

test('BPM, grid and master clock follow the playhead across a track change', async () => {
  const A = synth({ ...PATTERNS.house, bars: 30, tail: 0 });
  const B = synth({ ...PATTERNS.house, bpm: 100, bars: 20, tail: 0, seed: 9 });
  const x = new Float32Array(A.x.length + B.x.length); x.set(A.x); x.set(B.x, A.x.length);
  const boundary = A.x.length / FS;
  const { d, clock } = realDeck();
  const proc = new Input();
  const out = [[new Float32Array(128)]];
  let inA = null, inB = null;
  for (let s = 0; s + 128 <= x.length; s += 128) {
    const blk = x.subarray(s, s + 128);
    proc.process([[blk, blk]], out, {});
    clock.t += 128 / FS;
    for (const { msg } of proc.port.posted.splice(0)) d.onInput(msg);
    if (s % 2048) continue;
    if (!d.wantPlay && d.ts.liveEdge >= 20) await d.act('play'); // 20 s of reserve
    if (!d.wantPlay) continue;
    const now = clock.t, p = d.ts.posAt(now);
    const live = d.tempo.get().inBpm;
    if (!inA && d.ts.liveEdge > boundary + 6 && live && near(live, 100, 1)) {
      inA = { p, live, native: d.tempoInfo().native, master: d.masterInfo(now), st: d.state(now), g: d.grids.at(p) };
    }
    if (!inB && p > boundary + 1.5) inB = { p, native: d.tempoInfo().native, master: d.masterInfo(now), g: d.grids.at(p) };
  }
  assert.ok(inA, 'the live edge moved on to the 100 BPM track');
  assert.ok(inA.p < boundary - 10, `playhead ${inA.p.toFixed(1)} s is still in the 124 BPM track (ends ${boundary.toFixed(1)} s)`);
  assert.ok(near(inA.native, 124, 0.2), `deck BPM ${inA.native.toFixed(2)} at the playhead while the live edge reads ${inA.live.toFixed(2)}`);
  assert.ok(near(inA.st.bpm.native, 124, 0.2) && near(inA.st.bpm.out, 124, 0.2), `snapshot ${JSON.stringify(inA.st.bpm)}`);
  assert.ok(near(inA.master.bpm, 124, 0.2) && near(inA.master.period, 60 / 124, 0.001), `master clock ${JSON.stringify(inA.master)}`);
  assert.ok(near(bpmOf(inA.st.grid), 124, 0.2), `snapshot grid ${bpmOf(inA.st.grid).toFixed(2)} BPM`);
  assert.ok(Math.abs(gridErrMs(inA.g, inA.p, A.truth)) < 5, `phase ${gridErrMs(inA.g, inA.p, A.truth).toFixed(1)} ms`);
  assert.ok(inB, 'the playhead crossed into the 100 BPM track');
  assert.ok(near(inB.native, 100, 0.2), `deck BPM after the crossing ${inB.native.toFixed(2)}`);
  assert.ok(near(inB.master.bpm, 100, 0.2), `master clock after the crossing ${inB.master.bpm.toFixed(2)}`);
});

/**
 * A playing deck with a tapped 120 BPM grid whose source assist has stepped up 8 times (+2%),
 * so the playhead (heard audio) is in the oldest grid segment.
 */
async function assistedDeck() {
  const { d, clock } = realDeck({ liveEdge: 16 });
  d.tempo = new DeckTempo({ sampleRate: FS, fps: 93.75 });
  for (let k = 0; k < 8; k++) d.tempo.tap(Math.round((4 + k * 0.5) * FS + 100));
  d.grids.update(d.tempo.get().grid);
  d.setCue(10);
  await d.act('play');
  clock.t += 0.25;
  d.params.pitch = 0.04;
  d.applyRate();
  clock.t += 0.25;
  d.agents.set(1, { port: { postMessage() {} }, status: { hasMedia: true } });
  for (let i = 0; i < 8; i++) { clock.t += 0.25; d.ts.liveEdge += 0.25; d.assistTick(clock.t, 2); }
  assert.ok(near(d.assist.sourceRate, 1.02, 1e-9), `assist at ${d.assist.sourceRate}`);
  clock.t += 0.25;
  const p = d.ts.posAt(clock.t);
  assert.ok(d.ts.playingAt(clock.t) && p > 10 && p < 16 && d.grids.segs.length >= 9, `playhead ${p} is in an older grid segment`);
  return { d, clock, p };
}

const lastGrid = (d) => d.grids.segs[d.grids.segs.length - 1].grid;
const phaseOf = (g, p) => { const b = (p - g.t0) / g.T; return b - Math.floor(b); };

test('GRID shift after assist steps moves the grid the DJ hears', async () => {
  const { d, p } = await assistedDeck();
  const before = d.grids.at(p), beforeLast = lastGrid(d);
  await d.act('gridShift', { beats: 0.5, ms: 0 });
  const after = d.grids.at(p);
  const moved = phaseOf(before, p) - phaseOf(after, p);
  assert.ok(near(Math.abs(moved), 0.5, 1e-6), `grid at the playhead moved by ${moved} beats`);
  assert.ok(near(Math.abs(phaseOf(beforeLast, 30) - phaseOf(lastGrid(d), 30)), 0.5, 1e-6), 'the live grid moved too');
  await d.act('gridShift', { beats: 0, ms: 10 });
  assert.ok(near(d.grids.at(p).t0 - after.t0, 0.01, 1e-9), 'a 10 ms shift reaches the playhead');
});

test('½× / 2× after assist steps change the BPM the DJ hears', async () => {
  const { d, p } = await assistedDeck();
  assert.ok(near(d.tempoInfo().native, 120, 0.01), `native ${d.tempoInfo().native}`);
  await d.act('mult', { factor: 2 });
  assert.ok(near(bpmOf(d.grids.at(p)), 240, 0.01), `grid at the playhead ${bpmOf(d.grids.at(p))} BPM`);
  assert.ok(near(d.tempoInfo().native, 240, 0.01), `native ${d.tempoInfo().native}`);
  assert.ok(near(d.tempo.get().inBpm, 240 * 1.02, 0.01), `live ${d.tempo.get().inBpm}`);
  await d.act('mult', { factor: 0.5 });
  assert.ok(near(d.tempoInfo().native, 120, 0.01));
});

test('TAP 1 after assist steps marks the downbeat the DJ hears', async () => {
  const { d, clock, p } = await assistedDeck();
  await d.act('tap1');
  const g = d.grids.at(p);
  assert.ok(g.bar1 != null, 'bar 1 set at the playhead');
  assert.ok(Math.abs(g.bar1 - p) <= g.T / 2 + 1e-9, `bar 1 ${g.bar1} near the heard position ${p}`);
  assert.ok(near(phaseOf(g, g.bar1), 0, 1e-6) || near(phaseOf(g, g.bar1), 1, 1e-6), 'bar 1 is on a beat');
  assert.ok(near(lastGrid(d).bar1, g.bar1, 1e-4), 'the live grid has the same bar 1');
  assert.equal(d.state(clock.t).grid.bar1, g.bar1);
});

test('TAP after assist steps sets the tempo the DJ hears, rescaled for the live edge', async () => {
  const { d, clock } = await assistedDeck();
  // Tap 125 BPM on the heard audio: one tap every 0.48 s of input, played at 1.04×.
  const rate = d.ts.rateAt(clock.t);
  const t0 = clock.t + 0.1;
  for (let k = 0; k < 8; k++) await d.act('tap', { wallMs: (t0 + (k * 0.48) / rate) * 1000 });
  const tEnd = t0 + (7 * 0.48) / rate;
  clock.t = tEnd;
  const p = d.ts.posAt(tEnd), g = d.grids.at(p);
  assert.ok(near(g.T, 0.48, 1e-4), `grid at the playhead T=${g.T}`);
  assert.ok(Math.abs(gridErrMs(g, p, [p])) < 1, 'beat on the last tap');
  assert.ok(near(d.tempoInfo().native, 125, 0.05), `native ${d.tempoInfo().native}`);
  assert.equal(d.tempo.get().tapped, true);
  assert.ok(near(d.tempo.get().inBpm, 125 * 1.02, 0.05), `live input tempo ${d.tempo.get().inBpm}`);
  assert.ok(near(lastGrid(d).T, 0.48 / 1.02, 1e-4), `live grid T=${lastGrid(d).T}`);
});

test('changing the BPM range refolds the grid the DJ hears', async () => {
  const { d, p } = await assistedDeck();
  d.setRange(55, 115);
  assert.ok(near(d.tempoInfo().native, 60, 0.01), `native ${d.tempoInfo().native}`);
  assert.ok(near(bpmOf(d.grids.at(p)), 60, 0.01));
  assert.equal(d.tempo.get().tapped, true, 'tap kept');
});
