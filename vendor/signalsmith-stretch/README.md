# Signalsmith Stretch (vendored, patched)

- Package: `signalsmith-stretch@1.3.2` from npm (JS/WASM release by Geraint Luff, MIT licence).
- `SignalsmithStretch.js` (UMD; also the AudioWorklet module) and `SignalsmithStretch.mjs`
  (ES module factory) are the npm files **plus the patches** applied by `patch.mjs` (each line is
  marked `PATCHED (JD Samps)`):
  1. Fix: buffer-streaming mode read the wrong samples (or threw and killed the node) whenever its
     read window spanned two `addBuffers()` chunks. Upstream HEAD a670068 (2026-09-25) still has the bug.
  2. Addition: a `destroy()` remote method. It releases the buffered audio and makes `process()` return
     false. Upstream `process()` always returns true, and Chrome keeps running a disconnected
     AudioWorkletNode whose `process()` returns true (measured: ≈375 calls/s at 48 kHz after
     `disconnect()` + GC), holding up to 240 s of float32 stereo. `Deck.dispose()` calls it on eject.
  3. Performance (`process-cost` hunks): upstream `process()` walks every buffered chunk from the oldest one
     on each 128-frame block and allocates a closure context per chunk, so its cost grows with the history.
     Measured with 6 decks at the 240 s cap: ~560 ms/s of the realtime audio thread and ~350 MB/s of garbage.
     The scan now resumes from a cursor (`seekChunk()`, which starts over whenever the front of the chunk list
     changes), copies with plain loops, and caches its views of the WASM buffers (`views()`, rebuilt when the
     memory grows). The output is bit-identical: `tests/unit/stretch-process.test.mjs` and the
     OfflineAudioContext check in `tests/browser/offline.test.mjs` compare against the file without this patch.
  4. One-way `addBuffers()` (`one-way` hunks): the node posts it with a `null` message id and the processor
     does not answer a `null` id, so it returns `undefined`, not a Promise. Upstream answered every chunk
     (~22/s per deck), each answer a main-thread wakeup nobody read.
- Behaviour notes the engine relies on (measured in Chromium 141):
  - `schedule()` resolves to the stored segment; `p(t) = input + rate·(t − output)` is the audible position.
  - A new `schedule()` drops every change scheduled at/after `currentTime` (README says "after this one").
  - `active:false` lands ≈ `latency()/2` late; `numberOfInputs: 0` throws in `process()` — use 1, unconnected.
  - Needs `'wasm-unsafe-eval'` in the extension CSP; the factory's default `blob:` module URL is blocked,
    so the engine `addModule()`s this file and presets `SignalsmithStretch.moduleUrl`.
- To upgrade: `npm pack` the new version, copy both files, run `node patch.mjs` (it refuses if an
  anchor moved), then run the browser tests.
