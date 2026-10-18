// engine/analysis-worker.js — whole-track analysis off the main thread (engine/analysis.js does the
// work; OdfCore comes in through it). In: {mono: Float32Array, sampleRate, range} with the mono
// downmix transferred. Out: the analysis, its waveform bytes transferred back, or {error}.
import { analyseMono } from './analysis.js';

self.onmessage = (e) => {
  try {
    const a = analyseMono(e.data.mono, e.data.sampleRate, e.data.range);
    self.postMessage(a, [a.wave.data.buffer]);
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
