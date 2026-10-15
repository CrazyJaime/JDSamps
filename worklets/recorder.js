// worklets/recorder.js — PCM capture for WAV recording. Converts to interleaved 16-bit
// in a preallocated batch and transfers each full batch (8192 frames ≈ 170 ms) to the
// engine, which appends it to a Blob — so memory stays flat for hours.

const BATCH = 8192;
const toI16 = (x) => {
  const s = x < -1 ? -1 : x > 1 ? 1 : x;
  return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
};

class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = null;
    this.n = 0;
    this.disposed = false;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'dispose') { // process() returns false from now on, so Chrome stops calling it
        this.disposed = true;
        this.on = false;
        this.buf = null;
      } else if (m.t === 'start') {
        this.on = true;
        this.buf = new Int16Array(BATCH * 2);
        this.n = 0;
      } else if (m.t === 'stop') {
        if (!this.on) return;
        this.on = false;
        this.flush(true);
      }
    };
  }

  flush(final) {
    const frames = this.n;
    const out = frames === BATCH ? this.buf : this.buf.slice(0, frames * 2);
    this.port.postMessage({ t: 'data', buf: out, frames, final }, [out.buffer]);
    this.buf = final ? null : new Int16Array(BATCH * 2);
    this.n = 0;
  }

  process(inputs) {
    if (this.disposed) return false;
    if (!this.on) return true;
    const input = inputs[0];
    const l = input && input.length ? input[0] : null;
    const r = input && input.length > 1 ? input[1] : l;
    const n = l ? l.length : 128;
    for (let i = 0; i < n; i++) {
      const j = this.n * 2;
      this.buf[j] = toI16(l ? l[i] : 0);
      this.buf[j + 1] = toI16(r ? r[i] : 0);
      if (++this.n === BATCH) this.flush(false);
    }
    return true;
  }
}

registerProcessor('jds-recorder', Recorder);
