import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeParts, decodePlaced, gapsFor, AssemblyError } from '../../engine/assemble.js';
import { webmItems } from '../../engine/bmff.js';
import { initSeg, fragSeg, adtsFrame, cat } from './fixtures/bmff-build.mjs';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/fmp4');
const read = (f) => { const b = fs.readFileSync(path.join(FIX, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const MP4 = 'audio/mp4; codecs="opus"';
const END = (28 * 48000 + 100 * 960 + 312) / 48000;                      // media end of the fixture: 30 s + the pre-skip

/** Parts as the tap reports them: init then segments `ks` (1-based) of one rendition, appended in that order. */
function load(rep, ks = [1, 2, 3, 4, 5, 6, 7, 8], { sb = 0, seq = 0 } = {}) {
  const parts = [{ bytes: read(`${rep}/init.mp4`), mime: MP4, kind: 'init', sb, seq: seq++ }];
  for (const k of ks) parts.push({ bytes: read(`${rep}/seg-${String(k).padStart(5, '0')}.m4s`), mime: MP4, kind: 'media', sb, seq: seq++ });
  return parts;
}
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const shuffle = (a, seed = 7) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { seed = (seed * 1103515245 + 12345) % 2 ** 31; const j = seed % (i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const spans = (list) => list.map(([a, b]) => [+a.toFixed(4), +b.toFixed(4)]);
const fragOf = (buf) => { const u = new Uint8Array(buf); for (let i = 0; i + 8 <= u.length; i++) if (String.fromCharCode(...u.subarray(i + 4, i + 8)) === 'moof') return u.subarray(i); return u; }; // moof + mdat
const rejects = async (p, check) => { try { await p; } catch (e) { check(e); return; } assert.fail('expected a rejection'); };

test('tfdt and timescale place every segment at its true media time', () => {
  const placed = placeParts(load('lo'));
  assert.equal(placed.runs.length, 1);
  const segs = placed.runs[0].segs;
  assert.equal(segs.length, 8);
  segs.forEach((s, k) => assert.equal(s.t0, 4 * k));
  assert.ok(near(segs.at(-1).t1, END));
  assert.deepEqual(placed.coverage.length, 1);
  assert.deepEqual(placed.gaps, []);
  assert.ok(placed.runs[0].init.byteLength > 0);
  assert.equal(placed.runs[0].mime, MP4);
});

test('out-of-order parts are placed in order', () => {
  const parts = load('lo', shuffle([1, 2, 3, 4, 5, 6, 7, 8]));            // appended out of timeline order
  const placed = placeParts(shuffle(parts, 3));                            // and reported in any order
  assert.equal(placed.runs.length, 1);
  assert.deepEqual(placed.runs[0].segs.map((s) => s.t0), [0, 4, 8, 12, 16, 20, 24, 28]);
  assert.deepEqual(spans(placed.coverage), [[0, +END.toFixed(4)]]);
  assert.deepEqual(placed.gaps, []);
});

test('a missing segment is reported as a gap, never closed up', () => {
  const placed = placeParts(load('lo', [1, 2, 3, 5, 6, 7, 8]));
  assert.deepEqual(placed.gaps, [[12, 16]]);
  assert.deepEqual(spans(placed.coverage), [[0, 12], [16, +END.toFixed(4)]]);
});

test('duplicates are dropped', () => {
  const placed = placeParts(load('lo', [1, 2, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(placed.runs.length, 1);
  assert.deepEqual(placed.runs[0].segs.map((s) => s.t0), [0, 4, 8, 12, 16, 20, 24, 28]);
});

test('the same rendition re-initialised after a seek, or captured in two frames, is still one run', () => {
  const placed = placeParts([...load('lo', [5, 6, 7, 8], { seq: 0 }), ...load('lo', [1, 2, 3, 4], { seq: 10 }), ...load('lo', [3, 4], { sb: 1 })]);
  assert.equal(placed.runs.length, 1);
  assert.equal(placed.runs[0].segs.length, 8);
});

test('an ABR switch mid-capture: each span taken once, from the higher bitrate where both exist', () => {
  const placed = placeParts([...load('lo', [1, 2, 3, 4]), ...load('hi', [4, 5, 6, 7, 8], { seq: 5 })]);
  assert.deepEqual(placed.runs.map((r) => r.segs.map((s) => s.t0)), [[0, 4, 8], [12, 16, 20, 24, 28]]);
  assert.deepEqual(spans(placed.coverage), [[0, +END.toFixed(4)]]);
  assert.deepEqual(placed.gaps, []);
  const lo3 = new Uint8Array(read('lo/seg-00003.m4s'));
  const pre = placed.runs[1].preroll.segs;
  assert.equal(pre.length, 1, 'one 4 s segment warms the decoder');
  assert.deepEqual(fragOf(pre[0].bytes), fragOf(lo3), 'the switch is warmed with the packets a player would have decoded before it');
});

test('a switch down keeps the higher bitrate up to the shared boundary', () => {
  const placed = placeParts([...load('hi', [1, 2, 3, 4], { sb: 0 }), ...load('lo', [4, 5, 6, 7, 8], { sb: 1 })]);
  assert.deepEqual(placed.runs.map((r) => r.segs.map((s) => s.t0)), [[0, 4, 8, 12], [16, 20, 24, 28]]);
  assert.deepEqual(placed.runs[1].preroll.segs.map((s) => s.t0), [12]);
  assert.deepEqual(fragOf(placed.runs[1].preroll.segs[0].bytes), fragOf(read('hi/seg-00004.m4s')));
});

test('renditions whose segment boundaries never line up are not spliced: the span is a gap', () => {
  const sec = (n) => Array(n).fill(960);                                    // n frames of 20 ms
  const a = initSeg({ trexDuration: 960 }), b = initSeg({ trexDuration: 961 });       // same codec, different renditions
  const parts = [
    { bytes: ab(a), mime: MP4, kind: 'init', sb: 0, seq: 0 },
    ...[0, 1, 2].map((s, i) => ({ bytes: ab(fragSeg({ t: s * 48000, durs: sec(50), size: 4 })), mime: MP4, kind: 'media', sb: 0, seq: 1 + i })),
    { bytes: ab(b), mime: MP4, kind: 'init', sb: 1, seq: 0 },
    ...[[0.5, 50], [1.5, 50], [2.5, 75]].map(([s, n], i) => ({ bytes: ab(fragSeg({ t: s * 48000, durs: sec(n), size: 40 })), mime: MP4, kind: 'media', sb: 1, seq: 1 + i })),
  ];
  const placed = placeParts(parts);
  assert.deepEqual(placed.runs.map((r) => r.segs.map((s) => s.t0)), [[0, 1, 2]]);
  assert.deepEqual(placed.gaps, [[3, 4]]);
});

test('a higher bitrate whose boundaries are a few samples off is not switched to: the join could not be warmed', () => {
  const sec = Array(50).fill(960);
  const a = initSeg({ trexDuration: 960 }), b = initSeg({ trexDuration: 961 });
  const parts = [
    { bytes: ab(a), mime: MP4, kind: 'init', sb: 0, seq: 0 },
    ...[0, 1, 2].map((s, i) => ({ bytes: ab(fragSeg({ t: s * 48000, durs: sec, size: 4 })), mime: MP4, kind: 'media', sb: 0, seq: 1 + i })),
    { bytes: ab(b), mime: MP4, kind: 'init', sb: 1, seq: 0 },
    { bytes: ab(fragSeg({ t: 2 * 48000 + 5, durs: sec, size: 40 })), mime: MP4, kind: 'media', sb: 1, seq: 1 },
  ];
  const placed = placeParts(parts);
  assert.deepEqual(placed.runs.map((r) => [r.segs.length, r.cold]), [[3, false]]);
  assert.deepEqual(placed.gaps, []);
  parts.push({ bytes: ab(fragSeg({ t: 48000 + 5, durs: sec, size: 40 })), mime: MP4, kind: 'media', sb: 1, seq: 2 });
  const warm = placeParts(parts);                                           // now it has its own segment to warm up on
  assert.deepEqual(warm.runs.map((r) => [r.segs[0].t0, r.preroll?.segs.map((x) => x.t0) ?? null]), [[0, null], [2 + 5 / 48000, [1 + 5 / 48000]]]);
});

test('contiguity tolerance is one codec frame (960 samples of Opus)', () => {
  const init = ab(initSeg());
  const mk = (holeSec) => placeParts([
    { bytes: init, mime: MP4, kind: 'init', sb: 0, seq: 0 },
    { bytes: ab(fragSeg({ t: 0, durs: Array(50).fill(960) })), mime: MP4, kind: 'media', sb: 0, seq: 1 },
    { bytes: ab(fragSeg({ t: Math.round((1 + holeSec) * 48000), durs: Array(50).fill(960) })), mime: MP4, kind: 'media', sb: 0, seq: 2 },
  ]);
  const ok = mk(0.015);
  assert.equal(ok.tolSamples, 960);
  assert.ok(near(ok.tol, 0.02));
  assert.deepEqual(ok.gaps, []);
  assert.deepEqual(mk(0.025).gaps, [[1, 1.025]]);
});

test('media with no init before it cannot be placed and is counted, not guessed', () => {
  const parts = load('lo').slice(1);
  const placed = placeParts(parts);
  assert.deepEqual(placed.runs, []);
  assert.deepEqual(placed.coverage, []);
  assert.ok(placed.skipped >= 1);
});

test('an unknown duration is never declared complete', async () => {
  const placed = placeParts(load('lo'));
  for (const duration of [null, undefined, NaN, Infinity, 0, -1]) {
    await rejects(decodePlaced(null, placed, { duration }), (e) => {
      assert.ok(e instanceof AssemblyError, String(e));
      assert.equal(e.reason, 'duration');
      assert.ok(Array.isArray(e.gaps));
    });
  }
});

test('a duration that grows after placement is re-checked, not trusted', async () => {
  const placed = placeParts(load('lo', [1, 2, 3, 4, 5]));
  assert.deepEqual(gapsFor(placed, 20), []);
  assert.deepEqual(gapsFor(placed, 30), [[20, 30]]);
  await rejects(decodePlaced(null, placed, { duration: 30 }), (e) => {
    assert.ok(e instanceof AssemblyError);
    assert.equal(e.reason, 'gaps');
    assert.deepEqual(e.gaps, [[20, 30]]);
    assert.match(e.message, /20\.0.*30\.0/);
  });
});

test('a first piece starting a little after 0 is covered or missing by one rule: gapsFor and decodePlaced agree across the frame tolerance', async () => {
  // A stand-in decoder: each run's bytes carry the length it decodes to; one run decodes at the context rate.
  const SR = 48000, tol = 0.0213, end = 30;
  const ctx = { sampleRate: SR, async decodeAudioData(buf) {
    const n = Number(new TextDecoder().decode(new Uint8Array(buf))), ch = new Float32Array(n).fill(0.25);
    return { length: n, numberOfChannels: 2, sampleRate: SR, getChannelData: () => ch };
  } };
  for (const t0 of [0, 0.005, tol, tol + 0.0005, 0.05]) {
    const bytes = new TextEncoder().encode(String(Math.round((end - t0) * SR))).buffer;
    const placed = { runs: [{ mime: MP4, init: null, segs: [{ t0, t1: end, bytes }], delay: 0, rate: SR, key: 'k', preroll: null, cold: false }],
      coverage: [[t0, end]], gaps: [], tol, tolSamples: Math.round(tol * SR), skipped: 0 };
    const gaps = gapsFor(placed, end);
    let out = null, err = null;
    try { out = await decodePlaced(ctx, placed, { duration: end }); } catch (e) { err = e; }
    if (!gaps.length) {
      assert.equal(err, null, `${t0} s: gapsFor finds it whole, so decodePlaced must take it (${err && err.message})`);
      const lead = Math.round(t0 * SR);
      assert.equal(out.L.length, end * SR, `${t0} s`);
      assert.ok(out.L.subarray(0, lead).every((x) => x === 0) && out.L[lead] === 0.25, `${t0} s: silence before the first piece, then the piece at its own time`);
    } else {
      assert.ok(t0 > tol, `${t0} s: a gap only past the tolerance`);
      assert.ok(err instanceof AssemblyError && err.reason === 'gaps', `${t0} s: refused as missing audio, ${err && err.message}`);
      assert.deepEqual(spans(err.gaps), spans([[0, t0]]));
    }
  }
});

test('captured audio running well past the reported duration is refused', async () => {
  const placed = placeParts(load('lo'));
  await rejects(decodePlaced(null, placed, { duration: 20 }), (e) => { assert.equal(e.reason, 'duration'); });
});

test('a gap inside the track is refused before anything is decoded', async () => {
  const placed = placeParts(load('lo', [1, 2, 3, 5, 6, 7, 8]));
  await rejects(decodePlaced(null, placed, { duration: 30 }), (e) => { assert.deepEqual(e.gaps, [[12, 16]]); });
});

test('WebM clusters are placed by their timecodes, whatever order they arrive in', () => {
  const file = new Uint8Array(read('track.webm'));
  const items = webmItems(file);
  const init = items.find((i) => i.kind === 'init'), clusters = items.filter((i) => i.kind === 'media');
  const W = 'audio/webm; codecs="opus"';
  const parts = [{ bytes: ab(file.slice(init.start, init.end)), mime: W, kind: 'init', sb: 0, seq: 0 },
    ...shuffle(clusters).map((c, i) => ({ bytes: ab(file.slice(c.start, c.end)), mime: W, kind: 'media', sb: 0, seq: 1 + i }))];
  const placed = placeParts(parts);
  assert.equal(placed.runs.length, 1);
  assert.deepEqual(placed.runs[0].segs.map((s) => s.t0), clusters.map((c) => c.t0));
  assert.deepEqual(placed.gaps, []);
  assert.ok(near(placed.coverage[0][1], 480312 / 48000));
  assert.ok(near(placed.runs[0].delay, 0.0065));
});

test('MP3 appends are placed back to back by their frames, split anywhere', () => {
  const file = new Uint8Array(read('track.mp3'));
  const cuts = [0, 1000, 9999, 20001, 33333, file.length];
  const parts = cuts.slice(1).map((e, i) => ({ bytes: ab(file.slice(cuts[i], e)), mime: 'audio/mpeg', kind: 'media', sb: 2, seq: i }));
  const placed = placeParts(parts);
  assert.equal(placed.runs.length, 1);
  assert.equal(placed.runs[0].init, null);
  assert.deepEqual(spans(placed.coverage), [[0, 10]]);
});

test('ADTS appends are placed by their header walk', () => {
  const parts = [0, 1, 2].map((i) => ({ bytes: ab(cat(adtsFrame({ sf: 3 }), adtsFrame({ sf: 3 }))), mime: 'audio/aac', kind: 'media', sb: 0, seq: i }));
  const placed = placeParts(parts);
  assert.deepEqual(spans(placed.coverage), [[0, +(6 * 1024 / 48000).toFixed(4)]]);
});

test('a whole file is one run from zero to its length', () => {
  const mp3 = placeParts([{ bytes: read('track.mp3'), mime: 'audio/mpeg', kind: 'file' }]);
  assert.deepEqual(spans(mp3.coverage), [[0, 10]]);
  assert.equal(mp3.runs[0].segs.length, 1);
  const mp4 = placeParts([{ bytes: read('whole-lo.mp4'), mime: 'audio/mp4', kind: 'file' }]);
  assert.deepEqual(spans(mp4.coverage), [[0, +END.toFixed(4)]]);
  assert.equal(mp4.runs[0].init, null);
  assert.ok(near(mp4.runs[0].delay, 312 / 48000), 'the edit list delay of a whole file');
  const junk = placeParts([{ bytes: new ArrayBuffer(64), mime: 'audio/ogg', kind: 'file' }]);
  assert.deepEqual(junk.runs, []);
  assert.equal(junk.skipped, 1);
});

test('AssemblyError is an Error that carries the missing spans', () => {
  const e = new AssemblyError('Audio is missing.', { gaps: [[1, 2]] });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'AssemblyError');
  assert.deepEqual(e.gaps, [[1, 2]]);
  assert.equal(e.reason, 'gaps');
});
