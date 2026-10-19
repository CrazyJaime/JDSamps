// Two LIVE decks beat-matched by SYNC, in the real extension (tabs loaded live, as with resident loading off): the
// follower holds the master's tempo and beat over a minute of master recording, and capture gaps in either tab's
// audio (its WAV spliced: a few ms dropped or repeated, as a tab capture under load does) are jumped across where the
// playhead reaches them, not bent back over afterwards: around each of them the recording shows no bend. (The box's
// own capture skips come on top, sometimes several within a few beats; at one jump a beat, the phase loop may bend
// after such a burst. They are reported, not judged: where a capture stepped is read from that deck's own tracker
// input, never from the engine's jumps, and every jump must answer a step there. The judgement: live-sync-judge.mjs.)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  prepareExtension, launchExtension, hubCall, tabIdFor, waitFor, installClient, act, set, state, offscreenEval, makeTrackWav,
  downloadIds, waitForDownload, parseWav,
} from './ext-harness.mjs';
import { TRACKS, GAPS, judge } from './live-sync-judge.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REC_S = 60;
const DIAG = process.env.JDS_DIAG; // a directory: the run is kept there, to judge again offline (live-sync-judge.mjs <dir>)
let h, server, deck;

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

// Each deck's tracker input (its ODF frames), where its capture's own steps are read, and the capture gaps it found.
const TAP = `(async () => {
  const m = await import('/engine/tempo.js'), P = m.DeckTempo.prototype, push = P.pushBatch, detect = P.detectJump;
  window.__odf = new Map();
  const of = (d) => { let a = window.__odf.get(d); if (!a) window.__odf.set(d, a = { sr: d.sr, fps: d.fps, batches: [], gaps: [] }); return a; };
  P.pushBatch = function (b) { of(this).batches.push({ t0: b.t0, spf: b.spf, full: Array.from(b.full), low: Array.from(b.low) }); return push.call(this, b); };
  P.detectJump = function () {
    const was = this.track.jump;
    detect.call(this);
    const j = this.track.jump;
    if (j && j !== was) of(this).gaps.push({ from: j.from, edge: this.tracker.lastT / this.sr, prev: j.prev, t0: this.clock.t0 / this.sr, T: this.clock.T / this.sr });
  };
  return true;
})()`;
// Each tick of the recording, for decks 1 and 2: [time, slot, playhead, scheduled rate, the rate it is synced to, starved,
// phase error (ms), dropout runs].
const PROBE = `(() => {
  const e = globalThis.__jdsEngine, log = window.__liveSync = [], orig = e.tick.bind(e);
  e.tick = (m) => {
    orig(m);
    const now = e.ctx.currentTime;
    for (const d of e.decks.values()) if (d.slot <= 2 && d.ts) log.push([now, d.slot, d.ts.posAt(now), d.ts.rateAt(now), d.effRate(d.ts.posAt(now)), d.starved, d.phaseMs, d.dropouts.runs]);
  };
  return true;
})()`;

before(async () => {
  server = await startServer();
  h = await launchExtension({ ext: prepareExtension() });
  for (const k of ['a', 'b']) await (await h.context.newPage()).goto(server.url(k));
  deck = await h.context.newPage();
  await deck.goto(`chrome-extension://${h.extId}/deck.html`);
  await deck.evaluate(() => chrome.storage.local.set({ 'resident.auto': false }));
  await offscreenEval(h, TAP);
  for (const k of ['a', 'b']) {
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: await tabIdFor(h, server.url(k)) });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  await installClient(deck);
});
after(async () => { await h?.close(); await server?.close(); });

test('two synced live decks: a minute of master recording at one tempo and on one beat, capture gaps jumped, no bend', async (t) => {
  const by = (s, slot) => s.decks.find((d) => d.slot === slot);
  let seen = '';
  await waitFor(async () => {
    const s = await state(deck), a = by(s, 1), b = by(s, 2);
    seen = [a, b].map((d) => d && `deck ${d.slot} ${d.bpm.state} ${d.bpm.native} BPM, reserve ${d.reserve}`).join('; ');
    return a?.bpm.state === 'LOCKED' && b?.bpm.state === 'LOCKED' && Math.abs(a.bpm.native - 124) < 0.3 && Math.abs(b.bpm.native - 128) < 0.3;
  }, 25000).catch((e) => { throw new Error(`${e.message}: ${seen}`); });
  set(deck, null, 'assist.on', false); // the reserve is seconds: deck 1 plays every gap from its buffer, captured at 1x
  assert.equal((await act(deck, 2, 'master')).ok, true);
  assert.equal((await act(deck, 2, 'play')).ok, true);
  await sleep(1000);
  assert.equal((await act(deck, 1, 'syncPlay')).ok, true);
  // Where each tab's track was when its deck's capture began: the gaps' places in each deck's input.
  const began = {};
  for (const [k, slot] of [['a', 1], ['b', 2]]) {
    const page = h.context.pages().find((p) => p.url() === server.url(k));
    const edge = () => offscreenEval(h, `[...globalThis.__jdsEngine.decks.values()].find((d) => d.slot === ${slot}).ts.liveEdge`);
    const e0 = await edge(), at = await page.evaluate(() => document.getElementById('a').currentTime), e1 = await edge();
    began[slot] = at - (e0 + e1) / 2;
  }
  await sleep(12000); // the follower settles on the master's beat
  await offscreenEval(h, PROBE);
  const known = await downloadIds(h), recFrom = (await state(deck)).ctxTime;
  assert.equal((await act(deck, null, 'mixRecStart')).ok, true);
  await sleep(REC_S * 1000);
  await act(deck, null, 'mixRecStop');
  const file = (await waitForDownload(h, known)).filename;
  const ticks = await offscreenEval(h, 'window.__liveSync');
  const odf = await offscreenEval(h, 'JSON.stringify({ decks: [...globalThis.__jdsEngine.decks.values()].map((d) => ({ slot: d.slot, ...window.__odf.get(d.tempo) })) })');
  if (DIAG) {
    const segs = await offscreenEval(h, '[...globalThis.__jdsEngine.decks.values()].map((d) => [d.slot, d.grids.segs.map((s) => [s.from, s.shift || 0])])');
    fs.mkdirSync(DIAG, { recursive: true });
    fs.copyFileSync(file, path.join(DIAG, 'mix.wav'));
    fs.writeFileSync(path.join(DIAG, 'ticks.json'), JSON.stringify({ recFrom, began, segs, ticks }));
    fs.writeFileSync(path.join(DIAG, 'odf.json'), odf);
  }
  const { notes, fails } = judge({ rec: parseWav(fs.readFileSync(file)), ticks, began, recFrom, odf: JSON.parse(odf), seconds: REC_S });
  for (const n of notes) t.diagnostic(n);
  assert.deepEqual(fails, []);
});
