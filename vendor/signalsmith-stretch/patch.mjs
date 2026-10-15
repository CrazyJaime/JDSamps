// Applies JD Samps' fix for Signalsmith Stretch 1.3.2 buffer-streaming mode. Idempotent.
// Bug: in WasmProcessor.process(), the loop that copies buffered input advances `audioSamples`
// by `count` instead of advancing the read cursor `inputSamples` and moving `audioSamples` to the
// end of the buffer just consumed. Reads spanning two addBuffers() chunks then use wrong offsets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD = '\t\t\t\t\t\taudioSamples += count;\n\t\t\t\t\t\tblockSamples += count;';
const NEW = '\t\t\t\t\t\tinputSamples += count; // PATCHED (JD Samps): was `audioSamples += count;`\n\t\t\t\t\t\taudioSamples = bufferEnd; // PATCHED (JD Samps)\n\t\t\t\t\t\tblockSamples += count;';
for (const f of ['SignalsmithStretch.js', 'SignalsmithStretch.mjs']) {
  const file = path.join(HERE, f);
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes('PATCHED (JD Samps)')) { console.log(`${f}: already patched`); continue; }
  if (src.split(OLD).length !== 2) throw new Error(`${f}: patch anchor not found exactly once — check the upstream version`);
  fs.writeFileSync(file, src.replace(OLD, NEW));
  console.log(`${f}: patched`);
}
