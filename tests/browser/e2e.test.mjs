// End-to-end: real extension, real captured tabs, real engine. About 3 minutes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareExtension, launchExtension, startTrackServer, hubCall, tabIdFor, waitFor, installClient,
  act, set, state, events, downloadIds, waitForDownload, parseWav, bandOnsets, bandRms, medianBpm, offscreenEval,
  offscreenHeap, steadyBeats, wavHeader, makeTrackWav,
} from './ext-harness.mjs';

const ART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
let h, server, deck, tabs = {};
const deckPageErrors = [];
const deckBy = (s, slot) => s.decks.find((d) => d.slot === slot);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function record(target, seconds) {
  const known = await downloadIds(h);
  const start = target === 'mix' ? await act(deck, null, 'mixRecStart') : await act(deck, target, 'recStart');
  assert.equal(start.ok, true, JSON.stringify(start));
  await sleep(seconds * 1000);
  if (target === 'mix') await act(deck, null, 'mixRecStop'); else await act(deck, target, 'recStop');
  const dl = await waitForDownload(h, known);
  return { dl, wav: parseWav(fs.readFileSync(dl.filename)) };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
/** Each deck's stretcher latency (s), by slot. */
const latencies = async () => Object.fromEntries(await offscreenEval(h, '[...globalThis.__jdsEngine.decks.values()].map((d) => [d.slot, d.ts.lat])'));
/**
 * The playhead never passes the live edge minus the stretcher latency. The snapshot playhead is
 * the heard position; the node is rendering outputLatency later, so that is where it is checked.
 */
function assertBehindLiveEdge(s, d, lat) {
  const ahead = d.liveEdge - (d.playhead + d.engineRate * s.outputLatency);
  assert.ok(ahead >= lat, `deck ${d.slot}: live edge ${d.liveEdge.toFixed(3)} - playhead ${d.playhead.toFixed(3)} (+ ${s.outputLatency} s output latency) = ${ahead.toFixed(3)} < latency ${lat}`);
}

// Lining up separate recordings: one 10 ms full-scale pulse, scheduled on the audio clock and
// added to the inputs of the given decks' recorders, lands on the same context frame in each file.
// (The decks' own audio stays well under full scale at the default trim.)
const MARK = (slots) => `(() => {
  const e = globalThis.__jdsEngine, ctx = e.ctx, t = ctx.currentTime + 0.25;
  const nodes = [...e.decks.values()].filter((d) => ${JSON.stringify(slots)}.includes(d.slot)).map((d) => d.recorder.node);
  if (nodes.length !== ${slots.length} || nodes.some((n) => !n)) throw new Error('recorders not running');
  const c = ctx.createConstantSource();
  c.offset.value = 2;
  for (const n of nodes) c.connect(n);
  c.onended = () => c.disconnect();
  c.start(t); c.stop(t + 0.01);
  return t;
})()`;
/** Frame index of each marker pulse in a 16-bit stereo WAV: >= 5 ms with both channels pinned at +32767. */
function markerFrames(buf) {
  const frames = wavHeader(buf).dataSize / 4, out = [];
  for (let i = 0, run = 0; i < frames; i++) {
    run = buf.readInt16LE(44 + i * 4) === 32767 && buf.readInt16LE(46 + i * 4) === 32767 ? run + 1 : 0;
    if (run === 240) out.push(i - 239);
  }
  return out;
}
/** How late bandOnsets() reports a beat of the synthetic track itself (s): subtracted before comparing decks. */
function onsetBias(bpm, kind, band) {
  const w = parseWav(makeTrackWav({ bpm, kind, seconds: 8 })), T = 60 / bpm;
  return median(bandOnsets(w.mono, w.sr, band).map((t) => t - Math.round(t / T) * T));
}

before(async () => {
  server = await startTrackServer({ seconds: 240 }); // longer than the suite: no <audio> loop restart (a 0.1 s gap) mid-test
  h = await launchExtension({ ext: prepareExtension() });
  for (const k of ['a', 'b']) { tabs[k] = await h.context.newPage(); await tabs[k].goto(server.url(k)); }
  deck = await h.context.newPage(); // the deck page, watched for console errors from its first load
  deck.on('console', (m) => { if (m.type() === 'error') deckPageErrors.push(m.text()); });
  deck.on('pageerror', (e) => deckPageErrors.push(String(e)));
  await deck.goto(`chrome-extension://${h.extId}/deck.html`);
  for (const k of ['a', 'b']) {
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: await tabIdFor(h, server.url(k)) });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  await installClient(deck);
});
after(async () => { await h?.close(); await server?.close(); });

test('two tabs load as cued decks and start buffering', async () => {
  const s = await state(deck);
  assert.equal(s.decks.length, 2);
  for (const d of s.decks) assert.equal(d.playing, false);
  await sleep(1500);
  const s2 = await state(deck);
  for (const d of s2.decks) {
    assert.ok(d.liveEdge > 1 && d.reserve > 0.5, JSON.stringify({ liveEdge: d.liveEdge, reserve: d.reserve }));
    // Cued: parked on the cue point (the first audible sample, near the start), not moving.
    assert.ok(d.cue >= 0 && d.cue < 1 && Math.abs(d.playhead - d.cue) < 1e-6 && d.engineRate === 0, JSON.stringify({ cue: d.cue, playhead: d.playhead, rate: d.engineRate }));
  }
  assert.equal(await deck.locator('.deck').count(), 2);
});

test('deck tabs are kept from being discarded while they are on a deck', async () => {
  for (const k of ['a', 'b']) {
    const t = await h.sw.evaluate((id) => chrome.tabs.get(id), await tabIdFor(h, server.url(k)));
    assert.equal(t.autoDiscardable, false, `tab ${k}`);
  }
});

test('tempo locks on both decks', async () => {
  await waitFor(async () => {
    const s = await state(deck);
    const a = deckBy(s, 1), b = deckBy(s, 2);
    return a.bpm.state === 'LOCKED' && b.bpm.state === 'LOCKED' && Math.abs(a.bpm.native - 124) < 0.3 && Math.abs(b.bpm.native - 128) < 0.3;
  }, 25000);
});

test('SYNC PLAY matches tempo and phase to the master', async () => {
  // Player assist stays off until the assist test: deck 1's reserve then falls at exactly rate − 1
  // (measured during the 60 s recordings) and every buffered second was captured at 1×.
  set(deck, null, 'assist.on', false);
  assert.equal((await act(deck, 2, 'master')).ok, true);
  assert.equal((await act(deck, 2, 'play')).ok, true);
  await sleep(1000);
  // SYNC▶ straight from SYNC off: it must set the tempo before it schedules the start.
  assert.equal(deckBy(await state(deck), 1).sync.on, false);
  assert.equal((await act(deck, 1, 'syncPlay')).ok, true);
  // The rate the engine actually scheduled (not params), read as the deck starts, before any phase
  // bend. Assist steps land at the live edge, seconds ahead of this playhead, so the source rate is 1.
  // (The master's own BPM estimate still settles for a few seconds, so compare against it, not 128.)
  const s0 = await waitFor(async () => { const s = await state(deck); return deckBy(s, 1).engineRate > 0 && s; }, 3000, 20);
  const st = deckBy(s0, 1);
  assert.equal(st.sync.on, true);
  assert.ok(Math.abs(st.bpm.out - s0.clock.bpm) < 0.05, `out ${st.bpm.out} vs clock ${s0.clock.bpm} at start`);
  assert.ok(Math.abs(st.engineRate - (1 + st.params.pitch)) < 0.005, `scheduled rate at start ${st.engineRate}, pitch ${st.params.pitch}`);
  await sleep(6000);
  const s = await state(deck);
  const a = deckBy(s, 1);
  assert.equal(s.clock.mode, 'deck');
  assert.ok(Math.abs(a.bpm.out - s.clock.bpm) < 0.02, `out ${a.bpm.out} vs clock ${s.clock.bpm}`);
  // The pitch follows both decks' BPM estimates, which can sit a few tenths of a BPM off for a few
  // seconds this soon after lock (seen on a busy box); they must come back to 128 and 124. (The
  // readouts are checked against the decks' recorded audio in the 60 s tests.)
  let last = a;
  await waitFor(async () => {
    last = deckBy(await state(deck), 1);
    return Math.abs(last.params.pitch - (128 / 124 - 1)) < 0.0025 && Math.abs(last.bpm.out - 128) < 0.3;
  }, 10000, 200).catch(() => assert.fail(`pitch ${last.params.pitch}, out ${last.bpm.out}`));
  // Phase lock: median of 10 readings over 2 s < 15 ms. A capture dropout (see the 60 s tests) moves
  // a deck's beat grid now and then and the loop takes a few seconds to re-lock, so allow 15 s.
  const ph = [];
  await waitFor(async () => {
    const p = deckBy(await state(deck), 1).sync.phaseMs;
    if (p != null) ph.push(Math.abs(p));
    return ph.length >= 10 && median(ph.slice(-10)) < 15;
  }, 15000, 200).catch(() => assert.fail(`phase ${JSON.stringify(ph.slice(-10))}`));
});

test('deck meters read each playing deck post-fader (from the master worklet); a closed fader reads silence', async () => {
  // A meter covers one 32 ms tick and the clicks are short: take the loudest of 1.5 s of states.
  const loudest = async () => {
    const pk = { 1: 0, 2: 0 }, rms = { 1: 0, 2: 0 };
    for (let i = 0; i < 15; i++) {
      const s = await state(deck);
      for (const k of [1, 2]) { const m = deckBy(s, k).meter; pk[k] = Math.max(pk[k], m.peak); rms[k] = Math.max(rms[k], m.rms); }
      await sleep(100);
    }
    return { pk, rms };
  };
  const on = await loudest();
  for (const k of [1, 2]) assert.ok(on.pk[k] > 0.05 && on.rms[k] > 0.005 && on.pk[k] < 0.999, `deck ${k}: ${JSON.stringify(on)}`);
  const fader = deckBy(await state(deck), 2).params.fader;
  set(deck, 2, 'fader', 0);
  try {
    await sleep(300);
    const off = await loudest();
    assert.ok(off.pk[2] < 1e-3, `deck 2 with its fader closed: ${JSON.stringify(off)}`);
    assert.ok(off.pk[1] > 0.05, 'deck 1 untouched');
  } finally { set(deck, 2, 'fader', fader); }
  await sleep(300);
});

// The next four tests share one 60 s window: decks 1 (synced, +3.2 %, assist off) and 2 (master)
// are each recorded with deck REC while the engine heap and deck 1's reserve are sampled. Run them
// together (--test-name-pattern '60 s' plus the setup tests above).
const LONG_S = 60;
let long = null;

test('60 s deck recordings: valid WAV headers, no lost frames, durations within 1 %, flat engine heap', async (t) => {
  const s0 = await state(deck);
  const d1 = deckBy(s0, 1);
  assert.ok(d1.playing && d1.sync.on && !s0.master.params['assist.on'] && d1.assist.sourceRate === 1, JSON.stringify({ sync: d1.sync, assist: d1.assist }));
  const lat = await latencies(), known = await downloadIds(h), started = {}, stopped = {}, samples = [], heap = [];
  for (const k of [1, 2]) { assert.equal((await act(deck, k, 'recStart')).ok, true); started[k] = Date.now(); }
  const t0 = Date.now(), end = t0 + LONG_S * 1000, marks = [];
  heap.push({ at: 0, ...(await offscreenHeap(h)) });
  marks.push(await offscreenEval(h, MARK([1, 2])));
  while (Date.now() < end - 1500) {
    const s = await state(deck);
    samples.push({ t: s.ctxTime, outputLatency: s.outputLatency, d1: deckBy(s, 1), d2: deckBy(s, 2) });
    if (heap.length === 1 && Date.now() - t0 > LONG_S * 500) heap.push({ at: (Date.now() - t0) / 1000, ...(await offscreenHeap(h)) });
    await sleep(250);
  }
  marks.push(await offscreenEval(h, MARK([1, 2])));
  heap.push({ at: (Date.now() - t0) / 1000, ...(await offscreenHeap(h)) });
  await sleep(Math.max(0, end - Date.now()));
  for (const k of [1, 2]) { stopped[k] = Date.now(); await act(deck, k, 'recStop'); }
  const files = {};
  await waitFor(async () => {
    const xs = await h.sw.evaluate((ids) => chrome.downloads.search({ state: 'complete' }).then((ds) => ds.filter((d) => !ids.includes(d.id)).map((d) => d.filename)), known);
    for (const f of xs) { const m = path.basename(f).match(/^JDSamps-D([12])-/); if (m) files[m[1]] = f; }
    return files[1] && files[2];
  }, 20000, 250);
  long = { samples, lat, marks, files: {} };
  for (const k of [1, 2]) {
    const buf = fs.readFileSync(files[k]);
    long.files[k] = { buf, hdr: wavHeader(buf), wav: parseWav(buf), marks: markerFrames(buf), wallSec: (stopped[k] - started[k]) / 1000 };
  }
  for (const k of [1, 2]) {
    const { hdr, wav, marks: m, wallSec } = long.files[k];
    t.diagnostic(`deck ${k}: ${hdr.fileBytes} bytes, ${wav.seconds.toFixed(3)} s of audio for ${wallSec.toFixed(3)} s between REC and STOP; markers at frames ${m}`);
    assert.deepEqual([hdr.riff, hdr.wave, hdr.fmt, hdr.data], ['RIFF', 'WAVE', 'fmt ', 'data']);
    assert.deepEqual([hdr.fmtSize, hdr.format, hdr.ch, hdr.sr, hdr.bits], [16, 1, 2, s0.sampleRate, 16]);
    assert.equal(hdr.blockAlign, 4);
    assert.equal(hdr.byteRate, hdr.sr * 4);
    assert.equal(hdr.riffSize, hdr.fileBytes - 8, 'RIFF size = file length - 8');
    assert.equal(hdr.dataSize, hdr.fileBytes - 44, 'data size = file length - 44');
    assert.equal(hdr.dataSize % 4, 0);
    assert.ok(Math.abs(wav.seconds - wallSec) < 0.01 * wallSec, `deck ${k}: ${wav.seconds} s of audio for ${wallSec} s recorded`);
    // Both pulses are in the file, exactly as many frames apart as they were scheduled: no frame lost or doubled.
    assert.equal(m.length, 2, `deck ${k} markers ${m}`);
    assert.ok(Math.abs(m[1] - m[0] - Math.round((marks[1] - marks[0]) * hdr.sr)) <= 1, `deck ${k}: ${m[1] - m[0]} frames between markers, scheduled ${(marks[1] - marks[0]) * hdr.sr}`);
  }
  const mb = (x) => (x / 2 ** 20).toFixed(2);
  t.diagnostic(`engine heap after GC (used / ArrayBuffer backing stores, MB): ${heap.map((x) => `${x.at.toFixed(0)} s ${mb(x.usedSize)} / ${mb(x.backingStorageSize || 0)}`).join(', ')}`);
  // 60 s of 16-bit stereo is 11 MB per deck: kept in the engine, it would show up here.
  for (const x of heap.slice(1)) {
    assert.ok(x.usedSize - heap[0].usedSize < 2 * 2 ** 20, `JS heap grew ${mb(x.usedSize - heap[0].usedSize)} MB by ${x.at} s`);
    assert.ok((x.backingStorageSize || 0) - (heap[0].backingStorageSize || 0) < 2 * 2 ** 20, `ArrayBuffers grew by ${x.at} s`);
  }
});

/**
 * Beats in the two 60 s recordings, between the marker pulses (0.5 s clear of each), on one
 * timeline: seconds after the first pulse, less the detector's own lateness on each sound. When
 * the box is busy the audio clock and the tab captures drift apart and the capture drops or
 * repeats 10-20 ms now and then, so a recording is a series of steady runs with small jumps.
 * `fit` is the tempo of the steady runs (the music as played); `bpm` counts beats over the whole
 * window, jumps included (diagnostic only).
 */
function beats() {
  if (long.beats) return long.beats;
  const bias = { low: onsetBias(124, 'low', 'low'), high: onsetBias(128, 'high', 'high') };
  const one = (k, band) => {
    const { wav, marks: m } = long.files[k], from = m[0] + Math.round(0.5 * wav.sr);
    const on = bandOnsets(wav.mono.subarray(from, m[1] - Math.round(0.5 * wav.sr)), wav.sr, band).map((x) => x + (from - m[0]) / wav.sr - bias[band]);
    const fit = steadyBeats(on), n = on.slice(1).reduce((acc, x, i) => acc + Math.round((x - on[i]) / fit.T), 0);
    return { on, fit, bpm: (60 * n) / (on[on.length - 1] - on[0]) };
  };
  long.beats = { bias, 1: one(1, 'low'), 2: one(2, 'high') };
  return long.beats;
}

test('60 s deck recordings: the synced deck matches the master within 0.2 % tempo and 20 ms phase', async (t) => {
  assert.ok(long, 'needs the 60 s recording test');
  const { bias, 1: A, 2: B } = beats();
  const tempoErr = A.fit.T / B.fit.T - 1;
  // A capture jump moves that deck's beats, and the follower re-locks over a few seconds. Phase is
  // judged once both decks have played K steady beats since their last jump or phase bend.
  const K = 8, at = new Map();
  B.fit.runs.forEach((r) => r.forEach((u, k) => at.set(u, k)));
  const all = [], settled = [];
  for (const r of A.fit.runs) {
    r.forEach((x, k) => {
      const u = B.on.reduce((best, y) => (Math.abs(x - y) < Math.abs(x - best) ? y : best), Infinity);
      all.push((x - u) * 1000);
      if (k >= K && at.get(u) >= K) settled.push((x - u) * 1000);
    });
  }
  const stats = (xs) => { const v = xs.map(Math.abs).sort((p, q) => p - q); return { n: v.length, med: v[v.length >> 1], p90: v[Math.floor(v.length * 0.9)], max: v[v.length - 1] }; };
  const st = stats(settled), sa = stats(all), f = (o) => `median ${o.med.toFixed(1)}, p90 ${o.p90.toFixed(1)}, max ${o.max.toFixed(1)} over ${o.n} beats`;
  t.diagnostic(`detector lateness: kick ${(bias.low * 1000).toFixed(1)} ms, click ${(bias.high * 1000).toFixed(1)} ms`);
  t.diagnostic(`steady tempo: deck 1 ${(60 / A.fit.T).toFixed(3)} BPM (runs ${A.fit.runs.map((r) => r.length)}), deck 2 ${(60 / B.fit.T).toFixed(3)} BPM (runs ${B.fit.runs.map((r) => r.length)}): error ${(tempoErr * 100).toFixed(4)} %`);
  t.diagnostic(`|beat offset| deck 1 - deck 2 (ms), settled: ${f(st)}; every beat: ${f(sa)}`);
  assert.ok(A.fit.n > 60 && B.fit.n > 60, `steady beats ${A.fit.n}, ${B.fit.n}`);
  assert.ok(Math.abs(tempoErr) < 0.002, `tempo error ${tempoErr * 100} %`);
  assert.ok(st.n >= 40, `only ${st.n} settled beats`);
  assert.ok(st.p90 <= 20, `settled beat offsets: ${f(st)}`);
});

test('60 s deck recordings: each BPM readout is within ±0.2 of the tempo in its recording', async (t) => {
  assert.ok(long, 'needs the 60 s recording test');
  const b = beats();
  for (const k of [1, 2]) {
    const out = median(long.samples.map((s) => s[`d${k}`].bpm.out)), rec = 60 / b[k].fit.T;
    t.diagnostic(`deck ${k}: readout ${out.toFixed(3)} BPM (median); recording ${rec.toFixed(3)} BPM steady, ${b[k].bpm.toFixed(3)} counting jumps`);
    assert.ok(Math.abs(out - rec) <= 0.2, `deck ${k}: readout ${out} vs ${rec} BPM recorded`);
  }
});

test('60 s deck recordings: with assist off the reserve drained at rate − 1, the playhead always latency behind the live edge', async (t) => {
  assert.ok(long, 'needs the 60 s recording test');
  const xs = long.samples, x = median(xs.map((s) => s.d1.params.pitch));
  for (const s of xs) {
    assert.equal(s.d1.starved, false);
    assert.equal(s.d1.assist.sourceRate, 1);
    for (const d of [s.d1, s.d2]) assertBehindLiveEdge(s, d, long.lat[d.slot]);
  }
  // Least-squares slope of reserve against the audio clock.
  const mt = xs.reduce((a, s) => a + s.t, 0) / xs.length, mr = xs.reduce((a, s) => a + s.d1.reserve, 0) / xs.length;
  let sxy = 0, sxx = 0;
  for (const s of xs) { sxy += (s.t - mt) * (s.d1.reserve - mr); sxx += (s.t - mt) ** 2; }
  const slope = sxy / sxx;
  t.diagnostic(`deck 1 at +${(x * 100).toFixed(2)} %: reserve ${xs[0].d1.reserve.toFixed(2)} -> ${xs[xs.length - 1].d1.reserve.toFixed(2)} s, slope ${slope.toFixed(4)} s/s over ${(xs[xs.length - 1].t - xs[0].t).toFixed(1)} s (${xs.length} samples)`);
  assert.ok(x > 0.03, `pitch ${x}`);
  assert.ok(Math.abs(slope + x) < 0.1 * x, `reserve slope ${slope} s/s, expected ${-x}`);
});

test('the mix recording has both decks at 128 BPM with aligned beats', async () => {
  const { wav } = await record('mix', 8);
  assert.ok(wav.seconds > 7 && wav.sr > 0);
  const lo = bandOnsets(wav.mono, wav.sr, 'low'), hi = bandOnsets(wav.mono, wav.sr, 'high');
  assert.ok(Math.abs(medianBpm(lo) - 128) < 1, `low ${medianBpm(lo)}`);
  assert.ok(Math.abs(medianBpm(hi) - 128) < 1, `high ${medianBpm(hi)}`);
  const offs = lo.map((t) => Math.min(...hi.map((u) => Math.abs(u - t)))).sort((x, y) => x - y);
  const med = offs[Math.floor(offs.length / 2)] * 1000;
  assert.ok(med < 25, `median beat offset ${med.toFixed(1)} ms`);
});

test('crossfader extremes isolate the A and B sides', async (t) => {
  // Deck 1 (A) is the low kick, deck 2 (B) the high click: each side is measured in its own band.
  set(deck, 1, 'xf', 'A'); set(deck, 2, 'xf', 'B'); set(deck, null, 'xfader.pos', 0.5);
  await sleep(300);
  const both = await record('mix', 3);
  set(deck, null, 'xfader.pos', 1);
  await sleep(300);
  const onlyB = await record('mix', 3);
  set(deck, null, 'xfader.pos', 0);
  await sleep(300);
  const onlyA = await record('mix', 3);
  await Promise.all([set(deck, null, 'xfader.pos', 0.5), set(deck, 1, 'xf', 'THRU'), set(deck, 2, 'xf', 'THRU')]);
  const db = (x, y, band) => 20 * Math.log10(bandRms(x.wav.mono, x.wav.sr, band) / bandRms(y.wav.mono, y.wav.sr, band));
  const aDrop = db(onlyB, both, 'low'), bDrop = db(onlyA, both, 'high');
  t.diagnostic(`at B: A (low band) ${aDrop.toFixed(1)} dB; at A: B (high band) ${bDrop.toFixed(1)} dB`);
  assert.ok(aDrop < -30, `A drop ${aDrop.toFixed(1)} dB`);
  assert.ok(bDrop < -30, `B drop ${bDrop.toFixed(1)} dB`);
  assert.ok(db(onlyA, both, 'low') > -3 && db(onlyB, both, 'high') > -3, 'the selected side stays up');
});

test('low kill cuts the kick in the deck recording by 30 dB or more', async (t) => {
  const on = await record(1, 3);
  set(deck, 1, 'kill.low', true);
  await sleep(200);
  const killed = await record(1, 3);
  await set(deck, 1, 'kill.low', false);
  const drop = 20 * Math.log10(bandRms(killed.wav.mono, killed.wav.sr, 'low') / bandRms(on.wav.mono, on.wav.sr, 'low'));
  t.diagnostic(`low band ${drop.toFixed(1)} dB`);
  assert.ok(drop < -30, `low drop ${drop.toFixed(1)} dB`);
  assert.match(path.basename(on.dl.filename), /^JDSamps-D1-Track A 124 BPM-\d{8}-\d{6}.*\.wav$/);
});

test('the limiter holds the master under -1 dBFS with +12 dB trims', async (t) => {
  set(deck, 1, 'trim', 1); set(deck, 2, 'trim', 1);
  await sleep(500);
  const grs = [];
  let polling = true;
  const poll = (async () => { while (polling) { grs.push((await state(deck)).master.gr); await sleep(100); } })();
  const { wav } = await record('mix', 3); // the mix tap is after the limiter: check every sample
  polling = false;
  await poll;
  await Promise.all([set(deck, 1, 'trim', 0.5), set(deck, 2, 'trim', 0.5)]);
  let peak = 0;
  for (const x of wav.mono) peak = Math.max(peak, Math.abs(x));
  const gr = Math.min(...grs);
  t.diagnostic(`peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS, deepest gain reduction ${gr.toFixed(1)} dB`);
  assert.ok(peak <= 10 ** (-1 / 20) + 2 / 32768, `peak ${peak}`);
  assert.ok(peak > 0.8, `peak ${peak} (limiting engaged)`);
  assert.ok(gr < -3, `gain reduction reported while limiting: ${gr} dB`);
});

test('player assist refills the reserve on a media-element page', async () => {
  // LIVE leaves ~0.6 s of reserve; deck 1 must run +3.2 %, so assist has to keep it fed.
  set(deck, null, 'assist.on', true);
  const lat = await latencies();
  assert.equal((await act(deck, 1, 'live')).ok, true);
  await waitFor(async () => (await tabs.a.evaluate(() => window.__media())).rate > 1.01, 15000, 250);
  const m = await tabs.a.evaluate(() => window.__media());
  assert.equal(m.pp, false);
  await sleep(1500); // the LIVE jump lands ~0.15 s after the call; let it settle
  const d0 = deckBy(await state(deck), 1);
  assert.equal(d0.assist.active, true);
  assert.ok(d0.reserve < 3, `reserve after LIVE ${d0.reserve}`);
  for (const until = Date.now() + 6000; Date.now() < until; await sleep(200)) { const s = await state(deck); assertBehindLiveEdge(s, deckBy(s, 1), lat[1]); }
  const d1 = deckBy(await state(deck), 1);
  assert.ok(d1.reserve > d0.reserve, `reserve ${d0.reserve} -> ${d1.reserve}`);
  assert.equal(d1.starved, false);
  assert.ok(Math.abs(d1.bpm.out - 128) < 0.4, `out ${d1.bpm.out}`);
  assert.ok(Math.abs(d1.bpm.native - 124) < 0.4, `native ${d1.bpm.native}`);
  // Phase lock is regained after the LIVE jump while assist runs: median of 5 readings < 15 ms.
  const recent = [];
  await waitFor(async () => {
    const p = deckBy(await state(deck), 1).sync.phaseMs;
    if (p != null) recent.push(Math.abs(p));
    const last = recent.slice(-5).sort((x, y) => x - y);
    return last.length === 5 && last[2] < 15;
  }, 15000, 300);
});

test('a Web-Audio page with a muted decorative <audio> has no assist and the reserve stays protected', async () => {
  tabs.c = await h.context.newPage();
  await tabs.c.goto(server.url('c'));
  await sleep(500);
  assert.equal((await hubCall(deck, { type: 'LOAD_TAB', tabId: await tabIdFor(h, server.url('c')) })).ok, true);
  const early = await act(deck, 3, 'sync', { on: true }); // the tracker needs >= 4 s of audio first
  assert.equal(early.ok, false);
  assert.match(early.error, /No BPM yet/);
  await waitFor(async () => { const d = deckBy(await state(deck), 3); return d && d.bpm.state === 'LOCKED'; }, 25000);
  await act(deck, 3, 'live');
  assert.equal((await act(deck, 3, 'sync', { on: true })).ok, true);
  assert.equal((await act(deck, 3, 'play')).ok, true);
  // Needs +6.7 % with no player to drive: the small LIVE reserve drains, then the deck is held at 1×.
  const lat = await latencies();
  await waitFor(async () => { const s = await state(deck), d = deckBy(s, 3); assertBehindLiveEdge(s, d, lat[3]); return d.starved; }, 20000, 250);
  await sleep(600); // the 1x clamp is scheduled ~0.15 s ahead and reported at the heard time
  for (let i = 0; i < 10; i++) {
    const s = await state(deck), d = deckBy(s, 3);
    assert.equal(d.assist.available, false);
    assert.equal(d.playing, true);
    assert.equal(d.starved, true);
    assert.ok(d.engineRate <= 1.0001, `rate ${d.engineRate}`);
    assertBehindLiveEdge(s, d, lat[3]);
    await sleep(200);
  }
  // The muted element was left alone and the tempo/pitch model is untouched.
  const d = deckBy(await state(deck), 3);
  assert.equal(d.assist.sourceRate, 1);
  assert.ok(Math.abs(d.bpm.native - 120) < 0.4, `native ${d.bpm.native}`);
  assert.deepEqual(await tabs.c.evaluate(() => { const a = document.getElementById('decor'); return [a.paused, a.playbackRate, a.preservesPitch]; }), [false, 1, true]);
});

test('recordings stopped together are all saved, reported and released', async () => {
  const rounds = 4, known = await downloadIds(h), ev0 = (await events(deck)).length;
  const completed = () => h.sw.evaluate((k) => chrome.downloads.search({ state: 'complete' }).then((xs) => xs.filter((d) => !k.includes(d.id)).length), known);
  for (let i = 0; i < rounds; i++) {
    assert.equal((await act(deck, 1, 'recStart')).ok, true);
    assert.equal((await act(deck, null, 'mixRecStart')).ok, true);
    await sleep(700);
    await Promise.all([act(deck, 1, 'recStop'), act(deck, null, 'mixRecStop')]); // as STOP ALL or a closing tab does
    await waitFor(async () => (await completed()) === 2 * (i + 1), 15000, 200);
  }
  const notices = async () => (await events(deck)).slice(ev0).filter((e) => /^Sav(ed|ing) /.test(e.text));
  await waitFor(async () => (await notices()).length >= 2 * rounds, 5000).catch(() => {});
  const n = await notices();
  assert.equal(n.filter((e) => e.level === 'info').length, 2 * rounds, JSON.stringify(n.map((e) => e.text)));
  assert.equal(n.length, 2 * rounds);
  assert.deepEqual(await offscreenEval(h, '[...globalThis.__jdsEngine.downloads.values()].map((x) => x.filename)'), []);
  const s = await h.sw.evaluate(() => chrome.storage.session.get(null));
  assert.deepEqual(Object.entries(s).flatMap(([k, v]) => (k === 'dl' ? Object.keys(v) : k.startsWith('dl:') ? [k] : [])), []);
});

test('reloading the deck page keeps the engine playing; the deck page logged no console errors', async () => {
  const before = deckBy(await state(deck), 2).playhead;
  const t0 = Date.now();
  await deck.reload();
  await deck.waitForSelector('.deck >> nth=2', { timeout: 10000 });
  await installClient(deck);
  const after = deckBy(await state(deck), 2).playhead;
  assert.ok(after - before > (Date.now() - t0) / 1000 - 0.8, `playhead ${before} -> ${after}`);
  fs.mkdirSync(ART, { recursive: true });
  await sleep(500);
  await deck.screenshot({ path: path.join(ART, 'e2e-deck.png') });
  assert.deepEqual(deckPageErrors, []);
});

test('closing a recording tab saves its recording and frees the master clock at its tempo', async () => {
  const known = await downloadIds(h);
  assert.equal((await act(deck, 2, 'recStart')).ok, true);
  await sleep(2000);
  const bpm = (await state(deck)).clock.bpm;
  await tabs.b.close();
  const dl = await waitForDownload(h, known, 15000);
  assert.match(path.basename(dl.filename), /^JDSamps-D2-/);
  const wav = parseWav(fs.readFileSync(dl.filename));
  assert.ok(wav.seconds > 1.5, `seconds ${wav.seconds}`);
  await waitFor(async () => (await state(deck)).decks.length === 2, 8000);
  const c = (await state(deck)).clock;
  assert.equal(c.mode, 'free');
  assert.ok(Math.abs(c.bpm - bpm) < 0.2, `clock ${bpm} -> ${c.bpm} BPM`); // the master's readout wobbles ~0.1 BPM
});

// Inside the engine: wrap AudioWorkletNode to log what each new node is told (port messages and
// stretcher remote calls), and whether the stretcher processor answered destroy().
const NODE_PROBE = `(() => {
  const Orig = AudioWorkletNode, lc = window.__lc = { Orig, nodes: [] };
  window.AudioWorkletNode = class extends Orig {
    constructor(ctx, name, opts) {
      super(ctx, name, opts);
      const rec = { name, sent: [], destroyAnswered: false };
      lc.nodes.push(rec);
      const port = this.port, post = port.postMessage.bind(port);
      let destroyId = null;
      port.postMessage = (...args) => {
        const m = args[0];
        if (Array.isArray(m)) { if (m[1] !== 'addBuffers') rec.sent.push(m[1]); if (m[1] === 'destroy') destroyId = m[0]; }
        else if (m && m.t) rec.sent.push(m.t);
        return post(...args);
      };
      port.addEventListener('message', (e) => { if (destroyId !== null && Array.isArray(e.data) && e.data[0] === destroyId) rec.destroyAnswered = true; });
    }
  };
  return true;
})()`;

test('ejected and closed deck tabs stop their audio processors (stretcher, input, FX, recorder)', async () => {
  await offscreenEval(h, NODE_PROBE);
  try {
    // 0: eject. 1: record, stop, close the tab. 2: eject while recording.
    for (let i = 0; i < 3; i++) {
      const url = `${server.url('a')}?lifecycle=${i}`;
      const tab = await h.context.newPage();
      await tab.goto(url);
      const tabId = await tabIdFor(h, url);
      const r = await hubCall(deck, { type: 'LOAD_TAB', tabId });
      assert.equal(r.ok, true, JSON.stringify(r));
      const d = await waitFor(async () => (await state(deck)).decks.find((x) => x.tabId === tabId), 8000);
      await sleep(1500);
      if (i > 0) { assert.equal((await act(deck, d.id, 'recStart')).ok, true); await sleep(1000); }
      if (i === 1) { await act(deck, d.id, 'recStop'); await tab.close(); } else { assert.equal((await act(deck, d.id, 'eject')).ok, true); await tab.close(); }
      await waitFor(async () => !(await state(deck)).decks.some((x) => x.tabId === tabId), 10000);
    }
    const done = (n) => n.filter((x) => x.name === 'signalsmith-stretch').every((x) => x.destroyAnswered)
      && n.filter((x) => x.name === 'jds-recorder').every((x) => x.sent.includes('dispose'));
    await waitFor(async () => done(await offscreenEval(h, 'window.__lc.nodes')), 15000, 250).catch(() => {});
    const nodes = await offscreenEval(h, 'window.__lc.nodes');
    const by = (name) => nodes.filter((x) => x.name === name);
    assert.equal(by('signalsmith-stretch').length, 3);
    for (const s of by('signalsmith-stretch')) {
      assert.ok(s.sent.includes('dropBuffers') && s.destroyAnswered, `stretcher not destroyed: ${JSON.stringify(s)}`);
    }
    for (const name of ['jds-deck-input', 'jds-beatfx']) {
      assert.equal(by(name).length, 3, name);
      for (const x of by(name)) assert.ok(x.sent.includes('dispose'), `${name} not disposed: ${JSON.stringify(x.sent.slice(-5))}`);
    }
    assert.deepEqual(by('jds-recorder').map((x) => x.sent), [['start', 'stop', 'dispose'], ['start', 'stop', 'dispose']]);
  } finally {
    await offscreenEval(h, 'window.AudioWorkletNode = window.__lc.Orig, true').catch(() => {});
  }
});

test("ejecting a deck pauses its tab's player, whether the user or the engine ejects it, even with a slow hub", async () => {
  // 0: EJECT from the deck. 1: the engine ejects it (the tab stopped sharing audio).
  // 2: EJECT while the hub answers slowly (a busy machine): the capture still waits for the pause.
  for (let i = 0; i < 3; i++) {
    const url = `${server.url('a')}?eject=${i}`;
    const tab = await h.context.newPage();
    await tab.goto(url);
    const tabId = await tabIdFor(h, url);
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId });
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = await waitFor(async () => (await state(deck)).decks.find((x) => x.tabId === tabId), 8000);
    await waitFor(() => tab.evaluate(() => { const m = window.__media(); return !m.paused && m.t > 0.3; }), 8000);
    // Wall-clock times of the page's pause and of the capture being released.
    await tab.evaluate(() => document.getElementById('a').addEventListener('pause', () => { window.__pausedAt = Date.now(); }));
    // On a busy machine the hub may mute first (the pause is late); either way the tab is silent.
    await h.sw.evaluate((id) => { globalThis.__mutedAt = 0; chrome.tabs.onUpdated.addListener((t, info) => {
      if (t === id && info.mutedInfo && info.mutedInfo.muted && !globalThis.__mutedAt) globalThis.__mutedAt = Date.now(); }); }, tabId);
    await offscreenEval(h, `(() => { window.__releasedAt = 0; const t = globalThis.__jdsEngine.decks.get(${d.id}).stream.getAudioTracks()[0], stop = t.stop.bind(t);
      t.stop = () => { window.__releasedAt = Date.now(); stop(); }; return true; })()`);
    if (i === 2) {
      await offscreenEval(h, `(() => { const e = globalThis.__jdsEngine, hub = e.hub.bind(e); e.__hub = hub;
        e.hub = (m) => (m.type === 'STOP_TAB' ? new Promise((r) => setTimeout(r, 700)).then(() => hub(m)) : hub(m)); return true; })()`);
    }
    if (i !== 1) assert.equal((await act(deck, d.id, 'eject')).ok, true);
    else await offscreenEval(h, `globalThis.__jdsEngine.decks.get(${d.id}).stream.getAudioTracks()[0].dispatchEvent(new Event('ended'))`);
    await waitFor(async () => !(await state(deck)).decks.some((x) => x.tabId === tabId), 8000);
    await waitFor(() => tab.evaluate(() => window.__media().paused), 1500).catch(() => {});
    assert.equal((await tab.evaluate(() => window.__media())).paused, true, `eject ${i}: the tab's <audio> is still playing`);
    const releasedAt = await waitFor(() => offscreenEval(h, 'window.__releasedAt || 0'), 3000);
    const pausedAt = await tab.evaluate(() => window.__pausedAt);
    const mutedAt = await h.sw.evaluate(() => globalThis.__mutedAt);
    // The hub answers only after the page's pause() calls returned, so the capture is released after the
    // pause; the 'pause' event itself is dispatched a task later, which a starved CPU can delay a few ms.
    const EVENT_LAG = 100;
    assert.ok(pausedAt <= releasedAt + EVENT_LAG || (mutedAt && mutedAt <= releasedAt),
      `eject ${i}: the tab was still playing when the capture was released (paused ${pausedAt - releasedAt} ms after, muted ${mutedAt ? mutedAt - releasedAt : 'never'})`);
    // Paused in the end, so any mute made while the pause was late is taken back off.
    await waitFor(async () => !(await h.sw.evaluate((id) => chrome.tabs.get(id), tabId)).mutedInfo.muted, 3000)
      .catch(() => assert.fail(`eject ${i}: paused, but the tab was left muted`));
    if (i === 2) await offscreenEval(h, '(() => { const e = globalThis.__jdsEngine; e.hub = e.__hub; delete e.__hub; return true; })()');
    await tab.close();
  }
});

test('stop all ejects everything; no engine errors were reported', async () => {
  assert.equal((await act(deck, null, 'stopAll')).ok, true);
  await waitFor(async () => (await state(deck)).decks.length === 0, 8000);
  const errs = (await events(deck)).filter((e) => e.level === 'error');
  assert.deepEqual(errs, []);
});

test('ejected tabs may be discarded again', async () => {
  for (const k of ['a', 'b', 'c']) {
    const id = await tabIdFor(h, server.url(k));
    if (id == null) continue; // closed by an earlier test (b): nothing left to give back
    await waitFor(async () => (await h.sw.evaluate((x) => chrome.tabs.get(x), id)).autoDiscardable === true, 3000);
  }
});

test("STOP ALL left every deck's tab silent: players paused at their own rate, the Web-Audio tab muted", async () => {
  await waitFor(() => tabs.a.evaluate(() => window.__media().paused), 1500).catch(() => {});
  const m = await tabs.a.evaluate(() => window.__media());
  assert.deepEqual([m.paused, m.rate, m.pp], [true, 1, true], 'deck 1 (<audio>, assisted earlier)');
  const cId = await tabIdFor(h, server.url('c'));
  const mi = await h.sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.mutedInfo), cId);
  assert.deepEqual([mi.muted, mi.reason, mi.extensionId], [true, 'extension', h.extId], 'Web-Audio tab muted by us');
  assert.equal(await tabs.c.evaluate(() => document.getElementById('decor').paused), true, 'its muted decor <audio> is paused too');
  const notes = (await events(deck)).filter((e) => /no pausable player/.test(e.text));
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.match(notes[0].text, /^Deck \d: the tab has no pausable player, so it was muted\.$/);
  assert.equal(notes[0].level, 'info');
});

test('loading a tab we muted unmutes it first, so the deck hears it', async () => {
  const cId = await tabIdFor(h, server.url('c'));
  assert.equal((await h.sw.evaluate((id) => chrome.tabs.get(id), cId)).mutedInfo.muted, true, 'muted by the STOP ALL');
  const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: cId });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await h.sw.evaluate((id) => chrome.tabs.get(id), cId)).mutedInfo.muted, false);
  const d = await waitFor(async () => (await state(deck)).decks.find((x) => x.tabId === cId), 8000);
  await waitFor(() => offscreenEval(h, `globalThis.__jdsEngine.decks.get(${d.id}).firstAudible != null`), 8000);
  assert.equal((await act(deck, d.id, 'eject')).ok, true);
  await waitFor(async () => (await state(deck)).decks.length === 0, 8000);
});
