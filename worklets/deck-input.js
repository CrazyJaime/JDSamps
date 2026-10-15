// worklets/deck-input.js — one per deck, fed by the captured tab's MediaStreamSource.
//  1. Counts input frames from 0: this is the deck's input timeline.
//  2. Batches stereo audio into 2048-frame transferable chunks for the time-shift buffer.
//  3. Runs the onset detection function on the mono downmix and batches its frames
//     (onset strength + waveform band levels) for tempo tracking and the UI waveform.
import { OdfCore } from './odf-core.js';

const CHUNK = 2048;
const ODF_BATCH = 8;
const AUDIBLE = 0.003; // about -50 dBFS

class DeckInput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
    this.mono = new Float32Array(128);
    this.newChunk(0);
    this.odf = new OdfCore(sampleRate, (full, low, t, bl, bm, bh) => this.onOdf(full, low, t, bl, bm, bh));
    this.newOdfBatch();
    this.disposed = false;
    this.live = false; // the timeline starts at the first real input block (the capture connects late)
    // Chrome keeps calling process() on a disconnected node until it returns false.
    this.port.onmessage = (e) => { if (e.data && e.data.t === 'dispose') this.disposed = true; };
    this.port.postMessage({ t: 'init', fps: this.odf.fps, spf: this.odf.spf, chunk: CHUNK });
  }

  newChunk(start) {
    this.L = new Float32Array(CHUNK);
    this.R = new Float32Array(CHUNK);
    this.fill = 0;
    this.chunkStart = start;
    this.peak = 0;
    this.firstAbove = -1;
  }

  newOdfBatch() {
    this.full = new Float32Array(ODF_BATCH);
    this.low = new Float32Array(ODF_BATCH);
    this.bands = new Uint8Array(ODF_BATCH * 3);
    this.nOdf = 0;
    this.odfT0 = 0;
  }

  onOdf(full, low, t, bl, bm, bh) {
    const i = this.nOdf;
    if (i === 0) this.odfT0 = t;
    this.full[i] = full;
    this.low[i] = low;
    this.bands[i * 3] = bl;
    this.bands[i * 3 + 1] = bm;
    this.bands[i * 3 + 2] = bh;
    if (++this.nOdf === ODF_BATCH) {
      this.port.postMessage(
        { t: 'odf', t0: this.odfT0, spf: this.odf.spf, full: this.full, low: this.low, bands: this.bands },
        [this.full.buffer, this.low.buffer, this.bands.buffer],
      );
      this.newOdfBatch();
    }
  }

  process(inputs) {
    if (this.disposed) return false;
    const input = inputs[0];
    const l = input && input.length ? input[0] : null;
    const r = input && input.length > 1 ? input[1] : l;
    if (!l && !this.live) return true;
    this.live = true;
    const n = l ? l.length : 128;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    const blockStart = this.frames;
    for (let i = 0; i < n; i++) {
      const a = l ? l[i] : 0;
      const b = r ? r[i] : 0;
      const f = this.fill;
      this.L[f] = a;
      this.R[f] = b;
      this.mono[i] = 0.5 * (a + b);
      const m = a > 0 ? a : -a, m2 = b > 0 ? b : -b, mx = m > m2 ? m : m2;
      if (mx > this.peak) this.peak = mx;
      if (this.firstAbove < 0 && mx > AUDIBLE) this.firstAbove = f;
      if (++this.fill === CHUNK) {
        this.port.postMessage(
          { t: 'chunk', start: this.chunkStart, L: this.L, R: this.R, peak: this.peak, firstAbove: this.firstAbove },
          [this.L.buffer, this.R.buffer],
        );
        this.newChunk(blockStart + i + 1);
      }
    }
    this.odf.push(this.mono, blockStart);
    this.frames += n;
    return true;
  }
}

registerProcessor('jds-deck-input', DeckInput);
