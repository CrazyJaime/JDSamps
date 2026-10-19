// The live-sync acceptance's judgement of one run (tests/browser/live-sync.test.mjs), apart from the browser so a run
// kept with JDS_DIAG (mix.wav, ticks.json, odf.json) can be judged again offline: node live-sync-judge.mjs <dir>.
//
// Where each deck's capture really stepped is read from its own tracker input (the onsets in its ODF frames), never
// from what the engine did: a spliced gap shows there, and so does each of the box's own capture skips. Every engine
// playhead jump must answer a step in that deck's capture: at a spliced gap by its size, near one of the box's own
// steps as reported trouble. A jump where the capture shows no step fails, and only the box's own steps (and dropouts)
// are left out of the bounds, so a product that jumps or bends for no reason cannot excuse itself.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseWav, bandOnsets, steadyBeats, onsetBias, beatMatch } from './ext-harness.mjs';

// Track A (kick, 124 BPM: the follower, deck 1) and track B (click, 128 BPM: the master, deck 2), 240 s each, with
// capture gaps spliced in at track seconds the decks play during the recording: ms > 0 drops that much, < 0 repeats it.
export const TRACKS = { a: { bpm: 124, kind: 'low' }, b: { bpm: 128, kind: 'high' } };
export const GAPS = { a: [{ ms: 15, at: 24.1 }, { ms: -12, at: 36.3 }, { ms: 20, at: 48.2 }, { ms: -10, at: 60.4 }], b: [{ ms: -15, at: 30.2 }, { ms: 12, at: 54.1 }] };
const DECKS = [{ slot: 1, k: 'a', band: 'low', follower: true }, { slot: 2, k: 'b', band: 'full', follower: false }];
const STEP_MS = 4;   // the smallest step read in a capture
const NEAR = 0.6;    // s of input: a step read in a capture, or a gap the tracker found, against a spliced gap's place
const AFTER = 2.5;   // s of input a jump may come after its step (a gap found as the playhead went through it)

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
 * A deck's tempo bends (fraction) through its beats: the slope of every 4 consecutive beats against the steady period,
 * as {t (the first beat), dev}; of the four least-squares slopes through 3 of them, the one nearest the period. A
 * phase-loop bend (0.5-4 % for up to a beat or two) or a capture gap played as it came moves the beats after it, and
 * shows in all four; one beat off on its own does not (an onset's jitter, or the box's capture moving one beat by a few
 * ms and back, too small a step to find: seen 7 ms in the master's own tracker input, played as it came).
 */
function bends(on) {
  const T = steadyBeats(on).T, out = [];
  for (let i = 0; i + 4 <= on.length; i++) {
    const xs = on.slice(i, i + 4);
    if (xs.some((x, j) => j && Math.abs(x - xs[j - 1] - T) > T / 4)) continue; // a missing beat: not 4 in a row
    let dev = Infinity;
    for (let out1 = 0; out1 < 4; out1++) {
      const k = [0, 1, 2, 3].filter((j) => j !== out1), km = (k[0] + k[1] + k[2]) / 3, ym = (xs[k[0]] + xs[k[1]] + xs[k[2]]) / 3;
      const slope = k.reduce((q, j) => q + (j - km) * (xs[j] - ym), 0) / k.reduce((q, j) => q + (j - km) ** 2, 0);
      if (Math.abs(slope / T - 1) < Math.abs(dev)) dev = slope / T - 1;
    }
    out.push({ t: xs[0], dev });
  }
  return out;
}
const worst = (xs) => xs.reduce((w, x) => (Math.abs(x.dev) > Math.abs(w.dev) ? x : w), { t: 0, dev: 0 });
const pct = (x) => `${(x.dev * 100).toFixed(2)} % at ${x.t.toFixed(2)} s`;
const det3 = (a, b, c, d, e, f, g, h, i) => a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);

/** A deck's onsets (input s) in its tracker input: the peaks of one band of its ODF frames, at least 0.6 beat apart. */
function inputOnsets(d, band, T) {
  const v = [], t = [];
  for (const b of d.batches) for (let i = 0; i < b[band].length; i++) { v.push(b[band][i]); t.push((b.t0 + i * b.spf) / d.sr); }
  const spf = d.batches.length ? d.batches[0].spf / d.sr : 0, peaks = [];
  for (let i = 1; i + 1 < v.length; i++) if (v[i] > v[i - 1] && v[i] >= v[i + 1]) peaks.push(i);
  const hi = peaks.map((i) => v[i]).sort((a, b) => a - b), ref = hi[Math.floor(hi.length * 0.9)] || 0, out = [], vals = [];
  for (const i of peaks) {
    if (v[i] < 0.3 * ref) continue;
    const a = v[i - 1], b = v[i], c = v[i + 1], q = a - 2 * b + c, x = t[i] + (q < 0 ? (0.5 * (a - c)) / q : 0) * spf;
    if (out.length && x - out[out.length - 1] < 0.6 * T) { if (b > vals[vals.length - 1]) { out[out.length - 1] = x; vals[vals.length - 1] = b; } continue; }
    out.push(x); vals.push(b);
  }
  return out;
}

/**
 * Where a deck's capture stepped: {p (input s), ms} for each step of at least STEP_MS in its onsets (period T), the
 * largest first, each the step of a level and a slope over 8 beats on each side (the analysis frames' own few ms of
 * jitter from beat to beat average out), taken out of the onsets after it before the next is looked for.
 */
export function inputSteps(d, band, T, W = 8) {
  const o = inputOnsets(d, band, T), n = [0];
  for (let k = 1; k < o.length; k++) n.push(n[k - 1] + Math.max(1, Math.round((o[k] - o[k - 1]) / T)));
  const r = o.map((x, k) => x - n[k] * T), out = [];
  const stepAt = (k) => { // between onsets k and k + 1
    if (k - W + 1 < 0 || k + W >= o.length) return null;
    let s1 = 0, si = 0, su = 0, sii = 0, siu = 0, sy = 0, siy = 0, suy = 0;
    for (let j = k - W + 1; j <= k + W; j++) {
      const i = n[j] - n[k], u = j > k ? 1 : 0, y = r[j];
      s1++; si += i; su += u; sii += i * i; siu += i * u; sy += y; siy += i * y; suy += u * y;
    }
    const det = det3(s1, si, su, si, sii, siu, su, siu, su);
    return det ? det3(s1, si, sy, si, sii, siy, su, siu, suy) / det : null;
  };
  for (let it = 0; it < 60; it++) {
    let bk = -1, bd = 0;
    for (let k = 0; k + 1 < o.length; k++) { const D = stepAt(k); if (D != null && Math.abs(D) > Math.abs(bd)) { bd = D; bk = k; } }
    if (bk < 0 || Math.abs(bd) * 1000 < STEP_MS) break;
    out.push({ p: (o[bk] + o[bk + 1]) / 2, ms: bd * 1000 });
    for (let j = bk + 1; j < o.length; j++) r[j] -= bd;
  }
  return out.sort((a, b) => a.p - b.p);
}

/**
 * Judge one run: rec (parseWav of the master recording), ticks ([time, slot, playhead, scheduled rate, synced rate,
 * starved, phase ms, dropout runs] per engine tick), began (track second at each deck's input 0), recFrom (context time
 * the recording began), odf ({decks: [{slot, sr, batches, gaps}]}: each deck's tracker input and the gaps it found).
 * Returns {notes, fails}: diagnostics, and what failed.
 */
export function judge({ rec, ticks, began, recFrom, odf, gaps = GAPS, seconds = 60 }) {
  const notes = [], fails = [], check = (ok, msg) => { if (!ok) fails.push(msg); };
  const at = (slot, p) => { const x = ticks.find((y) => y[1] === slot && y[2] >= p); return x ? x[0] - recFrom : null; }; // recording time the playhead reached p
  // Where each spliced gap is in its deck's input, and when its playhead reached it (recording time).
  const heard = [];
  for (const { slot, k } of DECKS) {
    let moved = 0;
    for (const g of [...gaps[k]].sort((x, y) => x.at - y.at)) {
      const p = g.at - began[slot] - moved;
      moved += g.ms / 1000;
      heard.push({ slot, ms: g.ms, p, t: at(slot, p) });
    }
  }
  // Each deck's capture: the steps in its own tracker input. A spliced gap shows as a step of -ms (a drop brings the
  // beats after it early); any other is one of the box's own capture skips. A spliced gap the box's capture also
  // stepped at or near (both decks' captures can skip together) is the box's trouble too: not judged.
  const own = [], input = {};
  for (const { slot, k, band } of DECKS) {
    const d = odf.decks.find((x) => x.slot === slot), steps = inputSteps(d, band, 60 / TRACKS[k].bpm);
    input[slot] = { steps, found: d.gaps.map((g) => g.from) };
    for (const s of steps) if (!heard.some((g) => g.slot === slot && Math.abs(s.p - g.p) < NEAR)) own.push({ slot, ...s });
  }
  for (const g of heard) {
    const st = input[g.slot].steps.filter((s) => Math.abs(s.p - g.p) < NEAR);
    g.step = st.length ? st.reduce((a, b) => (Math.abs(b.ms + g.ms) < Math.abs(a.ms + g.ms) ? b : a)) : null;
    g.boxy = !g.step || Math.abs(g.step.ms + g.ms) > STEP_MS || own.some((s) => s.slot === g.slot && Math.abs(s.p - g.p) < 1.5);
    if (!g.boxy) check(input[g.slot].found.some((f) => Math.abs(f - g.p) < NEAR), `deck ${g.slot} did not find its ${g.ms} ms gap at input ${g.p.toFixed(2)} s (found ${input[g.slot].found.map((f) => f.toFixed(2)).join(', ') || 'none'})`);
  }
  // Every playhead jump answers a step in its own deck's capture: at a spliced gap by its size (a follower also takes
  // off the few ms it sat off the beat, under the phase loop's 5 ms deadband), near the box's own as reported trouble.
  const eng = {}, rough = [];
  for (const { slot, follower } of DECKS) {
    const xs = ticks.filter((x) => x[1] === slot), jumps = [];
    let bend = 0, worstAt = null;
    for (let i = 1; i < xs.length; i++) {
      const [t1, , p1, r1, want, starved, , dry1] = xs[i], [t0, , p0, r0, , , ph0, dry0] = xs[i - 1];
      if (!starved && want > 0 && Math.abs(r1 / want - 1) > bend) { bend = Math.abs(r1 / want - 1); worstAt = xs[i - 1]; }
      if (dry1 > dry0) rough.push({ slot, t: t1 - recFrom, until: 2, what: 'a dropout' });
      const d = p1 - (p0 + ((r0 + r1) / 2) * (t1 - t0));
      if (Math.abs(d) <= 0.004) continue;
      const ms = d * 1000, after = (s) => p0 > s.p - NEAR && p0 < s.p + AFTER;
      const g = heard.find((x) => x.slot === slot && after(x)), b = own.find((x) => x.slot === slot && after(x));
      if (g && !g.boxy) {
        const tol = 3 + (follower ? Math.min(5, Math.abs(ph0 ?? 0)) : 0);
        jumps.push(`${ms.toFixed(1)} ms at ${p0.toFixed(2)} s`);
        check(Math.abs(ms + g.ms) <= tol, `deck ${slot} jumped ${ms.toFixed(1)} ms at input ${p0.toFixed(2)} s for its ${g.ms} ms gap (its capture stepped ${g.step.ms.toFixed(1)} ms there)`);
      } else if (g || b) jumps.push(`${ms.toFixed(1)} ms at ${p0.toFixed(2)} s (the box's)`);
      else {
        jumps.push(`${ms.toFixed(1)} ms at ${p0.toFixed(2)} s (no step in its capture)`);
        check(false, `deck ${slot} jumped ${ms.toFixed(1)} ms at input ${p0.toFixed(2)} s, where its capture shows no step`);
      }
    }
    eng[slot] = { bend, jumps, at: worstAt ? `at ${worstAt[2].toFixed(2)} s (phase ${worstAt[6] == null ? '-' : worstAt[6].toFixed(1)} ms just before)` : '' };
  }
  // The box's own trouble, from 1 s before to 2 s after (to 8 s after a skip over 25 ms, which leaves both decks'
  // captures lagging and catching up for seconds, so their grids settle and the follower follows): reported, and left
  // out of the bounds below. Only what the captures show counts as such, never a jump of the engine's.
  const first = Object.fromEntries(DECKS.map(({ slot }) => [slot, ticks.find((y) => y[1] === slot)]));
  for (const s of own) {
    const f = first[s.slot];
    if (!f || s.p < f[2] - 8) continue;
    const t = at(s.slot, Math.max(s.p, f[2]));
    if (t != null) rough.push({ slot: s.slot, t, until: Math.abs(s.ms) > 25 ? 8 : 2, what: `a ${s.ms.toFixed(0)} ms capture skip` });
  }
  for (const g of heard) if (g.boxy && g.t != null) rough.push({ slot: g.slot, t: g.t, until: Math.abs(g.step ? g.step.ms : g.ms) > 25 ? 8 : 2, what: `capture trouble at its ${g.ms} ms gap` });
  const smooth = (x) => !rough.some((r) => x > r.t - 1 && x < r.t + r.until);
  const m = beatMatch(rec, onsetBias(124, 'low', 'low') - onsetBias(128, 'high', 'high'));
  const all = m.off.filter((o) => o.t > 0.15 && o.t < m.seconds - 0.15), off = all.filter((o) => smooth(o.t)).map((o) => Math.abs(o.ms)).sort((x, y) => x - y);
  const med = off[off.length >> 1], max = off[off.length - 1];
  const bent = { 1: bends(fineOnsets(rec, 'low')), 2: bends(fineOnsets(rec, 'high')) };
  notes.push(`tempo error ${(m.tempoErr * 100).toFixed(4)} % (kick ${(60 / m.A.T).toFixed(3)}, click ${(60 / m.B.T).toFixed(3)} BPM); beat offsets median ${med?.toFixed(1)} ms, max ${max?.toFixed(1)} ms over ${off.length} beats; ${all.length - off.length} beats left out near the box's own capture trouble`);
  for (const { slot } of DECKS) {
    notes.push(`deck ${slot}: worst 4-beat bend in the recording ${pct(worst(bent[slot]))}; in the engine ${(eng[slot].bend * 100).toFixed(2)} % ${eng[slot].at}; playhead jumps ${eng[slot].jumps.join(', ') || 'none'}; steps in its capture ${input[slot].steps.map((s) => `${s.ms.toFixed(1)} ms at ${s.p.toFixed(2)} s`).join(', ') || 'none'}; capture gaps found ${input[slot].found.length}`);
  }
  notes.push(`spliced gaps heard at: ${heard.map((g) => `deck ${g.slot} ${g.ms} ms ${g.t == null ? '-' : g.t.toFixed(2)} s${g.boxy ? ' (the box\'s capture stepped there too)' : ''}`).join(', ')}`);
  notes.push(`the box's own capture trouble: ${rough.map((r) => `deck ${r.slot} ${r.what} at ${r.t.toFixed(2)} s`).join(', ') || 'none'}`);
  check(rec.seconds > seconds - 1, `${rec.seconds} s recorded`);
  check(heard.every((g) => g.t != null), 'every spliced gap played during the recording');
  check(off.length >= 0.5 * all.length, `the box's own capture trouble covers ${all.length - off.length} of ${all.length} beats: the run says too little`);
  check(Math.abs(m.tempoErr) < 0.002, `tempo error ${(m.tempoErr * 100).toFixed(4)} %`);
  check(med <= 20 && max <= 40, `beat offsets median ${med?.toFixed(1)} ms, max ${max?.toFixed(1)} ms`);
  // Around each spliced gap (from 2 s before it, the beats that lead into it, to 3 s after), neither deck bends; a gap
  // with the box's own trouble around it is not judged, but half of them must be.
  let judged = 0;
  for (const g of heard) {
    if (g.t == null) continue;
    const near = (slot) => bent[slot].filter((x) => x.t > g.t - 2 && x.t < g.t + 3 && smooth(x.t) && smooth(x.t + 1.5));
    if (g.boxy || near(1).length < 4 || near(2).length < 4) continue;
    judged++;
    for (const { slot } of DECKS) {
      const w = worst(near(slot));
      check(Math.abs(w.dev) <= 0.005, `deck ${slot} bent ${pct(w)} of the recording, around deck ${g.slot}'s ${g.ms} ms gap at ${g.t.toFixed(2)} s`);
    }
  }
  check(judged >= heard.length / 2, `only ${judged} of ${heard.length} spliced gaps clear of the box's own capture trouble: the run says too little`);
  return { notes, fails };
}

// node live-sync-judge.mjs <dir> ['<gaps json>']: judge a run JDS_DIAG kept.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2], read = (f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  const { recFrom, began, ticks } = read('ticks.json');
  const { notes, fails } = judge({ rec: parseWav(fs.readFileSync(`${dir}/mix.wav`)), ticks, began, recFrom, odf: read('odf.json'), gaps: process.argv[3] ? JSON.parse(process.argv[3]) : GAPS });
  for (const n of notes) console.log(`# ${n}`);
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(fails.length ? 'not ok' : 'ok');
  process.exitCode = fails.length ? 1 : 0;
}
