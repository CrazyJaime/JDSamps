import { createIsolator, createTrim } from '../../../engine/eq.js';
import { createDjFilter, createFxRack } from '../../../engine/fx.js';
import { createMaster } from '../../../engine/master.js';

const SR = 48000;
const WORKLETS = ['../../../worklets/beatfx.js', '../../../worklets/master.js'];

async function offline(sec) {
  const ctx = new OfflineAudioContext(2, Math.round(sec * SR), SR);
  for (const w of WORKLETS) await ctx.audioWorklet.addModule(w);
  return ctx;
}
let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
function source(ctx, fill) {
  const b = ctx.createBuffer(2, ctx.length, SR);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = fill(i / SR, c, i); }
  const s = ctx.createBufferSource(); s.buffer = b; s.start();
  return s;
}
const idx = (t) => Math.round(t * SR);
const rms = (d, a, b) => { let s = 0; for (let i = idx(a); i < idx(b); i++) s += d[i] * d[i]; return Math.sqrt(s / (idx(b) - idx(a))); };
const peakAbs = (d, a, b) => { let p = 0; for (let i = idx(a); i < idx(b); i++) p = Math.max(p, Math.abs(d[i])); return p; };
const db = (x) => 20 * Math.log10(x);
const sine = (f, amp) => (t) => amp * Math.sin(2 * Math.PI * f * t);
const settle = () => new Promise((r) => setTimeout(r, 50));
// Worklet port messages posted just before startRendering() are not processed by an
// OfflineAudioContext unless the worklet scope gets a moment first (verified in Chromium 141).
// Real-time contexts deliver them within milliseconds, so only the offline harness waits.
async function render(ctx) { await new Promise((r) => setTimeout(r, 100)); return ctx.startRendering(); }

window.tests = {
  async eqFlat() {
    const ctx = await offline(2); const s = source(ctx, () => rnd() * 0.5);
    const eq = createIsolator(ctx); s.connect(eq.input); eq.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { db: db(rms(out, 0.2, 1.9) / rms(s.buffer.getChannelData(0), 0.2, 1.9)) };
  },
  async eqKill({ band, freq }) {
    const ctx = await offline(2); const s = source(ctx, sine(freq, 0.5));
    const eq = createIsolator(ctx); eq.kill(band, true); s.connect(eq.input); eq.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { db: db(rms(out, 0.5, 1.5) / rms(s.buffer.getChannelData(0), 0.5, 1.5)) };
  },
  async eqBoost() {
    const ctx = await offline(1.5); const s = source(ctx, sine(1000, 0.2));
    const eq = createIsolator(ctx); eq.set('mid', 1); s.connect(eq.input); eq.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { db: db(rms(out, 0.5, 1.4) / rms(s.buffer.getChannelData(0), 0.5, 1.4)) };
  },
  async trim({ k }) {
    const ctx = await offline(1); const s = source(ctx, sine(440, 0.1));
    const t = createTrim(ctx); t.set(k); s.connect(t.input); t.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { db: db(rms(out, 0.3, 0.9) / rms(s.buffer.getChannelData(0), 0.3, 0.9)) };
  },
  async filter({ x, freq }) {
    const ctx = await offline(1.5); const s = source(ctx, sine(freq, 0.5));
    const f = createDjFilter(ctx); f.set(x, 0); s.connect(f.input); f.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { db: db(rms(out, 0.5, 1.4) / rms(s.buffer.getChannelData(0), 0.5, 1.4)) };
  },
  async echo() {
    const ctx = await offline(1); const s = source(ctx, (t, c, i) => (i === idx(0.1) ? 1 : 0));
    const rack = createFxRack(ctx); rack.setFx({ type: 'ECHO', beats: 0.5, level: 0.5, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    let at = 0, best = 0;
    for (let i = idx(0.2); i < idx(0.5); i++) if (Math.abs(out[i]) > best) { best = Math.abs(out[i]); at = i / SR; }
    return { at, best };
  },
  async gate() {
    const ctx = await offline(1); const s = source(ctx, sine(1000, 0.5));
    const rack = createFxRack(ctx);
    rack.setClock(0, SR * 0.5);
    rack.setFx({ type: 'GATE', beats: 0.25, level: 1, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    // 1/4-beat steps of 0.125 s from the beat at 0: step 0 opens for its first half, step 1 is a rest.
    return { open: rms(out, 0.01, 0.055), closed: rms(out, 0.075, 0.12), rest: rms(out, 0.135, 0.18), open2: rms(out, 0.26, 0.305) };
  },
  async crush() {
    const ctx = await offline(1); const s = source(ctx, sine(220, 0.8));
    const rack = createFxRack(ctx); rack.setFx({ type: 'CRUSH', beats: 0.5, level: 1, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    const vals = new Set(); for (let i = idx(0.5); i < idx(0.6); i++) vals.add(out[i].toFixed(6));
    return { distinct: vals.size };
  },
  async flanger() {
    const ctx = await offline(1.5); const s = source(ctx, () => rnd() * 0.3);
    const rack = createFxRack(ctx); rack.setFx({ type: 'FLANGER', beats: 0.5, level: 1, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0); const inp = s.buffer.getChannelData(0);
    let xy = 0, xx = 0, yy = 0; for (let i = idx(0.5); i < idx(1.4); i++) { xy += inp[i] * out[i]; xx += inp[i] ** 2; yy += out[i] ** 2; }
    return { corr: xy / Math.sqrt(xx * yy) };
  },
  /** Clicks every 10 ms: the wet copy's offset from each click traces the flanger delay over time. */
  async flangerSweep({ anchor, beats }) {
    const ctx = await offline(3.2), every = idx(0.01);
    const s = source(ctx, (t, c, i) => (i % every === 0 ? 1 : 0));
    const rack = createFxRack(ctx);
    rack.setClock(idx(anchor), SR * 0.5); // 120 BPM grid with a beat at `anchor`
    rack.setFx({ type: 'FLANGER', beats, level: 1, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    const t = [], d = [];
    for (let i0 = idx(0.05); i0 + every <= out.length; i0 += every) {
      let w = 0, m = 0;
      for (let k = 12; k < every - 12; k++) { const a = Math.abs(out[i0 + k]); w += a; m += a * k; }
      if (w > 0.2) { t.push(i0 / SR); d.push(m / w / SR); }
    }
    // Sweep bottoms: midway between a falling and the next rising crossing of the mid delay.
    const mid = (Math.min(...d) + Math.max(...d)) / 2, cross = [];
    for (let j = 1; j < d.length; j++) {
      if ((d[j - 1] - mid) * (d[j] - mid) < 0) cross.push({ at: t[j - 1] + ((mid - d[j - 1]) / (d[j] - d[j - 1])) * (t[j] - t[j - 1]), up: d[j] > d[j - 1] });
    }
    const bottoms = [];
    for (let j = 1; j < cross.length; j++) if (!cross[j - 1].up && cross[j].up) bottoms.push((cross[j - 1].at + cross[j].at) / 2);
    return { bottoms, minMs: Math.min(...d) * 1000, maxMs: Math.max(...d) * 1000 };
  },
  async reverb() {
    const ctx = await offline(1.5); const s = source(ctx, (t, c, i) => (i === idx(0.05) ? 1 : 0));
    const rack = createFxRack(ctx); rack.setFx({ type: 'REVERB', beats: 1, level: 1, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { tail: rms(out, 0.6, 0.9) };
  },
  async fxOffIsTransparent() {
    const ctx = await offline(1); const s = source(ctx, () => rnd() * 0.3);
    const rack = createFxRack(ctx); rack.setFx({ type: 'ECHO', beats: 0.5, level: 0.5, on: false, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0); const inp = s.buffer.getChannelData(0);
    let maxDiff = 0; for (let i = idx(0.2); i < idx(0.9); i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - inp[i]));
    return { maxDiff };
  },
  async limiter({ amp, on }) {
    const ctx = await offline(1.2); const s = source(ctx, sine(200, amp));
    const m = createMaster(ctx); m.setLimiter(on);
    const meters = []; m.onMeter((x) => meters.push(x));
    s.connect(m.bus); m.out.disconnect(); m.out.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    await settle();
    return { peak: peakAbs(out, 0.1, 1.1), inRms: rms(s.buffer.getChannelData(0), 0.2, 1.0), outRms: rms(out, 0.2, 1.0), minGr: Math.min(...meters.map((x) => x.gr)), ticks: meters.length, frames: meters.map((x) => x.frame) };
  },
  /** A deck's post-fader meter from jds-master (its input = the deck slot) against an AnalyserNode
   *  (fftSize 2048, what Deck.meterTick used to read) on the same fader, read at the same frames. */
  async deckMeter() {
    const ctx = await offline(2);
    const s = source(ctx, (t, c) => (c ? 0.3 * Math.sin(2 * Math.PI * 440 * t + 0.4) : 0.5 * Math.sin(2 * Math.PI * 440 * t)) + 0.05 * Math.sin(2 * Math.PI * 61 * t));
    const fader = ctx.createGain();
    fader.gain.setValueAtTime(0.9, 0); fader.gain.setValueAtTime(0.4, 1);
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    const m = createMaster(ctx);
    s.connect(fader); fader.connect(an); m.meterIn(3, fader);
    const meters = []; m.onMeter((x) => meters.push(x));
    const reads = [], buf = new Float32Array(2048);
    for (let k = 4; k * 1536 < 2 * SR; k += 3) {
      const F = k * 1536;
      if (F > SR && F - 2048 < SR) continue; // a window across the fader move: the two windows differ in length
      ctx.suspend(F / SR).then(() => {
        an.getFloatTimeDomainData(buf);
        let pk = 0, sq = 0;
        for (const x of buf) { pk = Math.max(pk, Math.abs(x)); sq += x * x; }
        reads.push({ frame: F, peak: pk, rms: Math.sqrt(sq / buf.length) });
        ctx.resume();
      });
    }
    await render(ctx);
    await settle(); await settle();
    return reads.map((r) => {
      const x = meters.find((y) => y.frame === r.frame);
      return { ...r, worklet: x ? { peak: x.decks[6], rms: x.decks[7], clip: x.decks[8], others: [...x.decks.slice(0, 6), ...x.decks.slice(9)] } : null };
    });
  },
  async xfader() {
    const ctx = await offline(1); const s = source(ctx, sine(440, 0.5));
    const m = createMaster(ctx); const g = ctx.createGain();
    s.connect(g).connect(m.bus); m.out.disconnect(); m.out.connect(ctx.destination);
    m.addDeck(1, g, 'A'); m.setCrossfader(1, 'SMOOTH');
    const out = (await render(ctx)).getChannelData(0);
    return { rms: rms(out, 0.3, 0.9) };
  },
};
window.ready = true;
