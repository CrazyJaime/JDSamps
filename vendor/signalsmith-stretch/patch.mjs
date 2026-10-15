// Applies JD Samps' patches to Signalsmith Stretch 1.3.2 (both files). Idempotent: a patch whose
// replacement is already present is skipped. Run `node patch.mjs`; importing it changes nothing.
// 1. Buffer-streaming fix. Bug: in WasmProcessor.process(), the loop that copies buffered input advances
//    `audioSamples` by `count` instead of advancing the read cursor `inputSamples` and moving `audioSamples`
//    to the end of the buffer just consumed. Reads spanning two addBuffers() chunks then use wrong offsets.
// 2. destroy(): a remote method that releases the buffered audio and makes process() return false.
//    Upstream process() always returns true, and Chrome keeps running a disconnected AudioWorkletNode
//    whose process() returns true, forever, with its whole buffer. The engine calls it on eject.
// 3. process-cost (hunks with id 'process-cost'): upstream process() walks every buffered chunk from the
//    oldest on each 128-frame block, allocating a closure context per chunk, and makes new typed-array views
//    every block. With 240 s buffered that is ~5600 chunks per block per deck (measured: 6 decks took
//    ~560 ms/s of the audio thread and made ~350 MB/s of garbage). The scan now resumes from a cursor that
//    starts over whenever the front of the chunk list changes, copies with plain loops, and keeps its views
//    until the WASM memory grows. The output is bit-identical (tests/unit/stretch-process.test.mjs and the
//    OfflineAudioContext check in tests/browser/offline.test.mjs).
// 4. one-way (id 'one-way'): addBuffers() is posted with a null message id and the processor does not
//    answer a null id. Upstream answered every chunk (~22/s per deck), waking the main thread for nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Multi-line hunks are written with two spaces per indent level; upstream indents with tabs. */
const T = (s) => s.replace(/^(?: {2})+/gm, (m) => '\t'.repeat(m.length / 2));
const COST = 'process-cost', ONE_WAY = 'one-way';
export const PATCHES = [
  {
    old: '\t\t\t\t\t\taudioSamples += count;\n\t\t\t\t\t\tblockSamples += count;',
    new: '\t\t\t\t\t\tinputSamples += count; // PATCHED (JD Samps): was `audioSamples += count;`\n\t\t\t\t\t\taudioSamples = bufferEnd; // PATCHED (JD Samps)\n\t\t\t\t\t\tblockSamples += count;',
  },
  {
    old: '\t\t\t\taddBuffers: sampleBuffers => {',
    new: '\t\t\t\tdestroy: () => { this.destroyed = true; this.audioBuffers = []; }, // PATCHED (JD Samps): ends the processor\n\t\t\t\taddBuffers: sampleBuffers => {',
  },
  {
    old: '\t\tprocess(inputList, outputList, parameters) {\n',
    new: '\t\tprocess(inputList, outputList, parameters) {\n\t\t\tif (this.destroyed) return false; // PATCHED (JD Samps): see destroy()\n',
  },
  {
    id: COST,
    old: '\t\tupdateBuffers() {\n',
    new: T(`    // PATCHED (JD Samps): views of the WASM input/output buffers, made once; rebuilt only when the memory
    // grows (a new ArrayBuffer), the buffers move (updateBuffers) or the block size changes
    views(memory, blockSize) {
      let v = this.viewCache;
      if (!v || v.memory !== memory || v.buffersIn !== this.buffersIn || v.blockSize !== blockSize) {
        v = this.viewCache = {memory: memory, buffersIn: this.buffersIn, blockSize: blockSize, input: [], output: []};
        for (let c = 0; c < this.buffersIn.length; ++c) {
          v.input.push(new Float32Array(memory, this.buffersIn[c], this.bufferLength));
          v.output.push(new Float32Array(memory, this.buffersOut[c], blockSize));
        }
      }
      return v;
    }
    // PATCHED (JD Samps): index of the first buffered chunk that ends after input sample \`samples\` (its start
    // is left in this.cursorStart). Resumes from the previous answer instead of walking from the oldest
    // chunk; starts over whenever the front of the list changed (dropBuffers, destroy).
    seekChunk(samples) {
      let list = this.audioBuffers, index = this.cursorIndex, start = this.cursorStart;
      if (this.cursorList !== list || this.cursorFirst !== list[0]) {
        this.cursorList = list;
        this.cursorFirst = list[0];
        index = 0;
        start = this.audioBuffersStart;
      }
      while (index > 0 && start > samples) start -= list[--index][0].length;
      while (index < list.length && start + list[index][0].length <= samples) start += list[index++][0].length;
      this.cursorIndex = index;
      this.cursorStart = start;
      return index;
    }
`) + '\t\tupdateBuffers() {\n',
  },
  {
    id: COST,
    old: T(`      if (!currentMapSegment.active) {
        outputList[0].forEach((_, c) => {
          let channelBuffer = inputs[c%inputs.length];
          let buffer = new Float32Array(memory, this.buffersIn[c], outputBlockSize);
          buffer.fill(0);
        });
`),
    new: T(`      if (!currentMapSegment.active) {
        let views = this.views(memory, outputBlockSize).input; // PATCHED (JD Samps): cached views, a loop not a closure
        for (let c = 0; c < outputList[0].length; ++c) views[c].fill(0, 0, outputBlockSize);
`),
  },
  {
    id: COST,
    old: T(`        outputList[0].forEach((_, c) => {
          let channelBuffer = inputs[c%inputs.length];
          let buffer = new Float32Array(memory, this.buffersIn[c], outputBlockSize);
          if (channelBuffer) {
            buffer.set(channelBuffer);
          } else {
            buffer.fill(0);
          }
        })
`),
    new: T(`        let views = this.views(memory, outputBlockSize).input; // PATCHED (JD Samps): cached views, a loop not a closure
        for (let c = 0; c < outputList[0].length; ++c) {
          let channelBuffer = inputs[c%inputs.length];
          if (channelBuffer) {
            views[c].set(channelBuffer);
          } else {
            views[c].fill(0, 0, outputBlockSize);
          }
        }
`),
  },
  {
    id: COST,
    old: '\t\t\t\tlet buffers = outputList[0].map((_, c) => new Float32Array(memory, this.buffersIn[c], this.bufferLength));\n',
    new: '\t\t\t\tlet buffers = this.views(memory, outputBlockSize).input; // PATCHED (JD Samps): cached views\n',
  },
  {
    id: COST,
    old: '\t\t\t\t\tbuffers.forEach(b => b.fill(0, 0, blockSamples));\n',
    new: '\t\t\t\t\tfor (let c = 0; c < buffers.length; ++c) buffers[c].fill(0, 0, blockSamples); // PATCHED (JD Samps): no closure\n',
  },
  {
    id: COST,
    old: '\t\t\t\twhile (audioBufferIndex < this.audioBuffers.length && audioSamples < inputSamplesEnd) {\n',
    new: T(`        // PATCHED (JD Samps): start at the chunk holding inputSamples. The chunks before it all end before it;
        // upstream skipped them one by one, from the oldest, on every block.
        audioBufferIndex = this.seekChunk(inputSamples);
        audioSamples = this.cursorStart;
`) + '\t\t\t\twhile (audioBufferIndex < this.audioBuffers.length && audioSamples < inputSamplesEnd) {\n',
  },
  {
    id: COST,
    old: T(`            buffers.forEach((buffer, c) => {
              let channelBuffer = audioBuffer[c%audioBuffer.length];
              buffer.subarray(blockSamples).set(channelBuffer.subarray(startIndex, startIndex + count));
            });
`),
    new: T(`            for (let c = 0; c < buffers.length; ++c) { // PATCHED (JD Samps): a loop, not a closure (and its context) per chunk
              let channelBuffer = audioBuffer[c%audioBuffer.length];
              buffers[c].set(channelBuffer.subarray(startIndex, startIndex + count), blockSamples);
            }
`),
  },
  {
    id: COST,
    old: '\t\t\t\t\tbuffers.forEach(buffer => buffer.subarray(blockSamples).fill(0));\n',
    new: '\t\t\t\t\tfor (let c = 0; c < buffers.length; ++c) buffers[c].fill(0, blockSamples); // PATCHED (JD Samps): no closure\n',
  },
  {
    id: COST,
    old: T(`      outputList[0].forEach((channelBuffer, c) => {
        let buffer = new Float32Array(memory, this.buffersOut[c], outputBlockSize);
        channelBuffer.set(buffer);
      });
`),
    new: T(`      let outViews = this.views(memory, outputBlockSize).output; // PATCHED (JD Samps): cached views, a loop not a closure
      for (let c = 0; c < outputList[0].length; ++c) outputList[0][c].set(outViews[c]);
`),
  },
  {
    id: ONE_WAY,
    old: '\t\t\t\t\tlet result = remoteMethods[method](...data);\n',
    new: '\t\t\t\t\tlet result = remoteMethods[method](...data);\n\t\t\t\t\tif (messageId === null) return; // PATCHED (JD Samps): a one-way call (addBuffers) gets no reply\n',
  },
  {
    id: ONE_WAY,
    old: '\t\t\t\t\t\treturn post(transfer, key, ...args);\n',
    new: '\t\t\t\t\t\tif (key == \'addBuffers\') return void audioNode.port.postMessage([null, key].concat(args), transfer); // PATCHED (JD Samps): one-way, no reply per chunk\n\t\t\t\t\t\treturn post(transfer, key, ...args);\n',
  },
];

export function applyPatches(src, name = 'source') {
  for (const p of PATCHES) {
    if (src.includes(p.new)) continue;
    if (src.split(p.old).length !== 2) throw new Error(`${name}: patch anchor not found exactly once — check the upstream version`);
    src = src.replace(p.old, () => p.new);
  }
  return src;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const f of ['SignalsmithStretch.js', 'SignalsmithStretch.mjs']) {
    const file = path.join(HERE, f);
    const src = fs.readFileSync(file, 'utf8');
    const out = applyPatches(src, f);
    if (out === src) { console.log(`${f}: already patched`); continue; }
    fs.writeFileSync(file, out);
    console.log(`${f}: patched`);
  }
}
