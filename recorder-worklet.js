// recorder-worklet.js — runs on the audio thread.
//
// When "armed" it copies incoming stereo frames and batches them up to the
// offscreen document, which accumulates raw PCM and encodes a WAV on stop.
// Batching (post every ~8k frames) keeps message traffic low.

class RecProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.buf = [];
    this.frames = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'arm') {
        this.armed = true;
        this.buf = [];
        this.frames = 0;
      } else if (d.type === 'stop') {
        this.armed = false;
        this.flush(true); // final batch
      }
    };
  }

  flush(final) {
    this.port.postMessage({ type: 'data', chunks: this.buf, final: !!final });
    this.buf = [];
    this.frames = 0;
  }

  process(inputs) {
    if (this.armed) {
      const input = inputs[0];
      if (input && input[0]) {
        const l = input[0];
        const r = input[1] || input[0]; // mono source -> duplicate
        // Copy: the engine reuses these buffers next block.
        this.buf.push([new Float32Array(l), new Float32Array(r)]);
        this.frames += l.length;
        if (this.frames >= 8192) this.flush(false);
      }
    }
    return true; // keep the node alive
  }
}

registerProcessor('rec-processor', RecProcessor);
