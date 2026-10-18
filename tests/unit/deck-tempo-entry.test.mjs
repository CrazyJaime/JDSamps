// Typed tempos. setBpm plays a deck at the tempo the DJ types, as heard at the playhead: a
// hand-moved tempo, like the fader. setNativeBpm tells the deck what the track's own tempo is
// (detection got it wrong): the grid takes that period around the beat the DJ hears, and holds
// against detection the way a TAP does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet } from './worklet-shim.mjs';
import { GridMap } from '../../engine/timeshift.js';
import { validateUiMessage, parseTypedBpm } from '../../shared/protocol.js';
import { makeEngine, makeDeck, run, playedBpm } from './fixtures/deck-harness.mjs';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

const reg = await loadWorklet('worklets/deck-input.js', { sampleRate: FS });
const Input = reg['jds-deck-input'];

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const nodeRate = (n, t) => { const s = n.segAt(t); return s.active ? s.rate : 0; };
/** Where input position x falls between two beats of grid g (0 = on a beat). */
const offBeat = (g, x) => { const b = (x - g.t0) / g.T; return Math.abs(b - Math.round(b)); };

/** One playing-ready deck on the harness's fake tracker (124 BPM, beat grid from 0 s). */
function setup(opts = {}) {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  const d = makeDeck(engine, clock, { liveEdge: 400, bpm: 124, ...opts });
  d.tempo.track = { n: 0 };
  d.setCue(2);
  return { clock, engine, d, go: (s) => run(engine, clock, s) };
}

/** Deck A (master, 128 BPM) and deck B (`bpmB`, TEMPO sync: no phase bends in the tempo it plays), both cued. */
function pair(bpmB = 124) {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  const a = makeDeck(engine, clock, { id: 1, slot: 1, liveEdge: 400, bpm: 128 });
  const b = makeDeck(engine, clock, { id: 2, slot: 2, liveEdge: 400, bpm: bpmB, syncMode: 'TEMPO' });
  for (const d of [a, b]) { d.tempo.track = { n: 0 }; d.setCue(2); }
  return { clock, engine, a, b, go: (s) => run(engine, clock, s) };
}

async function synced(bpmB) {
  const s = pair(bpmB);
  await s.a.act('master');
  await s.a.act('play');
  s.go(1);
  assert.deepEqual(await s.b.act('sync', { on: true }), { ok: true });
  await s.b.act('play');
  s.go(2);
  return s;
}

// ------------------------------------------------------------------ setBpm

test('setBpm plays the deck at the typed tempo, as heard at the playhead', async () => {
  const { d, clock, go } = setup();
  // The tab's player sped up at the live edge: the audio there runs at 124 × 1.04, the audio
  // under the playhead still at 124. The typed tempo is what the DJ hears.
  d.commitSourceRate(1.04, null, d.ts.liveEdge);
  await d.act('play');
  go(1);
  assert.deepEqual(await d.act('setBpm', { bpm: 128 }), { ok: true });
  go(0.5);
  assert.ok(near(playedBpm(d, clock.t), 128, 1e-6), `the node plays ${playedBpm(d, clock.t)} BPM, not 128`);
  assert.ok(near(d.tempoInfo().out, 128, 1e-9), `the deck reads ${d.tempoInfo().out}`);
  assert.ok(near(d.params.pitch, 128 / 124 - 1, 1e-12), `pitch ${d.params.pitch}`);
});

test('setBpm on a paused deck sets the tempo it starts at', async () => {
  const { d, clock, go } = setup();
  assert.deepEqual(await d.act('setBpm', { bpm: 120 }), { ok: true });
  await d.act('play');
  go(0.5);
  assert.ok(near(playedBpm(d, clock.t), 120, 1e-6), `the node plays ${playedBpm(d, clock.t)} BPM`);
});

test('setBpm widens the pitch range to the smallest that reaches the tempo, and says so once', async () => {
  const { d, clock, engine, go } = setup({ range: 0.06 });
  await d.act('play');
  go(1);
  let before = engine.events.length;
  assert.deepEqual(await d.act('setBpm', { bpm: 126 }), { ok: true }); // +1.6%: ±6 holds it
  assert.equal(d.params.range, 0.06, 'a range that holds the tempo is left alone');
  assert.deepEqual(engine.events.slice(before), []);
  before = engine.events.length;
  assert.deepEqual(await d.act('setBpm', { bpm: 140 }), { ok: true }); // +12.9%: needs ±16
  go(0.5);
  assert.equal(d.params.range, 0.16);
  assert.ok(near(playedBpm(d, clock.t), 140, 1e-6), `the node plays ${playedBpm(d, clock.t)} BPM`);
  assert.deepEqual(engine.events.slice(before).map((e) => [e.level, e.text, e.id]),
    [['info', 'Deck 2: range widened to ±16 to reach 140.0.', 2]]);
});

test('setBpm beyond the widest range is refused with a reason, and nothing moves', async () => {
  const { d, clock, go } = setup();
  await d.act('play');
  go(1);
  const r = await d.act('setBpm', { bpm: 200 }); // +61%
  assert.equal(r.ok, false);
  assert.match(r.error, /200\.0/);
  assert.match(r.error, /widest/);
  go(0.3);
  assert.equal(d.params.range, 0.1);
  assert.equal(d.params.pitch, 0);
  assert.equal(nodeRate(d.node, clock.t), 1);
  // A tempo an octave away is most likely the track read at the wrong octave: say how to fix that.
  const r2 = await d.act('setBpm', { bpm: 250 });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /2×|ORIG/);
});

test('setBpm with no BPM yet says so, as SYNC does', async () => {
  const { d } = setup();
  d.tempo = null;
  d.grids = new GridMap();
  const r = await d.act('setBpm', { bpm: 128 });
  assert.equal(r.ok, false);
  assert.match(r.error, /^No BPM yet/);
});

test('a typed tempo is a hand-moved tempo: SYNC goes off, as with the fader', async () => {
  const { b, clock, engine, go } = await synced(124);
  assert.ok(near(playedBpm(b, clock.t), 128, 1e-3), `premise: B follows the 128 BPM master (${playedBpm(b, clock.t)})`);
  const before = engine.events.length;
  assert.deepEqual(await b.act('setBpm', { bpm: 126 }), { ok: true });
  go(2);
  assert.equal(b.syncOn, false, 'SYNC is off');
  assert.ok(near(playedBpm(b, clock.t), 126, 1e-6), `B plays ${playedBpm(b, clock.t)} BPM, not the typed 126`);
  assert.deepEqual(engine.events.slice(before).map((e) => e.text), ['Deck 2: sync off (tempo moved by hand).']);
});

test("a master's typed tempo carries its synced decks, on the octave they already use", async () => {
  // B is a 64 BPM track synced at half time to the 128 BPM master.
  const { a, b, clock, go } = await synced(64);
  assert.equal(b.syncMult, 0.5, 'premise: B follows at half time');
  assert.deepEqual(await a.act('setBpm', { bpm: 132 }), { ok: true });
  go(2);
  assert.ok(near(playedBpm(a, clock.t), 132, 1e-6), `the master plays ${playedBpm(a, clock.t)} BPM`);
  assert.equal(b.syncOn, true, 'the synced deck stays synced');
  assert.equal(b.syncMult, 0.5, 'and on its octave');
  assert.ok(near(playedBpm(b, clock.t), 66, 1e-3), `B plays ${playedBpm(b, clock.t)} BPM, not 66 (132 at half time)`);
});

// ------------------------------------------------------------------ setNativeBpm

/** A deck with the real tempo tracker, before any audio. */
function realDeck(opts = {}) {
  const clock = { t: 0 };
  const engine = makeEngine(clock);
  const d = makeDeck(engine, clock, { liveEdge: 0, ...opts });
  d.tempo = null;
  d.grids = new GridMap();
  return { d, clock, engine };
}

/** Feed x into a real deck through the real input worklet; onBlock(s, d) runs every 2048 samples (true stops). */
async function feed(d, clock, x, onBlock) {
  const proc = new Input(), out = [[new Float32Array(128)]];
  for (let s = 0; s + 128 <= x.length; s += 128) {
    const blk = x.subarray(s, s + 128);
    proc.process([[blk, blk]], out, {});
    clock.t += 128 / FS;
    for (const { msg } of proc.port.posted.splice(0)) d.onInput(msg);
    if (s % 2048) continue;
    d.tick(clock.t);
    if (onBlock && (await onBlock(s, d))) return;
  }
}

test('setNativeBpm rescales the grid period around the beat the DJ hears, and detection does not undo it', async () => {
  // Steady 124 BPM house, played 12 s behind the live edge. The DJ says it is 126.
  const { x } = synth({ ...PATTERNS.house, bars: 40, tail: 0 });
  const { d, clock } = realDeck();
  let typed = null, after = null;
  await feed(d, clock, x, async () => {
    if (!d.wantPlay && d.ts.liveEdge >= 12) { await d.act('play'); return false; }
    if (!d.wantPlay || d.ts.liveEdge < 30) return false;
    if (!typed) {
      const p = d.heardPos(), g = d.grids.at(p);
      assert.ok(g && near(60 / g.T, 124, 0.5), `premise: detection reads ${g && (60 / g.T).toFixed(2)} BPM`);
      const beat = g.t0 + Math.round((p - g.t0) / g.T) * g.T;
      const pitch = d.params.pitch;
      assert.deepEqual(await d.act('setNativeBpm', { bpm: 126 }), { ok: true });
      typed = { p, beat, edge: d.ts.liveEdge };
      const h = d.grids.at(p);
      assert.ok(near(h.T, 60 / 126, 1e-9), `grid period ${h.T}, not 60/126`);
      assert.ok(offBeat(h, beat) < 1e-6, `the beat nearest the playhead moved by ${offBeat(h, beat)} beats`);
      assert.ok(near(d.tempoInfo().native, 126, 1e-6), `native ${d.tempoInfo().native}`);
      assert.equal(d.params.pitch, pitch, 'the pitch stays as it was');
      return false;
    }
    if (d.ts.liveEdge < typed.edge + 20) return false;
    after = { live: d.grids.segs[d.grids.segs.length - 1].grid, st: d.state(clock.t) };
    return true;
  });
  assert.ok(after, 'fed 20 s of detection after the typed tempo');
  const g = d.grids.at(typed.p);
  assert.ok(near(g.T, 60 / 126, 1e-9), `20 s later the grid the DJ set has period ${g.T}`);
  assert.ok(offBeat(g, typed.beat) < 1e-6, `20 s later the anchor beat is ${offBeat(g, typed.beat)} beats off`);
  assert.ok(near(after.live.T, 60 / 126, 1e-9), `the live grid ${60 / after.live.T} BPM`);
  assert.ok(offBeat(after.live, typed.beat) < 1e-6, 'the live grid keeps the same beats');
  assert.ok(near(after.st.bpm.native, 126, 1e-6), `snapshot native ${after.st.bpm.native}`);
  assert.equal(after.st.bpm.manual, 'typed');
  assert.equal(after.st.bpm.tapped, true, 'a manual tempo, like TAP');
});

test('setNativeBpm on a cued, paused deck: the grid keeps its beat nearest the cue', async () => {
  const { d, clock } = realDeck();
  await feed(d, clock, synth({ ...PATTERNS.house, bars: 14, tail: 0 }).x);
  assert.equal(d.ts.playingAt(clock.t), false, 'premise: the deck is still cued');
  const p = d.heardPos(), g = d.grids.at(p);
  assert.ok(g, 'premise: the deck has a grid');
  const beat = g.t0 + Math.round((p - g.t0) / g.T) * g.T;
  assert.deepEqual(await d.act('setNativeBpm', { bpm: 125 }), { ok: true });
  const h = d.grids.at(p);
  assert.ok(near(h.T, 60 / 125, 1e-9), `grid period ${h.T}`);
  assert.ok(offBeat(h, beat) < 1e-6, 'anchor beat kept');
  assert.equal(d.canBeat(), true);
  assert.ok(near(d.tempoInfo().native, 125, 1e-6));
});

test('setNativeBpm on a deck with no grid yet anchors the grid at the cue point', async () => {
  const { d, clock } = realDeck();
  d.onInput({ t: 'init', fps: FS / 512 });
  d.ts.liveEdge = 20;
  d.setCue(5.3);
  clock.t += 0.5;
  assert.equal(d.tempoInfo().native, null, 'premise: no BPM yet');
  assert.deepEqual(await d.act('setNativeBpm', { bpm: 124 }), { ok: true });
  const g = d.grids.at(d.heardPos());
  assert.ok(g, 'a grid now');
  assert.ok(near(g.T, 60 / 124, 1e-9), `grid period ${g.T}`);
  assert.ok(offBeat(g, d.cue) < 1e-6, `the cue ${d.cue} is ${offBeat(g, d.cue)} beats off the grid`);
  assert.ok(near(d.tempoInfo().native, 124, 1e-6));
  assert.equal(d.canBeat(), true, 'the DJ can beat-match on it');
});

test('setNativeBpm refuses a tempo outside the BPM range, naming the range', async () => {
  const { d, engine } = realDeck();
  d.onInput({ t: 'init', fps: FS / 512 });
  d.ts.liveEdge = 20;
  d.setCue(5);
  const r = await d.act('setNativeBpm', { bpm: 64 });
  assert.equal(r.ok, false);
  assert.match(r.error, /70–180/);
  assert.match(r.error, /Type 128\.0/, 'and offers the same beat inside the range');
  assert.equal(d.tempoInfo().native, null, 'nothing was set');
  engine.params['bpm.range'] = '98-195';
  const r2 = await d.act('setNativeBpm', { bpm: 195.5 }); // its half, 97.75, is outside the range too
  assert.equal(r2.ok, false);
  assert.doesNotMatch(r2.error, /Type/);
  assert.match(r2.error, /98–195/);
  engine.params['bpm.range'] = '55-115';
  assert.deepEqual(await d.act('setNativeBpm', { bpm: 64 }), { ok: true });
  assert.ok(near(d.tempoInfo().native, 64, 1e-6));
  d.tempo = null;
  assert.deepEqual(await d.act('setNativeBpm', { bpm: 64 }), { ok: false, error: 'Waiting for audio.' });
});

test('½×, 2× and TAP still work after a typed tempo', async () => {
  const { d, clock } = realDeck();
  d.onInput({ t: 'init', fps: FS / 512 });
  d.ts.liveEdge = 40;
  d.setCue(10);
  await d.act('play');
  clock.t += 0.5;
  assert.deepEqual(await d.act('setNativeBpm', { bpm: 124 }), { ok: true });
  assert.ok(near(d.tempoInfo().native, 124, 1e-6));
  assert.deepEqual(await d.act('mult', { factor: 2 }), { ok: true });
  assert.ok(near(d.tempoInfo().native, 248, 1e-6), `2× reads ${d.tempoInfo().native}`);
  assert.deepEqual(await d.act('mult', { factor: 0.5 }), { ok: true });
  assert.ok(near(d.tempoInfo().native, 124, 1e-6), `½× reads ${d.tempoInfo().native}`);
  assert.equal(d.state(clock.t).bpm.manual, 'typed', 'still the typed tempo');
  // Tap 125 BPM on the heard audio: one tap every 0.48 s of input.
  const rate = d.ts.rateAt(clock.t), t0 = clock.t + 0.1;
  for (let k = 0; k < 8; k++) await d.act('tap', { wallMs: (t0 + (k * 0.48) / rate) * 1000 });
  clock.t = t0 + (7 * 0.48) / rate;
  assert.ok(near(d.tempoInfo().native, 125, 0.05), `after TAP: ${d.tempoInfo().native}`);
  assert.equal(d.state(clock.t).bpm.manual, 'tap');
});

test('a synced deck whose tempo is corrected re-chooses its half/double against the master', async () => {
  // B was read at 62 BPM and follows the 128 master at half time; the DJ says it is 124.
  const s = pair(62);
  const b = s.b;
  b.tempo.applyTap = function ({ t0, T }) { this.bpm = (60 * FS) / T; this.grid = { t0: t0 / FS, T: T / FS, bar1: null }; };
  await s.a.act('master');
  await s.a.act('play');
  s.go(1);
  await b.act('sync', { on: true });
  await b.act('play');
  s.go(2);
  assert.equal(b.syncMult, 0.5, 'premise: half time');
  assert.deepEqual(await b.act('setNativeBpm', { bpm: 124 }), { ok: true });
  s.go(2);
  assert.equal(b.syncOn, true, 'a correction is not a hand-moved tempo: SYNC stays on');
  assert.equal(b.syncMult, 1, 'the octave is chosen again');
  assert.equal(b.outOfRange, false, 'and the deck is not left pinned at the end of its range');
  assert.ok(near(playedBpm(b, s.clock.t), 128, 1e-3), `B plays ${playedBpm(b, s.clock.t)} BPM`);
});

test('a synced deck doubled with 2× re-chooses its half/double against the master', async () => {
  // Same correction as above, made with 2× instead of a typed tempo.
  const s = pair(62);
  const b = s.b;
  b.tempo.multiply = function (f) { this.bpm *= f; this.grid = { ...this.grid, T: this.grid.T / f }; return true; };
  await s.a.act('master');
  await s.a.act('play');
  s.go(1);
  await b.act('sync', { on: true });
  await b.act('play');
  s.go(2);
  assert.equal(b.syncMult, 0.5, 'premise: half time');
  assert.deepEqual(await b.act('mult', { factor: 2 }), { ok: true });
  s.go(2);
  assert.equal(b.syncMult, 1, 'the octave is chosen again');
  assert.equal(b.outOfRange, false, 'and the deck is not left pinned at the end of its range');
  assert.ok(near(playedBpm(b, s.clock.t), 128, 1e-3), `B plays ${playedBpm(b, s.clock.t)} BPM`);
});

// ------------------------------------------------------------------ protocol

test('setBpm / setNativeBpm arguments are validated', () => {
  for (const a of ['setBpm', 'setNativeBpm']) {
    assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a, arg: { bpm: 128.5 } }), { ok: true, arg: { bpm: 128.5 } });
    for (const bpm of [NaN, Infinity, '128', null, undefined, 19.9, 400.1, -128]) {
      assert.equal(validateUiMessage({ t: 'act', deck: 1, a, arg: { bpm } }).ok, false, `${a} ${String(bpm)}`);
    }
    assert.equal(validateUiMessage({ t: 'act', deck: null, a, arg: { bpm: 128 } }).ok, false, 'deck actions only');
  }
});

test('typed tempos take a dot or a comma, and junk gets a short reason', () => {
  for (const [s, bpm] of [['128', 128], ['128.0', 128], ['128,5', 128.5], [' 97.25 ', 97.25], ['128.', 128], ['85,', 85]]) {
    assert.deepEqual(parseTypedBpm(s), { ok: true, bpm }, JSON.stringify(s));
  }
  for (const s of ['', '  ', 'abc', '12a', '1.2.3', '128,5.1', '-128', '+128', '1e3', '0x80', '12 8', '.', ',5']) {
    const r = parseTypedBpm(s);
    assert.equal(r.ok, false, JSON.stringify(s));
    assert.ok(r.error && r.error.length <= 60, `short reason for ${JSON.stringify(s)}: ${r.error}`);
  }
  for (const s of ['5', '19.9', '400.5', '999']) {
    const r = parseTypedBpm(s);
    assert.equal(r.ok, false, s);
    assert.match(r.error, /20.+400/);
  }
});
