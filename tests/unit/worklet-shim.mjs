// Minimal AudioWorkletGlobalScope shim so worklet modules can be unit-tested in Node.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let counter = 0;
export async function loadWorklet(file, { sampleRate = 48000 } = {}) {
  const registered = {};
  globalThis.sampleRate = sampleRate;
  globalThis.currentFrame = 0;
  globalThis.currentTime = 0;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      const posted = [];
      this.port = {
        posted,
        onmessage: null,
        postMessage(msg, transfer) { posted.push({ msg, transfer: transfer || [] }); },
        deliver(msg) { if (this.onmessage) this.onmessage({ data: msg }); },
      };
    }
  };
  globalThis.registerProcessor = (name, cls) => { registered[name] = cls; };
  // Cache-bust so each call re-registers against the current globals.
  await import(`${pathToFileURL(path.resolve(file)).href}?v=${++counter}`);
  return registered;
}

/** Run a processor over a mono/stereo signal in 128-frame quanta. */
export function runBlocks(proc, channels, { quantum = 128, outChannels = 1 } = {}) {
  const n = channels[0].length;
  for (let s = 0; s + quantum <= n; s += quantum) {
    const input = channels.map((c) => c.subarray(s, s + quantum));
    const outputs = [Array.from({ length: outChannels }, () => new Float32Array(quantum))];
    proc.process([input], outputs, {});
  }
}
