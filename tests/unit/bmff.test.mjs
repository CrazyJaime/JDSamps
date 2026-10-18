import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxes, tfdt, timescale, readInit, mp4Items, webmItems, mp3Frames, adtsFrames } from '../../engine/bmff.js';
import { box, full, cat, u32, u64, initSeg, fragSeg, webmInit, webmCluster, mp3Frame, adtsFrame } from './fixtures/bmff-build.mjs';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/fmp4');
const read = (f) => { const b = fs.readFileSync(path.join(FIX, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const seg = (rep, k) => read(`${rep}/seg-${String(k).padStart(5, '0')}.m4s`);

test('boxes walks the top level of an init segment, sizes adding up to the file', () => {
  const init = read('lo/init.mp4');
  const list = [...boxes(init)];
  assert.deepEqual(list.map((b) => b.type), ['ftyp', 'moov']);
  assert.equal(list[0].start, 0);
  assert.equal(list.at(-1).end, init.byteLength);
  assert.equal(list.reduce((n, b) => n + b.size, 0), init.byteLength);
});

test('boxes reads a 64-bit largesize box and a size-0 box that runs to the end', () => {
  const big = cat(u32(1), [...'free'].map((c) => c.charCodeAt(0)), u64(20), new Uint8Array(4));
  const tail = cat(u32(0), [...'mdat'].map((c) => c.charCodeAt(0)), new Uint8Array(10));
  const buf = cat(big, tail);
  const list = [...boxes(buf)];
  assert.deepEqual(list.map((b) => [b.type, b.start, b.end]), [['free', 0, 20], ['mdat', 20, 38]]);
});

test('boxes stops at a truncated box instead of reading past the buffer', () => {
  const buf = cat(box('free', new Uint8Array(4)), u32(100), [...'mdat'].map((c) => c.charCodeAt(0)), new Uint8Array(10));
  assert.deepEqual([...boxes(buf)].map((b) => b.type), ['free']);
});

test('tfdt reads version 0 and version 1, including a 64-bit time past 2^32', () => {
  assert.equal(tfdt(fragSeg({ t: 123456, durs: [960], version: 0 })), 123456);
  const big = 2 ** 33 + 960 * 7;
  assert.equal(tfdt(fragSeg({ t: big, durs: [960], version: 1 })), big);
  assert.equal(tfdt(fragSeg({ t: 5, durs: [960], styp: true })), 5, 'a styp ahead of the moof is skipped');
});

test('tfdt and timescale read the ffmpeg fixture: 48 kHz, segment k at 4k s', () => {
  assert.equal(timescale(read('lo/init.mp4')), 48000);
  assert.equal(timescale(read('hi/init.mp4')), 48000);
  for (let k = 1; k <= 8; k++) assert.equal(tfdt(seg('lo', k)), (k - 1) * 4 * 48000);
});

test('timescale reads a version 1 mdhd', () => {
  assert.equal(timescale(initSeg({ timescale: 44100, mdhdVersion: 1 })), 44100);
});

test('readInit gives the track, decode rate, channels, codec delay (in media ticks) and a codec key', () => {
  const a = readInit(read('lo/init.mp4'));
  assert.equal(a.trackId, 1); assert.equal(a.timescale, 48000); assert.equal(a.rate, 48000); assert.equal(a.channels, 2);
  assert.equal(a.delay, 312, 'the edit list starts after the Opus pre-skip');
  assert.equal(a.codec, 'Opus');
  assert.equal(readInit(read('hi/init.mp4')).key, a.key, 'two bitrates of one stream share a codec key');
  assert.notEqual(readInit(initSeg({ channels: 1 })).key, readInit(initSeg({ channels: 2 })).key);
  assert.equal(readInit(box('free')), null);
  const video = initSeg(); video.set([...'vide'].map((c) => c.charCodeAt(0)), findSoun(video));
  assert.equal(readInit(video), null, 'a SourceBuffer with no audio track is not audio');
});
function findSoun(u) { for (let i = 0; i + 4 <= u.length; i++) if (String.fromCharCode(...u.subarray(i, i + 4)) === 'soun') return i; return -1; }

test('mp4Items splits a stream into inits and complete fragments with their media times', () => {
  const init = initSeg();
  const stream = cat(init, fragSeg({ t: 0, durs: Array(50).fill(960) }), fragSeg({ t: 48000, durs: [960, 960, 480], styp: true }));
  const items = mp4Items(stream);
  assert.deepEqual(items.map((i) => i.kind), ['init', 'media', 'media']);
  assert.equal(items[0].end, init.length);
  assert.deepEqual(items.slice(1).map((i) => [i.t0, i.t1, i.frame]), [[0, 1, 0.02], [1, 1.05, 0.02]]);
});

test('mp4Items reads the fixture fragments: contiguous 4 s segments, the last one 2 s plus the pre-skip', () => {
  const items = mp4Items(cat(new Uint8Array(read('lo/init.mp4')), ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => new Uint8Array(seg('lo', k)))));
  const media = items.filter((i) => i.kind === 'media');
  assert.equal(media.length, 8);
  for (let k = 0; k < 8; k++) assert.equal(media[k].t0, 4 * k);
  for (let k = 0; k < 7; k++) assert.equal(media[k].t1, media[k + 1].t0);
  assert.equal(media[7].t1, (28 * 48000 + 100 * 960 + 312) / 48000);
});

test('mp4Items drops a fragment whose samples do not fit its mdat, and media with no init before it', () => {
  const good = fragSeg({ t: 0, durs: [960, 960], size: 4 });             // mdat: 8 header + 8 payload
  const bad = cat(good.slice(0, good.length - 16), box('mdat', new Uint8Array(4)));
  assert.deepEqual(mp4Items(cat(initSeg(), bad)).map((i) => i.kind), ['init']);
  assert.deepEqual(mp4Items(good).map((i) => i.kind), [], 'no timescale without an init');
});

test('a new init that never completes does not lend the old one to the media after it', () => {
  const ftyp = initSeg().subarray(0, 28);                                   // ftyp alone: its moov was never appended
  const mp4 = mp4Items(cat(initSeg(), fragSeg({ t: 0, durs: [960] }), ftyp, fragSeg({ t: 960, durs: [960] })));
  assert.deepEqual(mp4.map((i) => i.kind), ['init', 'media']);
  const ebml = webmInit().subarray(0, 26);                                  // the EBML header element alone
  const webm = webmItems(cat(webmInit(), webmCluster({ tc: 0, rel: [0] }), ebml, webmCluster({ tc: 20, rel: [0] })));
  assert.deepEqual(webm.map((i) => i.kind), ['init', 'media']);
});

test('mp4Items resyncs at the next part boundary after junk', () => {
  const init = initSeg(), a = fragSeg({ t: 0, durs: [960] }), b = fragSeg({ t: 960, durs: [960] });
  const junk = new Uint8Array(13).fill(0xAB);
  const stream = cat(init, junk, a, b);
  const items = mp4Items(stream, { resync: [init.length + junk.length] });
  assert.deepEqual(items.filter((i) => i.kind === 'media').map((i) => i.t0), [0, 0.02]);
});

test('webmItems places clusters by timecode and sizes the last block from the Opus TOC', () => {
  const stream = cat(webmInit(), webmCluster({ tc: 0, rel: [0, 20, 40] }), webmCluster({ tc: 60, rel: [0, 20] }), webmCluster({ tc: 100, rel: [0], unknown: true }));
  const items = webmItems(stream);
  assert.deepEqual(items.map((i) => i.kind), ['init', 'media', 'media', 'media']);
  assert.equal(items[0].info.delay, 0.0065);
  assert.equal(items[0].info.rate, 48000);
  assert.deepEqual(items.slice(1).map((i) => [i.t0, +i.t1.toFixed(6)]), [[0, 0.06], [0.06, 0.1], [0.1, 0.12]]);
});

test('webmItems reads the fixture: contiguous clusters from 0 to 10 s', () => {
  const items = webmItems(read('track.webm'));
  assert.equal(items[0].kind, 'init');
  const media = items.filter((i) => i.kind === 'media');
  assert.ok(media.length >= 4, `clusters: ${media.length}`);
  assert.equal(media[0].t0, 0);
  for (let k = 0; k + 1 < media.length; k++) assert.ok(Math.abs(media[k].t1 - media[k + 1].t0) < 1e-9, `cluster ${k} ends at ${media[k].t1}, next starts ${media[k + 1].t0}`);
  for (const m of media) { const f = m.t0 / 0.02; assert.ok(Math.abs(f - Math.round(f)) < 1e-6, `millisecond timecode ${m.t0} snapped to the 20 ms frame grid`); }
  assert.ok(Math.abs(media.at(-1).t1 - 480312 / 48000) < 1e-9, `ends at ${media.at(-1).t1}: 10 s + the pre-skip, discard padding honoured`);
});

test('mp3Frames walks frames, skips an ID3v2 tag and resyncs over junk', () => {
  const id3 = cat([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5], new Uint8Array(5));
  const f = () => mp3Frame();
  const buf = cat(id3, f(), f(), new Uint8Array(7).fill(0x11), f(), f(), f());
  const r = mp3Frames(buf);
  assert.equal(r.sampleRate, 48000);
  assert.equal(r.frames, 5);
  assert.equal(r.samples, 5 * 1152);
  assert.equal(r.junk, 7);
  assert.equal(r.midJunk, true, 'sync lost between frames: bytes may be missing there');
  assert.equal(r.end, buf.length);
  assert.equal(mp3Frames(cat(new Uint8Array(5), f(), f(), new Uint8Array(128))).midJunk, false, 'junk at the edges (tags) is not a hole');
});

test('mp3Frames leaves a frame cut short at the end out of the count', () => {
  const buf = cat(mp3Frame(), mp3Frame(), mp3Frame().slice(0, 100));
  const r = mp3Frames(buf);
  assert.equal(r.frames, 2);
  assert.equal(r.end, 2 * 384);
});

test('mp3Frames reads the fixture: about 10 s, the Xing frame not counted as audio', () => {
  const r = mp3Frames(read('track.mp3'));
  assert.equal(r.sampleRate, 48000);
  assert.ok(Math.abs(r.samples / r.sampleRate - 10) < 1152 / 48000 * 2, `duration ${r.samples / r.sampleRate}`);
  assert.equal(r.junk, 0);
});

test('adtsFrames walks a hand-built header sequence: rate, raw blocks and resync', () => {
  const buf = cat(adtsFrame({ sf: 4 }), adtsFrame({ sf: 4, blocks: 2, len: 300 }), new Uint8Array(3).fill(0x22), adtsFrame({ sf: 4 }));
  const r = adtsFrames(buf);
  assert.equal(r.sampleRate, 44100);
  assert.equal(r.frames, 3);
  assert.equal(r.samples, 1024 * 4);
  assert.equal(r.junk, 3);
  assert.equal(r.end, buf.length);
});
