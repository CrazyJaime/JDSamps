# Resident Decks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a deck hold a whole decoded track, so it is independent of its source tab, can be navigated anywhere, and is beat-gridded from whole-track analysis.

**Architecture:** A new deck kind, `resident`, reuses the existing `Deck`, Timeshift and stretcher with the whole track pushed in one `addBuffers` call and the live-window machinery gated off. Audio reaches it by a strategy ladder: direct file, re-fetching URLs the page requested, driving the page's player while a MAIN-world hook captures the bytes it appends, and output capture as an opt-in last resort. Captured media is assembled strictly by timeline position, decoded with `decodeAudioData`, and analysed once in a Worker to give a piecewise beat grid.

**Tech Stack:** Chrome MV3 extension, plain ES modules, no build step; Web Audio + AudioWorklet; vendored Signalsmith Stretch; Node `--test` for units; Playwright 1.56 + Chromium 141 (global install) for browser and E2E.

**Spec:** `docs/superpowers/specs/2026-10-18-jdsamps-resident-decks-design.md` — read it first. Section references (§n) below point into it.

**Ruling on plan granularity:** This plan fixes exact files, interfaces, message shapes and the failing tests (test code for the assertions that define each contract), and leaves implementation bodies to the implementer. The user asked for speed ("do both", "just build"). The implementers are agents working against the real code. Precise interfaces and RED-first tests are what keep six parallel streams from diverging. *Cost if wrong:* internal designs may diverge between streams; mitigated by the Interfaces blocks below, which every stream must honour verbatim.

## Global Constraints

- Chrome MV3, plain ES modules, **no build step, no npm runtime dependencies**. `minimum_chrome_version` stays `119`.
- **No YouTube signature decipher, and no site-specific protocol reverse-engineering.** Per-site knowledge lives only in the declarative site table (§4.6).
- **Bytes never travel on the agent port.** The MAIN world mints `blob:` URLs and only the URL string crosses (§5).
- In MAIN-world code, buffer type checks use **brand checks** (`Object.prototype.toString.call(x) === '[object ArrayBuffer]'`, `ArrayBuffer.isView`), **never `instanceof`** (§2).
- The MAIN-world agent stays **dormant until commanded**: no globals, no listeners before its first command, native-looking wrappers (existing conventions in `agent/agent-main.js`).
- **Nothing leaves the machine.** Decoded audio stays in memory; disk only via the existing recorder or an explicit save.
- A whole-track load uses **one** `addBuffers([L, R])` call (§7).
- A resident deck never runs: trim, the buffer cap or cap skip, starvation, the emergency jump, the dry-audio notice, player assist, or the deck-input worklet (§7).
- **Resident track limit** default: 15 minutes per deck (§10).
- A gapped, overlapping or truncated capture is **never** turned into a deck (§6).
- Tests: `node --test` units; browser tests use the globally installed Playwright with Chromium at `/opt/pw-browsers`; **never run `playwright install`**. This Chromium cannot decode AAC, so fixtures use Opus-in-MP4, WebM/Opus and MP3.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU
  ```

## Review Focus

1. **Two loads racing** (load tab A, then tab B before A is resident): each deck gets its own track, and tap data never crosses tabs or frames. *Pinned in Task R4.3.*
2. **Eject during loading**: the load cancels cleanly — the tab's rate, position and mute are restored, the capture stream is released, and no blob URL, Worker or agent command is left behind. *Pinned in Task R4.3.*
3. **Duration unknown or changing** (the element reports `Infinity`, then a number; or the manifest grows): never declare a truncated track resident. *Pinned in Task R3.3.*
4. **ABR switch mid-capture** (segments of the same span at two qualities): the stitched track has no doubled or missing audio at the switch. *Pinned in Task R3.3.*
5. **The page navigates away mid-load** (blob URLs die): the load fails over to live or reports an error, with no exception escaping and no half-built deck. *Pinned in Task R4.3.*

---

## File Structure

| File | Responsibility | Stream |
|---|---|---|
| `engine/deck.js` (modify) | `kind` ('live' / 'loading' / 'resident'); `initLive()` (today's `init`) and `initResident()`; resident gating of the live machinery; end of track; snapshot fields | R1 |
| `engine/engine.js` (modify) | `startResidentDeck`, `startLoadingDeck`, `loadFile` / `loadUrl` handlers, resident memory accounting, `deckByTab` ignoring null | R1 |
| `engine/decode.js` (create) | fetch a `blob:` or URL and decode to `{L, R, sampleRate}`; enforce the resident limit; resample if needed | R1 |
| `engine/analysis.js` (create) | main-thread side of whole-track analysis: worker orchestration, coarse tempo, staged grid fit, segmentation, bar-1 suggestion, waveform output | R2 |
| `engine/analysis-worker.js` (create) | Worker: run `OdfCore` over mono PCM, return frame arrays | R2 |
| `engine/tempo.js` (modify) | `DeckTempo.seed(analysis)` so a resident deck's manual tools work on the analysed grid without a live tracker | R2 |
| `agent/agent-main.js` (modify) | the tap: byte, URL and element layers; `drive` (seek-hop / accelerate); blob minting; fingerprint gaps fixed | R3 |
| `agent/agent-relay.js` (modify) | forward `tap` / `drive` commands and `tap-*` statuses | R3 |
| `engine/bmff.js` (create) | minimal ISO-BMFF reader: box iteration, `tfdt`, `mdhd` timescale; WebM cluster timecode; MP3/ADTS frame walk | R3 |
| `engine/assemble.js` (create) | group parts into runs, place on the timeline, choose per span, verify contiguity, decode runs and stitch | R3 |
| `engine/loader.js` (create) | the strategy ladder and the site table; progress; release of the source; the load report | R4 |
| `shared/protocol.js` (modify) | new UI actions, agent messages, snapshot fields, validators | R1 (UI/engine), R3 (agent) |
| `ui/deck-strip.js`, `ui/app.js`, `ui/sources.js`, `deck.html`, `deck.css` (modify) | loading state, kind badge, elapsed/remaining, LIVE hidden on resident, drag-drop and Load link, Copy load report, settings | R5 |
| `tests/browser/ext-harness.mjs` (modify) | model-site pages and fixtures | R6 |

---

## Shared Interfaces (every stream honours these verbatim)

### I1 — Resident deck (produced by R1)
```js
// engine/engine.js
startLoadingDeck({ tabId = null, streamId = null, meta }) // -> Promise<{ok:true, deckId, slot} | {ok:false, error}>
startResidentDeck({ deckId = null, tabId = null, pcm, meta, analysis = null })
  // pcm: { L: Float32Array, R: Float32Array, sampleRate: number }
  // deckId given -> promote that loading deck; otherwise create a new deck
  // -> Promise<{ok:true, deckId, slot} | {ok:false, error}>
failLoadingToLive(deckId, reason)   // loading deck holding a stream -> run today's live init; reason shown once
// engine/deck.js
deck.kind                // 'live' | 'loading' | 'resident'
deck.setLoad({ state, progress, strategy, error, report })  // state: 'loading'|'ready'|'error'
deck.appendResident({ L, R })        // slow paths: append decoded audio, trim stays off
deck.finishResident({ duration })    // loading -> resident
// snapshot per deck adds:
//   kind, duration (s|null), load: { state, progress (0..1), strategy, error|null, report|null }
// snapshot master adds: residentBytes
```

### I2 — Analysis (produced by R2)
```js
// engine/analysis.js
export async function analyseTrack({ L, R, sampleRate }, { lo, hi }) // -> Promise<{
//   bpm, conf, octConf,
//   segments: Array<{ from: number /*input s*/, grid: { t0: number, T: number } }>, // piecewise, increasing `from`
//   bar1: { t: number, conf: number } | null,
//   residuals: { median: number, max: number },          // ms
//   wave: { tStart: 0, hop: number /*s*/, data: Uint8Array /* bl,bm,bh per hop */ }
// }>
// engine/tempo.js
DeckTempo.prototype.seed(analysis)   // resident decks: lock to the analysed grid; evaluate() is never called
```

### I3 — Tap messages (produced by R3; consumed by R4)
```js
// engine -> agent (via relay), sent on the existing per-frame agent port
{ t: 'tap', on: boolean }
{ t: 'drive', mode: 'seekhop' | 'accelerate' | 'stop', step?: number /*s*/, rate?: number }
{ t: 'fetch', urls: string[], concurrency?: number }      // page-context fetch, results come back as tap-ready parts
{ t: 'readTralbum' }                                       // Bandcamp: answer with tap-ready kind:'file'
// agent -> engine
{ t: 'tap-progress', bytes: number, buffered: Array<[number, number]>, duration: number | null, mimes: string[] }
{ t: 'tap-urls', reqs: Array<{ url: string, method: string, range: string | null, size: number | null, media: boolean }> }
{ t: 'tap-ready', parts: Array<{ blobUrl: string, mime: string, kind: 'init' | 'media' | 'file', sb: number, seq: number }>, duration: number | null }
{ t: 'tap-error', reason: 'drm' | 'worker' | 'preview' | 'live' | 'none' | 'fetch', detail: string }
```

### I4 — Assembly (produced by R3; consumed by R4)
```js
// engine/assemble.js
export function placeParts(parts /* [{bytes: ArrayBuffer, mime, kind, sb, seq}] */)
  // -> { runs: Array<{ mime, init: ArrayBuffer|null, segs: Array<{ t0, t1, bytes }> }>, coverage: Array<[t0,t1]>, gaps: Array<[t0,t1]> }
export async function decodePlaced(ctx, placed, { duration })   // throws AssemblyError{gaps} if not contiguous over [0, duration]
  // -> { L, R, sampleRate }
// engine/bmff.js
export function boxes(buf) /* iterator of {type, start, end, size} */
export function tfdt(moofBuf)        // baseMediaDecodeTime (number)
export function timescale(initBuf)   // from mdhd
```

### I5 — UI actions (produced by R1 engine side; consumed by R5)
```js
// shared/protocol.js — UI -> engine
{ t: 'act', deck: null, a: 'loadFile',   arg: { name: string, blobUrl: string } }
{ t: 'act', deck: null, a: 'loadUrl',    arg: { url: string } }
{ t: 'act', deck: id,   a: 'loadCancel', arg: {} }
{ t: 'act', deck: id,   a: 'recordWhole',arg: {} }
// master param
'resident.limitMin'  // number, default 15, range 1..60, persisted
'resident.recordWhole' // boolean, default false, persisted
```

---

## Phases

| Phase | Tasks | Notes |
|---|---|---|
| **A** (parallel, now) | R1.1–R1.3, R2.1–R2.2, R3.1–R3.3, R6.1 | No stream depends on another's code yet; they agree on I1–I5 |
| **B** (after A merges) | R4.1–R4.3, R5.1–R5.2 | R5 also waits for the running `nav` and `tempo-entry` UI branches to merge |
| **C** | R6.2, full suite, whole-branch review | acceptance E2E across every model site |

---

## Stream R1 — Resident engine and direct files

### Task R1.1: Deck kind and resident gating

**Files:**
- Modify: `engine/deck.js` (constructor; `init` split into `initLive()` / `initResident()`; `tick`; `trim`; `act('live')`; `clampInput` use; `state()`)
- Modify: `engine/timeshift.js` (`clampInput` end margin for resident)
- Test: `tests/unit/deck-resident.test.mjs` (create)

**Interfaces:** Produces I1's `deck.kind`, `initResident`, `appendResident`, `finishResident`, `setLoad`, snapshot fields.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/deck-resident.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck } from './fixtures/deck-harness.mjs';

const tone = (sec, sr = 48000) => { const n = Math.round(sec * sr), L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = 0.3 * Math.sin(i / 7); return { L, R: L.slice(), sampleRate: sr }; };

test('a resident 300 s track never triggers the buffer-cap skip on first PLAY', async () => {
  const { d, clock, engine } = await makeDeck({ resident: tone(300) });
  assert.equal(d.kind, 'resident');
  await d.act('play');
  for (let i = 0; i < 200; i++) { clock.t += 0.032; d.tick(clock.t); }
  const p = d.ts.posAt(clock.t);
  assert.ok(p < 10, `playhead jumped to ${p.toFixed(1)} s (cap skip fired)`);
  assert.equal(engine.events.filter((e) => /skipped ahead/.test(e.text)).length, 0);
});

test('a resident deck plays to the end and stops there: no emergency loop, no dry notice', async () => {
  const { d, clock, engine } = await makeDeck({ resident: tone(20) });
  await d.act('play');
  for (let i = 0; i < 1000; i++) { clock.t += 0.032; d.tick(clock.t); }        // 32 s modelled
  assert.equal(d.ts.playingAt(clock.t), false, 'still playing past the end');
  const p = d.ts.posAt(clock.t);
  assert.ok(p >= 19.9 && p <= 20.0001, `stopped at ${p}`);
  assert.equal(engine.events.filter((e) => /ran dry|skipped ahead/.test(e.text)).length, 0);
});

test('a resident deck can seek to its last 0.1 s', async () => {
  const { d, clock } = await makeDeck({ resident: tone(30) });
  await d.act('seek', { pos: 29.9 });
  clock.t += 0.3; d.tick(clock.t);
  assert.ok(Math.abs(d.ts.posAt(clock.t) - 29.9) < 0.01);
});

test('a resident deck never schedules assist and never trims', async () => {
  const { d, clock } = await makeDeck({ resident: tone(120) });
  const sent = []; d.postAssist = (m) => sent.push(m);
  let trims = 0; const t0 = d.ts.trim.bind(d.ts); d.ts.trim = (...a) => { trims++; return t0(...a); };
  await d.act('play');
  for (let i = 0; i < 400; i++) { clock.t += 0.032; d.tick(clock.t); }
  assert.deepEqual(sent, []); assert.equal(trims, 0);
});

test('snapshot reports kind, duration and load state', async () => {
  const { d } = await makeDeck({ resident: tone(42) });
  const s = d.state();
  assert.equal(s.kind, 'resident'); assert.ok(Math.abs(s.duration - 42) < 1e-3);
  assert.equal(s.load.state, 'ready');
});
```

- [ ] **Step 2: Run them; expect FAIL** — `node --test tests/unit/deck-resident.test.mjs` → `makeDeck` has no `resident` option / `d.kind` undefined.

- [ ] **Step 3: Implement.**
  - Extend `tests/unit/fixtures/deck-harness.mjs` `makeDeck` with `{resident: pcm}`. When given, it builds the deck through `initResident(pcm)` against the harness's fake node, which must accept a single `addBuffers`.
  - In `Deck`:
    - Add `this.kind`. Split `init()`: the current body becomes `initLive()`, and `init()` calls it, so no call site changes.
    - `initResident(pcm)` builds the same stretch/EQ/FX/fader graph without `source`/`inputNode`/`attachInput`. It calls `addBuffers([L, R])` once, sets the Timeshift's `historyStart = 0` and `liveEdge = duration`, then `kind = 'resident'` and `load.state = 'ready'`.
    - Gate on `this.kind === 'resident'`:
      - the `nextTrim` call in `tick` and `trim()` entirely;
      - the starvation set/clear and the emergency jump;
      - `onDry`;
      - the `assistTick` call.
    - End of track: on a resident deck, when playing, schedule `active:false` at the input position equal to the duration (and re-plan it after every change).
    - `act('live')` on a resident deck returns `fail('A whole-track deck has no live edge.')`.
    - `clampInput` lets a resident deck reach `duration − 1 frame`.
  - `state()` adds `kind`, `duration`, `load`.

- [ ] **Step 4: Run** `node --test tests/unit/deck-resident.test.mjs` → PASS; then `npm run test:unit` → all pass.

- [ ] **Step 5: Commit** — `git commit -m "Resident decks: a deck can hold a whole track, with the live-window machinery off"`

### Task R1.2: Engine entry points, decode, memory limit

**Files:**
- Create: `engine/decode.js`
- Modify: `engine/engine.js` (`startLoadingDeck`, `startResidentDeck`, `failLoadingToLive`, `deckByTab`, act handlers `loadFile` / `loadUrl` / `loadCancel`, `residentBytes`)
- Modify: `shared/protocol.js` (I5 actions + master params + validators)
- Test: `tests/unit/engine-resident.test.mjs` (create), `tests/browser/resident-load.test.mjs` (create; add to `test:browser` in `package.json`)

**Interfaces:** Consumes I1 from R1.1; produces I1's engine functions and I5.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/engine-resident.test.mjs (pure parts)
import test from 'node:test';
import assert from 'node:assert/strict';
import { limitPcm } from '../../engine/decode.js';
import { validateUiMessage, defaults, MASTER_PARAMS } from '../../shared/protocol.js';

test('a source longer than the resident limit is cut to the limit and says so', () => {
  const sr = 1000, n = 20 * 60 * sr, L = new Float32Array(n), R = new Float32Array(n);
  const r = limitPcm({ L, R, sampleRate: sr }, 15);
  assert.equal(r.pcm.L.length, 15 * 60 * sr);
  assert.match(r.notice, /first 15 minutes/);
});

test('loadFile / loadUrl / loadCancel are valid UI actions; junk is not', () => {
  assert.ok(validateUiMessage({ t: 'act', deck: null, a: 'loadFile', arg: { name: 'a.mp3', blobUrl: 'blob:chrome-extension://x/y' } }));
  assert.ok(validateUiMessage({ t: 'act', deck: null, a: 'loadUrl', arg: { url: 'https://example.com/a.mp3' } }));
  assert.equal(validateUiMessage({ t: 'act', deck: null, a: 'loadUrl', arg: { url: 'javascript:alert(1)' } }), null);
  assert.equal(defaults(MASTER_PARAMS)['resident.limitMin'], 15);
});
```

```js
// tests/browser/resident-load.test.mjs (real extension, real decode)
// Serve an MP3 fixture from startTrackServer; in the deck page create a blob URL from a fetched File;
// send act loadFile; assert within 10 s: a deck with kind 'resident', duration within 0.1 s of the fixture,
// load.state 'ready'; send loadUrl with the fixture's http URL and assert the same; send loadUrl with a
// non-audio URL and assert {ok:false, error} mentions it is not audio.
```

- [ ] **Step 2: Run them; expect FAIL** (`engine/decode.js` missing; actions unknown).

- [ ] **Step 3: Implement.**
  - `decode.js`:
    - `fetchArrayBuffer(urlOrBlobUrl)`;
    - `decodeTo(ctx, buf)` returns `{L, R, sampleRate}`, duplicating mono to both channels;
    - `limitPcm(pcm, limitMin)` returns `{pcm, notice|null}`;
    - resample to `ctx.sampleRate` with an `OfflineAudioContext` when rates differ.
  - Engine:
    - `startResidentDeck` shares the MAX_DECKS check, slot search, defaults and `new Deck`, calls `deck.initResident(pcm)`, then accounts `residentBytes`.
    - `startLoadingDeck` creates a deck in `kind = 'loading'` holding its stream (if any) without running `initLive`.
    - `failLoadingToLive` runs `initLive()` with the held stream.
    - `deckByTab(null)` matches nothing.
    - The `loadFile` / `loadUrl` act handlers call decode, then the limit, then `startResidentDeck` with the file name or URL basename as title.
    - `loadCancel` cancels via the loader hook (a no-op until R4) and ejects the loading deck.
  - Protocol: the I5 actions with validators — `blobUrl` must start with `blob:`; `url` must be http(s). Master params `resident.limitMin` (number 1..60, default 15) and `resident.recordWhole` (boolean, default false), both in `PERSISTED_MASTER_KEYS`.

- [ ] **Step 4: Run** the two new test files → PASS; `npm run test:unit`, `npm run test:browser` → all pass.

- [ ] **Step 5: Commit** — `git commit -m "Load a local file or an audio link straight onto a resident deck"`

### Task R1.3: Resident-aware identity, eject and recorder

**Files:** Modify `engine/engine.js` (`eject`, `stopTab` skip when `tabId == null`, `DECKS_CHANGED` filters tabless decks), `engine/deck.js` (Recorder title, `dispose` for resident decks: no stream tracks, no input node). Test: extend `tests/unit/engine-resident.test.mjs` and `tests/browser/resident-load.test.mjs`.

- [ ] **Step 1: Failing tests:**
  - two resident decks load side by side (the second is not refused as "already on deck");
  - ejecting a resident deck sends no `STOP_TAB` and leaves no processors running — reuse the counting approach in `tests/browser/lifecycle.test.mjs`;
  - a resident deck's recording is titled after the track, not `Tab null`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the branches listed under Files.
- [ ] **Step 4: Run** → PASS; full unit + browser suites pass.
- [ ] **Step 5: Commit** — `git commit -m "Tabless resident decks eject, record and coexist cleanly"`

---

## Stream R2 — Whole-track analysis

### Task R2.1: Analysis worker and staged grid fit

**Files:** Create `engine/analysis-worker.js`, `engine/analysis.js`. Test: `tests/unit/analysis.test.mjs` (create).

**Interfaces:** Produces I2 `analyseTrack`. Reuses `OdfCore` from `worklets/odf-core.js` verbatim, `pickOctave` and `RELATED` from `engine/tempo.js`, and `GridMap` from `engine/timeshift.js`. Prototypes from the analysis probe are under `/tmp/claude-0/-home-user-JDSamps/0026a8ab-13e4-544b-b808-e8c814faceb3/scratchpad/filedeck/analysis/` — read them; they measured exactly this pipeline.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/analysis.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseTrackSync } from '../../engine/analysis.js';     // same pipeline, no Worker, for Node
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

const truthErrMs = (segments, beats) => { /* for each true beat time, nearest grid beat via the segment in force; return {median, p95} in ms */ };

for (const [name, bpm] of [['house', 124], ['techno', 130], ['dnb', 174], ['house', 76], ['trap', 140]]) {
  test(`whole-track analysis of ${name} at ${bpm} BPM: BPM within 0.01 %, grid within 3 ms median across the whole track`, () => {
    const { L, beats } = synth(PATTERNS[name], { bpm, seconds: 180 });
    const a = analyseTrackSync({ L, R: L, sampleRate: FS }, { lo: 70, hi: 180 });
    assert.ok(Math.abs(a.bpm - bpm) / bpm < 1e-4, `bpm ${a.bpm}`);
    const e = truthErrMs(a.segments, beats);
    assert.ok(e.median < 3 && e.p95 < 8, JSON.stringify(e));
  });
}

test('a track with a +0.5 % tempo ramp gets a piecewise grid that stays on the beats', () => { /* synth with ramp; assert segments.length > 1 and p95 < 25 ms */ });
test('two tempos in one file are split at the change point', () => { /* 124 then 100; assert a segment boundary within 1 s of the change */ });
test('a beatless track is refused: conf below the gate, no bar 1', () => { /* ambient fixture; conf < 0.25 */ });
test('the waveform covers the whole track at the analysis hop', () => { /* wave.data.length / 3 * hop ≈ duration */ });
test('analysis of 5 minutes takes under 2 s in Node', () => { /* timing guard with generous bound */ });
```

- [ ] **Step 2: Run; expect FAIL** (module missing).
- [ ] **Step 3: Implement** per §8.
  - Worker: mono Float32Array in (transferred), OdfCore frames out (transferred).
  - Main thread:
    - coarse tempo by ACF + comb, with the octave chosen by `pickOctave`;
    - phase combs over 10 s windows every 5 s, unwrapped beat numbers, then a clarity-weighted least-squares fit;
    - segmentation from per-20 s block tempi, with RELATED merges and refined change points;
    - a bar-1 suggestion only when its contrast clears a threshold;
    - residuals.
  - Export both `analyseTrack` (Worker) and `analyseTrackSync` (same code path, inline, for tests).
- [ ] **Step 4: Run** → PASS; `npm run test:unit` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "Whole-track analysis: a piecewise beat grid fitted to the entire track"`

### Task R2.2: Seed a deck from the analysis

**Files:** Modify `engine/tempo.js` (`DeckTempo.prototype.seed`), `engine/deck.js` (`initResident` calls `analyseTrack`, builds `GridMap` segments via `split`, seeds the tempo, fills `deck.wave`). Test: `tests/unit/deck-resident.test.mjs` (extend), `tests/unit/grid.test.mjs` (extend).

**Interfaces:** Consumes I2; produces "resident decks are gridded at ready time".

- [ ] **Step 1: Failing tests:**
  - a resident deck is `canBeat()` at its playhead the moment it is ready, with no 5 s wait;
  - TAP, ½×/2×, GRID ±½ and `setNativeBpm` act on the analysed grid at the playhead and survive (no `evaluate()` ever runs);
  - `waveBacklog()` holds the whole track.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `seed(analysis)`:
  - set the clock to the segment at the playhead;
  - state LOCKED with `conf` and `octConf` from the analysis;
  - mark the tempo as externally driven so `evaluate()` never resets it;
  - `canBeatAt` answers from the analysis confidence for any input position.
  - `initResident` awaits the analysis, then `grids.split(from, grid)` per segment, `tempo.seed`, and the wave fill (`appendWave` with `i0 = 0`).
- [ ] **Step 4: Run** → PASS; full unit suite passes.
- [ ] **Step 5: Commit** — `git commit -m "Resident decks are beat-gridded the moment they are ready"`

---

## Stream R3 — The page tap and strict assembly

### Task R3.1: MAIN-world tap (byte, URL, element layers)

**Files:** Modify `agent/agent-main.js`, `agent/agent-relay.js`, `shared/protocol.js` (`validateAgentMessage` for I3). Test: `tests/browser/agent-tap.test.mjs` (create; add to `test:browser`). Probe code to learn from: `/tmp/claude-0/-home-user-JDSamps/0026a8ab-13e4-544b-b808-e8c814faceb3/scratchpad/filedeck/tap/` (`probe1`–`probe12`, `ext3`).

**Interfaces:** Produces I3 messages.

- [ ] **Step 1: Write the failing tests** (browser; local MSE pages built from ffmpeg-made Opus-in-MP4 segments, as in the probe):
  - **Tap on:** a page appending `[init, seg1..segN]` produces `tap-ready` parts whose bytes, fetched from their blob URLs, are SHA-256-identical to the files served. A page that snapshots `appendBuffer` before our hook is still captured.
  - **Tap off (default):** no bytes are copied, no blob URLs are minted, and no listeners are attached — assert with the existing "leaves no trace" pattern in `tests/browser/isolate.test.mjs`.
  - **Cross-realm:** an append from an `about:blank` iframe realm is captured (brand check).
  - **URL layer:** `fetch` and XHR media requests appear in `tap-urls` with their `Range` header.
  - **Element layer:** an `encrypted` event produces `tap-error {reason:'drm'}`.
  - **Fingerprint:** `Function.prototype.toString.call(SourceBuffer.prototype.appendBuffer)` looks native; the wrapper's own property names are `['length','name']`; `length` matches native.
  - **Transport:** the agent port never carries an ArrayBuffer — spy on the relay's `port.postMessage`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per §5:
  - The wrappers are installed dormant at document_start and switched on by `{t:'tap', on:true}`. Each one reads from a per-SourceBuffer record (mime from `addSourceBuffer`, append order, bytes copied by brand check).
  - Statuses are rate-limited. `tap-ready` mints `URL.createObjectURL(new Blob(...))` per part.
  - Fix the disguise gaps: patch `Function.prototype.toString` once to answer native source for our wrappers, drop the own `toString` properties, and match arity.
- [ ] **Step 4: Run** → PASS; `tests/browser/agent.test.mjs` and `isolate.test.mjs` still pass.
- [ ] **Step 5: Commit** — `git commit -m "Page tap: capture the media a page's own player appends, losslessly"`

### Task R3.2: Drive the player; page-context fetch; Bandcamp read

**Files:** Modify `agent/agent-main.js`, `agent/agent-relay.js`. Test: extend `tests/browser/agent-tap.test.mjs`.

**Interfaces:** Produces I3 `drive`, `fetch`, `readTralbum` handling.

- [ ] **Step 1: Failing tests:**
  - **`drive seekhop`** on a local MSE player that buffers 20 s ahead makes the tap cover `[0, duration]` of a 3-minute fixture in under 10 s, without playing it through.
  - **`drive accelerate`** (rate 8, `preservesPitch=false`) does the same through playback, and is refused cleanly with back-off on a page that resets `playbackRate`. Reuse the existing assist back-off.
  - **`drive stop`** restores the player's rate, `preservesPitch` and `currentTime`.
  - **`fetch {urls}`** fetches from the page context and answers with blob-URL parts.
  - **`readTralbum`** on a page carrying a `data-tralbum` attribute answers with the stream URL fetched as a `kind:'file'` part, and with `tap-error {reason:'none'}` when the attribute is absent.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - Seek-hop: step = the player's observed buffer-ahead; wait for `buffered` to cover the step, with a timeout per hop.
  - Accelerate goes through the existing rate machinery with its back-off.
  - Fetch with concurrency 8; every fetch is time-boxed.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Drive the player through its track, fetch from the page, read Bandcamp's own stream link"`

### Task R3.3: ISO-BMFF reader and strict assembly

**Files:** Create `engine/bmff.js`, `engine/assemble.js`. Test: `tests/unit/assemble.test.mjs` (create), `tests/browser/assemble-decode.test.mjs` (create; add to `test:browser`).

**Interfaces:** Produces I4.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/assemble.test.mjs — fixtures: ffmpeg-made fMP4 (Opus) init + segments checked into tests/fixtures/fmp4/ (small: 30 s, 4 s segments, two bitrates)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { placeParts } from '../../engine/assemble.js';
import { tfdt, timescale } from '../../engine/bmff.js';

const load = (rep) => { /* read tests/fixtures/fmp4/<rep>/init.mp4 and seg-0000N.m4s into {bytes,mime,kind,sb,seq} parts */ };

test('tfdt and timescale place every segment at its true media time', () => { /* seg k starts at 4k s */ });
test('out-of-order parts are placed in order', () => { /* shuffle; coverage [[0,30]], gaps [] */ });
test('a missing segment is reported as a gap, never closed up', () => { /* drop seg 3; gaps [[12,16]] */ });
test('duplicates are dropped', () => { /* seg 2 twice; one run, one copy */ });
test('an ABR switch mid-capture: each span taken once, from the higher bitrate where both exist', () => { /* lo 0-16, hi 12-30; no doubled 12-16 */ });
test('an unknown duration is never declared complete', () => { /* duration null -> decodePlaced refuses */ });
test('a duration that grows after placement is re-checked, not trusted', () => { /* placed at duration 20, later 30 -> gap [[20,30]] */ });
```

```js
// tests/browser/assemble-decode.test.mjs — decodePlaced in real Chromium
// all segments shuffled -> decoded PCM sample-exact against decoding the unfragmented fixture;
// ABR switch fixture -> length equals the duration ±1 frame and no doubled audio at the switch (cross-correlation);
// gapped set -> throws AssemblyError naming the gap.
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `bmff.js`: box iteration over `ArrayBuffer`; `tfdt` v0/v1; `mdhd` timescale; WebM cluster timecode; MP3/ADTS frame walk for durations.
  - `assemble.js`: group into runs at each init; place; choose per span; contiguity with a one-frame tolerance; decode each run as `[init + segs]` and stitch at the placed offsets, trimming codec delay (Opus pre-skip, AAC priming) at run starts.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Strict assembly: captured media is placed by timeline, gap-checked and decoded"`

---

## Stream R4 — The loader ladder (Phase B)

### Task R4.1: Loader core, site table, progress, release

**Files:** Create `engine/loader.js`. Modify `engine/engine.js` (`ENGINE.START` with `mode:'resident'` routes through the loader), `background.js` (`capture()` passes `mode:'resident'`). Test: `tests/unit/loader.test.mjs` (create; fake agent and fake hub), `tests/browser/e2e.test.mjs` (extend).

**Interfaces:** Consumes I1, I3, I4. Produces the `loadTab` behaviour.

- [ ] **Step 1: Failing tests** (unit, fake agent):
  - **Ladder order:** Bandcamp-like source → `readTralbum` only; segment-URL source → `fetch` (back-fill) then assemble; MSE-only source → `drive seekhop`, then `accelerate` if seek-hop stalls.
  - **Failures:** everything failing → `failLoadingToLive` with the reason; a DRM error → live immediately with "protected audio"; a live stream (`duration` Infinity) → live immediately without trying the slow rungs; preview-only → refused with "preview only — 30 s".
  - **Resident:** the load ends with `startResidentDeck({deckId})` (promote, not create).
  - **Release:** on success, `STOP_TAB` (pause + restore) is sent for the source tab and the held capture stream's tracks are stopped.
  - **Progress:** `setLoad` is called with monotonic progress and plain-words strategies.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per §3–§4.
  - The site table is a frozen object keyed by host suffix, giving the first rung.
  - The loader runs as an async job per loading deck, with an `AbortController`, owned by the engine and keyed by deck id.
  - Progress is weighted per rung.
  - Release reuses `Engine.stopTab`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Loading a tab makes it resident: the strategy ladder, with live as the fallback"`

### Task R4.2: Load report and opt-in whole-track recording

**Files:** Modify `engine/loader.js`, `engine/deck.js` (`recordWhole`: speed-capture at 2× with `preservesPitch=false` through the existing capture, then resample by 2 into resident). Test: extend `tests/unit/loader.test.mjs` and `tests/browser/e2e.test.mjs`.

- [ ] **Step 1: Failing tests:**
  - every load (success or failure) leaves `load.report`: plain text naming the strategies tried, the mimes, the run and segment counts and the first failure;
  - `recordWhole` on a live deck whose page is Web-Audio-only stays 1× and says so; on a media-element page it records at 2×;
  - the result becomes resident with the right duration, labelled "recorded from the page — reduced highs".
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Load report for real-site failures; opt-in whole-track recording"`

### Task R4.3: Races, cancellation and navigation (Review Focus 1, 2, 5)

**Files:** Modify `engine/loader.js`, `engine/engine.js`. Test: `tests/unit/loader.test.mjs`, `tests/browser/e2e.test.mjs`.

- [ ] **Step 1: Failing tests:**
  - Load tab A then tab B before A is resident: each deck gets its own track, and A's tap parts are never routed to B — the agent port is per frame and per tab, so assert by content.
  - Eject a loading deck mid-drive: within 1 s the player's rate, position and mute are restored, the stream is released, no further agent commands are sent for that tab, the analysis Worker is terminated if running, and minted blob URLs are revoked.
  - The source page navigates away mid-load: the job fails over to live (or errors, when the stream died too) with one message, no unhandled rejection, and no half-built deck.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** cancellation through the job's `AbortController`, used at every await, plus cleanup in `finally`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Loads are independent, cancellable and survive the page going away"`

---

## Stream R5 — Resident UI (Phase B; after `nav` and `tempo-entry` merge)

### Task R5.1: Loading state, kind badge, time, LIVE hidden

**Files:** Modify `ui/deck-strip.js`, `deck.html`, `deck.css`. Test: `tests/browser/ui-resident.test.mjs` (create; add to `test:browser`), extend `tests/browser/fixtures/mock-state.mjs` with `kind`, `duration`, `load`.

- [ ] **Step 1: Failing tests** against mock state:
  - **Loading deck:** shows `LOADING · 42%` and the strategy text; controls other than eject are inert; cancel sends `loadCancel`.
  - **Resident deck:** shows `TRACK`, elapsed and remaining time, and no LIVE button.
  - **Live deck:** shows `LIVE`.
  - **Error state:** shows the one-line error and a "Copy load report" button that copies `load.report`.
  - `tests/browser/ui-layout.test.mjs` still passes at 1280×720 with 6 decks.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with the compare-first DOM helpers in `ui/util.js`, rendering through the existing once-per-frame `render()`.
- [ ] **Step 4: Run** → PASS; `npm run test:browser` all pass.
- [ ] **Step 5: Commit** — `git commit -m "Deck UI shows loading, whole-track and live decks for what they are"`

### Task R5.2: Drag a file, paste a link, settings

**Files:** Modify `ui/app.js`, `ui/sources.js`, `deck.html`, `deck.css`. Test: extend `tests/browser/ui-resident.test.mjs`.

- [ ] **Step 1: Failing tests:**
  - Dropping a file onto a deck slot or the board sends `loadFile` with a `blob:` URL; non-audio files are refused in the UI.
  - The Sources drawer's "Load link" field sends `loadUrl`; bad URLs are refused with a message.
  - The settings drawer has "Resident track limit" (1–60 min) and "Record whole track at 2× when bytes are unavailable", both persisted.
  - The top bar warns when `residentBytes` passes 1.5 GiB.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Blob URLs created by the deck page are revoked once the engine reports the deck ready or failed.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Drag a file or paste a link to load a whole track"`

---

## Stream R6 — Model sites and acceptance

### Task R6.1: Model-site pages and fixtures (Phase A)

**Files:** Modify `tests/browser/ext-harness.mjs` (`startTrackServer` routes). Create `tests/fixtures/fmp4/` (generated, small) and a fixture generator script `tests/fixtures/make-fixtures.mjs` that uses ffmpeg (`/usr/bin/ffmpeg`), committed alongside its outputs. Test: `tests/browser/model-sites.test.mjs` (create; add to `test:browser`), proving each page behaves as the site it models.

- [ ] **Step 1: Failing tests** — each model page plays and reports its shape:
  - `/m/progressive` (MP3 `<audio src>`);
  - `/m/mse` (fMP4 via a tiny MSE player buffering 20 s ahead);
  - `/m/abr` (two representations; switches at 12 s);
  - `/m/ratefight` (resets `playbackRate`);
  - `/m/worker` (MSE in a DedicatedWorker if supported, else marked skipped with a reason);
  - `/m/drm` (fires `encrypted`);
  - `/m/preview` (a 30 s preview of a longer track, flagged in its JSON like SoundCloud's `snipped`);
  - `/m/bandcamp` (`data-tralbum` with a `trackinfo[0].file['mp3-128']`);
  - `/m/live` (`duration` Infinity).
- [ ] **Step 2: Run, expect FAIL** (routes missing).
- [ ] **Step 3: Implement** the routes, the tiny MSE player and the fixtures. Keep total fixture size under 2 MB.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Model streaming sites for testing resident loads"`

### Task R6.2: Acceptance E2E (Phase C)

**Files:** Modify `tests/browser/e2e.test.mjs`.

- [ ] **Step 1: Failing tests** (real extension), for each model site:
  - Loading it ends `resident` (or `live` for drm, worker and live, with the right message; preview is refused) with the right duration.
  - The audio matches the source: sample-exact where the format allows, otherwise cross-correlated with a bounded error.
  - The tab is released.
  - **Then pause, seek and close the tab, and assert the deck's audio and position are unaffected** — the user's core requirement.
  - Resident decks sync with each other within the existing 0.2 % / 20 ms check, measured on recordings.
- [ ] **Step 2: Run, expect FAIL** until R1–R4 are merged.
- [ ] **Step 3: Fix** whatever the acceptance run exposes, test-first.
- [ ] **Step 4: Run** the full `npm test` twice → all pass.
- [ ] **Step 5: Commit** — `git commit -m "Acceptance: every model site loads resident and ignores its tab afterwards"`

---

## Self-review

- **Spec coverage:**

  | Spec section | Task(s) |
  |---|---|
  | §3 | R1.1, R1.2, R4.1 |
  | §4.1 | R1.2; Bandcamp in R3.2 / R4.1 |
  | §4.2 | R3.2, R4.1 |
  | §4.3 | R3.2, R4.1 |
  | §4.4 | R4.2 |
  | §4.5 | R3.1, R4.1, R4.2 |
  | §4.6 | R4.1 |
  | §5 | R3.1, R3.2 |
  | §6 | R3.3 |
  | §7 | R1.1, R1.3 |
  | §8 | R2.1, R2.2 |
  | §9 | R2.2; overview from `nav` |
  | §10 | R1.2, R5.2 |
  | §11 | R5.1, R5.2, R4.2 |
  | §12 | R1.2, R3.1 |
  | §13 | R6.1, R6.2 |

  No gaps.
- **Placeholders:** the elided bodies in the test sketches are helpers whose behaviour is stated inline; each task's assertions are explicit. No TBD/TODO.
- **Type consistency:** checked against I1–I5:
  - `startResidentDeck({deckId})` is used identically in R1.2 and R4.1;
  - `tap-ready.parts` in R3.1 matches `placeParts` in R3.3;
  - `analyseTrack` in R2.1 matches its use in R2.2.
- **Review Focus:** each line is pinned to its owning task (R3.3, R4.3).
