// worklets/beatfx.js — per-deck insert for the beat-locked GATE and the CRUSH effect, plus the
// FLANGER's LFO on output 1. Both are computed per sample from the deck's beat clock, expressed in
// output frames (the AudioWorkletGlobalScope `currentFrame` clock), so they never drift.

// GATE: 16 steps of the FX beat length (1/4 beat → one bar). 1 = the step opens for its first
// half, 0 = a rest. A trance-gate gallop (x.xx per beat) with a turnaround on the last beat.
const GATE_PATTERN = new Uint8Array([1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 0]);

class BeatFx extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'off';
    this.depth = 1;
    this.stepBeats = 0.25;
    this.amount = 0.5;
    // Beat clock: `anchor` is the output frame of beat number `beat` (a running count, so pattern
    // and LFO positions stay put when the deck re-anchors on a later beat).
    this.anchor = 0;
    this.beat = 0;
    this.period = sampleRate * 0.5;
    this.clocked = false;
    this.gateStart = 0; // beat on which pattern step 0 falls
    this.gateRestart = false;
    this.lfoOn = false;
    this.lfoBeats = 4; // FLANGER sweep length in beats
    this.lfoStart = 0; // beat on which a sweep starts
    this.lfoRestart = false;
    this.lfo = -1;
    this.g = 1;
    this.mix = 0;
    this.coef = 1 - Math.exp(-1 / (0.002 * sampleRate));
    this.gbuf = new Float32Array(128);
    this.mbuf = new Float32Array(128);
    this.hold = new Float32Array(2);
    this.holdCount = 0;
    this.disposed = false;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'dispose') this.disposed = true; // process() returns false from now on, so Chrome stops calling it
      else if (m.t === 'mode') { if (m.mode === 'gate' && this.mode !== 'gate') this.gateRestart = true; this.mode = m.mode; }
      else if (m.t === 'gate') { this.depth = m.depth; this.stepBeats = m.stepBeats; }
      else if (m.t === 'crush') this.amount = m.amount;
      else if (m.t === 'clock' && m.periodFrames > 0) {
        this.beat = Math.round(this.beat + (m.anchorFrame - this.anchor) / this.period);
        this.anchor = m.anchorFrame; this.period = m.periodFrames; this.clocked = true;
      } else if (m.t === 'flanger') {
        if (m.on && !this.lfoOn) this.lfoRestart = true;
        this.lfoOn = !!m.on;
        if (m.periodBeats > 0) this.lfoBeats = m.periodBeats;
        if (!this.clocked && m.bpm > 0) { // no grid yet: keep the beat position, follow the BPM
          const b = this.beat + (currentFrame - this.anchor) / this.period, P = (sampleRate * 60) / m.bpm;
          this.beat = Math.floor(b); this.anchor = currentFrame - (b - this.beat) * P; this.period = P;
        }
      }
    };
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const inp = inputs[0], out = outputs[0];
    const lfoOut = outputs[1] && outputs[1][0];
    const n = out[0].length;
    if (this.gbuf.length !== n) { this.gbuf = new Float32Array(n); this.mbuf = new Float32Array(n); }
    const gate = this.mode === 'gate', crush = this.mode === 'crush';
    const dB = 1 / this.period;
    const b0 = this.beat + (currentFrame - this.anchor) * dB;
    if (this.gateRestart) { this.gateStart = Math.round(b0); this.gateRestart = false; }
    if (this.lfoRestart) { this.lfoStart = Math.round(b0); this.lfoRestart = false; }
    // The LFO may move at most twice its own sweep speed, so a re-phase glides instead of clicking.
    const slew = (8 * dB) / this.lfoBeats;
    for (let i = 0; i < n; i++) {
      const b = b0 + i * dB;
      let gt = 1;
      if (gate) {
        const pos = (b - this.gateStart) / this.stepBeats, k = Math.floor(pos);
        if (pos - k >= 0.5 || !GATE_PATTERN[((k % 16) + 16) % 16]) gt = 1 - this.depth;
      }
      this.g += (gt - this.g) * this.coef;
      this.mix += ((crush ? 1 : 0) - this.mix) * this.coef;
      this.gbuf[i] = this.g;
      this.mbuf[i] = this.mix;
      const ph = (b - this.lfoStart) / this.lfoBeats;
      const tri = 1 - 4 * Math.abs(ph - Math.floor(ph) - 0.5); // -1 on the sweep's first beat, +1 halfway
      this.lfo += Math.max(-slew, Math.min(slew, tri - this.lfo));
      if (lfoOut) lfoOut[i] = this.lfo;
    }
    const bits = 16 - 12 * this.amount;
    const q = Math.pow(2, bits - 1);
    const factor = 1 + Math.floor(this.amount * 15);
    const startCount = this.holdCount;
    for (let c = 0; c < out.length; c++) {
      const src = inp && inp.length ? inp[Math.min(c, inp.length - 1)] : null;
      const dst = out[c];
      let count = startCount;
      for (let i = 0; i < n; i++) {
        const x = src ? src[i] : 0;
        let y = x;
        const mx = this.mbuf[i];
        if (mx > 1e-4) {
          if (count === 0) this.hold[c] = Math.round(x * q) / q;
          y = x * (1 - mx) + this.hold[c] * mx;
          count = (count + 1) % factor;
        }
        dst[i] = y * this.gbuf[i];
      }
      if (c === out.length - 1) this.holdCount = count;
    }
    return true;
  }
}

registerProcessor('jds-beatfx', BeatFx);
