// Applies JD Samps' patches to Signalsmith Stretch 1.3.2 (both files). Idempotent: a patch whose
// replacement is already present is skipped. Run `node patch.mjs`; importing it changes nothing.
// 1. Buffer-streaming fix. Bug: in WasmProcessor.process(), the loop that copies buffered input advances
//    `audioSamples` by `count` instead of advancing the read cursor `inputSamples` and moving `audioSamples`
//    to the end of the buffer just consumed. Reads spanning two addBuffers() chunks then use wrong offsets.
// 2. destroy(): a remote method that releases the buffered audio and makes process() return false.
//    Upstream process() always returns true, and Chrome keeps running a disconnected AudioWorkletNode
//    whose process() returns true, forever, with its whole buffer. The engine calls it on eject.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
