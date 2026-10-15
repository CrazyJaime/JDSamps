// Real Deck + real worklets in a real-time AudioContext, with a stub engine whose ticks come from the
// real master worklet (as in the engine, a stalled main thread leaves a backlog of them). Checks what
// the audio path asks of the main thread, and that a stall of the main thread does not reach the audio.
import SignalsmithStretch from '../../../vendor/signalsmith-stretch/SignalsmithStretch.mjs';
import { Deck } from '../../../engine/deck.js';
import { createMaster } from '../../../engine/master.js';
import { MasterClock } from '../../../engine/sync.js';
import { DECK_PARAMS, defaults } from '../../../shared/protocol.js';

const STRETCH_URL = new URL('../../../vendor/signalsmith-stretch/SignalsmithStretch.js', import.meta.url).href;
SignalsmithStretch.moduleUrl = STRETCH_URL;
const workletUrl = (f) => new URL(`../../../worklets/${f}`, import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };

async function boot() {
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.audioWorklet.addModule('./capture-worklet.js');
  for (const f of ['deck-input.js', 'beatfx.js', 'recorder.js', 'master.js']) await ctx.audioWorklet.addModule(workletUrl(f));
  await ctx.audioWorklet.addModule(STRETCH_URL);
  await ctx.resume();
  const silentSink = ctx.createGain(); silentSink.gain.value = 0; silentSink.connect(ctx.destination);
  const master = createMaster(ctx);
  master.setVolume(0);
  const tone = ctx.createOscillator(); tone.frequency.value = 220; tone.start();
  const env = { ctx, silentSink, events: [] };
  env.engine = {
    ctx, params: { 'buffer.capSec': 240, 'rec.format': 'wav', 'bpm.range': 'AUTO', 'assist.on': false },
    decks: new Map(), clock: new MasterClock(), silentSink, master,
    createStretch: () => SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }),
    deliver() {}, eject() {}, broadcast() {}, updateClock() {},
    event: (level, text) => env.events.push({ level, text, at: ctx.currentTime }),
    wallNow: () => performance.timeOrigin + performance.now(), heardTime: () => ctx.currentTime, ctxTimeAtWall: () => ctx.currentTime,
  };
  const dest = ctx.createMediaStreamDestination();
  tone.connect(dest);
  const deck = new Deck(env.engine, { id: 1, slot: 1, tabId: 101, stream: dest.stream, meta: { title: 'tone' }, params: defaults(DECK_PARAMS) });
  await deck.init();
  env.engine.decks.set(deck.id, deck);
  master.onMeter(() => deck.tick(ctx.currentTime)); // the engine's tick
  env.deck = deck;
  return env;
}

/** Load a tone deck and play it once `reserve` seconds are buffered ahead of the start. */
async function playing(env, reserve) {
  const { deck } = env;
  for (let i = 0; i < 200 && !(deck.ts.liveEdge - deck.ts.lat - deck.cue >= reserve); i++) await sleep(20);
  await deck.act('play');
  await sleep(1000);
}

/** Count messages on the deck's ports for `seconds`: stretcher → main, main → stretcher, deck input → main. */
function countMessages(env, seconds) {
  const { deck } = env;
  const c = { fromStretch: {}, toStretch: {}, fromInput: {}, inputAudio: 0 };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const onStretch = (e) => bump(c.fromStretch, typeof e.data[0] === 'number' ? 'reply' : String(e.data[0]));
  const onInput = (e) => { bump(c.fromInput, e.data.t); if (e.data.L) c.inputAudio++; };
  deck.stretch.port.addEventListener('message', onStretch);
  deck.inputNode.port.addEventListener('message', onInput);
  const post = deck.stretch.port.postMessage;
  deck.stretch.port.postMessage = function (m, t) { bump(c.toStretch, Array.isArray(m) ? m[1] : 'other'); return post.call(this, m, t); };
  return sleep(seconds * 1000).then(() => {
    deck.stretch.port.removeEventListener('message', onStretch);
    deck.inputNode.port.removeEventListener('message', onInput);
    deck.stretch.port.postMessage = post;
    return c;
  });
}

window.tests = {
  /** Steady playback: what the stretcher and the deck input send to, and get from, the main thread. */
  async messages({ seconds }) {
    const env = await boot();
    try {
      await playing(env, 1.5);
      return { seconds, ...(await countMessages(env, seconds)), events: env.events };
    } finally { await env.deck.dispose(); await env.ctx.close(); }
  },
  /**
   * Block the main thread for blockMs while a deck plays with `reserve` s buffered. The deck output is
   * captured on the audio thread; schedule() calls with an explicit input (jumps) are counted.
   */
  async stall({ reserve, blockMs }) {
    const env = await boot();
    const { ctx, deck } = env;
    try {
      const cap = new AudioWorkletNode(ctx, 'jds-test-capture');
      deck.stretch.connect(cap);
      cap.connect(env.silentSink);
      await playing(env, reserve);
      const before = { reserve: deck.ts.reserveAt(ctx.currentTime), liveEdge: deck.ts.liveEdge };
      const jumps = [];
      const change = deck.ts.change.bind(deck.ts);
      deck.ts.change = (now, T, f) => { if (f.input !== undefined) jumps.push({ at: now, input: f.input }); return change(now, T, f); };
      let starved = false;
      const watch = setInterval(() => { starved = starved || deck.starved; }, 10);
      cap.port.postMessage('start');
      await sleep(300);
      const t0 = ctx.currentTime;
      busy(blockMs);
      const t1 = ctx.currentTime;
      await sleep(1500);
      const got = new Promise((r) => { cap.port.onmessage = (e) => r(e.data); });
      cap.port.postMessage('stop');
      const { peaks } = await got;
      clearInterval(watch);
      starved = starved || deck.starved;
      // Longest run of silent 128-frame blocks in the deck's output.
      let run = 0, longest = 0, silent = 0;
      for (const p of peaks) { if (p < 0.01) { run++; silent++; longest = Math.max(longest, run); } else run = 0; }
      return {
        blocks: peaks.length, silentBlocks: silent, longestSilentMs: (longest * 128 * 1000) / ctx.sampleRate,
        blockedMs: (t1 - t0) * 1000, before, after: { reserve: deck.ts.reserveAt(ctx.currentTime) }, starved, jumps,
        dropouts: deck.dropouts || null, events: env.events,
      };
    } finally { await deck.dispose(); await ctx.close(); }
  },
};
window.ready = true;
