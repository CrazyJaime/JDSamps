// Added to a test AudioContext before any other worklet module: counts process() calls of every
// processor registered after it. The 'jds-test-counter' node answers any port message with the counts.
const calls = {};
const register = globalThis.registerProcessor;
globalThis.registerProcessor = (name, cls) => {
  register(name, class extends cls {
    process(inputs, outputs, params) { calls[name] = (calls[name] || 0) + 1; return super.process(inputs, outputs, params); }
  });
};
register('jds-test-counter', class extends AudioWorkletProcessor {
  constructor() { super(); this.port.onmessage = () => this.port.postMessage({ ...calls }); }
  process() { return true; }
});
