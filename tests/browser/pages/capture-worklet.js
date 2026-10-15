// Test tap: records the peak of every 128-frame block of its input on the audio thread, so a stalled
// main thread cannot hide a dropout. 'start' clears and starts; 'stop' answers {t0, peaks}.
registerProcessor('jds-test-capture', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.peaks = [];
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.peaks = []; this.t0 = currentTime; }
      else if (e.data === 'stop') { this.on = false; this.port.postMessage({ t0: this.t0, peaks: this.peaks }); }
    };
  }

  process(inputs) {
    if (!this.on) return true;
    const ch = inputs[0] && inputs[0][0];
    let p = 0;
    if (ch) for (let i = 0; i < ch.length; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > p) p = a; }
    this.peaks.push(p);
    return true;
  }
});
