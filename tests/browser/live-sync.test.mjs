// Two LIVE decks beat-matched by SYNC, in the real extension (tabs loaded live, as with resident loading off): the
// follower holds the master's tempo and beat over a minute of master recording, and capture gaps in either tab's
// audio (its WAV spliced: a few ms dropped or repeated, as a tab capture under load does) are jumped across where the
// playhead reaches them, not bent back over afterwards: around each of them the recording shows no bend. (The box's
// own capture skips come on top, sometimes several within a few beats; at one jump a beat, the phase loop may bend
// after such a burst. They are reported, not judged.)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {
  prepareExtension, launchExtension, hubCall, tabIdFor, waitFor, installClient, act, set, state, offscreenEval, makeTrackWav,
  downloadIds, waitForDownload, parseWav, bandOnsets, steadyBeats, onsetBias, beatMatch,
} from './ext-harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REC_S = 60;
// Track A (kick, 124 BPM: the follower, deck 1) and track B (click, 128 BPM: the master, deck 2), 240 s each, with
// capture gaps spliced in at track seconds the decks play during the recording: ms > 0 drops that much, < 0 repeats it.
const TRACKS = { a: { bpm: 124, kind: 'low' }, b: { bpm: 128, kind: 'high' } };
const GAPS = { a: [{ ms: 15, at: 24.1 }, { ms: -12, at: 36.3 }, { ms: 20, at: 48.2 }, { ms: -10, at: 60.4 }], b: [{ ms: -15, at: 30.2 }, { ms: 12, at: 54.1 }] };
let h, server, deck, rec;

/** A 16-bit mono WAV with |ms| of audio dropped (ms > 0) or repeated (ms < 0) at each gap's track second. */
function splice(buf, gaps) {
  const sr = buf.readUInt32LE(24), pcm = buf.subarray(44), parts = [];
  let s0 = 0;
  for (const { ms, at } of [...gaps].sort((x, y) => x.at - y.at)) {
    const i = Math.round(at * sr) * 2, n = Math.round((Math.abs(ms) / 1000) * sr) * 2;
    parts.push(pcm.subarray(s0, i));
    if (ms > 0) s0 = i + n; else { parts.push(pcm.subarray(i - n, i)); s0 = i; }
  }
  parts.push(pcm.subarray(s0));
  const data = Buffer.concat(parts), out = Buffer.alloc(44 + data.length);
  buf.copy(out, 0, 0, 44);
  out.writeUInt32LE(36 + data.length, 4);
  out.writeUInt32LE(data.length, 40);
  data.copy(out, 44);
  return out;
}

/** /a and /b: <audio loop autoplay> pages on the spliced tracks. */
async function startServer() {
  const wavs = Object.fromEntries(Object.entries(TRACKS).map(([k, t]) => [k, splice(makeTrackWav({ ...t, seconds: 240 }), GAPS[k])]));
  const srv = http.createServer((req, res) => {
    const k = req.url.slice(1).replace(/\.wav$/, '');
    if (!wavs[k]) { res.writeHead(404); res.end(); return; }
    if (req.url.endsWith('.wav')) { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wavs[k]); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Track ${k.toUpperCase()} ${TRACKS[k].bpm} BPM, with gaps</title><audio id="a" src="/${k}.wav" loop autoplay></audio>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  return { url: (k) => `${origin}/${k}`, close: () => new Promise((r) => srv.close(r)) };
}

// Each tick of the recording, for decks 1 and 2: [time, slot, playhead, scheduled rate, the rate it is synced to, starved, phase error (ms)].
const PROBE = `(() => {
  const e = globalThis.__jdsEngine, log = window.__liveSync = [], orig = e.tick.bind(e);
  e.tick = (m) => {
    orig(m);
    const now = e.ctx.currentTime;
    for (const d of e.decks.values()) if (d.slot <= 2 && d.ts) log.push([now, d.slot, d.ts.posAt(now), d.ts.rateAt(now), d.effRate(d.ts.posAt(now)), d.starved, d.phaseMs]);
  };
  return true;
})()`;

/** Onsets in one band at sample precision: where each bandOnsets onset's band signal first rises through 35 % of its peak. */
function fineOnsets(wav, band) {
  const sr = wav.sr, x = wav.mono, y = new Float32Array(x.length), k = (fc) => Math.exp((-2 * Math.PI * fc) / sr);
  if (band === 'low') { // as bandOnsets filters
    const a = k(150);
    let s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 0; i < x.length; i++) { s1 = (1 - a) * x[i] + a * s1; s2 = (1 - a) * s1 + a * s2; s3 = (1 - a) * s2 + a * s3; s4 = (1 - a) * s3 + a * s4; y[i] = s4; }
  } else {
    const a = k(1500), s = [0, 0, 0, 0], xp = [0, 0, 0, 0];
    for (let i = 0; i < x.length; i++) { let v = x[i]; for (let j = 0; j < 4; j++) { const o = a * (s[j] + v - xp[j]); xp[j] = v; s[j] = o; v = o; } y[i] = v; }
  }
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  const thr = 0.35 * peak, out = [];
  for (const t of bandOnsets(x, sr, band)) {
    for (let i = Math.max(1, Math.round((t - 0.006) * sr)), end = Math.min(y.length - 1, Math.round((t + 0.004) * sr)); i <= end; i++) {
      const p = Math.abs(y[i - 1]), q = Math.abs(y[i]);
      if (q >= thr && p < thr) { out.push((i - 1 + (thr - p) / (q - p)) / sr); break; }
    }
  }
  return out;
}

/**
 * A deck's tempo bends (fraction) through its beats: the slope of every 4 consecutive beats (least squares) against
 * the steady period, as {t (the first beat), dev}. A phase-loop bend (0.5-4 % for up to a beat or two) or a capture gap
 * played as it came shows; one onset's jitter (a millisecond or two) does not.
 */
function bends(on) {
  const T = steadyBeats(on).T, out = [];
  for (let i = 0; i + 4 <= on.length; i++) {
    const xs = on.slice(i, i + 4);
    if (xs.some((x, j) => j && Math.abs(x - xs[j - 1] - T) > T / 4)) continue; // a missing beat: not 4 in a row
    out.push({ t: xs[0], dev: (3 * (xs[3] - xs[0]) + (xs[2] - xs[1])) / 10 / T - 1 }); // the slope of 4 equally spaced points
  }
  return out;
}
const worst = (xs) => xs.reduce((w, x) => (Math.abs(x.dev) > Math.abs(w.dev) ? x : w), { t: 0, dev: 0 });
const pct = (x) => `${(x.dev * 100).toFixed(2)} % at ${x.t.toFixed(2)} s`;

before(async () => {
  server = await startServer();
  h = await launchExtension({ ext: prepareExtension() });
  for (const k of ['a', 'b']) await (await h.context.newPage()).goto(server.url(k));
  deck = await h.context.newPage();
  await deck.goto(`chrome-extension://${h.extId}/deck.html`);
  await deck.evaluate(() => chrome.storage.local.set({ 'resident.auto': false }));
  for (const k of ['a', 'b']) {
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: await tabIdFor(h, server.url(k)) });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  await installClient(deck);
});
after(async () => { await h?.close(); await server?.close(); });

test('two synced live decks: a minute of master recording at one tempo and on one beat, capture gaps jumped, no bend', async (t) => {
  const by = (s, slot) => s.decks.find((d) => d.slot === slot);
  await waitFor(async () => {
    const s = await state(deck), a = by(s, 1), b = by(s, 2);
    return a?.bpm.state === 'LOCKED' && b?.bpm.state === 'LOCKED' && Math.abs(a.bpm.native - 124) < 0.3 && Math.abs(b.bpm.native - 128) < 0.3;
  }, 25000);
  set(deck, null, 'assist.on', false); // the reserve is seconds: deck 1 plays every gap from its buffer, captured at 1x
  assert.equal((await act(deck, 2, 'master')).ok, true);
  assert.equal((await act(deck, 2, 'play')).ok, true);
  await sleep(1000);
  assert.equal((await act(deck, 1, 'syncPlay')).ok, true);
  // Where each tab's track was when its deck's capture began: the gaps' places in each deck's input.
  const s0 = await state(deck), began = {};
  for (const [k, slot] of [['a', 1], ['b', 2]]) {
    const page = h.context.pages().find((p) => p.url() === server.url(k));
    began[slot] = (await page.evaluate(() => document.getElementById('a').currentTime)) - by(s0, slot).liveEdge;
  }
  await sleep(12000); // the follower settles on the master's beat
  await offscreenEval(h, PROBE);
  const known = await downloadIds(h), recFrom = (await state(deck)).ctxTime;
  assert.equal((await act(deck, null, 'mixRecStart')).ok, true);
  await sleep(REC_S * 1000);
  await act(deck, null, 'mixRecStop');
  rec = parseWav(fs.readFileSync((await waitForDownload(h, known)).filename));
  const ticks = await offscreenEval(h, 'window.__liveSync');
  const found = Object.fromEntries(await offscreenEval(h, '[...globalThis.__jdsEngine.decks.values()].map((d) => [d.slot, d.tempo.track.jump ? d.tempo.track.jump.n + 1 : 0])'));

  const m = beatMatch(rec, onsetBias(124, 'low', 'low') - onsetBias(128, 'high', 'high'));
  const off = m.off.filter((o) => o.t > 0.15 && o.t < m.seconds - 0.15).map((o) => Math.abs(o.ms)).sort((x, y) => x - y);
  const med = off[off.length >> 1], max = off.at(-1);
  const bent = { 1: bends(fineOnsets(rec, 'low')), 2: bends(fineOnsets(rec, 'high')) };
  // When each spliced gap reached its deck's playhead, in the recording's time.
  const heard = [];
  for (const [k, slot] of [['a', 1], ['b', 2]]) {
    let moved = 0;
    for (const g of [...GAPS[k]].sort((x, y) => x.at - y.at)) {
      const p = g.at - began[slot] - moved, x = ticks.find((y) => y[1] === slot && y[2] >= p);
      moved += g.ms / 1000;
      if (x) heard.push({ slot, ms: g.ms, t: x[0] - recFrom });
    }
  }
  // In the engine: how far each deck's scheduled rate left the rate it is synced to, and its playhead jumps.
  const eng = {};
  for (const slot of [1, 2]) {
    const xs = ticks.filter((x) => x[1] === slot), jumps = [];
    let bend = 0, at = null;
    for (let i = 1; i < xs.length; i++) {
      const [t1, , p1, r1, want, starved] = xs[i], [t0, , p0, r0] = xs[i - 1];
      if (!starved && want > 0 && Math.abs(r1 / want - 1) > bend) { bend = Math.abs(r1 / want - 1); at = xs[i - 1]; }
      const d = p1 - (p0 + ((r0 + r1) / 2) * (t1 - t0));
      if (Math.abs(d) > 0.004) jumps.push(`${(d * 1000).toFixed(1)} ms at ${p0.toFixed(2)} s`);
    }
    eng[slot] = { bend, jumps, at: at ? `at ${at[2].toFixed(2)} s (phase ${at[6] == null ? '-' : at[6].toFixed(1)} ms just before)` : '' };
  }
  t.diagnostic(`tempo error ${(m.tempoErr * 100).toFixed(4)} % (kick ${(60 / m.A.T).toFixed(3)}, click ${(60 / m.B.T).toFixed(3)} BPM); beat offsets median ${med.toFixed(1)} ms, max ${max.toFixed(1)} ms over ${off.length} beats`);
  for (const slot of [1, 2]) {
    t.diagnostic(`deck ${slot}: worst 4-beat bend in the recording ${pct(worst(bent[slot]))}; in the engine ${(eng[slot].bend * 100).toFixed(2)} % ${eng[slot].at}; playhead jumps ${eng[slot].jumps.join(', ') || 'none'}; capture gaps found ${found[slot]}`);
  }
  t.diagnostic(`spliced gaps heard at: ${heard.map((g) => `deck ${g.slot} ${g.ms} ms ${g.t.toFixed(2)} s`).join(', ')}`);
  assert.ok(rec.seconds > REC_S - 1, `${rec.seconds} s recorded`);
  assert.equal(heard.length, GAPS.a.length + GAPS.b.length, 'every spliced gap played during the recording');
  assert.ok(found[1] >= GAPS.a.length && found[2] >= GAPS.b.length, `capture gaps found: deck 1 ${found[1]} of ${GAPS.a.length}, deck 2 ${found[2]} of ${GAPS.b.length}`);
  assert.ok(Math.abs(m.tempoErr) < 0.002, `tempo error ${(m.tempoErr * 100).toFixed(4)} %`);
  assert.ok(med <= 20 && max <= 40, `beat offsets median ${med.toFixed(1)} ms, max ${max.toFixed(1)} ms`);
  // Around each spliced gap (from 2 s before it, the beats that lead into it, to 3 s after), neither deck bends.
  for (const g of heard) {
    for (const slot of [1, 2]) {
      const w = worst(bent[slot].filter((x) => x.t > g.t - 2 && x.t < g.t + 3));
      assert.ok(Math.abs(w.dev) <= 0.005, `deck ${slot} bent ${pct(w)} of the recording, around deck ${g.slot}'s ${g.ms} ms gap at ${g.t.toFixed(2)} s`);
    }
  }
});
