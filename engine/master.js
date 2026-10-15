// engine/master.js — master bus: decks → bus → volume → jds-master (limiter, meters, tick) → out → speakers.
// `out` is also the mix-recording tap, so recordings match what was heard.
import { knobToGain, crossfaderGains, deckXfGain } from './sync.js';
import { glide } from './params.js';

export function createMaster(ctx) {
  const bus = ctx.createGain();
  const vol = ctx.createGain();
  const node = new AudioWorkletNode(ctx, 'jds-master', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
  });
  const out = ctx.createGain();
  bus.connect(vol).connect(node).connect(out);
  out.connect(ctx.destination);
  const listeners = new Set();
  let last = { t: 'meter', frame: 0, peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, gr: 0 };
  node.port.onmessage = (e) => {
    const m = e.data;
    if (!m || m.t !== 'meter') return;
    last = m;
    for (const fn of listeners) fn(m);
  };
  const decks = new Map();
  let xf = { pos: 0.5, curve: 'SMOOTH' };
  const applyXf = (d) => glide(ctx, d.gain.gain, deckXfGain(d.assign, crossfaderGains(xf.pos, xf.curve)), 0.003);
  return {
    bus,
    out,
    onMeter(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get meter() { return last; },
    setVolume(k) { glide(ctx, vol.gain, knobToGain(k, 6)); },
    setLimiter(on) { node.port.postMessage({ t: 'limiter', on: !!on }); },
    setCrossfader(pos, curve) { xf = { pos, curve }; for (const d of decks.values()) applyXf(d); },
    addDeck(id, gainNode, assign) { const d = { gain: gainNode, assign }; decks.set(id, d); applyXf(d); },
    setAssign(id, assign) { const d = decks.get(id); if (d) { d.assign = assign; applyXf(d); } },
    removeDeck(id) { decks.delete(id); },
    dispose() { node.port.close(); for (const n of [bus, vol, node, out]) n.disconnect(); },
  };
}
