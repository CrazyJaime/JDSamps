// The longest wall-clock gap (ms) between two process() calls on the audio thread: how long that thread was
// held up (a message deserialized there runs between render quanta). Any port message is answered with the
// longest gap since the last one, which starts a new measure.
registerProcessor('jds-test-gap', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.last = 0; this.max = 0;
    this.port.onmessage = () => { this.port.postMessage(this.max); this.max = 0; };
  }
  process() {
    const t = Date.now();
    if (this.last && t - this.last > this.max) this.max = t - this.last;
    this.last = t;
    return true;
  }
});
