// Seeded synthetic drum loops with known beat times (ported from the research prototype).
export const FS = 48000;

export function makeRng(seed = 777) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const range = (a, b, s) => { const r = []; for (let v = a; v < b - 1e-9; v += s) r.push(v); return r; };

export const PATTERNS = {
  house: { bpm: 124, pat: [['kick', [0, 1, 2, 3], 0.9], ['snare', [1, 3], 0.4], ['ohat', [0.5, 1.5, 2.5, 3.5], 0.35], ['hat', range(0, 4, 0.25), 0.12], ['bass', [0.5, 1.5, 2.5, 3.5], 0.3]] },
  techno: { bpm: 132.7, pat: [['kick', [0, 1, 2, 3], 0.9], ['hat', range(0, 4, 0.25), 0.25], ['ohat', [0.5, 1.5, 2.5, 3.5], 0.2], ['bass', [0.25, 0.5, 1.25, 1.5, 2.25, 2.5, 3.25, 3.5], 0.2]] },
  boombap: { bpm: 92, swing: 0.55, human: 0.006, pat: [['kick', [0, 1.75, 2.5], 0.9], ['snare', [1, 3], 0.6], ['hat', range(0, 4, 0.25), 0.18], ['chord', [0, 2], 0.15]] },
  trap: { bpm: 140, pat: [['kick', [0, 0.75, 2.5, 3.25], 0.9], ['snare', [2], 0.6], ['hat', range(0, 4, 0.25), 0.2], ['hat', [3.125, 3.375, 3.625, 3.875], 0.15]] },
  dnb: { bpm: 174, pat: [['kick', [0, 2.5], 0.9], ['snare', [1, 3], 0.6], ['hat', range(0, 4, 0.5), 0.2], ['bass', [0, 2.5], 0.25]] },
  pop: { bpm: 102, padDb: -12, pat: [['kick', [0, 2], 0.5], ['snare', [1, 3], 0.35], ['chord', range(0, 4, 0.5), 0.12]] },
  dembow: { bpm: 95, pat: [['kick', [0, 1, 2, 3], 0.9], ['snare', [0.75, 1.5, 2.75, 3.5], 0.5], ['hat', range(0, 4, 0.5), 0.15]] },
  slowhh: { bpm: 75, swing: 0.4, human: 0.008, pat: [['kick', [0, 2.25, 2.75], 0.9], ['snare', [1, 3], 0.6], ['hat', range(0, 4, 0.25), 0.15]] },
  noisy128: { bpm: 128, noiseDb: -14, padDb: -10, pat: [['kick', [0, 1, 2, 3], 0.6], ['snare', [1, 3], 0.3], ['hat', range(0, 4, 0.25), 0.1]] },
  swing126: { bpm: 126, swing: 0.6, human: 0.004, pat: [['kick', [0, 1, 2, 3], 0.9], ['snare', [1, 3], 0.5], ['hat', range(0, 4, 0.25), 0.2], ['bass', [0.5, 1.5, 2.5, 3.5], 0.25]] },
  // Half-time feel: the accents are two beats apart, only the 8th-note hats carry the pulse.
  halftime140: { bpm: 140, pat: [['kick', [0, 2.5], 0.9], ['snare', [2], 0.7], ['hat', range(0, 4, 0.5), 0.12]] },
  dense150: { bpm: 150, noiseDb: -10, padDb: -8, pat: [['kick', [0, 1, 2, 3], 0.8], ['snare', [1, 3], 0.5], ['hat', range(0, 4, 0.125), 0.15], ['bass', range(0, 4, 0.25), 0.2]] },
  ambient: { bpm: 100, padDb: -6, pat: [['chord', [0], 0.1]] },
};

/**
 * @returns {{x: Float32Array, truth: number[] (beat times, s), beatSec: number}}
 * tail: seconds of pad/noise appended after the last bar (0 = exact bar length).
 */
export function synth({ bpm, bars = 24, pat, swing = 0, human = 0, noiseDb = -40, padDb = -18, rate = 1, tail = 0.5, seed = 777 }) {
  const rnd = makeRng(seed); const nrm = () => rnd() * 2 - 1;
  const beat = 60 / (bpm * rate);
  const n = Math.ceil((bars * 4 * beat + tail) * FS);
  const out = new Float32Array(n);
  const add = (t0, fn, len) => { const s = Math.round(t0 * FS); for (let i = 0; i < len * FS && s + i < n; i++) if (s + i >= 0) out[s + i] += fn(i / FS); };
  const kick = (g) => { let ph = 0; return (t) => { ph += 2 * Math.PI * (45 + 75 * Math.exp(-t / 0.03)) / FS; return g * Math.sin(ph) * Math.exp(-t / 0.18); }; };
  const snare = (g) => (t) => g * (0.7 * nrm() * Math.exp(-t / 0.09) + 0.4 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.05));
  let hp = 0;
  const hat = (g, dec) => (t) => { const v = nrm(); const o = v - hp; hp = v; return g * 0.5 * o * Math.exp(-t / dec); };
  const bass = (g, f) => (t) => g * (((t * f) % 1) * 2 - 1) * Math.exp(-t / 0.15) * Math.min(1, t / 0.005);
  const chord = (g) => (t) => g * nrm() * Math.min(1, t / 0.03) * Math.exp(-t / 0.25);
  const truth = [];
  for (let b = 0; b < bars; b++) {
    for (let q = 0; q < 4; q++) truth.push((b * 4 + q) * beat);
    for (const [inst, positions, g] of pat) {
      for (let p of positions) {
        if (swing && Math.abs((p % 0.5) - 0.25) < 1e-6) p += swing * 0.25;
        const t0 = (b * 4 + p) * beat + (human ? nrm() * human : 0);
        if (inst === 'kick') add(t0, kick(g), 0.6);
        else if (inst === 'snare') add(t0, snare(g), 0.4);
        else if (inst === 'hat') add(t0, hat(g, 0.02), 0.12);
        else if (inst === 'ohat') add(t0, hat(g, 0.12), 0.4);
        else if (inst === 'bass') add(t0, bass(g, 55), 0.4);
        else if (inst === 'chord') add(t0, chord(g), 0.8);
      }
    }
  }
  const pad = 10 ** (padDb / 20), nz = 10 ** (noiseDb / 20);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    out[i] += pad * (Math.sin(2 * Math.PI * 220 * t) + 0.7 * Math.sin(2 * Math.PI * 277.2 * t) + 0.5 * Math.sin(2 * Math.PI * 329.6 * t + Math.sin(2 * Math.PI * 5 * t))) / 2.2;
    out[i] += nz * nrm();
  }
  return { x: out, truth, beatSec: beat };
}

/** Error (s) from t to the nearest truth beat. */
export function nearestBeatError(t, truth) {
  let best = Infinity;
  for (const tb of truth) if (Math.abs(t - tb) < Math.abs(best)) best = t - tb;
  return best;
}
