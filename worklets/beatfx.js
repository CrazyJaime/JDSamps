// worklets/beatfx.js — per-deck insert for the beat-locked GATE and the CRUSH effect.
// The gate pattern is computed per sample from the deck's beat clock, expressed in output
// frames (the AudioWorkletGlobalScope `currentFrame` clock), so it never drifts.

class BeatFx extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'off';
    this.depth = 1;
    this.stepBeats = 0.25;
    this.amount = 0.5;
    this.anchor = 0;
    this.period = sampleRate * 0.5;
    this.g = 1;
    this.mix = 0;
    this.coef = 1 - Math.exp(-1 / (0.002 * sampleRate));
    this.gbuf = new Float32Array(128);
    this.mbuf = new Float32Array(128);
    this.hold = new Float32Array(2);
    this.holdCount = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'mode') this.mode = m.mode;
      else if (m.t === 'gate') { this.depth = m.depth; this.stepBeats = m.stepBeats; }
      else if (m.t === 'crush') this.amount = m.amount;
      else if (m.t === 'clock' && m.periodFrames > 0) { this.anchor = m.anchorFrame; this.period = m.periodFrames; }
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    if (this.gbuf.length !== n) { this.gbuf = new Float32Array(n); this.mbuf = new Float32Array(n); }
    const gate = this.mode === 'gate', crush = this.mode === 'crush';
    const step = this.period * this.stepBeats;
    for (let i = 0; i < n; i++) {
      let gt = 1;
      if (gate) {
        const pos = (currentFrame + i - this.anchor) / step;
        if (pos - Math.floor(pos) >= 0.5) gt = 1 - this.depth;
      }
      this.g += (gt - this.g) * this.coef;
      this.mix += ((crush ? 1 : 0) - this.mix) * this.coef;
      this.gbuf[i] = this.g;
      this.mbuf[i] = this.mix;
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
