// Real Deck + real worklets in a real-time AudioContext, with a stub engine. Counts process() calls
// per processor type (count-worklet.js) to check that ejected decks leave nothing running.
import SignalsmithStretch from '../../../vendor/signalsmith-stretch/SignalsmithStretch.mjs';
import { Deck } from '../../../engine/deck.js';
import { MasterClock } from '../../../engine/sync.js';
import { DECK_PARAMS, defaults } from '../../../shared/protocol.js';

const STRETCH_URL = new URL('../../../vendor/signalsmith-stretch/SignalsmithStretch.js', import.meta.url).href;
SignalsmithStretch.moduleUrl = STRETCH_URL;
const workletUrl = (f) => new URL(`../../../worklets/${f}`, import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const diff = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - (a[k] || 0)]));
const gc = async () => { for (let i = 0; i < 5; i++) { if (window.gc) window.gc(); await sleep(100); } };

async function boot() {
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.audioWorklet.addModule('./count-worklet.js');
  for (const f of ['deck-input.js', 'beatfx.js', 'recorder.js']) await ctx.audioWorklet.addModule(workletUrl(f));
  await ctx.audioWorklet.addModule(STRETCH_URL);
  await ctx.resume();
  const counter = new AudioWorkletNode(ctx, 'jds-test-counter');
  counter.connect(ctx.destination);
  const counts = () => new Promise((r) => { counter.port.onmessage = (e) => r(e.data); counter.port.postMessage(0); });
  const rate = async (ms) => { const a = await counts(); await sleep(ms); return diff(a, await counts()); };
  const silentSink = ctx.createGain(); silentSink.gain.value = 0; silentSink.connect(ctx.destination);
  const bus = ctx.createGain(); bus.gain.value = 0; bus.connect(ctx.destination);
  const tone = ctx.createOscillator(); tone.frequency.value = 220; tone.start();
  const env = { ctx, counts, rate, tone, delivered: [], errors: [] };
  env.engine = {
    ctx, params: { 'buffer.capSec': 240, 'rec.format': 'wav', 'bpm.range': 'AUTO', 'assist.on': false },
    decks: new Map(), clock: new MasterClock(), silentSink, master: { bus, removeDeck() {}, setAssign() {}, meterIn() {} },
    createStretch: () => SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }),
    deliver: (blob, name) => env.delivered.push({ name, size: blob.size }),
    event: (level, text) => { if (level === 'error') env.errors.push(text); },
    eject() {}, broadcast() {}, broadcastWave() {},
  };
  return env;
}

async function loadDeck(env, i) {
  const dest = env.ctx.createMediaStreamDestination();
  env.tone.connect(dest);
  const deck = new Deck(env.engine, { id: i, slot: 1, tabId: 100 + i, stream: dest.stream, meta: { title: `T${i}` }, params: defaults(DECK_PARAMS) });
  await deck.init();
  return { deck, dest };
}
async function idle(rec) { for (let i = 0; i < 100 && rec.state !== 'idle'; i++) await sleep(50); return rec.state; }

window.tests = {
  /** n load → play → record → eject cycles; odd cycles stop the recording first, even ones eject while recording. */
  async ejectCycles({ n }) {
    const env = await boot();
    try {
      const live = [];
      for (let i = 1; i <= n; i++) {
        const { deck, dest } = await loadDeck(env, i);
        await sleep(600);
        await deck.act('play');
        deck.recorder.start('wav');
        live.push(await env.rate(300));
        if (i % 2) { deck.recorder.stop(); await idle(deck.recorder); }
        await deck.dispose();
        env.tone.disconnect(dest);
      }
      await gc();
      await sleep(300);
      return { live, after: await env.rate(1000), delivered: env.delivered.length, errors: env.errors };
    } finally { await env.ctx.close(); }
  },
  /** A recording stopped while its deck stays loaded leaves no recorder processor behind. */
  async recStop() {
    const env = await boot();
    try {
      const { deck } = await loadDeck(env, 1);
      await sleep(300);
      deck.recorder.start('wav');
      await sleep(300);
      deck.recorder.stop();
      const state = await idle(deck.recorder);
      await gc();
      await sleep(200);
      const after = await env.rate(600);
      await deck.dispose();
      return { state, after, delivered: env.delivered.length };
    } finally { await env.ctx.close(); }
  },
};
window.ready = true;
