# Signalsmith Stretch (vendored, patched)

- Package: `signalsmith-stretch@1.3.2` from npm (JS/WASM release by Geraint Luff, MIT licence).
- `SignalsmithStretch.js` (UMD; also the AudioWorklet module) and `SignalsmithStretch.mjs`
  (ES module factory) are the npm files **plus one fix** applied by `patch.mjs`: buffer-streaming
  mode read the wrong samples (or threw and killed the node) whenever its read window spanned
  two `addBuffers()` chunks. Upstream HEAD a670068 (2026-09-25) still has the bug.
- Behaviour notes the engine relies on (measured in Chromium 141):
  - `schedule()` resolves to the stored segment; `p(t) = input + rate·(t − output)` is the audible position.
  - A new `schedule()` drops every change scheduled at/after `currentTime` (README says "after this one").
  - `active:false` lands ≈ `latency()/2` late; `numberOfInputs: 0` throws in `process()` — use 1, unconnected.
  - Needs `'wasm-unsafe-eval'` in the extension CSP; the factory's default `blob:` module URL is blocked,
    so the engine `addModule()`s this file and presets `SignalsmithStretch.moduleUrl`.
- To upgrade: `npm pack` the new version, copy both files, run `node patch.mjs` (it refuses if the
  anchor moved), then run the browser tests.
