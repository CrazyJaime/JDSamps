# JD Samps v2 Performance Deck — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild JD Samps as a full-page DJ performance deck. Each captured tab becomes a
time-shift deck with audio-based BPM sync, a 3-band isolator EQ, per-deck FX and ROLL, a
crossfader, a master section and leak-free recording.

**Architecture:**
- An offscreen-document audio engine owns every deck. Each deck buffers its tab's audio and plays
  it through the Signalsmith Stretch time-stretcher, so tempo, phase, loops and transport are all
  done on the audio.
- The full-page UI (`deck.html`) talks to the engine over a `runtime.connect` port.
- The service worker handles capture grants, the tab list, downloads and injecting the player
  assist agent.
- Pure logic (tempo tracking, sync maths, playhead model, assist policy, WAV writer, protocol) is
  kept in DOM-free ES modules with Node unit tests.
- Web Audio graphs are tested offline in headless Chromium. The full system is tested end to end
  in headless Chromium with real captured tabs.

**Tech Stack:**
- Chrome MV3: `tabCapture`, `offscreen`, `scripting`, `contextMenus`, `commands`, `downloads`,
  `storage`;
- Web Audio API with AudioWorklets;
- Signalsmith Stretch 1.3.2 (MIT, vendored WASM);
- plain ES modules with no build step;
- Node 22 (`node --test`) for unit tests;
- Playwright 1.56 with Chromium 141 for browser tests.

**Spec:** `docs/superpowers/specs/2026-10-15-jdsamps-v2-deck-design.md`. Read it first; this
plan argues from it.

## Global Constraints

- No build step and no runtime dependencies. Everything ships as plain files.
  `vendor/signalsmith-stretch/` is the only third-party code, with its MIT licence included.
- Manifest:
  - `manifest_version: 3`, `version: "2.0.0"`, `minimum_chrome_version: "119"`;
  - background service worker with `"type": "module"`;
  - no `default_popup`.
- Permissions are exactly `tabCapture`, `offscreen`, `tabs`, `downloads`, `storage`,
  `scripting`, `contextMenus`, plus `host_permissions: ["<all_urls>"]`.
- CSP: `"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`. No inline
  scripts, no inline event handlers and no `blob:` modules. Every worklet loads from a packaged
  file.
- Never put page-derived strings (tab titles, URLs, favicon URLs) into `innerHTML`. Use
  `textContent`. Assign favicons with `img.src` only after `isSafeIconUrl()` (http, https or
  `data:image/`).
- Derive every DSP constant from `ctx.sampleRate` (44100 or 48000).
- No per-sample or per-quantum allocation inside AudioWorklet `process()`. Allocation is
  allowed only when replacing a transferred output batch (at most once per 2048 frames) or
  posting a small status message (at most once per 1536 frames).
- Apply every audible parameter change with `setTargetAtTime` (time constant 0.01 s unless
  stated) or a scheduled ramp. Never assign `.value` while audio is running.
- Lowpass/highpass biquad Q values are in dB: a Butterworth section is `Q = -3.0103`.
- Engine timing comes from worklet messages and the AudioContext clock. Never use `setInterval`
  on timing-critical paths: the offscreen document is hidden and can be throttled.
- At most 6 decks. Deck colours by slot: 1 `#22d3ee`, 2 `#f59e0b`, 3 `#e879f9`, 4 `#a3e635`,
  5 `#fb7185`, 6 `#60a5fa`.
- Knob law for gain knobs (`knobToGain(k, maxDb)`):
  - `k ≥ 0.5`: dB = `maxDb·(k−0.5)/0.5`;
  - `k < 0.5`: gain = `(2k)³`, so `k = 0` is −∞;
  - EQ maxDb = 6, trim maxDb = 12, master volume maxDb = 6.
- New decks load **cued** (paused). Key lock defaults to on. Pitch range defaults to ±10%. Sync
  mode defaults to BEAT. Crossfader assign defaults to THRU. Channel fader defaults to 1.0.
- Recorded filenames: `JDSamps-<D#|mix>-<sanitised title>-<YYYYMMDD-HHMMSS>.<wav|webm>`. The
  sanitised title has at most 60 characters from `[A-Za-z0-9 ._-]`; anything else becomes `_`.
- Git: work on branch `claude/jdsamps-v2-deck`. Every commit message ends with these two lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU
  ```

## Review Focus

The most likely real-world failures that no single task's happy-path tests cover. Each line has a
test in the owning task.

1. **The deck tab is closed or reloaded mid-set.** Audio must keep playing and the UI must
   reconnect with full state. Tests: Task 13 (banner and reconnect against the fake engine) and
   Task 14 (E2E reloads `deck.html` while decks play).
2. **A captured tab navigates or closes while it's recording or is the sync master.** The
   recording must be finalised and downloaded, and the master clock must go free with no jump.
   Tests: Task 4 (clock goes free) and Task 14 (closing a recording master tab).
3. **A deck's reserve runs out while speeding up.** The playhead must never pass the live edge
   (no garbage or repeated audio): rate is clamped to ≤ 1, no phase bends are made, and a
   `starved` flag is shown. Tests: Task 5 (reserve and input clamping) and Task 14 (the
   Web-Audio-only page).
4. **Silence, ambient or beatless audio, or BPM never locks.** No false SYNC: BEAT sync is
   refused with a reason, and TAP still works. Tests: Task 2 (ambient never locks,
   `canBeat` false, tap tempo) and Task 14 (SYNC on a deck without a BPM is refused).
5. **Hostile page strings and agent messages.** A title containing `<img onerror>`, a favicon
   `javascript:` URL, or an agent sending NaN, strings or oversized numbers must not inject
   markup or corrupt engine state. Tests: Task 1 (validators), Task 10 (agent message fuzz) and
   Task 12 (title rendered literally).

---

## File Map

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 manifest (Task 9) |
| `background.js` | Service worker hub: action/command/menu capture, grants, sources, offscreen lifecycle, downloads, tab lifecycle, agent injection (Task 9) |
| `offscreen.html` | Loads `engine/engine.js` as a module (Task 8) |
| `shared/protocol.js` | Message names, parameter tables, validators, URL/filename helpers (Task 1) |
| `engine/tempo.js` | `TempoTracker`, `BeatClock` (pure) (Task 2) |
| `worklets/deck-input.js` | Deck input worklet: stereo chunker, ODF (onset curve), waveform bands (Task 3) |
| `engine/sync.js` | Pure maths: knob laws, crossfader, sync multiplier, phase error, correction planner, master clock, assist policy, filter mapping (Task 4) |
| `engine/timeshift.js` | Playhead model and buffer bookkeeping over a stretch node (Task 5) |
| `worklets/recorder.js`, `engine/recorder.js` | Streaming WAV/WebM recorders (Task 6) |
| `engine/eq.js`, `engine/fx.js`, `worklets/beatfx.js` | Isolator EQ, DJ filter, Echo/Reverb/Flanger, Gate/Crush worklet (Task 7) |
| `engine/master.js`, `worklets/meter.js` | Master bus, limiter, crossfader gains, master meter and tick source (Task 7) |
| `engine/deck.js`, `engine/engine.js` | Deck graph, transport, sync controller wiring, engine ports and snapshots (Task 8) |
| `agent/agent-main.js`, `agent/agent-relay.js` | Player-assist content scripts (Task 10) |
| `deck.html`, `deck.css`, `ui/*.js` | Full-page performance UI (Tasks 11–13) |
| `vendor/signalsmith-stretch/*` | Time-stretcher (Task 1) |
| `tests/unit/*.test.mjs` | Node unit tests |
| `tests/browser/*.mjs` | Headless-Chromium tests (offline graphs, agent, E2E) |
| `package.json` | `test:unit`, `test:browser`, `test:e2e` scripts |

The old files `popup.html`, `popup.css`, `popup.js`, `offscreen.js` and `recorder-worklet.js`
are deleted in Task 14.

## Shared Contracts (all tasks rely on these)

### Timelines
- **Input time** (`inSec` / `inFrame`): seconds or frames of captured audio since the deck was
  loaded. The deck-input worklet counts frames from 0. The stretch node's buffer time equals
  input time, because every chunk is appended contiguously from 0.
- **Output time:** `AudioContext.currentTime`.
- **Beat grid** (per deck): `{t0, T}` in input seconds. `t0` is a recent beat; `T` is seconds
  per beat in input time.
- **Tempo terms:**
  - `inBpm = 60/T` (tempo of the input audio);
  - `sourceRate` = assist playbackRate of the tab's media element (1 when assist is off);
  - `nativeBpm = inBpm / sourceRate`;
  - `ratio = 1 + pitch` = total tempo ratio heard versus native;
  - `engineRate = ratio / sourceRate` = stretch node rate;
  - `outBpm = nativeBpm·ratio`.
- **Engine pitch shift:** `semitones = keyLock ? -12·log2(sourceRate) : 12·log2(engineRate)`.

### Snapshot shape (engine → UI, ~30 Hz)

```js
/**
 * @typedef {{mode:'none'|'deck'|'free', deckId:number|null, bpm:number|null}} ClockState
 * @typedef {{state:'idle'|'recording'|'finalizing', format:'wav'|'webm', seconds:number}} RecState
 * @typedef {Object} DeckState
 * @property {number} id            engine deck id (unique per load)
 * @property {number} slot          1..6
 * @property {number} tabId
 * @property {string} title
 * @property {string} favIconUrl
 * @property {string} url
 * @property {boolean} playing
 * @property {boolean} previewing   CUE held while paused
 * @property {number} cue           input seconds
 * @property {number} playhead      input seconds at snapshot ctxTime
 * @property {number} engineRate    current stretch rate including bends
 * @property {number} liveEdge      input seconds buffered
 * @property {number} reserve       seconds playable ahead of playhead (>=0)
 * @property {boolean} starved      rate clamped because reserve ran out
 * @property {number} historyStart  oldest input second still buffered
 * @property {{state:'SEARCH'|'LOCKED'|'UNSURE'|'HOLD', native:number|null, out:number|null, conf:number, mult:number, tapped:boolean}} bpm
 * @property {{t0:number, T:number, bar1:number|null}|null} grid
 * @property {{on:boolean, mode:'BEAT'|'TEMPO', isMaster:boolean, outOfRange:boolean, phaseMs:number|null}} sync
 * @property {{available:boolean, active:boolean, sourceRate:number}} assist
 * @property {Object<string, number|boolean|string>} params   current DECK_PARAMS values
 * @property {number|null} roll     beats while a roll is held
 * @property {{start:number, end:number}|null} loop  active loop region in input seconds (roll)
 * @property {-1|0|1} nudge
 * @property {{peak:number, rms:number, clip:boolean}} meter     post-fader, linear
 * @property {RecState} rec
 * @property {string|null} error
 *
 * @typedef {Object} Snapshot
 * @property {number} ctxTime       AudioContext.currentTime (s)
 * @property {number} wallMs        performance.timeOrigin + performance.now() at the same moment
 * @property {number} sampleRate
 * @property {'running'|'suspended'|'closed'} engineState
 * @property {number} outputLatency seconds (ctx.outputLatency || 0)
 * @property {ClockState} clock
 * @property {{params:Object<string, number|boolean|string>, peakL:number, peakR:number, rmsL:number, rmsR:number, clipL:boolean, clipR:boolean, gr:number, rec:RecState}} master
 * @property {DeckState[]} decks    sorted by slot
 */
```

### Port messages (`chrome.runtime.connect({name: 'jds-ui'})`)

UI → engine (any message may carry `id`; the engine answers `{t:'reply', id, ok, error?}`):
- `{t:'hello'}`: the engine immediately sends one `state` message and a full `wave` backlog
  per deck.
- `{t:'set', deck:number|null, key:string, value}`: `deck:null` with a `MASTER_PARAMS` key,
  otherwise a `DECK_PARAMS` key.
- `{t:'act', deck:number|null, a:string, arg?:object}`: `deck:null` with `MASTER_ACTIONS`,
  otherwise `DECK_ACTIONS`.

Engine → UI:
- `{t:'state', s:Snapshot}`;
- `{t:'wave', deck:number, tStart:number, hop:number, data:Uint8Array}`. `data` holds three
  bytes (low, mid, high) per ODF hop. `tStart` is the input time of the first hop's window
  centre. `hop` is seconds per hop.
- `{t:'event', level:'info'|'warn'|'error', text:string, deck?:number}`;
- `{t:'reply', id, ok:boolean, error?:string}`.

### Runtime messages (`chrome.runtime.sendMessage`)

- **UI → hub** (`target:'hub'`):
  - `ENSURE_ENGINE` → `{ok}`: creates the offscreen engine if it isn't running, so the UI port
    has something to connect to;
  - `LIST_SOURCES` → `{ok, tabs:[{id,title,url,favIconUrl,audible,granted,deckSlot}]}`, where
    `deckSlot` is the slot number if the tab is on a deck, otherwise `null`;
  - `LOAD_TAB {tabId}` → `{ok, error?}`;
  - `GOTO_TAB {tabId}` → `{ok}`.
- **Hub → engine** (`target:'engine'`):
  - `START {tabId, streamId, meta:{title,url,favIconUrl}}` → `{ok, deckId?, error?}`;
  - `EJECT {tabId}`;
  - `META {tabId, meta}`;
  - `PING` → `{ok, decks:[{tabId, slot}]}`;
  - `DOWNLOAD_DONE {url, ok, error?}`;
  - `NOTIFY {level, text}`: the engine forwards it to the UI as a toast (used for capture
    errors raised by a toolbar click).
- **Engine → hub** (`target:'hub'`):
  - `DOWNLOAD {url, filename}` → `{ok, downloadId?, error?}`;
  - `AGENT_CONNECT {tabId}` → `{ok, error?}`: injects the agent if needed and asks it to
    connect;
  - `DECKS_CHANGED {decks:[{tabId, slot}]}` (badge and source list).
- **The service worker registers no `runtime.onConnect` listener.** Verified: if any receiver
  calls `port.disconnect()`, the port is torn down for every receiver. Content-script and UI
  ports go straight to the offscreen engine.

### Agent messages (port `jds-agent`, content script ↔ engine)

- **Agent → engine:**
  - `{t:'status', hasMedia:boolean, playing:boolean, rate:number, preservesPitch:boolean, count:number}`;
  - `{t:'external-rate', rate:number}`: the page changed the rate itself.
- **Engine → agent:**
  - `{t:'rate', rate:number}`: set `playbackRate` and `defaultPlaybackRate` with
    `preservesPitch = false` on all registered elements, and re-apply on `ratechange` while the
    rate ≠ 1;
  - `{t:'release'}`: restore rate 1 and `preservesPitch = true`, stop enforcing;
  - `{t:'query'}`: reply with a `status`.

---
## Task 1: Scaffolding, shared protocol, vendored stretcher

**Files:**
- Create: `package.json`, `shared/protocol.js`, `tests/unit/protocol.test.mjs`
- Create: `vendor/signalsmith-stretch/SignalsmithStretch.js`, `vendor/signalsmith-stretch/SignalsmithStretch.mjs`, `vendor/signalsmith-stretch/LICENSE`, `vendor/signalsmith-stretch/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces (`shared/protocol.js`):
  - constants: `PORT_UI`, `PORT_AGENT`, `MAX_DECKS`, `DECK_COLORS`, `TARGET`, `HUB`, `ENGINE`,
    `FX_TYPES`, `FX_BEATS`, `PITCH_RANGES`, `ROLL_BEATS`, `BPM_RANGES`, `DECK_PARAMS`,
    `MASTER_PARAMS`, `PERSISTED_MASTER_KEYS`, `DECK_ACTIONS`, `MASTER_ACTIONS`;
  - `defaults(table) → object`;
  - `validateValue(spec, value) → {ok, value?, error?}`;
  - `validateUiMessage(m) → {ok, value?, arg?, error?}`;
  - `validateAgentMessage(m) → object|null`;
  - `isSafeIconUrl(u) → boolean`;
  - `sanitizeTitle(s) → string`;
  - `timestamp(date) → 'YYYYMMDD-HHMMSS'`;
  - `recordingFilename(who, title, ext, date) → string`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "jdsamps",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "description": "JD Samps — multi-tab DJ performance deck (Chrome MV3 extension). Made by godspee.",
  "scripts": {
    "test:unit": "node --test \"tests/unit/*.test.mjs\"",
    "test:browser": "node --test --test-concurrency=1 \"tests/browser/*.test.mjs\"",
    "test": "npm run test:unit && npm run test:browser"
  }
}
```

- [ ] **Step 2: Write the failing protocol tests** — `tests/unit/protocol.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECK_PARAMS, MASTER_PARAMS, DECK_ACTIONS, MASTER_ACTIONS, defaults, validateValue,
  validateUiMessage, validateAgentMessage, isSafeIconUrl, sanitizeTitle, recordingFilename, timestamp,
} from '../../shared/protocol.js';

test('defaults match the spec', () => {
  const d = defaults(DECK_PARAMS);
  assert.equal(d.keyLock, true);
  assert.equal(d.range, 0.1);
  assert.equal(d.syncMode, 'BEAT');
  assert.equal(d.xf, 'THRU');
  assert.equal(d.fader, 1);
  assert.equal(d['eq.low'], 0.5);
  const m = defaults(MASTER_PARAMS);
  assert.equal(m['master.limiter'], true);
  assert.equal(m['rec.format'], 'wav');
  assert.equal(m['xfader.curve'], 'SMOOTH');
});

test('validateValue clamps numbers and rejects junk', () => {
  assert.deepEqual(validateValue(DECK_PARAMS.filter, 3), { ok: true, value: 1 });
  assert.deepEqual(validateValue(DECK_PARAMS.filter, -3), { ok: true, value: -1 });
  for (const bad of [NaN, Infinity, '0.5', null, undefined, {}]) {
    assert.equal(validateValue(DECK_PARAMS.filter, bad).ok, false, String(bad));
  }
  assert.equal(validateValue(DECK_PARAMS.keyLock, 1).ok, false);
  assert.equal(validateValue(DECK_PARAMS.xf, 'C').ok, false);
  assert.equal(validateValue(DECK_PARAMS.xf, 'A').ok, true);
  assert.equal(validateValue(undefined, 1).ok, false);
});

test('validateUiMessage routes deck vs master tables', () => {
  assert.equal(validateUiMessage({ t: 'set', deck: 1, key: 'eq.hi', value: 0.7 }).ok, true);
  assert.equal(validateUiMessage({ t: 'set', deck: null, key: 'eq.hi', value: 0.7 }).ok, false);
  assert.equal(validateUiMessage({ t: 'set', deck: null, key: 'xfader.pos', value: 0.2 }).ok, true);
  assert.equal(validateUiMessage({ t: 'set', deck: '1', key: 'eq.hi', value: 0.7 }).ok, false);
  assert.equal(validateUiMessage({ t: 'set', deck: 1, key: '__proto__', value: 1 }).ok, false);
  assert.equal(validateUiMessage({ t: 'act', deck: 2, a: 'play' }).ok, true);
  assert.equal(validateUiMessage({ t: 'act', deck: null, a: 'play' }).ok, false);
  assert.equal(validateUiMessage({ t: 'act', deck: null, a: 'mixRecStart' }).ok, true);
  assert.equal(validateUiMessage({ t: 'hello' }).ok, true);
  assert.equal(validateUiMessage({ t: 'nope' }).ok, false);
  assert.equal(validateUiMessage(null).ok, false);
});

test('action arguments are validated and normalised', () => {
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'nudge', arg: { dir: 1, fine: 1 } }).arg, { dir: 1, fine: true });
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'nudge', arg: { dir: 2 } }).ok, false);
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'mult', arg: { factor: 2 } }).arg, { factor: 2 });
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'mult', arg: { factor: 3 } }).ok, false);
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'gridShift', arg: { beats: 0.5 } }).arg, { beats: 0.5, ms: 0 });
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'gridShift', arg: { ms: -10 } }).arg, { beats: 0, ms: -10 });
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'gridShift', arg: { ms: 99 } }).ok, false);
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'rollStart', arg: { beats: 0.25 } }).arg, { beats: 0.25 });
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'rollStart', arg: { beats: 3 } }).ok, false);
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'sync', arg: { on: false } }).arg, { on: false });
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'sync' }).arg, { on: null });
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'tap', arg: { wallMs: 123.5 } }).arg, { wallMs: 123.5 });
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'tap', arg: { wallMs: 'x' } }).ok, false);
  for (const a of DECK_ACTIONS) assert.equal(typeof a, 'string');
  for (const a of MASTER_ACTIONS) assert.equal(typeof a, 'string');
});

test('validateAgentMessage rejects hostile payloads', () => {
  assert.deepEqual(validateAgentMessage({ t: 'status', hasMedia: true, playing: false, rate: 1.03, preservesPitch: false, count: 2 }),
    { t: 'status', hasMedia: true, playing: false, rate: 1.03, preservesPitch: false, count: 2 });
  for (const bad of [
    null, 'x', {}, { t: 'status' }, { t: 'status', hasMedia: 'yes', playing: true, rate: 1 },
    { t: 'status', hasMedia: true, playing: true, rate: NaN }, { t: 'status', hasMedia: true, playing: true, rate: 1e9 },
    { t: 'external-rate', rate: -1 }, { t: 'evil', rate: 1 },
  ]) assert.equal(validateAgentMessage(bad), null, JSON.stringify(bad));
  assert.deepEqual(validateAgentMessage({ t: 'status', hasMedia: true, playing: true, rate: 1, count: 1e9 }).count, 0);
  assert.deepEqual(validateAgentMessage({ t: 'external-rate', rate: 1.25 }), { t: 'external-rate', rate: 1.25 });
});

test('isSafeIconUrl only allows http(s) and data:image', () => {
  assert.equal(isSafeIconUrl('https://www.youtube.com/favicon.ico'), true);
  assert.equal(isSafeIconUrl('http://x/y.png'), true);
  assert.equal(isSafeIconUrl('data:image/png;base64,AAAA'), true);
  for (const bad of ['javascript:alert(1)', 'data:text/html;base64,AA', '" onerror="x', '', null, 42, 'chrome://favicon/x', 'x'.repeat(5000)]) {
    assert.equal(isSafeIconUrl(bad), false, String(bad).slice(0, 40));
  }
});

test('filenames are sanitised', () => {
  assert.equal(sanitizeTitle('Daft Punk — One More Time (Official Video) | YouTube'), 'Daft Punk_One More Time_Official Video_YouTube');
  assert.equal(sanitizeTitle('../../etc/passwd'), 'etc_passwd');
  assert.equal(sanitizeTitle('<img src=x onerror=alert(1)>'), 'img src_x onerror_alert_1');
  assert.equal(sanitizeTitle(''), 'tab');
  assert.equal(sanitizeTitle('a'.repeat(200)).length, 60);
  const d = new Date(2026, 9, 15, 1, 2, 3);
  assert.equal(timestamp(d), '20261015-010203');
  assert.equal(recordingFilename('D2', 'My Track', 'wav', d), 'JDSamps-D2-My Track-20261015-010203.wav');
  assert.equal(recordingFilename('mix', 'Master', 'webm', d), 'JDSamps-mix-Master-20261015-010203.webm');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL with `Cannot find module '.../shared/protocol.js'`.

- [ ] **Step 4: Implement `shared/protocol.js`**

```js
// shared/protocol.js — message names, parameter tables and validators shared by
// the deck UI (deck.html), the offscreen engine and the service worker.
// Pure module: no chrome.*, no DOM, safe to import from Node tests.

export const PORT_UI = 'jds-ui';
export const PORT_AGENT = 'jds-agent';
export const MAX_DECKS = 6;
export const DECK_COLORS = Object.freeze(['#22d3ee', '#f59e0b', '#e879f9', '#a3e635', '#fb7185', '#60a5fa']);

export const TARGET = Object.freeze({ HUB: 'hub', ENGINE: 'engine' });
export const HUB = Object.freeze({
  ENSURE_ENGINE: 'ENSURE_ENGINE', LIST_SOURCES: 'LIST_SOURCES', LOAD_TAB: 'LOAD_TAB', GOTO_TAB: 'GOTO_TAB',
  DOWNLOAD: 'DOWNLOAD', AGENT_CONNECT: 'AGENT_CONNECT', DECKS_CHANGED: 'DECKS_CHANGED',
});
export const ENGINE = Object.freeze({
  START: 'START', EJECT: 'EJECT', META: 'META', PING: 'PING', DOWNLOAD_DONE: 'DOWNLOAD_DONE', NOTIFY: 'NOTIFY',
});

export const FX_TYPES = Object.freeze(['ECHO', 'REVERB', 'GATE', 'FLANGER', 'CRUSH']);
export const FX_BEATS = Object.freeze([0.0625, 0.125, 0.25, 0.5, 0.75, 1, 2, 4]);
export const PITCH_RANGES = Object.freeze([0.06, 0.1, 0.16, 0.5]);
export const ROLL_BEATS = Object.freeze([0.125, 0.25, 0.5, 1]);
export const BPM_RANGES = Object.freeze({
  AUTO: [70, 180], '55-115': [55, 115], '68-135': [68, 135], '78-155': [78, 155], '88-175': [88, 175], '98-195': [98, 195],
});

const num = (min, max, def) => Object.freeze({ type: 'num', min, max, def });
const bool = (def) => Object.freeze({ type: 'bool', def });
const oneOf = (values, def) => Object.freeze({ type: 'enum', values, def });

export const DECK_PARAMS = Object.freeze({
  trim: num(0, 1, 0.5),
  'eq.hi': num(0, 1, 0.5),
  'eq.mid': num(0, 1, 0.5),
  'eq.low': num(0, 1, 0.5),
  'kill.hi': bool(false),
  'kill.mid': bool(false),
  'kill.low': bool(false),
  filter: num(-1, 1, 0),
  'filter.res': num(0, 1, 0.3),
  fader: num(0, 1, 1),
  xf: oneOf(['A', 'THRU', 'B'], 'THRU'),
  'fx.type': oneOf(FX_TYPES, 'ECHO'),
  'fx.beats': oneOf(FX_BEATS, 0.5),
  'fx.level': num(0, 1, 0.5),
  'fx.on': bool(false),
  keyLock: bool(true),
  range: oneOf(PITCH_RANGES, 0.1),
  pitch: num(-0.5, 0.5, 0),
  syncMode: oneOf(['BEAT', 'TEMPO'], 'BEAT'),
});

export const MASTER_PARAMS = Object.freeze({
  'master.volume': num(0, 1, 0.5),
  'master.limiter': bool(true),
  'xfader.pos': num(0, 1, 0.5),
  'xfader.curve': oneOf(['SMOOTH', 'SHARP'], 'SMOOTH'),
  'rec.format': oneOf(['wav', 'webm'], 'wav'),
  'bpm.range': oneOf(Object.keys(BPM_RANGES), 'AUTO'),
  'buffer.capSec': oneOf([120, 240, 480], 240),
  'assist.on': bool(true),
  'pitch.defaultRange': oneOf(PITCH_RANGES, 0.1),
});

/** Master params saved to chrome.storage.local by the UI and restored on engine start. */
export const PERSISTED_MASTER_KEYS = Object.freeze([
  'master.limiter', 'xfader.curve', 'rec.format', 'bpm.range', 'buffer.capSec', 'assist.on', 'pitch.defaultRange',
]);

export const DECK_ACTIONS = Object.freeze([
  'play', 'pause', 'cueDown', 'cueUp', 'syncPlay', 'sync', 'master', 'nudge', 'tap', 'mult', 'gridShift',
  'tap1', 'live', 'rollStart', 'rollEnd', 'recStart', 'recStop', 'eject', 'clipReset',
]);
export const MASTER_ACTIONS = Object.freeze(['mixRecStart', 'mixRecStop', 'clipReset', 'stopAll']);

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function defaults(table) {
  const out = {};
  for (const k of Object.keys(table)) out[k] = table[k].def;
  return out;
}

export function validateValue(spec, value) {
  if (!spec) return { ok: false, error: 'unknown parameter' };
  switch (spec.type) {
    case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'expected a finite number' };
      return { ok: true, value: Math.min(spec.max, Math.max(spec.min, value)) };
    case 'bool':
      if (typeof value !== 'boolean') return { ok: false, error: 'expected a boolean' };
      return { ok: true, value };
    case 'enum':
      if (!spec.values.includes(value)) return { ok: false, error: `expected one of ${spec.values.join(', ')}` };
      return { ok: true, value };
    default:
      return { ok: false, error: 'bad parameter spec' };
  }
}

const isDeckRef = (d) => d === null || Number.isInteger(d);

function validateActArg(a, arg) {
  const fail = (error) => ({ ok: false, error });
  switch (a) {
    case 'nudge':
      if (![-1, 0, 1].includes(arg.dir)) return fail('nudge.dir must be -1, 0 or 1');
      return { ok: true, arg: { dir: arg.dir, fine: !!arg.fine } };
    case 'mult':
      if (![0.5, 2].includes(arg.factor)) return fail('mult.factor must be 0.5 or 2');
      return { ok: true, arg: { factor: arg.factor } };
    case 'gridShift': {
      const beats = arg.beats ?? 0, ms = arg.ms ?? 0;
      if (![-0.5, 0, 0.5].includes(beats) || ![-10, 0, 10].includes(ms) || (beats === 0) === (ms === 0)) {
        return fail('gridShift needs beats ±0.5 or ms ±10');
      }
      return { ok: true, arg: { beats, ms } };
    }
    case 'rollStart':
      if (!ROLL_BEATS.includes(arg.beats)) return fail(`roll beats must be one of ${ROLL_BEATS.join(', ')}`);
      return { ok: true, arg: { beats: arg.beats } };
    case 'sync':
      if (arg.on != null && typeof arg.on !== 'boolean') return fail('sync.on must be boolean');
      return { ok: true, arg: { on: arg.on ?? null } };
    case 'tap':
      if (arg.wallMs != null && (typeof arg.wallMs !== 'number' || !Number.isFinite(arg.wallMs))) return fail('tap.wallMs must be a number');
      return { ok: true, arg: arg.wallMs == null ? {} : { wallMs: arg.wallMs } };
    default:
      return { ok: true, arg: {} };
  }
}

export function validateUiMessage(m) {
  if (!m || typeof m !== 'object') return { ok: false, error: 'not an object' };
  if (m.t === 'hello') return { ok: true };
  if (m.t === 'set') {
    if (!isDeckRef(m.deck)) return { ok: false, error: 'bad deck id' };
    const table = m.deck === null ? MASTER_PARAMS : DECK_PARAMS;
    if (typeof m.key !== 'string' || !has(table, m.key)) return { ok: false, error: `unknown parameter ${String(m.key)}` };
    return validateValue(table[m.key], m.value);
  }
  if (m.t === 'act') {
    if (!isDeckRef(m.deck)) return { ok: false, error: 'bad deck id' };
    const list = m.deck === null ? MASTER_ACTIONS : DECK_ACTIONS;
    if (!list.includes(m.a)) return { ok: false, error: `unknown action ${String(m.a)}` };
    const arg = m.arg == null ? {} : m.arg;
    if (typeof arg !== 'object') return { ok: false, error: 'bad action argument' };
    return validateActArg(m.a, arg);
  }
  return { ok: false, error: 'unknown message type' };
}

/** Agent (content script) messages are untrusted page-adjacent data. */
export function validateAgentMessage(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.t === 'status') {
    const rate = m.rate;
    if (typeof m.hasMedia !== 'boolean' || typeof m.playing !== 'boolean') return null;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 16) return null;
    const count = Number.isInteger(m.count) && m.count >= 0 && m.count < 1000 ? m.count : 0;
    return { t: 'status', hasMedia: m.hasMedia, playing: m.playing, rate, preservesPitch: m.preservesPitch === true, count };
  }
  if (m.t === 'external-rate') {
    if (typeof m.rate !== 'number' || !Number.isFinite(m.rate) || m.rate <= 0 || m.rate > 16) return null;
    return { t: 'external-rate', rate: m.rate };
  }
  return null;
}

const ICON_DATA = /^data:image\/(png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i;
export function isSafeIconUrl(u) {
  if (typeof u !== 'string' || !u || u.length > 4096) return false;
  return /^https?:\/\/[^\s"'<>]+$/i.test(u) || ICON_DATA.test(u);
}

export function sanitizeTitle(s) {
  const t = String(s ?? '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .replace(/ *_ */g, '_')
    .replace(/_+/g, '_')
    .replace(/^[ ._]+|[ ._]+$/g, '')
    .slice(0, 60)
    .replace(/[ ._]+$/g, '');
  return t || 'tab';
}

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function recordingFilename(who, title, ext, d = new Date()) {
  return `JDSamps-${who}-${sanitizeTitle(title)}-${timestamp(d)}.${ext}`;
}
```

Note: `sanitizeTitle('../../etc/passwd')` → `'.._.._etc_passwd'` → trimmed to `'etc_passwd'` after the edge rules. `'Daft Punk — One More Time (Official Video) | YouTube'` → `'Daft Punk_One More Time_Official Video_YouTube'`. If either expectation fails, fix the implementation, not the test; the expectations are the contract.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS (7 tests).

- [ ] **Step 6: Vendor Signalsmith Stretch (with the streaming fix)**

The stock 1.3.2 file (byte-identical to upstream HEAD a670068) crashes in buffer-streaming mode:
when the read window spans two `addBuffers` chunks, the copy loop advances the wrong cursor
(`audioSamples += count` instead of advancing the read cursor), so it reads wrong samples or throws
`RangeError: offset is out of bounds` from `process()`, which kills the node permanently.
Verified live in Chromium 141 and by simulation (`scratchpad/stretch-probe/sim-bufferfill.mjs`).

```bash
mkdir -p vendor/signalsmith-stretch /tmp/sss && cd /tmp/sss && npm pack signalsmith-stretch@1.3.2 && tar xzf signalsmith-stretch-1.3.2.tgz
cp package/SignalsmithStretch.js package/SignalsmithStretch.mjs /home/user/JDSamps/vendor/signalsmith-stretch/
cd /home/user/JDSamps
```

Write `vendor/signalsmith-stretch/patch.mjs`:

```js
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
```

Run: `node vendor/signalsmith-stretch/patch.mjs`
Expected: `SignalsmithStretch.js: patched` and `SignalsmithStretch.mjs: patched`; a second run prints `already patched`.

Write `vendor/signalsmith-stretch/LICENSE`:

```
MIT License

Copyright (c) Geraint Luff / Signalsmith Audio Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Write `vendor/signalsmith-stretch/README.md`:

```markdown
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
```

- [ ] **Step 7: Commit**

```bash
git add package.json shared/protocol.js tests/unit/protocol.test.mjs vendor/signalsmith-stretch
git commit -m "Add shared protocol, test scaffolding and vendored Signalsmith Stretch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---
## Task 2: Onset core + tempo tracker (pure)

Port the validated research prototype
(`scratchpad/bpmproto/odf.js` and `tempo.js`, which reproduced: BPM within 0.03 on 11 synthetic
genres, phase p95 ≤ 7.3 ms, first lock about 5 s). Add waveform band bytes to the ODF and a
`DeckTempo` wrapper with the manual tools.

**Files:**
- Create: `worklets/odf-core.js`, `engine/tempo.js`
- Create: `tests/unit/fixtures/synth.mjs`, `tests/unit/tempo.test.mjs`

**Interfaces:**
- Produces:
  - `OdfCore` (`worklets/odf-core.js`):
    - `new OdfCore(sampleRate, onFrame(full, low, tCentreFrame, bLow, bMid, bHigh))`;
    - `.fps`, `.D`, `.H`, `.spf` (= H·D input frames per hop);
    - `.push(monoBlock: Float32Array, startFrame: number)`, allocation-free.
  - `TempoTracker`, `BeatClock`, `DeckTempo` (`engine/tempo.js`):
    - `new DeckTempo({sampleRate, fps, lo=70, hi=180})`;
    - methods: `.pushBatch({t0, spf, full: Float32Array, low: Float32Array})`,
      `.pushFrame(full, low, t)`, `.setRange(lo, hi)`, `.multiply(0.5|2)`, `.tap(inFrame)`,
      `.shiftGrid({beats, ms})`, `.setBar1(inFrame)`, `.sourceRateChanged(ratio, atFrame)`,
      `.reset()`;
    - `.get() → {state:'SEARCH'|'LOCKED'|'UNSURE'|'HOLD', inBpm:number|null, conf:number, mult:number, tapped:boolean, grid:{t0,T,bar1}|null /*input seconds*/, canBeat:boolean}`.

- [ ] **Step 1: Create the synthetic-music fixture** — `tests/unit/fixtures/synth.mjs`

```js
// Seeded synthetic drum loops with known beat times (ported from the research prototype).
export const FS = 48000;

export function makeRng(seed = 777) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const range = (a, b, s) => { const r = []; for (let v = a; v < b - 1e-9; v += s) r.push(v); return r; };

export const PATTERNS = {
  house: { bpm: 124, pat: [['kick', [0, 1, 2, 3], 0.9], ['snare', [1, 3], 0.4], ['ohat', [0.5, 1.5, 2.5, 3.5], 0.35], ['hat', range(0, 4, 0.25), 0.12], ['bass', [0.5, 1.5, 2.5, 3.5], 0.3]] },
  techno: { bpm: 132.7, pat: [['kick', [0, 1, 2, 3], 0.9], ['hat', range(0, 4, 0.25), 0.25], ['ohat', [0.5, 1.5, 2.5, 3.5], 0.2], ['bass', [0.25, 0.5, 1.25, 1.5, 2.25, 2.5, 3.25, 3.5], 0.2]] },
  boombap: { bpm: 92, swing: 0.55, human: 0.006, pat: [['kick', [0, 1.75, 2.5], 0.9], ['snare', [1, 3], 0.6], ['hat', range(0, 4, 0.25), 0.18], ['chord', [0, 2], 0.15]] },
  trap: { bpm: 140, pat: [['kick', [0, 0.75, 2.5, 3.25], 0.9], ['snare', [2], 0.6], ['hat', range(0, 4, 0.25), 0.2], ['hat', [3.125, 3.375, 3.625, 3.875], 0.15]] },
  dnb: { bpm: 174, pat: [['kick', [0, 2.5], 0.9], ['snare', [1, 3], 0.6], ['hat', range(0, 4, 0.5), 0.2], ['bass', [0, 2.5], 0.25]] },
  pop: { bpm: 102, padDb: -12, pat: [['kick', [0, 2], 0.5], ['snare', [1, 3], 0.35], ['chord', range(0, 4, 0.5), 0.12]] },
  dembow: { bpm: 95, pat: [['kick', [0, 1, 2, 3], 0.9], ['snare', [0.75, 1.5, 2.75, 3.5], 0.5], ['hat', range(0, 4, 0.5), 0.15]] },
  slowhh: { bpm: 75, swing: 0.4, human: 0.008, pat: [['kick', [0, 2.25, 2.75], 0.9], ['snare', [1, 3], 0.6], ['hat', range(0, 4, 0.25), 0.15]] },
  noisy128: { bpm: 128, noiseDb: -14, padDb: -10, pat: [['kick', [0, 1, 2, 3], 0.6], ['snare', [1, 3], 0.3], ['hat', range(0, 4, 0.25), 0.1]] },
  ambient: { bpm: 100, padDb: -6, pat: [['chord', [0], 0.1]] },
};

/**
 * @returns {{x: Float32Array, truth: number[] (beat times, s), beatSec: number}}
 * tail: seconds of pad/noise appended after the last bar (0 = exact bar length).
 */
export function synth({ bpm, bars = 24, pat, swing = 0, human = 0, noiseDb = -40, padDb = -18, rate = 1, tail = 0.5, seed = 777 }) {
  const rnd = makeRng(seed); const nrm = () => rnd() * 2 - 1;
  const beat = 60 / (bpm * rate);
  const n = Math.ceil((bars * 4 * beat + tail) * FS);
  const out = new Float32Array(n);
  const add = (t0, fn, len) => { const s = Math.round(t0 * FS); for (let i = 0; i < len * FS && s + i < n; i++) if (s + i >= 0) out[s + i] += fn(i / FS); };
  const kick = (g) => { let ph = 0; return (t) => { ph += 2 * Math.PI * (45 + 75 * Math.exp(-t / 0.03)) / FS; return g * Math.sin(ph) * Math.exp(-t / 0.18); }; };
  const snare = (g) => (t) => g * (0.7 * nrm() * Math.exp(-t / 0.09) + 0.4 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.05));
  let hp = 0;
  const hat = (g, dec) => (t) => { const v = nrm(); const o = v - hp; hp = v; return g * 0.5 * o * Math.exp(-t / dec); };
  const bass = (g, f) => (t) => g * (((t * f) % 1) * 2 - 1) * Math.exp(-t / 0.15) * Math.min(1, t / 0.005);
  const chord = (g) => (t) => g * nrm() * Math.min(1, t / 0.03) * Math.exp(-t / 0.25);
  const truth = [];
  for (let b = 0; b < bars; b++) {
    for (let q = 0; q < 4; q++) truth.push((b * 4 + q) * beat);
    for (const [inst, positions, g] of pat) {
      for (let p of positions) {
        if (swing && Math.abs((p % 0.5) - 0.25) < 1e-6) p += swing * 0.25;
        const t0 = (b * 4 + p) * beat + (human ? nrm() * human : 0);
        if (inst === 'kick') add(t0, kick(g), 0.6);
        else if (inst === 'snare') add(t0, snare(g), 0.4);
        else if (inst === 'hat') add(t0, hat(g, 0.02), 0.12);
        else if (inst === 'ohat') add(t0, hat(g, 0.12), 0.4);
        else if (inst === 'bass') add(t0, bass(g, 55), 0.4);
        else if (inst === 'chord') add(t0, chord(g), 0.8);
      }
    }
  }
  const pad = 10 ** (padDb / 20), nz = 10 ** (noiseDb / 20);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    out[i] += pad * (Math.sin(2 * Math.PI * 220 * t) + 0.7 * Math.sin(2 * Math.PI * 277.2 * t) + 0.5 * Math.sin(2 * Math.PI * 329.6 * t + Math.sin(2 * Math.PI * 5 * t))) / 2.2;
    out[i] += nz * nrm();
  }
  return { x: out, truth, beatSec: beat };
}

/** Error (s) from t to the nearest truth beat. */
export function nearestBeatError(t, truth) {
  let best = Infinity;
  for (const tb of truth) if (Math.abs(t - tb) < Math.abs(best)) best = t - tb;
  return best;
}
```

- [ ] **Step 2: Write the failing tempo tests** — `tests/unit/tempo.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { OdfCore } from '../../worklets/odf-core.js';
import { DeckTempo } from '../../engine/tempo.js';
import { synth, PATTERNS, FS, nearestBeatError } from './fixtures/synth.mjs';

/** Feed audio through OdfCore -> DeckTempo, calling onEval(tSec, deck) after every 0.5 s evaluation. */
function run(x, opts = {}, hooks = {}) {
  let deck;
  const batch = { full: [], low: [], t0: 0 };
  const odf = new OdfCore(FS, (full, low, t) => {
    deck.pushFrame(full, low, t);
  });
  deck = new DeckTempo({ sampleRate: FS, fps: odf.fps, ...opts });
  const origEval = deck.evaluate.bind(deck);
  deck.evaluate = () => { origEval(); hooks.onEval && hooks.onEval(deck.tracker.lastT / FS, deck); };
  for (let s = 0; s + 128 <= x.length; s += 128) {
    if (hooks.at) hooks.at(s, deck);
    odf.push(x.subarray(s, s + 128), s);
  }
  return { deck, odf, batch };
}

function phaseStats(name, cfg, opts = {}) {
  const { x, truth } = synth({ ...cfg });
  const endSec = x.length / FS - 0.6;
  const errs = [];
  const { deck } = run(x, opts, {
    onEval: (t, d) => {
      const g = d.get();
      if (t > 8 && t < endSec && g.grid && g.state === 'LOCKED') errs.push(Math.abs(nearestBeatError(g.grid.t0, truth)) * 1000);
    },
  });
  errs.sort((a, b) => a - b);
  const p95 = errs.length ? errs[Math.floor(0.95 * (errs.length - 1))] : Infinity;
  return { deck, p95, n: errs.length };
}

const CASES = [
  ['house', 124, 0.1, 10], ['techno', 132.7, 0.1, 10], ['boombap', 92, 0.15, 12], ['trap', 140, 0.1, 10],
  ['pop', 102, 0.1, 10], ['dembow', 95, 0.1, 10], ['slowhh', 75, 0.15, 12], ['noisy128', 128, 0.1, 10],
];

for (const [name, bpm, tolBpm, tolMs] of CASES) {
  test(`${name}: locks to ${bpm} BPM with a tight grid`, () => {
    const { deck, p95, n } = phaseStats(name, PATTERNS[name]);
    const g = deck.get();
    assert.equal(g.state, 'LOCKED', `${name} state ${g.state}`);
    assert.ok(Math.abs(g.inBpm - bpm) <= tolBpm, `${name} bpm ${g.inBpm}`);
    assert.ok(g.canBeat, `${name} canBeat`);
    assert.ok(n > 10, `${name} phase samples ${n}`);
    assert.ok(p95 <= tolMs, `${name} phase p95 ${p95.toFixed(1)} ms`);
  });
}

test('dnb in range 88-175 locks to 174', () => {
  const { deck } = phaseStats('dnb', PATTERNS.dnb, { lo: 88, hi: 175 });
  assert.ok(Math.abs(deck.get().inBpm - 174) <= 0.15, String(deck.get().inBpm));
});

test('dnb in AUTO reads 87, and ×2 corrects it to 174 with a good grid', () => {
  const { x, truth } = synth({ ...PATTERNS.dnb, bars: 40 });
  let multiplied = false; const errs = [];
  const { deck } = run(x, {}, {
    onEval: (t, d) => {
      if (!multiplied && t > 12) { assert.ok(Math.abs(d.get().inBpm - 87) < 0.2, `auto ${d.get().inBpm}`); d.multiply(2); multiplied = true; }
      const g = d.get();
      if (multiplied && t > 20 && t < x.length / FS - 0.6 && g.grid) errs.push(Math.abs(nearestBeatError(g.grid.t0, truth)) * 1000);
    },
  });
  assert.ok(Math.abs(deck.get().inBpm - 174) <= 0.2, String(deck.get().inBpm));
  assert.equal(deck.get().mult, 2);
  errs.sort((a, b) => a - b);
  assert.ok(errs[Math.floor(0.95 * (errs.length - 1))] <= 10, `p95 ${errs[Math.floor(0.95 * (errs.length - 1))]}`);
});

test('ambient pad never locks and refuses beat sync', () => {
  const { deck } = run(synth({ ...PATTERNS.ambient }).x);
  const g = deck.get();
  assert.notEqual(g.state, 'LOCKED');
  assert.equal(g.canBeat, false);
});

test('silence holds a previously locked tempo', () => {
  const a = synth({ ...PATTERNS.house, bars: 16, tail: 0 });
  const silence = new Float32Array(FS * 6);
  const x = new Float32Array(a.x.length + silence.length); x.set(a.x); x.set(silence, a.x.length);
  const { deck } = run(x);
  const g = deck.get();
  assert.equal(g.state, 'HOLD');
  assert.ok(Math.abs(g.inBpm - 124) < 0.15);
});

test('sourceRateChanged keeps BPM and grid continuous across an assist step', () => {
  const bars1 = 16, rate = 1.03;
  const a = synth({ ...PATTERNS.house, bpm: 120, bars: bars1, tail: 0 });
  const b = synth({ ...PATTERNS.house, bpm: 120, rate, bars: 16, tail: 0.5 });
  const x = new Float32Array(a.x.length + b.x.length); x.set(a.x); x.set(b.x, a.x.length);
  const t1 = a.x.length / FS;
  const truth = [...a.truth, ...b.truth.map((t) => t + t1)];
  let notified = false; const errs = []; const bpms = [];
  run(x, {}, {
    at: (s, d) => { if (!notified && s >= a.x.length) { d.sourceRateChanged(rate, a.x.length); notified = true; } },
    onEval: (t, d) => {
      const g = d.get();
      if (notified) { bpms.push(g.inBpm); assert.notEqual(g.state, 'SEARCH', `searching at ${t}`); }
      if (notified && t > t1 + 4 && t < x.length / FS - 0.6 && g.grid) errs.push(Math.abs(nearestBeatError(g.grid.t0, truth)) * 1000);
    },
  });
  assert.ok(Math.abs(bpms[0] - 123.6) < 0.3, `bpm right after change ${bpms[0]}`);
  assert.ok(Math.abs(bpms[bpms.length - 1] - 123.6) < 0.15, `final ${bpms[bpms.length - 1]}`);
  errs.sort((p, q) => p - q);
  assert.ok(errs[Math.floor(0.95 * (errs.length - 1))] <= 15, `p95 ${errs[Math.floor(0.95 * (errs.length - 1))]}`);
});

test('tap tempo sets bpm and phase from 4+ taps', () => {
  const d = new DeckTempo({ sampleRate: FS, fps: 93.75 });
  for (let k = 0; k < 8; k++) d.tap(Math.round(10 * FS + k * 0.5 * FS + (k % 2 ? 200 : -200)));
  const g = d.get();
  assert.equal(g.tapped, true);
  assert.equal(g.state, 'LOCKED');
  assert.ok(Math.abs(g.inBpm - 120) < 0.5, String(g.inBpm));
  assert.ok(Math.abs(g.grid.T - 0.5) < 0.003);
  assert.ok(Math.abs(nearestBeatError(g.grid.t0, [13.5]) ) < 0.01);
  // A tap more than 2 s after the last one starts a new sequence.
  d.tap(Math.round(20 * FS));
  assert.equal(d.get().tapped, true);
});

test('grid shift by half a beat persists through later measurements', () => {
  const { x, truth } = synth({ ...PATTERNS.house, bars: 32 });
  let shifted = false; const errs = [];
  run(x, {}, {
    onEval: (t, d) => {
      if (!shifted && t > 10 && d.get().grid) { d.shiftGrid({ beats: 0.5, ms: 0 }); shifted = true; }
      const g = d.get();
      if (shifted && t > 14 && t < x.length / FS - 0.6) errs.push(Math.abs(nearestBeatError(g.grid.t0, truth)) * 1000);
    },
  });
  const halfBeatMs = (60 / 124 / 2) * 1000;
  const median = errs.sort((a, b) => a - b)[Math.floor(errs.length / 2)];
  assert.ok(Math.abs(median - halfBeatMs) < 15, `median ${median} vs ${halfBeatMs}`);
});

test('OdfCore emits band bytes and is allocation-free per sample', () => {
  const frames = [];
  const odf = new OdfCore(FS, (full, low, t, bl, bm, bh) => frames.push([full, low, t, bl, bm, bh]));
  const { x } = synth({ ...PATTERNS.house, bars: 2 });
  for (let s = 0; s + 128 <= x.length; s += 128) odf.push(x.subarray(s, s + 128), s);
  assert.equal(odf.spf, odf.H * odf.D);
  assert.ok(frames.length > 100);
  for (const f of frames) for (const b of f.slice(3)) assert.ok(Number.isInteger(b) && b >= 0 && b <= 255);
  // Kick frames (beat starts) carry more low-band energy than mid-beat frames.
  const beatFrames = frames.filter((f) => (f[2] / FS) % (60 / 124) < 0.03);
  const avgLow = (arr) => arr.reduce((a, f) => a + f[3], 0) / arr.length;
  assert.ok(avgLow(beatFrames) > avgLow(frames));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/unit/tempo.test.mjs`
Expected: FAIL with `Cannot find module '.../worklets/odf-core.js'`.

- [ ] **Step 4: Implement `worklets/odf-core.js`**

```js
// worklets/odf-core.js — onset detection function (ODF) core, shared by the
// deck-input AudioWorklet and the Node unit tests. push() is allocation-free.
//
// Mono input at ctx.sampleRate -> 4th-order Butterworth LP @ 0.4·fsDec -> decimate by D
// (to ~12 kHz) -> Hann(N=512) FFT every H=128 decimated samples -> log magnitude ->
// "SuperFlux-lite" flux (compare against a 3-bin max of the previous frame) ->
// half-wave-rectified flux for the full band and the low band (<150 Hz), plus
// three waveform band levels (low <250 Hz, mid <2.5 kHz, high) as bytes 0..255.
// Each frame is stamped with the input-frame index of the analysis-window centre.

class Biquad {
  constructor(b0, b1, b2, a1, a2) { this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2; this.z1 = 0; this.z2 = 0; }
  static lowpass(fs, f, q) {
    const w = (2 * Math.PI * f) / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), a0 = 1 + al;
    return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0);
  }
  step(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

const toByte = (mag) => {
  const db = 20 * Math.log10(mag + 1e-9);
  const v = Math.round(((db + 60) * 255) / 60);
  return v < 0 ? 0 : v > 255 ? 255 : v;
};

export class OdfCore {
  constructor(sampleRate, onFrame) {
    this.fs = sampleRate;
    this.D = Math.max(1, Math.round(sampleRate / 12000));
    this.fsDec = sampleRate / this.D;
    this.N = 512;
    this.H = 128;
    this.spf = this.H * this.D;
    this.fps = this.fsDec / this.H;
    this.lp1 = Biquad.lowpass(sampleRate, 0.4 * this.fsDec, Math.SQRT1_2);
    this.lp2 = Biquad.lowpass(sampleRate, 0.4 * this.fsDec, Math.SQRT1_2);
    this.ring = new Float32Array(this.N);
    this.w = 0;
    this.sinceHop = 0;
    this.decPhase = 0;
    this.win = new Float32Array(this.N);
    let wsum = 0;
    for (let i = 0; i < this.N; i++) { this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N); wsum += this.win[i]; }
    this.norm = 2 / wsum;
    this.re = new Float32Array(this.N);
    this.im = new Float32Array(this.N);
    this.K = this.N / 2;
    this.prev = new Float32Array(this.K);
    this.cur = new Float32Array(this.K);
    this.gamma = 100;
    const binHz = this.fsDec / this.N;
    this.lowMaxBin = Math.max(2, Math.round(150 / binHz));
    this.bandLowMax = Math.max(2, Math.round(250 / binHz));
    this.bandMidMax = Math.min(this.K - 2, Math.round(2500 / binHz));
    this.rev = new Uint16Array(this.N);
    const bits = Math.log2(this.N);
    for (let i = 0; i < this.N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float32Array(this.N / 2);
    this.sin = new Float32Array(this.N / 2);
    for (let i = 0; i < this.N / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / this.N); this.sin[i] = -Math.sin((2 * Math.PI * i) / this.N); }
    this.onFrame = onFrame;
    this.primed = false;
  }

  /** @param {Float32Array} block mono samples  @param {number} startFrame input-frame index of block[0] */
  push(block, startFrame) {
    for (let i = 0; i < block.length; i++) {
      const y = this.lp2.step(this.lp1.step(block[i]));
      if (++this.decPhase < this.D) continue;
      this.decPhase = 0;
      this.ring[this.w] = y;
      this.w = (this.w + 1) & (this.N - 1);
      if (++this.sinceHop >= this.H) {
        this.sinceHop = 0;
        this.frame(startFrame + i - (this.N / 2) * this.D);
      }
    }
  }

  frame(tCentre) {
    const N = this.N, re = this.re, im = this.im;
    for (let i = 0; i < N; i++) { const s = this.ring[(this.w + i) & (N - 1)] * this.win[i]; re[this.rev[i]] = s; im[this.rev[i]] = 0; }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let st = 0; st < N; st += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = st + j, b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    const cur = this.cur, prev = this.prev, K = this.K;
    let eL = 0, eM = 0, eH = 0;
    for (let k = 1; k < K; k++) {
      const mag = this.norm * Math.hypot(re[k], im[k]);
      cur[k] = Math.log1p(this.gamma * mag);
      const e = mag * mag;
      if (k <= this.bandLowMax) eL += e; else if (k <= this.bandMidMax) eM += e; else eH += e;
    }
    let full = 0, low = 0;
    if (this.primed) {
      for (let k = 1; k < K; k++) {
        const p = Math.max(prev[k], prev[k - 1], k + 1 < K ? prev[k + 1] : 0);
        const d = cur[k] - p;
        if (d > 0) { full += d; if (k <= this.lowMaxBin) low += d; }
      }
    }
    this.primed = true;
    prev.set(cur);
    this.onFrame(full, low, tCentre, toByte(Math.sqrt(eL)), toByte(Math.sqrt(eM)), toByte(Math.sqrt(eH)));
  }
}
```

- [ ] **Step 5: Implement `engine/tempo.js`**

```js
// engine/tempo.js — live tempo + beat-grid tracking for one deck. Pure: runs in the
// offscreen document (and Node tests), fed by ODF frames whose timestamps are input-frame
// indices, so results never depend on when this code happens to run.

export const DEFAULTS = Object.freeze({
  lo: 70, hi: 180, wideLo: 55, wideHi: 220, priorCenter: 120, priorSigmaOct: 1.0,
  windowSec: 8, phaseSec: 6, grid: 0.05, harmonics: [1, 1, 0.5, 0.5], smoothSigma: 1.5,
  fineSpanSec: 16, phaseOffsetMs: 4,
});

class Ring {
  constructor(n) { this.n = n; this.a = new Float32Array(n); this.w = 0; this.count = 0; }
  push(v) { this.a[this.w] = v; this.w = (this.w + 1) % this.n; if (this.count < this.n) this.count++; }
  last(m, out) { const s = (this.w - m + this.n * 2) % this.n; for (let i = 0; i < m; i++) out[i] = this.a[(s + i) % this.n]; return out; }
  clear() { this.w = 0; this.count = 0; }
}

function gaussSmooth(x, sigma) {
  if (!sigma) return x;
  const R = Math.ceil(3 * sigma), k = [];
  let ks = 0;
  for (let i = -R; i <= R; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); k.push(v); ks += v; }
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let j = -R; j <= R; j++) { const q = Math.min(x.length - 1, Math.max(0, i + j)); s += x[q] * k[j + R]; }
    y[i] = s / ks;
  }
  return y;
}

const rel = (a, b) => Math.abs(a / b - 1);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class TempoTracker {
  constructor(fps, opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.fps = fps;
    const cap = Math.ceil(12 * fps);
    this.full = new Ring(cap);
    this.low = new Ring(cap);
    this.lastT = 0; this.spf = 0; this.frames = 0;
    this.reset();
  }

  reset() {
    this.full.clear(); this.low.clear();
    this.state = 'search'; this.bpm = 0; this.cand = null; this.candCount = 0; this.conf = 0;
    this.beats = []; this.anchor = null; this.fineBpm = 0; this.fit = null; this.out = 0;
    this.holdUntil = 0; this.phaseFrom = 0;
  }

  resetFine() { this.beats = []; this.fit = null; this.anchor = null; this.fineBpm = 0; this.out = 0; }

  /** The input tempo changed by `ratio` at input frame tChange (assist step). */
  rateChanged(ratio, tChange, marginSec = 0.3) {
    const sr = this.spf * this.fps || 48000;
    if (this.bpm) this.bpm *= ratio;
    if (this.cand) this.cand *= ratio;
    this.resetFine();
    this.holdUntil = tChange + this.o.windowSec * sr;
    this.phaseFrom = tChange + marginSec * sr;
  }

  pushFrame(full, low, t) {
    if (this.frames > 0) this.spf = t - this.lastT;
    this.full.push(full); this.low.push(low); this.lastT = t; this.frames++;
  }

  estimate() {
    const o = this.o, fps = this.fps;
    const W = Math.min(this.full.count, Math.round(o.windowSec * fps));
    if (W < 4 * fps) return null;
    const x = this.full.last(W, new Float32Array(W));
    let y = new Float32Array(W);
    for (let i = 0; i < W; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - 8); j <= Math.min(W - 1, i + 7); j++) { s += x[j]; c++; }
      y[i] = Math.max(0, x[i] - s / c);
    }
    y = gaussSmooth(y, o.smoothSigma);
    let mean = 0; for (let i = 0; i < W; i++) mean += y[i]; mean /= W;
    let energy = 0; for (let i = 0; i < W; i++) { y[i] -= mean; energy += y[i] * y[i]; }
    if (energy / W < 1e-4) return { silent: true };
    const maxLag = Math.min(W - 2, Math.ceil((4 * 60 * fps) / o.wideLo) + 2);
    const r = new Float32Array(maxLag + 1);
    for (let L = 0; L <= maxLag; L++) { let s = 0; for (let i = L; i < W; i++) s += y[i] * y[i - L]; r[L] = s / (W - L); }
    const r0 = r[0];
    const interp = (lag) => { const i = Math.floor(lag), f = lag - i; return i + 1 > maxLag ? 0 : r[i] * (1 - f) + r[i + 1] * f; };
    const nG = Math.round((o.wideHi - o.wideLo) / o.grid) + 1;
    const S = new Float32Array(nG), Sw = new Float32Array(nG);
    let wsum = 0; for (const w of o.harmonics) wsum += w;
    for (let g = 0; g < nG; g++) {
      const bpm = o.wideLo + g * o.grid, tau = (60 * fps) / bpm;
      let s = 0; for (let k = 0; k < o.harmonics.length; k++) s += o.harmonics[k] * interp((k + 1) * tau);
      s /= wsum * r0;
      const lp = -0.5 * (Math.log2(bpm / o.priorCenter) / o.priorSigmaOct) ** 2;
      S[g] = s; Sw[g] = Math.max(0, s) * Math.exp(lp);
    }
    let best = 0; for (let g = 1; g < nG; g++) if (Sw[g] > Sw[best]) best = g;
    let off = 0;
    if (best > 0 && best < nG - 1) { const a = Sw[best - 1], b = Sw[best], c = Sw[best + 1]; const d = a - 2 * b + c; if (d < 0) off = (0.5 * (a - c)) / d; }
    let bpm = o.wideLo + (best + off) * o.grid;
    while (bpm < o.lo) bpm *= 2;
    while (bpm > o.hi) bpm /= 2;
    const related = (b) => [1, 2, 0.5, 1.5, 2 / 3, 3, 1 / 3].some((m) => Math.abs(b / (bpm * m) - 1) < 0.04);
    let second = 1e-9;
    for (let g = 0; g < nG; g++) { const b = o.wideLo + g * o.grid; if (!related(b) && Sw[g] > second) second = Sw[g]; }
    const salience = S[best], peakRatio = Sw[best] / second;
    const conf = clamp01((salience - 0.05) / 0.25) * clamp01((peakRatio - 1) / 0.6);
    return { bpm, salience, peakRatio, conf };
  }

  update(est) {
    if (!est || est.silent) return this.snapshot(est && est.silent ? 'hold' : undefined);
    if (this.holdUntil && this.lastT < this.holdUntil) return this.snapshot();
    if (this.state === 'search' || this.bpm === 0) {
      if (est.conf < 0.25) return this.snapshot();
      if (this.cand && rel(est.bpm, this.cand) < 0.02) this.candCount++; else { this.cand = est.bpm; this.candCount = 1; }
      if (this.candCount >= 3) { this.state = 'locked'; this.bpm = est.bpm; this.cand = null; this.candCount = 0; }
      this.conf = est.conf;
      return this.snapshot();
    }
    if (rel(est.bpm, this.bpm) < 0.02) {
      this.bpm += 0.2 * (est.bpm - this.bpm);
      this.conf += 0.3 * (est.conf - this.conf);
      this.cand = null; this.candCount = 0;
    } else {
      const octave = [2, 0.5, 1.5, 2 / 3].some((m) => rel(est.bpm, this.bpm * m) < 0.03);
      const need = octave ? 6 : 3;
      if (this.cand && rel(est.bpm, this.cand) < 0.02) this.candCount++; else { this.cand = est.bpm; this.candCount = 1; }
      if (this.candCount >= need && est.conf > (octave ? 0.5 : 0.3)) {
        this.bpm = est.bpm; this.conf = est.conf; this.cand = null; this.candCount = 0;
        this.resetFine();
      } else this.conf *= 0.9;
    }
    return this.snapshot();
  }

  bestBpm() { return this.fineBpm && rel(this.fineBpm, this.bpm) < 0.01 ? this.fineBpm : this.bpm; }
  snapshot(tag) { return { state: tag || this.state, bpm: this.bestBpm(), coarse: this.bpm, conf: this.conf }; }

  /** Phase comb at `bpm` (already multiplied by `mult`). Returns times in input frames. */
  phase(bpm, mult = 1) {
    const o = this.o, fps = this.fps;
    let W = Math.min(this.full.count, Math.round(o.phaseSec * fps));
    if (this.phaseFrom && this.lastT > this.phaseFrom) {
      const since = Math.floor((this.lastT - this.phaseFrom) / this.spf);
      if (since < W) W = Math.max(since, Math.ceil((2.2 * 60 * fps) / bpm));
    }
    W = Math.min(W, this.full.count);
    const f = this.full.last(W, new Float32Array(W)), l = this.low.last(W, new Float32Array(W));
    let mf = 1e-9, ml = 1e-9; for (let i = 0; i < W; i++) { mf += f[i]; ml += l[i]; } mf /= W; ml /= W;
    const z = new Float32Array(W);
    for (let i = 0; i < W; i++) z[i] = f[i] / mf + l[i] / ml;
    const s = gaussSmooth(z, 1);
    const at = (pos) => { const i = Math.floor(pos), fr = pos - i; if (i < 0 || i + 1 >= W) return 0; return s[i] * (1 - fr) + s[i + 1] * fr; };
    const tau = (60 * fps) / bpm;
    const K = Math.max(2, Math.floor((W - 2) / tau));
    const newest = W - 2, step = 0.25, nP = Math.ceil(tau / step);
    const P = new Float32Array(nP);
    for (let p = 0; p < nP; p++) { const phi = p * step; let acc = 0, g = 1; for (let k = 0; k < K; k++) { acc += g * at(newest - phi - k * tau); g *= 0.9; } P[p] = acc; }
    let best = 0; for (let p = 1; p < nP; p++) if (P[p] > P[best]) best = p;
    const a = P[(best - 1 + nP) % nP], b = P[best], c = P[(best + 1) % nP];
    const d = a - 2 * b + c, off = d < 0 ? (0.5 * (a - c)) / d : 0;
    let mean = 0; for (let p = 0; p < nP; p++) mean += P[p]; mean /= nP;
    const framesBack = W - 1 - newest + (best + off) * step;
    const sr = this.spf * fps;
    const beatT = this.lastT - framesBack * this.spf + (o.phaseOffsetMs / 1000) * sr;
    this.addBeat(beatT, tau * this.spf, mult);
    return { beatT, periodT: tau * this.spf, clarity: b / mean };
  }

  addBeat(t, T, mult) {
    if (this.anchor == null) { this.anchor = t; this.out = 0; }
    const sr = this.spf * this.fps;
    if (this.fit && this.beats.length >= 8) {
      const n = Math.round((t - this.fit.b) / this.fit.a);
      const resid = t - (this.fit.b + n * this.fit.a);
      if (Math.abs(resid) > 0.1 * T) {
        if (++this.out >= 4) { this.beats = []; this.anchor = t; this.fit = null; this.fineBpm = 0; this.out = 0; }
        return;
      }
      this.out = 0;
    }
    const n = Math.round((t - this.anchor) / T);
    const last = this.beats[this.beats.length - 1];
    if (last && last.n === n) last.t = t; else this.beats.push({ n, t });
    while (this.beats.length && t - this.beats[0].t > this.o.fineSpanSec * sr) this.beats.shift();
    if (this.beats.length < 8) return;
    let sn = 0, st = 0, snn = 0, snt = 0; const m = this.beats.length;
    for (const bt of this.beats) { sn += bt.n; st += bt.t; snn += bt.n * bt.n; snt += bt.n * bt.t; }
    const a = (m * snt - sn * st) / (m * snn - sn * sn);
    const b0 = (st - a * sn) / m;
    if (a > 0) { this.fit = { a, b: b0 }; this.fineBpm = (60 * sr) / a / mult; }
  }
}

export class BeatClock {
  constructor() { this.t0 = null; this.T = 0; this.miss = 0; }
  update(tMeas, T, beta = 0.3) {
    this.T = T;
    if (this.t0 == null) { this.t0 = tMeas; return this.t0; }
    const k = Math.round((tMeas - this.t0) / T), pred = this.t0 + k * T, e = tMeas - pred;
    if (Math.abs(e) < T / 4) { this.t0 = pred + beta * e; this.miss = 0; }
    else if (++this.miss >= 3) { this.t0 = tMeas; this.miss = 0; }
    else this.t0 = pred;
    return this.t0;
  }
}

/** One deck's tempo state: tracker + beat clock + manual corrections (×2/½, TAP, GRID, TAP 1). */
export class DeckTempo {
  constructor({ sampleRate, fps, lo = DEFAULTS.lo, hi = DEFAULTS.hi }) {
    this.sr = sampleRate;
    this.fps = fps;
    this.tracker = new TempoTracker(fps, { lo, hi });
    this.estEvery = Math.max(1, Math.round(0.5 * fps));
    this.reset();
  }

  reset() {
    this.tracker.reset();
    this.clock = new BeatClock();
    this.mult = 1;
    this.tapped = null;
    this.taps = [];
    this.bar1 = null;
    this.gridOffset = 0;
    this.sinceEst = 0;
    this.snap = { state: 'search', bpm: 0, coarse: 0, conf: 0 };
  }

  setRange(lo, hi) { this.tracker.o.lo = lo; this.tracker.o.hi = hi; this.reset(); }

  pushBatch({ t0, spf, full, low }) { for (let i = 0; i < full.length; i++) this.pushFrame(full[i], low[i], t0 + i * spf); }

  pushFrame(full, low, t) {
    this.tracker.pushFrame(full, low, t);
    if (++this.sinceEst >= this.estEvery) { this.sinceEst = 0; this.evaluate(); }
  }

  /** True when the last 1.5 s of onset energy is under 10% of the 8 s mean (breakdown, pause, silence). */
  recentlyQuiet() {
    const tr = this.tracker, nR = Math.round(1.5 * this.fps), nL = Math.min(tr.full.count, Math.round(8 * this.fps));
    if (tr.full.count < nR || nL <= nR) return false;
    const mean = (n) => { const a = tr.full.last(n, new Float32Array(n)); let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s / n; };
    const r = mean(nR), l = mean(nL);
    return r < 1e-4 || r < 0.1 * l;
  }

  evaluate() {
    const prev = this.snap.coarse;
    this.snap = this.tracker.update(this.tracker.estimate());
    if (this.snap.state !== 'hold' && this.snap.bpm && this.recentlyQuiet()) this.snap = this.tracker.snapshot('hold');
    if (prev && this.snap.coarse && rel(this.snap.coarse, prev) > 0.03 && this.snap.state !== 'hold') {
      // The tracker accepted a new tempo (new track): manual corrections no longer apply.
      this.mult = 1; this.tapped = null; this.gridOffset = 0; this.clock = new BeatClock(); this.bar1 = null;
    }
    const bpm = this.bpmIn();
    const usable = this.tapped || this.tracker.state === 'locked';
    if (!bpm || !usable || this.snap.state === 'hold') return;
    if (this.tracker.full.count < (2.2 * 60 * this.fps) / bpm) return;
    const ph = this.tracker.phase(bpm, this.tapped ? 1 : this.mult);
    if (ph.clarity >= 2 || this.clock.t0 == null) this.clock.update(ph.beatT + this.gridOffset, ph.periodT);
    else this.clock.T = ph.periodT;
  }

  bpmIn() {
    if (this.tapped) return this.tapped.bpm;
    return this.snap.bpm ? this.snap.bpm * this.mult : 0;
  }

  multiply(factor) {
    const next = this.mult * factor;
    if (next < 0.25 || next > 4) return;
    this.mult = next;
    this.tapped = null;
    this.tracker.resetFine();
    this.gridOffset = 0;
    this.clock = new BeatClock();
  }

  tap(inFrame) {
    const last = this.taps[this.taps.length - 1];
    if (last != null && inFrame - last > 2 * this.sr) this.taps = [];
    this.taps.push(inFrame);
    if (this.taps.length > 9) this.taps.shift();
    if (this.taps.length < 4) return null;
    const iv = this.taps.slice(1).map((t, i) => t - this.taps[i]).sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    if (!(med > 0)) return null;
    // Least-squares line through the taps, indexed by whole beats: robust to alternating jitter.
    const first = this.taps[0], m = this.taps.length;
    let sn = 0, st = 0, snn = 0, snt = 0;
    for (const t of this.taps) { const n = Math.round((t - first) / med); sn += n; st += t; snn += n * n; snt += n * t; }
    const den = m * snn - sn * sn;
    const period = den > 0 ? (m * snt - sn * st) / den : med;
    if (!(period > 0)) return null;
    const b0 = (st - period * sn) / m;
    const nLast = Math.round((this.taps[m - 1] - first) / med);
    const bpm = (60 * this.sr) / period;
    this.tapped = { bpm };
    this.mult = 1;
    this.gridOffset = 0;
    this.clock = new BeatClock();
    this.clock.t0 = b0 + nLast * period;
    this.clock.T = period;
    return bpm;
  }

  shiftGrid({ beats = 0, ms = 0 }) {
    if (this.clock.t0 == null || !this.clock.T) return;
    const T = this.clock.T;
    const delta = beats * T + (ms / 1000) * this.sr;
    this.gridOffset += delta;
    if (Math.abs(this.gridOffset) > T / 2) this.gridOffset -= Math.round(this.gridOffset / T) * T;
    this.clock.t0 += delta;
  }

  setBar1(inFrame) {
    const { t0, T } = this.clock;
    this.bar1 = t0 != null && T ? t0 + Math.round((inFrame - t0) / T) * T : inFrame;
  }

  sourceRateChanged(ratio, atFrame) {
    if (!(ratio > 0) || ratio === 1) return;
    this.tracker.rateChanged(ratio, atFrame);
    if (this.tapped) this.tapped.bpm *= ratio;
    if (this.clock.t0 != null && this.clock.T) {
      const k = Math.floor((atFrame - this.clock.t0) / this.clock.T);
      this.clock.t0 += k * this.clock.T;
      this.clock.T /= ratio;
      this.clock.miss = 0;
    }
    this.gridOffset /= ratio;
    this.snap = { ...this.snap, bpm: this.snap.bpm * ratio, coarse: this.snap.coarse * ratio };
  }

  get() {
    const bpm = this.bpmIn();
    const tr = this.tracker;
    let state;
    if (this.tapped) state = 'LOCKED';
    else if (this.snap.state === 'hold' && bpm) state = 'HOLD';
    else if (tr.state === 'locked') state = tr.conf >= 0.5 ? 'LOCKED' : 'UNSURE';
    else state = 'SEARCH';
    const grid = this.clock.t0 != null && this.clock.T > 0
      ? { t0: this.clock.t0 / this.sr, T: this.clock.T / this.sr, bar1: this.bar1 == null ? null : this.bar1 / this.sr }
      : null;
    const canBeat = !!grid && (!!this.tapped || (tr.state === 'locked' && tr.conf >= 0.5));
    return { state, inBpm: bpm || null, conf: this.tapped ? 1 : tr.conf, mult: this.mult, tapped: !!this.tapped, grid, canBeat };
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/unit/tempo.test.mjs`
Expected: PASS (all cases). If one genre misses its tolerance, compare against the prototype
(`node test.js` in the scratchpad `bpmproto/`, which must give the same numbers) before touching
any constants. A deviation means a porting bug.

- [ ] **Step 7: Commit**

```bash
git add worklets/odf-core.js engine/tempo.js tests/unit/fixtures/synth.mjs tests/unit/tempo.test.mjs
git commit -m "Add onset core and deck tempo tracker with grid tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---
## Task 3: Deck-input worklet (chunker + ODF + waveform bands)

**Files:**
- Create: `worklets/deck-input.js`
- Create: `tests/unit/worklet-shim.mjs`, `tests/unit/deck-input.test.mjs`

**Interfaces:**
- Consumes: `OdfCore` (Task 2), `DeckTempo` (Task 2, used in the test only).
- Produces: AudioWorklet processor `'jds-deck-input'`. Create it with
  `new AudioWorkletNode(ctx, 'jds-deck-input', {numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[1], channelCount:2, channelCountMode:'explicit', channelInterpretation:'speakers'})`.
  Port messages from the worklet:
  - `{t:'init', fps, spf, chunk}`: sent once.
  - `{t:'chunk', start, L:Float32Array, R:Float32Array, peak:number, firstAbove:number}`.
    `start` is the input frame of `L[0]`. Chunks are 2048 frames, contiguous from 0, with
    buffers transferred. `firstAbove` is the index of the first sample whose |x| > 0.003, or −1.
  - `{t:'odf', t0, spf, full:Float32Array(8), low:Float32Array(8), bands:Uint8Array(24)}`.
    `t0` is the input frame of the first hop's window centre; hop i is at `t0 + i·spf`.
- Produces (test helper): `tests/unit/worklet-shim.mjs` exports
  `loadWorklet(path, {sampleRate}) → Promise<{[name]: ProcessorClass}>`. Instances get
  `instance.port.posted: Array<{msg, transfer}>` and `instance.port.deliver(msg)` (calls
  `onmessage`).

- [ ] **Step 1: Write the worklet shim** — `tests/unit/worklet-shim.mjs`

```js
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
```

- [ ] **Step 2: Write the failing tests** — `tests/unit/deck-input.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet, runBlocks } from './worklet-shim.mjs';
import { DeckTempo } from '../../engine/tempo.js';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

const reg = await loadWorklet('worklets/deck-input.js', { sampleRate: FS });
const Proc = reg['jds-deck-input'];

const msgs = (p, t) => p.port.posted.map((x) => x.msg).filter((m) => m.t === t);

test('registers jds-deck-input and announces its timing', () => {
  assert.ok(Proc, 'processor registered');
  const p = new Proc();
  const init = msgs(p, 'init')[0];
  assert.equal(init.chunk, 2048);
  assert.equal(init.spf, 128 * 4);
  assert.ok(Math.abs(init.fps - 93.75) < 1e-9);
});

test('chunks are contiguous, exact copies, and transferred', () => {
  const p = new Proc();
  const n = 2048 * 5 + 128 * 3;
  const L = new Float32Array(n).map((_, i) => Math.sin(i / 10));
  const R = new Float32Array(n).map((_, i) => Math.cos(i / 7));
  runBlocks(p, [L, R]);
  const chunks = msgs(p, 'chunk');
  assert.equal(chunks.length, 5);
  chunks.forEach((c, k) => {
    assert.equal(c.start, k * 2048);
    assert.equal(c.L.length, 2048);
    assert.deepEqual(Array.from(c.L), Array.from(L.subarray(k * 2048, (k + 1) * 2048)));
    assert.deepEqual(Array.from(c.R), Array.from(R.subarray(k * 2048, (k + 1) * 2048)));
  });
  const posted = p.port.posted.find((x) => x.msg.t === 'chunk');
  assert.equal(posted.transfer.length, 2);
});

test('mono input is duplicated and missing input counts as silence', () => {
  const p = new Proc();
  const mono = new Float32Array(2048).fill(0.25);
  runBlocks(p, [mono]);
  for (let s = 0; s < 2048; s += 128) p.process([[]], [[new Float32Array(128)]], {});
  const [a, b] = msgs(p, 'chunk');
  assert.equal(a.R[100], 0.25);
  assert.equal(b.start, 2048);
  assert.equal(b.L[5], 0);
  assert.equal(a.peak, 0.25);
  assert.equal(a.firstAbove, 0);
  assert.equal(b.firstAbove, -1);
});

test('ODF batches are evenly stamped and drive tempo detection', () => {
  const p = new Proc();
  const { x } = synth({ ...PATTERNS.house, bars: 20 });
  runBlocks(p, [x, x]);
  const odf = msgs(p, 'odf');
  assert.ok(odf.length > 100);
  for (let i = 1; i < odf.length; i++) assert.equal(odf[i].t0 - odf[i - 1].t0, 8 * odf[i].spf);
  assert.equal(odf[0].bands.length, 24);
  const d = new DeckTempo({ sampleRate: FS, fps: 93.75 });
  for (const m of odf) d.pushBatch(m);
  const g = d.get();
  assert.equal(g.state, 'LOCKED');
  assert.ok(Math.abs(g.inBpm - 124) < 0.15, String(g.inBpm));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/unit/deck-input.test.mjs`
Expected: FAIL (module `worklets/deck-input.js` not found).

- [ ] **Step 4: Implement `worklets/deck-input.js`**

```js
// worklets/deck-input.js — one per deck, fed by the captured tab's MediaStreamSource.
//  1. Counts input frames from 0: this is the deck's input timeline.
//  2. Batches stereo audio into 2048-frame transferable chunks for the time-shift buffer.
//  3. Runs the onset detection function on the mono downmix and batches its frames
//     (onset strength + waveform band levels) for tempo tracking and the UI waveform.
import { OdfCore } from './odf-core.js';

const CHUNK = 2048;
const ODF_BATCH = 8;
const AUDIBLE = 0.003; // about -50 dBFS

class DeckInput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
    this.mono = new Float32Array(128);
    this.newChunk(0);
    this.odf = new OdfCore(sampleRate, (full, low, t, bl, bm, bh) => this.onOdf(full, low, t, bl, bm, bh));
    this.newOdfBatch();
    this.port.postMessage({ t: 'init', fps: this.odf.fps, spf: this.odf.spf, chunk: CHUNK });
  }

  newChunk(start) {
    this.L = new Float32Array(CHUNK);
    this.R = new Float32Array(CHUNK);
    this.fill = 0;
    this.chunkStart = start;
    this.peak = 0;
    this.firstAbove = -1;
  }

  newOdfBatch() {
    this.full = new Float32Array(ODF_BATCH);
    this.low = new Float32Array(ODF_BATCH);
    this.bands = new Uint8Array(ODF_BATCH * 3);
    this.nOdf = 0;
    this.odfT0 = 0;
  }

  onOdf(full, low, t, bl, bm, bh) {
    const i = this.nOdf;
    if (i === 0) this.odfT0 = t;
    this.full[i] = full;
    this.low[i] = low;
    this.bands[i * 3] = bl;
    this.bands[i * 3 + 1] = bm;
    this.bands[i * 3 + 2] = bh;
    if (++this.nOdf === ODF_BATCH) {
      this.port.postMessage(
        { t: 'odf', t0: this.odfT0, spf: this.odf.spf, full: this.full, low: this.low, bands: this.bands },
        [this.full.buffer, this.low.buffer, this.bands.buffer],
      );
      this.newOdfBatch();
    }
  }

  process(inputs) {
    const input = inputs[0];
    const l = input && input.length ? input[0] : null;
    const r = input && input.length > 1 ? input[1] : l;
    const n = l ? l.length : 128;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    const blockStart = this.frames;
    for (let i = 0; i < n; i++) {
      const a = l ? l[i] : 0;
      const b = r ? r[i] : 0;
      const f = this.fill;
      this.L[f] = a;
      this.R[f] = b;
      this.mono[i] = 0.5 * (a + b);
      const m = a > 0 ? a : -a, m2 = b > 0 ? b : -b, mx = m > m2 ? m : m2;
      if (mx > this.peak) this.peak = mx;
      if (this.firstAbove < 0 && mx > AUDIBLE) this.firstAbove = f;
      if (++this.fill === CHUNK) {
        this.port.postMessage(
          { t: 'chunk', start: this.chunkStart, L: this.L, R: this.R, peak: this.peak, firstAbove: this.firstAbove },
          [this.L.buffer, this.R.buffer],
        );
        this.newChunk(blockStart + i + 1);
      }
    }
    this.odf.push(this.mono, blockStart);
    this.frames += n;
    return true;
  }
}

registerProcessor('jds-deck-input', DeckInput);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/unit/deck-input.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add worklets/deck-input.js tests/unit/worklet-shim.mjs tests/unit/deck-input.test.mjs
git commit -m "Add deck-input worklet: chunker, onset curve and waveform bands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---
## Task 4: Sync, mixing and assist maths (pure)

**Files:**
- Create: `engine/sync.js`, `tests/unit/sync.test.mjs`

**Interfaces:**
- Produces (`engine/sync.js`, all pure):
  - **Gain and mixing:**
    - `dbToGain(db)`, `gainToDb(g)`, `knobToGain(k, maxDb)`;
    - `crossfaderGains(pos, curve:'SMOOTH'|'SHARP') → {a, b}`;
    - `deckXfGain(assign:'A'|'THRU'|'B', {a,b}) → number`.
  - **Tempo matching:**
    - `chooseMultiplier(masterBpm, nativeBpm) → 0.5|1|2`;
    - `syncRatio(masterBpm, nativeBpm, range) → {ratio, mult, want, outOfRange}`.
  - **Phase:**
    - `lastBeatOut(grid:{t0,T}, playhead, engineRate, tOut) → seconds`;
    - `wrapToHalf(x, P)`;
    - `phaseError(slaveLast, slavePeriod, masterLast, masterPeriod) → seconds` (> 0 means the
      slave is late);
    - `planCorrection(e, {audible, keyLock}) → {kind:'none'} | {kind:'bend', bend, duration} | {kind:'jump', seconds}`;
    - `PHASE_DEADBAND`.
  - **Master clock:** `class MasterClock` with `follow(id)`, `release(id)`,
    `update(tOut, info|null)`, `beat(tOut) → {lastBeat, period, bpm}|null`,
    `state() → {mode, deckId, bpm}`, and `assigned` (the deck id the clock follows or resumes).
  - **Auto master:** `pickAutoMaster(cands:[{id, playing, canBeat, conf, since}]) → id|null`.
  - **Assist:** `ASSIST`;
    `assistStep({need, reserve, sourceRate, target, available, playing, enabled}) → {target, next}`.
  - **Pitch and filter:** `engineSemitones(keyLock, sourceRate, engineRate)`;
    `djFilterParams(x, res) → {mode:'off'|'lp'|'hp', freq, q1, q2}`.

- [ ] **Step 1: Write the failing tests** — `tests/unit/sync.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dbToGain, gainToDb, knobToGain, crossfaderGains, deckXfGain, chooseMultiplier, syncRatio, lastBeatOut,
  wrapToHalf, phaseError, planCorrection, PHASE_DEADBAND, MasterClock, pickAutoMaster, assistStep, ASSIST,
  engineSemitones, djFilterParams,
} from '../../engine/sync.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('knob law: centre unity, +maxDb right, cubic to -inf left', () => {
  assert.ok(near(knobToGain(0.5, 6), 1));
  assert.ok(near(knobToGain(1, 6), dbToGain(6)));
  assert.ok(near(knobToGain(1, 12), dbToGain(12)));
  assert.ok(near(knobToGain(0.25, 6), 0.125));
  assert.equal(knobToGain(0, 6), 0);
  assert.ok(near(gainToDb(dbToGain(-18)), -18, 1e-9));
  assert.equal(gainToDb(0), -Infinity);
});

test('crossfader curves', () => {
  for (const curve of ['SMOOTH', 'SHARP']) {
    assert.deepEqual(crossfaderGains(0, curve), { a: 1, b: 0 });
    assert.deepEqual(crossfaderGains(1, curve), { a: 0, b: 1 });
  }
  const m = crossfaderGains(0.5, 'SMOOTH');
  assert.ok(near(m.a, Math.SQRT1_2, 1e-12) && near(m.b, Math.SQRT1_2, 1e-12));
  for (let p = 0; p <= 1; p += 0.05) { const g = crossfaderGains(p, 'SMOOTH'); assert.ok(near(g.a ** 2 + g.b ** 2, 1, 1e-9)); }
  assert.deepEqual(crossfaderGains(0.5, 'SHARP'), { a: 1, b: 1 });
  assert.ok(near(crossfaderGains(0.975, 'SHARP').a, 0.5, 1e-9));
  assert.equal(deckXfGain('THRU', { a: 0, b: 0 }), 1);
  assert.equal(deckXfGain('A', { a: 0.3, b: 0.9 }), 0.3);
  assert.equal(deckXfGain('B', { a: 0.3, b: 0.9 }), 0.9);
});

test('sync ratio is half/double aware and range-clamped', () => {
  assert.equal(chooseMultiplier(128, 64), 0.5);
  assert.equal(chooseMultiplier(128, 124), 1);
  assert.equal(chooseMultiplier(87, 174), 2);
  assert.deepEqual(syncRatio(128, 124, 0.1), { ratio: 128 / 124, mult: 1, want: 128 / 124, outOfRange: false });
  const far = syncRatio(128, 174, 0.1);
  assert.equal(far.mult, 1);
  assert.equal(far.outOfRange, true);
  assert.ok(near(far.ratio, 0.9));
  assert.equal(syncRatio(128, 174, 0.5).outOfRange, false);
  assert.ok(near(syncRatio(128, 64, 0.06).ratio, 1));
});

test('beat phase helpers', () => {
  // Grid anchored at input 1.0 s, 0.5 s per beat; playhead at 3.2 s input, rate 1 => 0.2 s past a beat.
  assert.ok(near(lastBeatOut({ t0: 1, T: 0.5 }, 3.2, 1, 100), 99.8, 1e-9));
  // At rate 2 the same input offset takes half the output time.
  assert.ok(near(lastBeatOut({ t0: 1, T: 0.5 }, 3.2, 2, 100), 99.9, 1e-9));
  assert.ok(near(wrapToHalf(0.3, 0.5), -0.2, 1e-12));
  assert.ok(near(wrapToHalf(-0.3, 0.5), 0.2, 1e-12));
  assert.ok(near(wrapToHalf(0.1, 0.5), 0.1, 1e-12));
  assert.ok(near(phaseError(10.02, 0.5, 10.0, 0.5), 0.02, 1e-12));
  assert.ok(near(phaseError(10.48, 0.5, 10.0, 0.5), -0.02, 1e-12));
  // Slave at double time: compare on the finer grid.
  assert.ok(near(phaseError(10.26, 0.25, 10.0, 0.5), 0.01, 1e-12));
});

test('correction planner', () => {
  assert.deepEqual(planCorrection(PHASE_DEADBAND / 2, { audible: true, keyLock: true }), { kind: 'none' });
  assert.deepEqual(planCorrection(0.08, { audible: false, keyLock: true }), { kind: 'jump', seconds: 0.08 });
  const b = planCorrection(0.1, { audible: true, keyLock: true });
  assert.equal(b.kind, 'bend');
  assert.ok(b.bend > 0 && b.bend <= 0.04);
  assert.ok(near(b.bend * b.duration, 0.1, 1e-12));
  const v = planCorrection(-0.1, { audible: true, keyLock: false });
  assert.ok(v.bend < 0 && v.bend >= -0.02);
  assert.ok(near(v.bend * v.duration, -0.1, 1e-12));
  // Just above the dead band: a gentle 1.5% bend for 0.4 s.
  const tiny = planCorrection(0.006, { audible: true, keyLock: true });
  assert.ok(near(tiny.bend, 0.015, 1e-12) && near(tiny.duration, 0.4, 1e-9));
});

test('closed-loop phase sync converges (bends only, 3 ms measurement noise)', () => {
  let seed = 4242; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const P = 60 / 128, dt = 0.01, lockTimes = [];
  for (let trial = 0; trial < 500; trial++) {
    let phase = (rnd() - 0.5) * P, bend = 0, bendEnd = -1, settle = 0, next = 0.5, tLock = null;
    for (let t = 0; t < 20; t += dt) {
      if (t < bendEnd) phase -= bend * dt;
      if (t >= next) {
        next += 0.5;
        if (t >= settle) {
          const plan = planCorrection(wrapToHalf(phase + 0.003 * gauss(), P), { audible: true, keyLock: true });
          if (plan.kind === 'bend') { bend = plan.bend; bendEnd = t + plan.duration; settle = bendEnd + 0.25; }
        }
      }
      if (tLock == null && Math.abs(wrapToHalf(phase, P)) < 0.01 && t >= bendEnd) tLock = t;
    }
    lockTimes.push(tLock ?? 99);
  }
  lockTimes.sort((a, b) => a - b);
  assert.ok(lockTimes[Math.floor(0.95 * (lockTimes.length - 1))] < 8, `p95 lock ${lockTimes[Math.floor(0.95 * (lockTimes.length - 1))]}`);
});

test('master clock follows, goes free, resumes and releases', () => {
  const c = new MasterClock();
  assert.equal(c.beat(1), null);
  c.follow(3);
  c.update(10, { playing: true, bpm: 120, lastBeat: 9.9, period: 0.5 });
  assert.deepEqual(c.state(), { mode: 'deck', deckId: 3, bpm: 120 });
  assert.ok(near(c.beat(10.75).lastBeat, 10.4, 1e-12));
  c.update(11, { playing: false, bpm: 120, lastBeat: 10.9, period: 0.5 });
  assert.equal(c.state().mode, 'free');
  assert.equal(c.assigned, 3);
  assert.ok(near(c.beat(20.1).lastBeat, 19.9, 1e-12)); // free-running on the old grid
  c.update(21, { playing: true, bpm: 126, lastBeat: 20.95, period: 60 / 126 });
  assert.deepEqual(c.state(), { mode: 'deck', deckId: 3, bpm: 126 });
  c.release(3);
  assert.equal(c.state().mode, 'free');
  assert.equal(c.assigned, null);
  c.update(30, null);
  assert.equal(c.state().mode, 'free');
  const fresh = new MasterClock(); fresh.follow(1); fresh.update(1, null);
  assert.equal(fresh.state().mode, 'none');
});

test('auto master prefers a playing, beat-locked, confident, long-running deck', () => {
  assert.equal(pickAutoMaster([]), null);
  assert.equal(pickAutoMaster([{ id: 1, playing: false, canBeat: true, conf: 1, since: 0 }]), null);
  assert.equal(pickAutoMaster([
    { id: 1, playing: true, canBeat: false, conf: 0.9, since: 0 },
    { id: 2, playing: true, canBeat: true, conf: 0.8, since: 5 },
    { id: 3, playing: true, canBeat: true, conf: 0.8, since: 2 },
  ]), 3);
  assert.equal(pickAutoMaster([{ id: 4, playing: true, canBeat: false, conf: 0.4, since: 0 }]), 4);
});

test('assist policy engages, holds, disengages and ramps', () => {
  const base = { need: 1.04, sourceRate: 1, target: 1, available: true, playing: true, enabled: true };
  let r = assistStep({ ...base, reserve: 5 });
  assert.ok(near(r.target, 1.07));
  assert.ok(near(r.next, 1 + ASSIST.step));
  r = assistStep({ ...base, reserve: 12, target: 1.07, sourceRate: 1.07 });
  assert.ok(near(r.target, 1.07)); // hysteresis: still engaged between the waters
  r = assistStep({ ...base, reserve: 25, target: 1.07, sourceRate: 1.07 });
  assert.equal(r.target, 1);
  assert.ok(near(r.next, 1.07 - ASSIST.step));
  assert.equal(assistStep({ ...base, reserve: 2, need: 0.97 }).target, 1);
  assert.equal(assistStep({ ...base, reserve: 2, available: false }).target, 1);
  assert.equal(assistStep({ ...base, reserve: 2, enabled: false }).target, 1);
  assert.equal(assistStep({ ...base, reserve: 2, playing: false }).target, 1);
  assert.equal(assistStep({ ...base, reserve: 2, need: 1.3 }).target, ASSIST.max);
  assert.equal(assistStep({ ...base, reserve: 2, sourceRate: 1.0699, target: 1.07 }).next, 1.07);
  // Hysteresis: tiny tempo refinements do not retarget an engaged assist...
  assert.equal(assistStep({ ...base, need: 1.0405, reserve: 5, target: 1.07, sourceRate: 1.07 }).target, 1.07);
  // ...but a real change (>= 1%) does, and so does a need that the target no longer covers.
  assert.ok(near(assistStep({ ...base, need: 1.06, reserve: 5, target: 1.07, sourceRate: 1.07 }).target, 1.09));
  assert.ok(near(assistStep({ ...base, need: 1.068, reserve: 5, target: 1.07, sourceRate: 1.07 }).target, 1.098));
});

test('engine pitch compensation', () => {
  assert.equal(engineSemitones(true, 1, 1.05), 0);
  assert.ok(near(engineSemitones(true, 1.06, 0.98), -12 * Math.log2(1.06)));
  assert.ok(near(engineSemitones(false, 1.06, 0.98), 12 * Math.log2(0.98)));
});

test('DJ filter mapping', () => {
  assert.equal(djFilterParams(0, 0.3).mode, 'off');
  assert.equal(djFilterParams(0.03, 0.3).mode, 'off');
  const lp = djFilterParams(-1, 0);
  assert.equal(lp.mode, 'lp');
  assert.ok(near(lp.freq, 70, 1e-6));
  const hp = djFilterParams(1, 0);
  assert.equal(hp.mode, 'hp');
  assert.ok(near(hp.freq, 8000, 1e-6));
  assert.ok(djFilterParams(-0.5, 0).freq < 20000 && djFilterParams(-0.5, 0).freq > 70);
  assert.ok(near(djFilterParams(1, 1).q2 - djFilterParams(1, 0).q2, 12, 1e-9));
  assert.ok(near(djFilterParams(1, 0).q1, -5.33) && near(djFilterParams(1, 0).q2, 2.32));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/sync.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `engine/sync.js`**

```js
// engine/sync.js — pure maths for mixing, sync and player assist. No Web Audio, no chrome.*.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

/** Gain knob: centre = unity, right end = +maxDb, left side cubic down to silence. */
export function knobToGain(k, maxDb) {
  if (k >= 0.5) return dbToGain((maxDb * (Math.min(1, k) - 0.5)) / 0.5);
  const x = 2 * Math.max(0, k);
  return x * x * x;
}

/** Gains for decks assigned to side A and side B. */
export function crossfaderGains(pos, curve) {
  const p = clamp(pos, 0, 1);
  if (curve === 'SHARP') {
    const edge = 0.05;
    return { a: p <= 1 - edge ? 1 : (1 - p) / edge, b: p >= edge ? 1 : p / edge };
  }
  const a = Math.cos((p * Math.PI) / 2), b = Math.sin((p * Math.PI) / 2);
  return { a: a < 1e-9 ? 0 : a, b: b < 1e-9 ? 0 : b };
}

export function deckXfGain(assign, g) {
  return assign === 'A' ? g.a : assign === 'B' ? g.b : 1;
}

export function chooseMultiplier(masterBpm, nativeBpm) {
  let best = 1, bestErr = Infinity;
  for (const m of [1, 0.5, 2]) {
    const e = Math.abs(Math.log2((masterBpm * m) / nativeBpm));
    if (e < bestErr - 1e-12) { bestErr = e; best = m; }
  }
  return best;
}

/** Tempo ratio (1+pitch) that makes a deck of `nativeBpm` play at `masterBpm`·mult. */
export function syncRatio(masterBpm, nativeBpm, range) {
  const mult = chooseMultiplier(masterBpm, nativeBpm);
  const want = (masterBpm * mult) / nativeBpm;
  const ratio = clamp(want, 1 - range, 1 + range);
  return { ratio, mult, want, outOfRange: Math.abs(ratio - want) > 1e-9 };
}

/** Output time of the most recent beat at or before tOut, from the deck's input-time grid. */
export function lastBeatOut(grid, playhead, engineRate, tOut) {
  const beats = (playhead - grid.t0) / grid.T;
  const frac = beats - Math.floor(beats);
  return tOut - (frac * grid.T) / engineRate;
}

export function wrapToHalf(x, P) {
  return ((((x + P / 2) % P) + P) % P) - P / 2;
}

/** Positive = the slave's beats arrive later than the master's (slave must speed up). */
export function phaseError(slaveLast, slavePeriod, masterLast, masterPeriod) {
  return wrapToHalf(slaveLast - masterLast, Math.min(slavePeriod, masterPeriod));
}

export const PHASE_DEADBAND = 0.005;

/**
 * Plan one correction for phase error e (seconds).
 * bend: play at rate·(1+bend) for `duration` seconds (bend·duration = e exactly).
 * jump: move the playhead forward by e output-seconds (caller multiplies by engineRate).
 */
export function planCorrection(e, { audible, keyLock }) {
  const ae = Math.abs(e);
  if (ae <= PHASE_DEADBAND) return { kind: 'none' };
  if (!audible) return { kind: 'jump', seconds: e };
  const dmax = keyLock ? 0.04 : 0.02, dmin = 0.005, target = 0.4;
  const bend = Math.sign(e) * clamp(ae / target, dmin, dmax);
  return { kind: 'bend', bend, duration: ae / Math.abs(bend) };
}

/**
 * Traktor-style master clock. Follows an assigned deck while it plays; when the deck
 * pauses or disappears the clock keeps running freely on the last tempo and phase.
 */
export class MasterClock {
  constructor() {
    this.mode = 'none';
    this.assigned = null;
    this.bpm = null;
    this.anchor = 0;
    this.period = 0;
  }

  follow(deckId) { this.assigned = deckId; this.mode = this.bpm ? 'free' : 'none'; }

  release(deckId) {
    if (this.assigned !== deckId) return;
    this.assigned = null;
    this.mode = this.bpm ? 'free' : 'none';
  }

  /** info: {playing, bpm, lastBeat, period} for the assigned deck, or null if unavailable. */
  update(tOut, info) {
    if (this.assigned == null) return;
    if (info && info.playing && info.bpm > 0 && info.period > 0) {
      this.mode = 'deck';
      this.bpm = info.bpm;
      this.anchor = info.lastBeat;
      this.period = info.period;
    } else {
      this.mode = this.bpm ? 'free' : 'none';
    }
  }

  beat(tOut) {
    if (this.mode === 'none' || !(this.period > 0)) return null;
    const k = Math.floor((tOut - this.anchor) / this.period);
    return { lastBeat: this.anchor + k * this.period, period: this.period, bpm: this.bpm };
  }

  state() {
    return { mode: this.mode, deckId: this.mode === 'deck' ? this.assigned : null, bpm: this.mode === 'none' ? null : this.bpm };
  }
}

/** Choose the deck that should become master when SYNC is pressed with no master. */
export function pickAutoMaster(cands) {
  const playing = cands.filter((c) => c.playing);
  if (!playing.length) return null;
  playing.sort((x, y) => (y.canBeat - x.canBeat) || (y.conf - x.conf) || (x.since - y.since));
  return playing[0].id;
}

export const ASSIST = Object.freeze({ lowWater: 8, highWater: 20, headroom: 0.03, max: 1.25, step: 0.0025 });

/**
 * Player-assist policy, evaluated every 250 ms per deck.
 * need = total tempo ratio the deck must play at; reserve = seconds of buffered audio ahead.
 * Returns the new target source rate and the next ramped value to send to the tab.
 */
export function assistStep(s, o = ASSIST) {
  let target = s.target ?? 1;
  const engaged = target > 1;
  // Retarget only for real changes (≥ 1%) or when the current target would let the reserve
  // drain; chasing tiny tempo refinements would schedule a rate crossing every step.
  const follow = () => {
    const want = Math.min(o.max, s.need + o.headroom);
    return !engaged || want > target + 1e-9 && target < s.need + 0.005 || Math.abs(want - target) >= 0.01 ? want : target;
  };
  if (!s.enabled || !s.available || !s.playing || s.need <= 1) target = 1;
  else if (s.reserve < o.lowWater) target = follow();
  else if (s.reserve > o.highWater) target = 1;
  else if (engaged) target = follow();
  const d = target - s.sourceRate;
  const next = Math.abs(d) <= o.step + 1e-12 ? target : s.sourceRate + Math.sign(d) * o.step;
  return { target, next };
}

/** Pitch shift for the stretch node so key lock holds the original key (assist resamples). */
export function engineSemitones(keyLock, sourceRate, engineRate) {
  return (keyLock ? -12 * Math.log2(sourceRate) : 12 * Math.log2(engineRate)) + 0; // + 0 normalises -0
}

/** One-knob DJ filter: x<0 low-pass sweep (20 kHz→70 Hz), x>0 high-pass (20 Hz→8 kHz). */
export function djFilterParams(x, res) {
  const ax = Math.abs(x);
  const q1 = -5.33, q2 = 2.32 + 12 * clamp(res, 0, 1);
  if (ax < 0.04) return { mode: 'off', freq: 0, q1, q2 };
  const u = (Math.min(1, ax) - 0.04) / 0.96;
  if (x < 0) return { mode: 'lp', freq: 20000 * (70 / 20000) ** u, q1, q2 };
  return { mode: 'hp', freq: 20 * (8000 / 20) ** u, q1, q2 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/sync.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/sync.js tests/unit/sync.test.mjs
git commit -m "Add pure sync, crossfader, assist and filter maths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---
## Task 5: Time-shift playhead model

Probe facts this task encodes (Signalsmith Stretch 1.3.2 patched, Chromium 141, see the vendor README):
- `schedule(seg)` resolves to the stored segment `{output, input, rate, active, semitones, loopStart, loopEnd}`.
  `p(t) = input + rate·(t − output)` is the **audible** input position at ctx time t (median error ~2 ms).
- A new `schedule()` **drops every change scheduled at or after `currentTime`** — so at most ONE future
  change may be pending in the node. Later changes wait in a JS queue and are sent once the pending
  one's output time has passed. Every sent segment carries an explicit `input`.
- `active:false` lands ~`outLatency` (≈0.06 s) after its output time, so pauses are sent that much early.
- Total latency (`latency()`) ≈ 0.12 s: the audible position must trail the buffer end by ≥ 0.12 s.
  Main-thread stalls of up to ~0.4 s were observed, so speed-ups stop when the reserve is < 0.5 s.
- `dropBuffers(t)` drops whole chunks and resolves to `{start, end}`.

Assist makes the *source* tempo piecewise along the input timeline, so this module also keeps
`SourceMap` (source playbackRate by input position) and `GridMap` (beat grid by input position).

**Files:**
- Create: `engine/timeshift.js`, `tests/unit/timeshift.test.mjs`

**Interfaces:**
- Produces (`engine/timeshift.js`):
  - `class Timeshift(node, {sampleRate, latency, outLatency, capSec=240, historySec=60})`
    - `.append(L, R) → liveEdge` (sends `addBuffers([L,R],[L.buffer,R.buffer])`), `.liveEdge`, `.historyStart`
    - `.posAt(t)`, `.segAt(t)`, `.playingAt(t)`, `.reserveAt(t)`, `.soon(now)` (= now + latency + 0.03)
    - `.change(now, T, fields) → seg` (replaces anything planned; fields ⊆ {active, rate, semitones, input, loopStart, loopEnd})
    - `.then(now, T, fields) → seg` (appends after the planned change; used for bend ends / crossings)
    - `.bend(now, T, factor, duration) → endTime`, `.pendingUntil()` (output time of the last planned change, or −∞)
    - `.flush(now)` — call every tick; sends the next queued change once the pending one has passed
    - `.clampInput(x)` → x limited to `[historyStart + 0.01, liveEdge − latency − 0.3]`
    - `.trim(now, keepFrom) → Promise<{dropped, start}>` — drop audio older than `keepFrom`, but never keep more than `capSec`
  - `class SourceMap` — `.rateAt(inPos)`, `.set(inPos, rate)`, `.nextChangeAfter(inPos) → {inPos, rate}|null`, `.prune(inPos)`
  - `class GridMap` — `.at(inPos) → {t0, T, bar1}|null`, `.update(grid)` (refresh latest segment), `.split(inPos, grid)` (new segment from inPos), `.prune(inPos)`
  - Constants: `GUARD = 0.5` (seconds of reserve below which speed-ups stop), `LIVE_RESERVE = 0.6`

- [ ] **Step 1: Write the failing tests** — `tests/unit/timeshift.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeshift, SourceMap, GridMap, GUARD } from '../../engine/timeshift.js';

/** Fake stretch node enforcing the real node's rule: a schedule() drops changes at/after currentTime. */
function fakeNode(clock) {
  const n = {
    sent: [], dropped: [], buffers: 0, drops: [],
    schedule(seg) {
      const pendingFuture = n.sent.filter((s) => s.output >= clock.now && !s.done);
      for (const s of pendingFuture) { s.done = true; n.dropped.push(s); }
      const stored = { ...seg };
      n.sent.push(stored);
      return Promise.resolve({ ...stored });
    },
    addBuffers(arr) { n.buffers += arr[0].length; return Promise.resolve(n.buffers / 48000); },
    dropBuffers(t) { n.drops.push(t); return Promise.resolve({ start: Math.floor(t * 10) / 10, end: n.buffers / 48000 }); },
  };
  return n;
}
const mk = (o = {}) => {
  const clock = { now: 0 };
  const node = fakeNode(clock);
  const ts = new Timeshift(node, { sampleRate: 48000, latency: 0.12, outLatency: 0.06, ...o });
  return { clock, node, ts };
};
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const chunk = (sec) => [new Float32Array(Math.round(sec * 48000)), new Float32Array(Math.round(sec * 48000))];

test('starts paused at input 0 and tracks the live edge', () => {
  const { ts } = mk();
  assert.equal(ts.posAt(5), 0);
  assert.equal(ts.playingAt(5), false);
  ts.append(...chunk(2));
  assert.ok(near(ts.liveEdge, 2));
  assert.ok(near(ts.reserveAt(0), 2 - 0.12));
});

test('play, rate change and explicit inputs follow p(t) = input + rate·(t − output)', () => {
  const { ts, node, clock } = mk();
  ts.append(...chunk(30));
  ts.change(0, 1, { active: true, input: 0, rate: 1 });
  assert.ok(near(ts.posAt(3), 2));
  clock.now = 1.5;
  ts.change(1.5, 2, { rate: 1.03 });
  assert.ok(near(node.sent[1].input, 1), 'explicit input = model position');
  assert.ok(near(ts.posAt(4), 1 + 2 * 1.03));
  assert.equal(node.dropped.length, 0);
});

test('only one change is pending in the node: bend end waits in the queue', () => {
  const { ts, node, clock } = mk();
  ts.append(...chunk(30));
  ts.change(0, 0.2, { active: true, input: 0, rate: 1 });
  clock.now = 1;
  const end = ts.bend(1, 1.2, 1.04, 0.5);
  assert.ok(near(end, 1.7));
  assert.equal(node.sent.length, 2, 'only the bend start is sent');
  clock.now = 1.1; ts.flush(1.1);
  assert.equal(node.sent.length, 2, 'end not sent while the start is pending');
  clock.now = 1.21; ts.flush(1.21);
  assert.equal(node.sent.length, 3);
  const last = node.sent[2];
  assert.ok(near(last.output, 1.7) && near(last.rate, 1));
  assert.ok(near(last.input, 1.0 + 0.5 * 1.04), 'end input continues the bent segment');
  assert.ok(near(ts.posAt(2.7), 1.52 + 1), 'shift of 0.02 s kept after the bend');
  assert.equal(node.dropped.length, 0);
});

test('a new change cancels a queued bend end and restarts from the model', () => {
  const { ts, node, clock } = mk();
  ts.append(...chunk(30));
  ts.change(0, 0.2, { active: true, input: 0, rate: 1 });
  clock.now = 1;
  ts.bend(1, 1.2, 1.04, 0.5);
  clock.now = 1.3;
  ts.change(1.3, 1.45, { rate: 1.02 });
  clock.now = 2; ts.flush(2);
  assert.equal(node.sent.length, 3, 'queued bend end discarded');
  assert.ok(near(node.sent[2].input, 1.0 + 0.25 * 1.04));
});

test('pause is sent outLatency early but the model freezes at the requested time', () => {
  const { ts, node } = mk();
  ts.append(...chunk(30));
  ts.change(0, 0.5, { active: true, input: 3, rate: 1 });
  ts.flush(0.6);
  ts.change(0.6, 2, { active: false });
  const sent = node.sent[node.sent.length - 1];
  assert.ok(near(sent.output, 2 - 0.06));
  assert.equal(sent.active, false);
  assert.ok(near(ts.posAt(5), 4.5));
  assert.equal(ts.playingAt(5), false);
});

test('loops wrap the model position', () => {
  const { ts } = mk();
  ts.append(...chunk(30));
  ts.change(0, 1, { active: true, input: 10, rate: 1 });
  ts.change(1.1, 1.2, { loopStart: 10, loopEnd: 10.5 });
  assert.ok(near(ts.posAt(1.2), 10.2));
  assert.ok(near(ts.posAt(1.6), 10.1));
  assert.ok(near(ts.posAt(2.45), 10.45));
  ts.change(2.5, 2.6, { input: 11.6, loopStart: 0, loopEnd: 0 });
  assert.ok(near(ts.posAt(3.6), 12.6));
});

test('inputs are clamped into the buffered range', () => {
  const { ts } = mk();
  ts.append(...chunk(10));
  assert.ok(near(ts.clampInput(50), 10 - 0.12 - 0.3));
  assert.ok(near(ts.clampInput(-3), 0.01));
});

test('reserve and soon()', () => {
  const { ts } = mk();
  ts.append(...chunk(10));
  ts.change(0, 1, { active: true, input: 0, rate: 1.5 });
  assert.ok(near(ts.reserveAt(3), 10 - 3 - 0.12));
  assert.ok(near(ts.soon(2), 2.15));
  assert.equal(ts.reserveAt(100), 0);
  assert.ok(GUARD >= 0.4);
});

test('trim keeps at most capSec and reports the new start', async () => {
  const { ts, node } = mk({ capSec: 20 });
  ts.append(...chunk(30));
  const r = await ts.trim(0, 0);
  assert.equal(r.dropped, true);
  assert.ok(near(node.drops[0], 10));
  assert.ok(near(ts.historyStart, 10));
  const r2 = await ts.trim(0, 5);
  assert.equal(r2.dropped, false);
});

test('SourceMap and GridMap are piecewise along the input timeline', () => {
  const sm = new SourceMap();
  assert.equal(sm.rateAt(5), 1);
  sm.set(10, 1.0025);
  sm.set(10.25, 1.005);
  assert.equal(sm.rateAt(9.99), 1);
  assert.equal(sm.rateAt(10.1), 1.0025);
  assert.equal(sm.rateAt(11), 1.005);
  assert.deepEqual(sm.nextChangeAfter(10.1), { inPos: 10.25, rate: 1.005 });
  assert.equal(sm.nextChangeAfter(10.25), null);
  sm.prune(10.3);
  assert.equal(sm.rateAt(0), 1.005);

  const gm = new GridMap();
  assert.equal(gm.at(3), null);
  gm.update({ t0: 1, T: 0.5, bar1: null });
  assert.deepEqual(gm.at(3), { t0: 1, T: 0.5, bar1: null });
  gm.split(10, { t0: 10.1, T: 0.49, bar1: null });
  assert.deepEqual(gm.at(5), { t0: 1, T: 0.5, bar1: null });
  assert.deepEqual(gm.at(12), { t0: 10.1, T: 0.49, bar1: null });
  gm.update({ t0: 10.12, T: 0.488, bar1: null });
  assert.equal(gm.at(12).T, 0.488);
  assert.equal(gm.at(5).T, 0.5);
  gm.prune(11);
  assert.equal(gm.at(5).T, 0.488);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/timeshift.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `engine/timeshift.js`**

```js
// engine/timeshift.js — one deck's playhead over its buffered input, driving a Signalsmith
// Stretch node in buffer mode. The model mirrors the node exactly: every segment we send
// carries an explicit input computed with the node's own formula p(t) = input + rate·(t − output),
// and at most one future change is ever pending in the node (a new schedule() drops all
// changes at/after currentTime), so later changes wait here until the pending one has passed.

export const GUARD = 0.5;        // s of reserve below which the deck may not play faster than 1×
export const LIVE_RESERVE = 0.6; // s of reserve kept by the LIVE jump

const FIELDS = ['active', 'rate', 'semitones', 'input', 'loopStart', 'loopEnd'];

export class Timeshift {
  constructor(node, { sampleRate, latency, outLatency, capSec = 240, historySec = 60 }) {
    this.node = node;
    this.sr = sampleRate;
    this.lat = latency;
    this.outLat = outLatency;
    this.capSec = capSec;
    this.historySec = historySec;
    this.liveEdge = 0;
    this.historyStart = 0;
    this.segs = [{ output: -Infinity, input: 0, rate: 1, active: false, semitones: 0, loopStart: 0, loopEnd: 0 }];
    this.queue = [];
    this.lastSentOut = -Infinity;
    this.trimming = false;
  }

  append(L, R) {
    this.liveEdge += L.length / this.sr;
    this.node.addBuffers([L, R], [L.buffer, R.buffer]);
    return this.liveEdge;
  }

  soon(now) { return now + this.lat + 0.03; }

  segAt(t) {
    let s = this.segs[0];
    for (const x of this.segs) { if (x.output <= t) s = x; else break; }
    return s;
  }

  posAt(t) {
    const s = this.segAt(t);
    if (!s.active || s.output === -Infinity) return s.input;
    let p = s.input + s.rate * (t - s.output);
    if (s.loopEnd > s.loopStart && p >= s.loopEnd) p = s.loopStart + ((p - s.loopStart) % (s.loopEnd - s.loopStart));
    return p;
  }

  playingAt(t) { return this.segAt(t).active; }
  rateAt(t) { return this.segAt(t).rate; }
  reserveAt(t) { return Math.max(0, this.liveEdge - this.lat - this.posAt(t)); }

  clampInput(x) {
    return Math.min(Math.max(x, this.historyStart + 0.01), Math.max(this.historyStart + 0.01, this.liveEdge - this.lat - 0.3));
  }

  /** Output time of the last planned change (pending or queued), or -Infinity. */
  pendingUntil() { return this.segs.length > 1 ? this.segs[this.segs.length - 1].output : -Infinity; }

  build(T, fields) {
    const base = this.segAt(T);
    const seg = { output: T };
    for (const k of FIELDS) seg[k] = fields[k] !== undefined ? fields[k] : base[k];
    if (fields.input === undefined) seg.input = this.posAt(T);
    return seg;
  }

  /** Replace everything planned after `now` with one change at T. */
  change(now, T, fields) {
    this.segs = this.segs.filter((s) => s.output <= now);
    if (!this.segs.length) this.segs = [{ output: -Infinity, input: 0, rate: 1, active: false, semitones: 0, loopStart: 0, loopEnd: 0 }];
    this.queue = [];
    const seg = this.build(T, fields);
    this.segs.push(seg);
    this.send(seg);
    return seg;
  }

  /** Plan a change after the currently planned one (it is sent once that one has passed). */
  then(now, T, fields) {
    const seg = this.build(T, fields);
    this.segs.push(seg);
    this.segs.sort((a, b) => a.output - b.output);
    this.queue.push(seg);
    this.flush(now);
    return seg;
  }

  bend(now, T, factor, duration) {
    const base = this.segAt(T);
    this.change(now, T, { rate: base.rate * factor });
    this.then(now, T + duration, { rate: base.rate });
    return T + duration;
  }

  flush(now) {
    while (this.queue.length && this.lastSentOut < now) {
      this.send(this.queue.shift());
    }
  }

  send(seg) {
    const out = { ...seg };
    // A pause becomes audible ~outLatency after its output time: send it that much earlier.
    if (seg.active === false && this.segAt(seg.output - 1e-9).active) out.output = seg.output - this.outLat;
    this.lastSentOut = out.output;
    const r = this.node.schedule(out);
    if (r && typeof r.then === 'function') r.catch(() => {});
  }

  /** Drop audio older than keepFrom (input s); never keep more than capSec. */
  async trim(now, keepFrom) {
    if (this.trimming) return { dropped: false, start: this.historyStart };
    const target = Math.max(keepFrom, this.liveEdge - this.capSec);
    if (target <= this.historyStart + 1) return { dropped: false, start: this.historyStart };
    this.trimming = true;
    try {
      const r = await this.node.dropBuffers(target);
      if (r && typeof r.start === 'number') this.historyStart = Math.max(this.historyStart, r.start);
      return { dropped: true, start: this.historyStart };
    } finally {
      this.trimming = false;
    }
  }
}

/** Source playbackRate (player assist) as a step function of input position. */
export class SourceMap {
  constructor() { this.steps = [{ inPos: -Infinity, rate: 1 }]; }
  set(inPos, rate) {
    this.steps = this.steps.filter((s) => s.inPos < inPos);
    this.steps.push({ inPos, rate });
  }
  rateAt(inPos) {
    let r = this.steps[0].rate;
    for (const s of this.steps) { if (s.inPos <= inPos) r = s.rate; else break; }
    return r;
  }
  nextChangeAfter(inPos) {
    const s = this.steps.find((x) => x.inPos > inPos);
    return s ? { inPos: s.inPos, rate: s.rate } : null;
  }
  prune(inPos) {
    let i = 0;
    while (i + 1 < this.steps.length && this.steps[i + 1].inPos <= inPos) i++;
    if (i > 0) { const keep = this.steps[i]; this.steps = [{ inPos: -Infinity, rate: keep.rate }, ...this.steps.slice(i + 1)]; }
  }
}

/** Beat grid as a step function of input position (assist steps change the input tempo). */
export class GridMap {
  constructor() { this.segs = []; }
  update(grid) {
    if (!grid) return;
    if (!this.segs.length) this.segs.push({ from: -Infinity, grid: { ...grid } });
    else this.segs[this.segs.length - 1].grid = { ...grid };
  }
  split(inPos, grid) {
    if (!grid) return;
    this.segs = this.segs.filter((s) => s.from < inPos);
    this.segs.push({ from: this.segs.length ? inPos : -Infinity, grid: { ...grid } });
  }
  at(inPos) {
    let g = null;
    for (const s of this.segs) { if (s.from <= inPos) g = s.grid; else break; }
    return g;
  }
  prune(inPos) {
    let i = 0;
    while (i + 1 < this.segs.length && this.segs[i + 1].from <= inPos) i++;
    if (i > 0) { this.segs = [{ from: -Infinity, grid: this.segs[i].grid }, ...this.segs.slice(i + 1)]; }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/timeshift.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/timeshift.js tests/unit/timeshift.test.mjs
git commit -m "Add time-shift playhead model with single-pending scheduling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---

## Task 6: Streaming recorder (WAV + WebM)

Fixes v1 review findings: unbounded WAV memory, blocking encode, spurious 44-byte WAV, state
wedged after an encode throw, per-block allocations.

**Files:**
- Create: `worklets/recorder.js`, `engine/recorder.js`
- Create: `tests/unit/recorder.test.mjs`

**Interfaces:**
- Consumes: `recordingFilename` (Task 1); `loadWorklet`/`runBlocks` shim (Task 3).
- Produces:
  - AudioWorklet processor `'jds-recorder'`:
    - port in: `{t:'start'}`, `{t:'stop'}`;
    - port out: `{t:'data', buf:Int16Array (interleaved stereo), frames, final:boolean}`;
    - batches are 8192 frames, transferred;
    - `stop` while not started sends nothing.
  - `engine/recorder.js`:
    - `wavHeader(dataBytes, sampleRate, channels=2, bits=16) → ArrayBuffer(44)`;
    - `WAV_ROLL_BYTES`;
    - `class WavStreamWriter(sampleRate, channels=2)` with `.push(int16, frames)`, `.frames`,
      `.bytes`, `.seconds`, `.shouldRoll()` and `.finish() → Blob`;
    - `pickWebmMime() → string`;
    - `class Recorder(ctx, source, {format, who, title:()=>string, sink, deliver:(blob, filename)=>void, onChange:()=>void, onError:(msg)=>void})`
      with `.state` ('idle'|'recording'|'finalizing'), `.format`, `.seconds`, `.start()`,
      `.stop()` and `.dispose()`.

- [ ] **Step 1: Write the failing tests** — `tests/unit/recorder.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet, runBlocks } from './worklet-shim.mjs';
import { wavHeader, WavStreamWriter, WAV_ROLL_BYTES } from '../../engine/recorder.js';

const reg = await loadWorklet('worklets/recorder.js', { sampleRate: 48000 });
const Rec = reg['jds-recorder'];
const data = (p) => p.port.posted.map((x) => x.msg).filter((m) => m.t === 'data');

test('wav header fields', () => {
  const v = new DataView(wavHeader(1000, 44100));
  const str = (o) => String.fromCharCode(...[0, 1, 2, 3].map((i) => v.getUint8(o + i)));
  assert.equal(str(0), 'RIFF');
  assert.equal(v.getUint32(4, true), 1036);
  assert.equal(str(8), 'WAVE');
  assert.equal(str(12), 'fmt ');
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint32(28, true), 44100 * 4);
  assert.equal(v.getUint16(32, true), 4);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(str(36), 'data');
  assert.equal(v.getUint32(40, true), 1000);
});

test('writer streams parts and finishes with a correct header', async () => {
  const w = new WavStreamWriter(48000);
  w.push(new Int16Array([1, 2, 3, 4]), 2);
  w.push(new Int16Array([5, 6]), 1);
  w.push(new Int16Array(0), 0);
  assert.equal(w.frames, 3);
  assert.equal(w.bytes, 12);
  assert.ok(Math.abs(w.seconds - 3 / 48000) < 1e-12);
  assert.equal(w.shouldRoll(), false);
  const blob = w.finish();
  assert.equal(blob.type, 'audio/wav');
  const buf = new DataView(await blob.arrayBuffer());
  assert.equal(buf.byteLength, 44 + 12);
  assert.equal(buf.getUint32(40, true), 12);
  assert.equal(buf.getInt16(44 + 10, true), 6);
  assert.ok(WAV_ROLL_BYTES < 2 ** 32 && WAV_ROLL_BYTES > 3.9e9);
});

test('recorder worklet: stop without start sends nothing', () => {
  const p = new Rec();
  runBlocks(p, [new Float32Array(1024), new Float32Array(1024)]);
  p.port.deliver({ t: 'stop' });
  assert.equal(data(p).length, 0);
});

test('recorder worklet: converts, clamps, batches and flushes once', () => {
  const p = new Rec();
  p.port.deliver({ t: 'start' });
  const n = 8192 + 256;
  const L = new Float32Array(n); const R = new Float32Array(n);
  L[0] = 1; L[1] = -1; L[2] = 2; L[3] = -2; L[4] = 0.5; R[0] = NaN;
  runBlocks(p, [L, R]);
  p.port.deliver({ t: 'stop' });
  p.port.deliver({ t: 'stop' });
  const d = data(p);
  assert.equal(d.length, 2);
  assert.equal(d[0].frames, 8192);
  assert.equal(d[0].final, false);
  assert.equal(d[0].buf.length, 8192 * 2);
  assert.deepEqual(Array.from(d[0].buf.subarray(0, 10)), [32767, 0, -32768, 0, 32767, 0, -32768, 0, 16384, 0]);
  assert.equal(d[1].frames, 256);
  assert.equal(d[1].final, true);
  assert.equal(d[1].buf.length, 512);
  const posted = p.port.posted.filter((x) => x.msg.t === 'data');
  assert.equal(posted[0].transfer.length, 1);
});

test('recorder worklet: missing input records silence, restart works', () => {
  const p = new Rec();
  p.port.deliver({ t: 'start' });
  for (let i = 0; i < 4; i++) p.process([[]], [[new Float32Array(128)]], {});
  p.port.deliver({ t: 'stop' });
  p.port.deliver({ t: 'start' });
  runBlocks(p, [new Float32Array(128).fill(0.25)]);
  p.port.deliver({ t: 'stop' });
  const d = data(p);
  assert.equal(d.length, 2);
  assert.equal(d[0].frames, 512);
  assert.equal(d[1].frames, 128);
  assert.equal(d[1].buf[1], d[1].buf[0]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/recorder.test.mjs`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `worklets/recorder.js`**

```js
// worklets/recorder.js — PCM capture for WAV recording. Converts to interleaved 16-bit
// in a preallocated batch and transfers each full batch (8192 frames ≈ 170 ms) to the
// engine, which appends it to a Blob — so memory stays flat for hours.

const BATCH = 8192;
const toI16 = (x) => {
  const s = x < -1 ? -1 : x > 1 ? 1 : x;
  return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
};

class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = null;
    this.n = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'start') {
        this.on = true;
        this.buf = new Int16Array(BATCH * 2);
        this.n = 0;
      } else if (m.t === 'stop') {
        if (!this.on) return;
        this.on = false;
        this.flush(true);
      }
    };
  }

  flush(final) {
    const frames = this.n;
    const out = frames === BATCH ? this.buf : this.buf.slice(0, frames * 2);
    this.port.postMessage({ t: 'data', buf: out, frames, final }, [out.buffer]);
    this.buf = final ? null : new Int16Array(BATCH * 2);
    this.n = 0;
  }

  process(inputs) {
    if (!this.on) return true;
    const input = inputs[0];
    const l = input && input.length ? input[0] : null;
    const r = input && input.length > 1 ? input[1] : l;
    const n = l ? l.length : 128;
    for (let i = 0; i < n; i++) {
      const j = this.n * 2;
      this.buf[j] = toI16(l ? l[i] : 0);
      this.buf[j + 1] = toI16(r ? r[i] : 0);
      if (++this.n === BATCH) this.flush(false);
    }
    return true;
  }
}

registerProcessor('jds-recorder', Recorder);
```

(`toI16(NaN)` evaluates to `Math.round(NaN)`, and storing that in an Int16Array gives 0, which
the test expects.)

- [ ] **Step 4: Implement `engine/recorder.js`**

```js
// engine/recorder.js — per-deck and mix recorders with an explicit state machine
// (idle → recording → finalizing → idle). WAV streams Int16 batches into Blob parts;
// WebM uses MediaRecorder with a timeslice. Errors always return the state to idle.
import { recordingFilename } from '../shared/protocol.js';

export const WAV_ROLL_BYTES = 4 * 1024 ** 3 - 64 * 1024 ** 2;

export function wavHeader(dataBytes, sampleRate, channels = 2, bits = 16) {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  const blockAlign = (channels * bits) / 8;
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bits, true);
  w(36, 'data');
  v.setUint32(40, dataBytes, true);
  return b;
}

export class WavStreamWriter {
  constructor(sampleRate, channels = 2) {
    this.sr = sampleRate;
    this.ch = channels;
    this.parts = [];
    this.bytes = 0;
    this.frames = 0;
  }
  push(int16, frames) {
    if (!frames) return;
    this.parts.push(new Blob([int16]));
    this.bytes += frames * this.ch * 2;
    this.frames += frames;
  }
  get seconds() { return this.frames / this.sr; }
  shouldRoll() { return this.bytes >= WAV_ROLL_BYTES; }
  finish() {
    const blob = new Blob([wavHeader(this.bytes, this.sr, this.ch), ...this.parts], { type: 'audio/wav' });
    this.parts = [];
    return blob;
  }
}

export function pickWebmMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export class Recorder {
  constructor(ctx, source, o) {
    this.ctx = ctx;
    this.source = source;
    this.o = o;
    this.state = 'idle';
    this.format = o.format;
    this.startedAt = 0;
    this.stoppedSeconds = 0;
    this.part = 1;
    this.node = null;
    this.writer = null;
    this.mr = null;
    this.dest = null;
  }

  get seconds() {
    return this.state === 'recording' ? this.ctx.currentTime - this.startedAt : this.stoppedSeconds;
  }

  filename(ext) {
    const title = this.part > 1 ? `${this.o.title()} part${this.part}` : this.o.title();
    return recordingFilename(this.o.who, title, ext, this.startDate);
  }

  start(format = this.format) {
    if (this.state !== 'idle') throw new Error('Already recording');
    this.format = format;
    this.startDate = new Date();
    this.part = 1;
    if (format === 'wav') {
      this.node = new AudioWorkletNode(this.ctx, 'jds-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit',
      });
      this.writer = new WavStreamWriter(this.ctx.sampleRate);
      this.node.port.onmessage = (e) => this.onData(e.data);
      this.source.connect(this.node);
      this.node.connect(this.o.sink);
      this.node.port.postMessage({ t: 'start' });
    } else {
      const mime = pickWebmMime();
      this.dest = this.ctx.createMediaStreamDestination();
      this.source.connect(this.dest);
      const chunks = [];
      this.mr = new MediaRecorder(this.dest.stream, mime ? { mimeType: mime } : undefined);
      this.mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      this.mr.onerror = (e) => this.fail(`Recording failed: ${e.error ? e.error.message : 'MediaRecorder error'}`);
      this.mr.onstop = () => this.finalize(() => this.deliver(new Blob(chunks, { type: mime || 'audio/webm' }), 'webm'));
      this.mr.start(1000);
    }
    this.startedAt = this.ctx.currentTime;
    this.state = 'recording';
    this.o.onChange();
  }

  stop() {
    if (this.state !== 'recording') return;
    this.stoppedSeconds = this.ctx.currentTime - this.startedAt;
    this.state = 'finalizing';
    this.o.onChange();
    if (this.format === 'wav') this.node.port.postMessage({ t: 'stop' });
    else if (this.mr && this.mr.state !== 'inactive') this.mr.stop();
    else this.finalize(() => {});
  }

  onData(m) {
    if (!m || m.t !== 'data' || !this.writer) return;
    try {
      this.writer.push(m.buf, m.frames);
      if (!m.final && this.writer.shouldRoll()) {
        this.deliver(this.writer.finish(), 'wav');
        this.writer = new WavStreamWriter(this.ctx.sampleRate);
        this.part++;
      }
    } catch (err) {
      this.fail(`Recording failed: ${err.message}`);
      return;
    }
    if (m.final) this.finalize(() => this.deliver(this.writer.finish(), 'wav'));
  }

  deliver(blob, ext) { this.o.deliver(blob, this.filename(ext)); }

  finalize(fn) {
    try {
      fn();
    } catch (err) {
      this.o.onError(`Saving the recording failed: ${err.message}`);
    } finally {
      this.teardown();
      this.state = 'idle';
      this.o.onChange();
    }
  }

  fail(msg) {
    this.o.onError(msg);
    this.teardown();
    this.state = 'idle';
    this.o.onChange();
  }

  teardown() {
    if (this.node) {
      try { this.source.disconnect(this.node); } catch (_) {}
      try { this.node.disconnect(); } catch (_) {}
      this.node.port.onmessage = null;
      this.node.port.close();
      this.node = null;
    }
    if (this.dest) {
      try { this.source.disconnect(this.dest); } catch (_) {}
      this.dest = null;
    }
    this.mr = null;
    this.writer = null;
  }

  dispose() {
    if (this.state === 'recording') this.stop();
    else if (this.state === 'idle') this.teardown();
  }
}
```

`dispose()` on a recording deck calls `stop()`, so ejecting a deck mid-recording still
finalises and delivers the file. The engine must keep the source node connected until
`onChange` reports `idle`; Task 8 handles that.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/unit/recorder.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add worklets/recorder.js engine/recorder.js tests/unit/recorder.test.mjs
git commit -m "Add streaming WAV/WebM recorder with explicit state machine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---
## Task 7: Audio graph modules: EQ, filter, FX rack, master (+ offline browser tests)

**Files:**
- Create: `engine/params.js`, `engine/eq.js`, `engine/fx.js`, `engine/master.js`
- Create: `worklets/beatfx.js`, `worklets/master.js`
- Create: `tests/browser/playwright.mjs`, `tests/browser/static-server.mjs`
- Create: `tests/browser/pages/offline.html`, `tests/browser/pages/offline.js`,
  `tests/browser/offline.test.mjs`

**Interfaces:**
- Consumes: `knobToGain`, `crossfaderGains`, `deckXfGain`, `djFilterParams` (Task 4).
- Produces:
  - **`engine/params.js`:** `glide(ctx, param, value, tc=0.01)` (cancel-and-hold, then
    `setTargetAtTime`); `ramp(ctx, param, value, sec=0.005)` (linear).
  - **`engine/eq.js`:**
    - `createIsolator(ctx, {low=250, high=2500}) → {input, output, set(band:'low'|'mid'|'hi', k), kill(band, on), dispose()}`;
    - `createTrim(ctx) → {input, output, set(k), dispose()}` (trim maxDb 12).
  - **`engine/fx.js`:**
    - `createDjFilter(ctx) → {input, output, set(x, res), dispose()}`;
    - `makeImpulse(ctx, t60, seed)`;
    - `createFxRack(ctx) → {input, output, beatfx, setFilter(x, res), setFx({type, beats, level, on, bpm}), setClock(anchorFrame, periodFrames), tick(now), dispose()}`;
    - `REVERB_SIZES`.
  - **`engine/master.js`:**
    - `createMaster(ctx) → {bus, out, onMeter(fn) → unsubscribe, meter, setVolume(k), setLimiter(on), setCrossfader(pos, curve), addDeck(id, gainNode, assign), setAssign(id, assign), removeDeck(id), dispose()}`;
    - meter messages are `{t:'meter', frame, peakL, peakR, rmsL, rmsR, gr}` every 1536 frames.
      They are **the engine tick**.
  - **Worklet `'jds-beatfx'`** (stereo insert). Port in:
    - `{t:'mode', mode:'off'|'gate'|'crush'}`;
    - `{t:'gate', depth, stepBeats}`;
    - `{t:'crush', amount}`;
    - `{t:'clock', anchorFrame, periodFrames}` (output frames, the `currentFrame` clock).
  - **Worklet `'jds-master'`** (stereo):
    - lookahead (5 ms) brickwall limiter at −1 dBFS;
    - port in `{t:'limiter', on}`;
    - posts meter/tick messages.
  - **Test helpers:**
    - `tests/browser/playwright.mjs` exports `chromium`, `launchPlain()`;
    - `tests/browser/static-server.mjs` exports `startStaticServer(root) → {origin, close()}`.

**Why a worklet limiter:** Chrome's `DynamicsCompressorNode` applies automatic makeup gain (Web
Audio spec, "makeup gain"), so it cannot guarantee a −1 dBFS ceiling. The master uses a small
lookahead limiter instead. It also provides true per-channel peaks and gain reduction, and its
messages are the engine's throttle-proof tick.

- [ ] **Step 1: Write the browser test helpers**

`tests/browser/playwright.mjs`:

```js
// Resolve the globally installed Playwright (no local node_modules in this repo).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.env.PLAYWRIGHT_ROOT || path.join(execSync('npm root -g').toString().trim(), 'playwright');
export const { chromium } = require(root);

/** Plain headless Chromium (no extension) for offline Web Audio tests. */
export function launchPlain() {
  return chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
}
```

`tests/browser/static-server.mjs`:

```js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wav': 'audio/wav', '.png': 'image/png', '.svg': 'image/svg+xml',
};

/** Serve `root` read-only on 127.0.0.1 with an ephemeral port. Extra routes: {'/path': (req,res)=>void}. */
export async function startStaticServer(root, routes = {}) {
  const base = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (routes[u.pathname]) return routes[u.pathname](req, res, u);
    const file = path.normalize(path.join(base, decodeURIComponent(u.pathname)));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
```

- [ ] **Step 2: Write the offline test page** — `tests/browser/pages/offline.html` and `tests/browser/pages/offline.js`

`tests/browser/pages/offline.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<title>JD Samps offline graph tests</title>
<script type="module" src="./offline.js"></script>
```

`tests/browser/pages/offline.js`:

```js
import { createIsolator, createTrim } from '../../../engine/eq.js';
import { createDjFilter, createFxRack } from '../../../engine/fx.js';
import { createMaster } from '../../../engine/master.js';

const SR = 48000;
const WORKLETS = ['../../../worklets/beatfx.js', '../../../worklets/master.js'];

async function offline(sec) {
  const ctx = new OfflineAudioContext(2, Math.round(sec * SR), SR);
  for (const w of WORKLETS) await ctx.audioWorklet.addModule(w);
  return ctx;
}
let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
function source(ctx, fill) {
  const b = ctx.createBuffer(2, ctx.length, SR);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = fill(i / SR, c, i); }
  const s = ctx.createBufferSource(); s.buffer = b; s.start();
  return s;
}
const idx = (t) => Math.round(t * SR);
const rms = (d, a, b) => { let s = 0; for (let i = idx(a); i < idx(b); i++) s += d[i] * d[i]; return Math.sqrt(s / (idx(b) - idx(a))); };
const peakAbs = (d, a, b) => { let p = 0; for (let i = idx(a); i < idx(b); i++) p = Math.max(p, Math.abs(d[i])); return p; };
const db = (x) => 20 * Math.log10(x);
const sine = (f, amp) => (t) => amp * Math.sin(2 * Math.PI * f * t);
const settle = () => new Promise((r) => setTimeout(r, 50));
// Worklet port messages posted just before startRendering() are not processed by an
// OfflineAudioContext unless the worklet scope gets a moment first (verified in Chromium 141).
// Real-time contexts deliver them within milliseconds, so only the offline harness waits.
async function render(ctx) { await new Promise((r) => setTimeout(r, 100)); return ctx.startRendering(); }

window.tests = {
  async eqFlat() {
    const ctx = await offline(2); const s = source(ctx, () => rnd() * 0.5);
    const eq = createIsolator(ctx); s.connect(eq.input); eq.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { db: db(rms(out, 0.2, 1.9) / rms(s.buffer.getChannelData(0), 0.2, 1.9)) };
  },
  async eqKill({ band, freq }) {
    const ctx = await offline(2); const s = source(ctx, sine(freq, 0.5));
    const eq = createIsolator(ctx); eq.kill(band, true); s.connect(eq.input); eq.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { db: db(rms(out, 0.5, 1.5) / rms(s.buffer.getChannelData(0), 0.5, 1.5)) };
  },
  async eqBoost() {
    const ctx = await offline(1.5); const s = source(ctx, sine(1000, 0.2));
    const eq = createIsolator(ctx); eq.set('mid', 1); s.connect(eq.input); eq.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { db: db(rms(out, 0.5, 1.4) / rms(s.buffer.getChannelData(0), 0.5, 1.4)) };
  },
  async trim({ k }) {
    const ctx = await offline(1); const s = source(ctx, sine(440, 0.1));
    const t = createTrim(ctx); t.set(k); s.connect(t.input); t.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { db: db(rms(out, 0.3, 0.9) / rms(s.buffer.getChannelData(0), 0.3, 0.9)) };
  },
  async filter({ x, freq }) {
    const ctx = await offline(1.5); const s = source(ctx, sine(freq, 0.5));
    const f = createDjFilter(ctx); f.set(x, 0); s.connect(f.input); f.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { db: db(rms(out, 0.5, 1.4) / rms(s.buffer.getChannelData(0), 0.5, 1.4)) };
  },
  async echo() {
    const ctx = await offline(1); const s = source(ctx, (t, c, i) => (i === idx(0.1) ? 1 : 0));
    const rack = createFxRack(ctx); rack.setFx({ type: 'ECHO', beats: 0.5, level: 0.5, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    let at = 0, best = 0;
    for (let i = idx(0.2); i < idx(0.5); i++) if (Math.abs(out[i]) > best) { best = Math.abs(out[i]); at = i / SR; }
    return { at, best };
  },
  async gate() {
    const ctx = await offline(1); const s = source(ctx, sine(1000, 0.5));
    const rack = createFxRack(ctx);
    rack.setClock(0, SR * 0.5);
    rack.setFx({ type: 'GATE', beats: 0.25, level: 1, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { open: rms(out, 0.135, 0.18), closed: rms(out, 0.2, 0.245) };
  },
  async crush() {
    const ctx = await offline(1); const s = source(ctx, sine(220, 0.8));
    const rack = createFxRack(ctx); rack.setFx({ type: 'CRUSH', beats: 0.5, level: 1, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    const vals = new Set(); for (let i = idx(0.5); i < idx(0.6); i++) vals.add(out[i].toFixed(6));
    return { distinct: vals.size };
  },
  async flanger() {
    const ctx = await offline(1.5); const s = source(ctx, () => rnd() * 0.3);
    const rack = createFxRack(ctx); rack.setFx({ type: 'FLANGER', beats: 0.5, level: 1, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0); const inp = s.buffer.getChannelData(0);
    let xy = 0, xx = 0, yy = 0; for (let i = idx(0.5); i < idx(1.4); i++) { xy += inp[i] * out[i]; xx += inp[i] ** 2; yy += out[i] ** 2; }
    return { corr: xy / Math.sqrt(xx * yy) };
  },
  async reverb() {
    const ctx = await offline(1.5); const s = source(ctx, (t, c, i) => (i === idx(0.05) ? 1 : 0));
    const rack = createFxRack(ctx); rack.setFx({ type: 'REVERB', beats: 1, level: 1, on: true, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    return { tail: rms(out, 0.6, 0.9) };
  },
  async fxOffIsTransparent() {
    const ctx = await offline(1); const s = source(ctx, () => rnd() * 0.3);
    const rack = createFxRack(ctx); rack.setFx({ type: 'ECHO', beats: 0.5, level: 0.5, on: false, bpm: 120 });
    s.connect(rack.input); rack.output.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0); const inp = s.buffer.getChannelData(0);
    let maxDiff = 0; for (let i = idx(0.2); i < idx(0.9); i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - inp[i]));
    return { maxDiff };
  },
  async limiter({ amp, on }) {
    const ctx = await offline(1.2); const s = source(ctx, sine(200, amp));
    const m = createMaster(ctx); m.setLimiter(on);
    const meters = []; m.onMeter((x) => meters.push(x));
    s.connect(m.bus); m.out.disconnect(); m.out.connect(ctx.destination);
    const out = (await render(ctx)).getChannelData(0);
    await settle();
    return { peak: peakAbs(out, 0.1, 1.1), inRms: rms(s.buffer.getChannelData(0), 0.2, 1.0), outRms: rms(out, 0.2, 1.0), minGr: Math.min(...meters.map((x) => x.gr)), ticks: meters.length, frames: meters.map((x) => x.frame) };
  },
  async xfader() {
    const ctx = await offline(1); const s = source(ctx, sine(440, 0.5));
    const m = createMaster(ctx); const g = ctx.createGain();
    s.connect(g).connect(m.bus); m.out.disconnect(); m.out.connect(ctx.destination);
    m.addDeck(1, g, 'A'); m.setCrossfader(1, 'SMOOTH');
    const out = (await render(ctx)).getChannelData(0);
    return { rms: rms(out, 0.3, 0.9) };
  },
};
window.ready = true;
```

- [ ] **Step 3: Write the failing test runner** — `tests/browser/offline.test.mjs`

```js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let server, browser, page; const errors = [];

before(async () => {
  server = await startStaticServer(ROOT);
  browser = await launchPlain();
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${server.origin}/tests/browser/pages/offline.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
});
after(async () => { await browser?.close(); await server?.close(); });

const run = (name, arg) => page.evaluate(([n, a]) => window.tests[n](a), [name, arg ?? null]);

test('isolator bands sum flat at unity', async () => {
  const r = await run('eqFlat');
  assert.ok(Math.abs(r.db) < 0.2, JSON.stringify(r));
});

for (const [band, freq] of [['low', 60], ['mid', 1000], ['hi', 8000]]) {
  test(`${band} kill removes ${freq} Hz by at least 30 dB`, async () => {
    const r = await run('eqKill', { band, freq });
    assert.ok(r.db <= -30, JSON.stringify(r));
  });
}

test('mid knob fully right boosts 1 kHz by about 6 dB', async () => {
  const r = await run('eqBoost');
  assert.ok(Math.abs(r.db - 6) < 0.6, JSON.stringify(r));
});

test('trim knob law', async () => {
  assert.ok(Math.abs((await run('trim', { k: 1 })).db - 12) < 0.2);
  assert.ok(Math.abs((await run('trim', { k: 0.5 })).db) < 0.05);
});

test('DJ filter: centre transparent, extremes cut', async () => {
  assert.ok(Math.abs((await run('filter', { x: 0, freq: 1000 })).db) < 0.1);
  assert.ok((await run('filter', { x: -1, freq: 2000 })).db <= -30);
  assert.ok((await run('filter', { x: 1, freq: 200 })).db <= -30);
});

test('echo repeats one beat-fraction later', async () => {
  const r = await run('echo');
  assert.ok(Math.abs(r.at - 0.35) < 0.003, JSON.stringify(r));
  assert.ok(r.best > 0.05);
});

test('gate opens and closes on the beat grid', async () => {
  const r = await run('gate');
  assert.ok(r.open > 0.3, JSON.stringify(r));
  assert.ok(r.closed < 0.01, JSON.stringify(r));
});

test('crush reduces bit depth', async () => {
  const r = await run('crush');
  assert.ok(r.distinct < 64, JSON.stringify(r));
});

test('flanger colours the signal', async () => {
  const r = await run('flanger');
  assert.ok(r.corr < 0.95, JSON.stringify(r));
});

test('reverb leaves a tail', async () => {
  const r = await run('reverb');
  assert.ok(r.tail > 1e-4, JSON.stringify(r));
});

test('rack with FX off is sample-transparent', async () => {
  const r = await run('fxOffIsTransparent');
  assert.ok(r.maxDiff < 1e-6, JSON.stringify(r));
});

test('limiter holds -1 dBFS on a +6 dB signal and reports gain reduction', async () => {
  const r = await run('limiter', { amp: 2, on: true });
  assert.ok(r.peak <= 10 ** (-1 / 20) + 1e-4, JSON.stringify({ peak: r.peak }));
  assert.ok(r.minGr < -5, JSON.stringify({ gr: r.minGr }));
  assert.ok(r.ticks > 20, `ticks ${r.ticks}`);
});

test('limiter is transparent below the ceiling', async () => {
  const r = await run('limiter', { amp: 0.5, on: true });
  assert.ok(Math.abs(20 * Math.log10(r.outRms / r.inRms)) < 0.05, JSON.stringify(r));
});

test('crossfader at B silences an A-assigned deck', async () => {
  const r = await run('xfader');
  assert.ok(r.rms < 1e-4, JSON.stringify(r));
});

test('no page errors', () => { assert.deepEqual(errors, []); });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test tests/browser/offline.test.mjs`
Expected: FAIL (the page cannot import `engine/eq.js`; `window.ready` never set).

- [ ] **Step 5: Implement `engine/params.js` and `engine/eq.js`**

`engine/params.js`:

```js
// engine/params.js — click-free AudioParam helpers. Never assign .value on live params.

export function glide(ctx, param, value, tc = 0.01) {
  const now = ctx.currentTime;
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
  else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
  param.setTargetAtTime(value, now, tc);
}

export function ramp(ctx, param, value, sec = 0.005) {
  const now = ctx.currentTime;
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
  else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
  param.linearRampToValueAtTime(value, now + sec);
}
```

`engine/eq.js`:

```js
// engine/eq.js — DJ-style 3-band isolator (Linkwitz-Riley 4th order) and input trim.
//
//  in ─┬─ LP ─ LP ─ AP(high) ─────────── gLow ─┐
//      └─ HP ─ HP ─┬─ LP(high) ─ LP(high) ─ gMid ─┼─► out
//                  └─ HP(high) ─ HP(high) ─ gHi ──┘
// LP/HP Q is in dB in Web Audio: -3.0103 dB = Butterworth (0.7071). The allpass Q is linear.
// LR4 LP + LR4 HP = 2nd-order allpass, so the allpass on the low band makes all bands sum flat.
import { knobToGain } from './sync.js';
import { glide, ramp } from './params.js';

const BW_DB = -3.0103;

function bq(ctx, type, freq, Q) {
  const n = ctx.createBiquadFilter();
  n.type = type;
  n.frequency.value = freq;
  n.Q.value = Q;
  return n;
}

export function createIsolator(ctx, { low = 250, high = 2500 } = {}) {
  const input = ctx.createGain(), output = ctx.createGain();
  const lp1 = bq(ctx, 'lowpass', low, BW_DB), lp2 = bq(ctx, 'lowpass', low, BW_DB), ap = bq(ctx, 'allpass', high, Math.SQRT1_2);
  const hp1 = bq(ctx, 'highpass', low, BW_DB), hp2 = bq(ctx, 'highpass', low, BW_DB);
  const mlp1 = bq(ctx, 'lowpass', high, BW_DB), mlp2 = bq(ctx, 'lowpass', high, BW_DB);
  const hhp1 = bq(ctx, 'highpass', high, BW_DB), hhp2 = bq(ctx, 'highpass', high, BW_DB);
  const gains = { low: ctx.createGain(), mid: ctx.createGain(), hi: ctx.createGain() };
  input.connect(lp1).connect(lp2).connect(ap).connect(gains.low).connect(output);
  input.connect(hp1).connect(hp2);
  hp2.connect(mlp1).connect(mlp2).connect(gains.mid).connect(output);
  hp2.connect(hhp1).connect(hhp2).connect(gains.hi).connect(output);
  const knob = { low: 0.5, mid: 0.5, hi: 0.5 };
  const killed = { low: false, mid: false, hi: false };
  const target = (band) => (killed[band] ? 0 : knobToGain(knob[band], 6));
  const nodes = [input, lp1, lp2, ap, hp1, hp2, mlp1, mlp2, hhp1, hhp2, gains.low, gains.mid, gains.hi, output];
  return {
    input,
    output,
    set(band, k) { knob[band] = k; if (!killed[band]) glide(ctx, gains[band].gain, target(band)); },
    kill(band, on) { killed[band] = !!on; ramp(ctx, gains[band].gain, target(band), 0.005); },
    dispose() { for (const n of nodes) n.disconnect(); },
  };
}

export function createTrim(ctx) {
  const g = ctx.createGain();
  return { input: g, output: g, set(k) { glide(ctx, g.gain, knobToGain(k, 12)); }, dispose() { g.disconnect(); } };
}
```

- [ ] **Step 6: Implement `worklets/beatfx.js`**

```js
// worklets/beatfx.js — per-deck insert for the beat-locked GATE and the CRUSH effect.
// The gate pattern is computed per sample from the deck's beat clock, expressed in output
// frames (the AudioWorkletGlobalScope `currentFrame` clock), so it never drifts.

class BeatFx extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'off';
    this.depth = 1;
    this.stepBeats = 0.25;
    this.amount = 0.5;
    this.anchor = 0;
    this.period = sampleRate * 0.5;
    this.g = 1;
    this.mix = 0;
    this.coef = 1 - Math.exp(-1 / (0.002 * sampleRate));
    this.gbuf = new Float32Array(128);
    this.mbuf = new Float32Array(128);
    this.hold = new Float32Array(2);
    this.holdCount = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'mode') this.mode = m.mode;
      else if (m.t === 'gate') { this.depth = m.depth; this.stepBeats = m.stepBeats; }
      else if (m.t === 'crush') this.amount = m.amount;
      else if (m.t === 'clock' && m.periodFrames > 0) { this.anchor = m.anchorFrame; this.period = m.periodFrames; }
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    if (this.gbuf.length !== n) { this.gbuf = new Float32Array(n); this.mbuf = new Float32Array(n); }
    const gate = this.mode === 'gate', crush = this.mode === 'crush';
    const step = this.period * this.stepBeats;
    for (let i = 0; i < n; i++) {
      let gt = 1;
      if (gate) {
        const pos = (currentFrame + i - this.anchor) / step;
        if (pos - Math.floor(pos) >= 0.5) gt = 1 - this.depth;
      }
      this.g += (gt - this.g) * this.coef;
      this.mix += ((crush ? 1 : 0) - this.mix) * this.coef;
      this.gbuf[i] = this.g;
      this.mbuf[i] = this.mix;
    }
    const bits = 16 - 12 * this.amount;
    const q = Math.pow(2, bits - 1);
    const factor = 1 + Math.floor(this.amount * 15);
    const startCount = this.holdCount;
    for (let c = 0; c < out.length; c++) {
      const src = inp && inp.length ? inp[Math.min(c, inp.length - 1)] : null;
      const dst = out[c];
      let count = startCount;
      for (let i = 0; i < n; i++) {
        const x = src ? src[i] : 0;
        let y = x;
        const mx = this.mbuf[i];
        if (mx > 1e-4) {
          if (count === 0) this.hold[c] = Math.round(x * q) / q;
          y = x * (1 - mx) + this.hold[c] * mx;
          count = (count + 1) % factor;
        }
        dst[i] = y * this.gbuf[i];
      }
      if (c === out.length - 1) this.holdCount = count;
    }
    return true;
  }
}

registerProcessor('jds-beatfx', BeatFx);
```

- [ ] **Step 7: Implement `engine/fx.js`**

```js
// engine/fx.js — DJ filter and the per-deck FX rack.
//
// rack: in → DJ FILTER → beatfx worklet (GATE/CRUSH) → FLANGER (insert) → post ─┬─ dry ─────────┐
//                                                                               ├─ ECHO send/return ─┼─► out
//                                                                               └─ REVERB send/return ┘
// ECHO and REVERB are send/return so switching them off lets their tails ring out.
import { djFilterParams } from './sync.js';
import { glide, ramp } from './params.js';

const BW_DB = -3.0103;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function bq(ctx, type, freq, Q) {
  const n = ctx.createBiquadFilter();
  n.type = type; n.frequency.value = freq; n.Q.value = Q;
  return n;
}

export function createDjFilter(ctx) {
  const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain();
  const lp1 = bq(ctx, 'lowpass', 20000, -5.33), lp2 = bq(ctx, 'lowpass', 20000, 2.32), lpWet = ctx.createGain();
  const hp1 = bq(ctx, 'highpass', 20, -5.33), hp2 = bq(ctx, 'highpass', 20, 2.32), hpWet = ctx.createGain();
  lpWet.gain.value = 0; hpWet.gain.value = 0;
  input.connect(dry).connect(output);
  input.connect(lp1).connect(lp2).connect(lpWet).connect(output);
  input.connect(hp1).connect(hp2).connect(hpWet).connect(output);
  let mode = 'off';
  return {
    input,
    output,
    set(x, res) {
      const p = djFilterParams(x, res);
      const now = ctx.currentTime;
      const pair = p.mode === 'lp' ? [lp1, lp2] : p.mode === 'hp' ? [hp1, hp2] : null;
      if (pair) {
        if (p.mode !== mode) for (const f of pair) { f.frequency.cancelScheduledValues(now); f.frequency.setValueAtTime(p.freq, now); }
        else for (const f of pair) glide(ctx, f.frequency, p.freq, 0.015);
        glide(ctx, pair[1].Q, p.q2, 0.02);
      }
      if (p.mode !== mode) {
        ramp(ctx, dry.gain, p.mode === 'off' ? 1 : 0, 0.01);
        ramp(ctx, lpWet.gain, p.mode === 'lp' ? 1 : 0, 0.01);
        ramp(ctx, hpWet.gain, p.mode === 'hp' ? 1 : 0, 0.01);
        mode = p.mode;
      }
    },
    dispose() { for (const n of [input, output, dry, lp1, lp2, lpWet, hp1, hp2, hpWet]) n.disconnect(); },
  };
}

function tanhCurve() {
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) { const x = (i / (c.length - 1)) * 2 - 1; c[i] = Math.tanh(1.2 * x) / Math.tanh(1.2); }
  return c;
}

function createEcho(ctx) {
  const input = ctx.createGain(); input.gain.value = 0;
  const delay = ctx.createDelay(4);
  const hp = bq(ctx, 'highpass', 150, BW_DB), lp = bq(ctx, 'lowpass', 4500, BW_DB);
  const sat = ctx.createWaveShaper(); sat.curve = tanhCurve();
  const fb = ctx.createGain(); fb.gain.value = 0.5;
  const output = ctx.createGain();
  input.connect(delay);
  delay.connect(hp).connect(lp);
  lp.connect(output);
  lp.connect(sat).connect(fb).connect(delay);
  return {
    input,
    output,
    set({ on, level, bpm, beats }, immediate) {
      const t = clamp((beats * 60) / bpm, 0.02, 3.9);
      if (immediate) delay.delayTime.setValueAtTime(t, ctx.currentTime); else glide(ctx, delay.delayTime, t, 0.05);
      glide(ctx, fb.gain, 0.3 + 0.45 * level, 0.02);
      ramp(ctx, input.gain, on ? Math.min(1, 0.4 + 0.6 * level) : 0, 0.01);
    },
    dispose() { for (const n of [input, delay, hp, lp, sat, fb, output]) n.disconnect(); },
  };
}

export const REVERB_SIZES = Object.freeze({ ROOM: 0.8, HALL: 2.2, WASH: 5 });
const reverbSize = (beats) => (beats <= 0.25 ? REVERB_SIZES.ROOM : beats <= 1 ? REVERB_SIZES.HALL : REVERB_SIZES.WASH);

export function makeImpulse(ctx, t60, seed = 1) {
  const sr = ctx.sampleRate, len = Math.ceil(sr * t60 * 1.1);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    let s = (seed * 9301 + c * 49297) >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const d = buf.getChannelData(c);
    let lpState = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const cutoff = 12000 * (2000 / 12000) ** Math.min(1, t / t60);
      const a = Math.exp((-2 * Math.PI * cutoff) / sr);
      lpState = (1 - a) * rnd() + a * lpState;
      d[i] = lpState * 10 ** ((-3 * t) / t60);
    }
    for (let k = 0; k < 7; k++) {
      const at = Math.round(sr * (0.007 + 0.009 * k + 0.002 * c));
      if (at < len) d[at] += 0.5 * 0.8 ** k * (k % 2 ? -1 : 1);
    }
  }
  return buf;
}

function createReverb(ctx, t60) {
  const input = ctx.createGain(); input.gain.value = 0;
  const hp = bq(ctx, 'highpass', 250, BW_DB);
  const pre = ctx.createDelay(0.1); pre.delayTime.value = 0.015;
  const conv = ctx.createConvolver(); conv.normalize = true; conv.buffer = makeImpulse(ctx, t60);
  const output = ctx.createGain(); output.gain.value = 0.7;
  input.connect(hp).connect(pre).connect(conv).connect(output);
  return { input, output, t60, dispose() { for (const n of [input, hp, pre, conv, output]) n.disconnect(); } };
}

function createFlanger(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const delay = ctx.createDelay(0.05); delay.delayTime.value = 0.003;
  const wet = ctx.createGain(); wet.gain.value = 0;
  const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = 0.25;
  const depth = ctx.createGain(); depth.gain.value = 0.002;
  lfo.connect(depth).connect(delay.delayTime);
  lfo.start();
  input.connect(output);
  input.connect(delay).connect(wet).connect(output);
  return {
    input,
    output,
    set({ on, level, bpm, beats }) {
      const periodBeats = clamp(beats * 8, 1, 32);
      glide(ctx, lfo.frequency, bpm / 60 / periodBeats, 0.05);
      ramp(ctx, wet.gain, on ? level : 0, 0.01);
    },
    dispose() { try { lfo.stop(); } catch (_) {} for (const n of [input, output, delay, wet, lfo, depth]) n.disconnect(); },
  };
}

export function createFxRack(ctx) {
  const filter = createDjFilter(ctx);
  const beatfx = new AudioWorkletNode(ctx, 'jds-beatfx', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
  });
  const flanger = createFlanger(ctx);
  const echo = createEcho(ctx);
  const post = ctx.createGain(), output = ctx.createGain();
  filter.output.connect(beatfx).connect(flanger.input);
  flanger.output.connect(post);
  post.connect(output);
  post.connect(echo.input);
  echo.output.connect(output);
  let reverb = null;
  const retiring = []; // [{rv, at}] reverbs whose tails are ringing out
  const s = { type: 'ECHO', beats: 0.5, level: 0.5, on: false, bpm: 120 };
  let first = true;

  function applyReverb(enabled) {
    const size = reverbSize(s.beats);
    if (enabled && (!reverb || reverb.t60 !== size)) {
      if (reverb) retire(reverb);
      reverb = createReverb(ctx, size);
      post.connect(reverb.input);
      reverb.output.connect(output);
    }
    if (reverb) ramp(ctx, reverb.input.gain, enabled ? 0.5 + 0.5 * s.level : 0, 0.01);
    if (!enabled && reverb) { retire(reverb); reverb = null; }
  }
  function retire(rv) {
    ramp(ctx, rv.input.gain, 0, 0.01);
    retiring.push({ rv, at: ctx.currentTime + rv.t60 + 0.5 });
  }

  function apply() {
    const on = (t) => s.on && s.type === t;
    echo.set({ on: on('ECHO'), level: s.level, bpm: s.bpm, beats: s.beats }, first);
    flanger.set({ on: on('FLANGER'), level: s.level, bpm: s.bpm, beats: s.beats });
    beatfx.port.postMessage({ t: 'gate', depth: s.level, stepBeats: s.beats });
    beatfx.port.postMessage({ t: 'crush', amount: s.level });
    beatfx.port.postMessage({ t: 'mode', mode: on('GATE') ? 'gate' : on('CRUSH') ? 'crush' : 'off' });
    applyReverb(on('REVERB'));
    first = false;
  }

  return {
    input: filter.input,
    output,
    beatfx,
    setFilter(x, res) { filter.set(x, res); },
    setFx(partial) { Object.assign(s, partial); if (!(s.bpm > 0)) s.bpm = 120; apply(); },
    setClock(anchorFrame, periodFrames) { beatfx.port.postMessage({ t: 'clock', anchorFrame, periodFrames }); },
    tick(now) {
      for (let i = retiring.length - 1; i >= 0; i--) if (now >= retiring[i].at) { retiring[i].rv.dispose(); retiring.splice(i, 1); }
    },
    dispose() {
      filter.dispose(); flanger.dispose(); echo.dispose();
      if (reverb) reverb.dispose();
      for (const r of retiring) r.rv.dispose();
      beatfx.port.close();
      for (const n of [beatfx, post, output]) n.disconnect();
    },
  };
}
```

- [ ] **Step 8: Implement `worklets/master.js`**

```js
// worklets/master.js — master limiter + meters + engine tick.
// Lookahead brickwall limiter: audio is delayed by L = 5 ms; a sliding-window max of |x|
// over the last L+1 samples gives the gain needed for the sample leaving the delay line,
// so the output never exceeds the -1 dBFS ceiling. The delay stays in place when the
// limiter is off, so toggling never shifts timing. Every 1536 frames it posts post-limiter
// peak/RMS per channel and the deepest gain reduction: the engine's tick.

const TICK = 1536;

class Master extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = Math.max(1, Math.round(0.005 * sampleRate));
    this.dl = new Float32Array(this.L);
    this.dr = new Float32Array(this.L);
    this.dw = 0;
    this.W = this.L + 1;
    this.C = this.W + 1;
    this.qv = new Float32Array(this.C);
    this.qi = new Float64Array(this.C);
    this.qh = 0; this.qt = 0; this.qn = 0;
    this.count = 0;
    this.g = 1;
    this.on = true;
    this.ceil = Math.pow(10, -1 / 20);
    this.rel = 1 - Math.exp(-1 / (0.1 * sampleRate));
    this.acc = 0; this.pkL = 0; this.pkR = 0; this.sqL = 0; this.sqR = 0; this.minG = 1;
    this.port.onmessage = (e) => { const m = e.data || {}; if (m.t === 'limiter') this.on = !!m.on; };
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const il = inp && inp.length ? inp[0] : null;
    const ir = inp && inp.length > 1 ? inp[1] : il;
    const ol = out[0], or = out.length > 1 ? out[1] : out[0];
    const n = ol.length, C = this.C;
    for (let i = 0; i < n; i++) {
      const xl = il ? il[i] : 0, xr = ir ? ir[i] : 0;
      const w = this.dw;
      const yl = this.dl[w], yr = this.dr[w];
      this.dl[w] = xl; this.dr[w] = xr;
      this.dw = w + 1 === this.L ? 0 : w + 1;
      const al = xl < 0 ? -xl : xl, ar = xr < 0 ? -xr : xr, a = al > ar ? al : ar;
      const id = this.count++;
      while (this.qn > 0) {
        const b = this.qt === 0 ? C - 1 : this.qt - 1;
        if (this.qv[b] <= a) { this.qt = b; this.qn--; } else break;
      }
      this.qv[this.qt] = a; this.qi[this.qt] = id;
      this.qt = this.qt + 1 === C ? 0 : this.qt + 1;
      this.qn++;
      while (this.qi[this.qh] <= id - this.W) { this.qh = this.qh + 1 === C ? 0 : this.qh + 1; this.qn--; }
      const pk = this.qv[this.qh];
      const req = this.on && pk > this.ceil ? this.ceil / pk : 1;
      if (req < this.g) this.g = req; else this.g += (req - this.g) * this.rel;
      const g = this.g;
      const zl = yl * g, zr = yr * g;
      ol[i] = zl;
      if (or !== ol) or[i] = zr;
      const ml = zl < 0 ? -zl : zl, mr = zr < 0 ? -zr : zr;
      if (ml > this.pkL) this.pkL = ml;
      if (mr > this.pkR) this.pkR = mr;
      this.sqL += zl * zl; this.sqR += zr * zr;
      if (g < this.minG) this.minG = g;
      if (++this.acc === TICK) {
        this.port.postMessage({
          t: 'meter', frame: currentFrame + i + 1, peakL: this.pkL, peakR: this.pkR,
          rmsL: Math.sqrt(this.sqL / TICK), rmsR: Math.sqrt(this.sqR / TICK), gr: 20 * Math.log10(this.minG),
        });
        this.acc = 0; this.pkL = 0; this.pkR = 0; this.sqL = 0; this.sqR = 0; this.minG = this.g;
      }
    }
    return true;
  }
}

registerProcessor('jds-master', Master);
```

- [ ] **Step 9: Implement `engine/master.js`**

```js
// engine/master.js — master bus: decks → bus → volume → jds-master (limiter, meters, tick) → out → speakers.
// `out` is also the mix-recording tap, so recordings match what was heard.
import { knobToGain, crossfaderGains, deckXfGain } from './sync.js';
import { glide } from './params.js';

export function createMaster(ctx) {
  const bus = ctx.createGain();
  const vol = ctx.createGain();
  const node = new AudioWorkletNode(ctx, 'jds-master', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
  });
  const out = ctx.createGain();
  bus.connect(vol).connect(node).connect(out);
  out.connect(ctx.destination);
  const listeners = new Set();
  let last = { t: 'meter', frame: 0, peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, gr: 0 };
  node.port.onmessage = (e) => {
    const m = e.data;
    if (!m || m.t !== 'meter') return;
    last = m;
    for (const fn of listeners) fn(m);
  };
  const decks = new Map();
  let xf = { pos: 0.5, curve: 'SMOOTH' };
  const applyXf = (d) => glide(ctx, d.gain.gain, deckXfGain(d.assign, crossfaderGains(xf.pos, xf.curve)), 0.003);
  return {
    bus,
    out,
    onMeter(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get meter() { return last; },
    setVolume(k) { glide(ctx, vol.gain, knobToGain(k, 6)); },
    setLimiter(on) { node.port.postMessage({ t: 'limiter', on: !!on }); },
    setCrossfader(pos, curve) { xf = { pos, curve }; for (const d of decks.values()) applyXf(d); },
    addDeck(id, gainNode, assign) { const d = { gain: gainNode, assign }; decks.set(id, d); applyXf(d); },
    setAssign(id, assign) { const d = decks.get(id); if (d) { d.assign = assign; applyXf(d); } },
    removeDeck(id) { decks.delete(id); },
    dispose() { node.port.close(); for (const n of [bus, vol, node, out]) n.disconnect(); },
  };
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `node --test tests/browser/offline.test.mjs`
Expected: PASS (all tests, including `no page errors`).

- [ ] **Step 11: Commit**

```bash
git add engine/params.js engine/eq.js engine/fx.js engine/master.js worklets/beatfx.js worklets/master.js tests/browser
git commit -m "Add isolator EQ, DJ filter, FX rack, master limiter with offline browser tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---
## Task 8: Deck and engine (offscreen document)

The engine is the source of truth. It runs every timing-critical loop from the master worklet's
meter message (about every 32 ms), never from `setInterval`.

**Files:**
- Create: `engine/deck.js`, `engine/engine.js`
- Modify: `offscreen.html` (replace the whole file)
- Test: exercised end to end by `tests/browser/e2e.test.mjs` (Task 14). This task's own check
  is the module smoke test in Step 4.

**Interfaces:**
- Consumes:
  - `DeckTempo` (T2), `OdfCore`/deck-input worklet (T3), `sync.js` (T4), `Timeshift`/`SourceMap`/`GridMap`/`GUARD`/`LIVE_RESERVE` (T5);
  - `Recorder` (T6), `createIsolator`/`createTrim`/`createFxRack`/`createMaster`/`glide` (T7);
  - protocol (T1); patched Signalsmith (T1).
- Produces:
  - `class Deck(engine, {id, slot, tabId, stream, meta, params})` with:
    - lifecycle: `.init()`, `.dispose() → Promise`;
    - control: `.setParam(key, value)`, `.act(a, arg) → Promise<{ok, error?}>`;
    - per-tick: `.tick(now)`, `.syncTick(now)`, `.phaseTick(now)`;
    - clock: `.masterInfo(now)`;
    - output: `.state(now) → DeckState`, `.waveBacklog() → wave message|null`;
    - agent: `.attachAgent(port, frameId)`;
    - fields `.xfGain`, `.tabId`, `.slot`, `.id`, `.meta`.
  - `engine/engine.js` (module side effects only). It:
    - registers `runtime.onConnect` (`jds-ui`, `jds-agent`) and `runtime.onMessage` (`target:'engine'`);
    - exposes `globalThis.__jdsEngine` for tests.

- [ ] **Step 1: Replace `offscreen.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>JD Samps — audio engine</title>
  </head>
  <body>
    <script type="module" src="engine/engine.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `engine/deck.js`**

```js
// engine/deck.js — one captured tab as a DJ deck.
//
// tab stream ─► MediaStreamSource ─► jds-deck-input ─(chunks)─► Timeshift/stretch node (buffer mode)
//                                         └─(ODF)─► DeckTempo ─► GridMap
// stretch ─► trim ─► EQ ─► FX rack (filter, gate/crush, flanger, echo/reverb sends) ─┬─► fader ─► xfGain ─► master bus
//                                                                                    └─► recorder (pre-fader, post-FX)
// All transport/tempo/phase changes are scheduled on the audio clock through Timeshift.
import { BPM_RANGES, validateAgentMessage } from '../shared/protocol.js';
import { DeckTempo } from './tempo.js';
import { Timeshift, SourceMap, GridMap, GUARD, LIVE_RESERVE } from './timeshift.js';
import { createIsolator, createTrim } from './eq.js';
import { createFxRack } from './fx.js';
import { Recorder } from './recorder.js';
import { glide } from './params.js';
import { syncRatio, lastBeatOut, phaseError, planCorrection, engineSemitones, assistStep, pickAutoMaster } from './sync.js';

const OK = { ok: true };
const fail = (error) => ({ ok: false, error });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

export class Deck {
  constructor(engine, { id, slot, tabId, stream, meta, params }) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.sr = engine.ctx.sampleRate;
    this.id = id;
    this.slot = slot;
    this.tabId = tabId;
    this.stream = stream;
    this.meta = { title: '', url: '', favIconUrl: '', ...meta };
    this.params = { ...params };
    this.tempo = null;
    this.grids = new GridMap();
    this.src = new SourceMap();
    this.cue = 0;
    this.cueAuto = true;
    this.cueSnapped = false;
    this.firstAudible = null;
    this.wantPlay = false;
    this.previewing = false;
    this.hasPlayed = false;
    this.playingSince = Infinity;
    this.syncOn = false;
    this.outOfRange = false;
    this.phaseMs = null;
    this.settleUntil = 0;
    this.nudge = 0;
    this.nudgeFactor = 1;
    this.roll = null;
    this.rollFrom = null;
    this.loop = null;
    this.starved = false;
    this.emergencyUntil = 0;
    this.assist = { target: 1, sourceRate: 1, active: false };
    this.agents = new Map();
    this.meter = { peak: 0, rms: 0, clipUntil: 0 };
    this.error = null;
    this.nextTrim = 0;
    this.nextAssist = 0;
    this.nextFxClock = 0;
    this.lastFxBpm = 0;
    this.crossingFor = null;
    this.wave = { tStart: null, hop: 0, data: new Uint8Array(0), n: 0 };
    this.disposed = false;
  }

  now() { return this.ctx.currentTime; }

  async init() {
    const ctx = this.ctx, e = this.engine;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.inputNode = new AudioWorkletNode(ctx, 'jds-deck-input', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    this.inputNode.port.onmessage = (ev) => this.onInput(ev.data);
    this.stretch = await e.createStretch();
    const lat = await withTimeout(this.stretch.latency(), 4000, 'The time-stretcher did not report its latency');
    this.ts = new Timeshift(this.stretch, { sampleRate: this.sr, latency: lat, outLatency: lat / 2, capSec: e.params['buffer.capSec'] });
    this.trimNode = createTrim(ctx);
    this.eq = createIsolator(ctx);
    this.rack = createFxRack(ctx);
    this.fader = ctx.createGain();
    this.xfGain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.meterBuf = new Float32Array(this.analyser.fftSize);
    this.stretch.connect(this.trimNode.input);
    this.trimNode.output.connect(this.eq.input);
    this.eq.output.connect(this.rack.input);
    this.rack.output.connect(this.fader);
    this.fader.connect(this.xfGain);
    this.fader.connect(this.analyser);
    this.xfGain.connect(e.master.bus);
    this.recorder = new Recorder(ctx, this.rack.output, {
      format: e.params['rec.format'], who: `D${this.slot}`, title: () => this.meta.title || `Tab ${this.tabId}`, sink: e.silentSink,
      deliver: (blob, name) => e.deliver(blob, name), onChange: () => {}, onError: (msg) => e.event('error', msg, this.id),
    });
    for (const [k, v] of Object.entries(this.params)) this.applyParam(k, v);
    // Connect the capture last, so no chunk arrives before the Timeshift exists.
    this.source.connect(this.inputNode);
    this.inputNode.connect(e.silentSink);
    for (const t of this.stream.getAudioTracks()) t.addEventListener('ended', () => e.eject(this.id, `Deck ${this.slot}: the tab stopped sharing audio.`));
  }

  // ------------------------------------------------------------------ input
  onInput(m) {
    if (!m || this.disposed) return;
    if (m.t === 'init') {
      const [lo, hi] = BPM_RANGES[this.engine.params['bpm.range']] || BPM_RANGES.AUTO;
      this.tempo = new DeckTempo({ sampleRate: this.sr, fps: m.fps, lo, hi });
    } else if (m.t === 'chunk') {
      this.ts.append(m.L, m.R);
      if (this.firstAudible == null && m.firstAbove >= 0) {
        this.firstAudible = (m.start + m.firstAbove) / this.sr;
        if (this.cueAuto && !this.hasPlayed) this.setCue(this.firstAudible);
      }
    } else if (m.t === 'odf' && this.tempo) {
      this.tempo.pushBatch(m);
      const g = this.tempo.get().grid;
      this.grids.update(g);
      if (g && this.cueAuto && !this.cueSnapped && !this.hasPlayed && this.firstAudible != null) {
        this.cueSnapped = true;
        const k = Math.ceil((this.firstAudible - 0.05 - g.t0) / g.T);
        this.setCue(g.t0 + k * g.T);
      }
      const tStart = m.t0 / this.sr, hop = m.spf / this.sr;
      this.appendWave(tStart, hop, m.bands);
      this.engine.broadcast({ t: 'wave', deck: this.id, tStart, hop, data: Array.from(m.bands) });
    }
  }

  appendWave(tStart, hop, bands) {
    const w = this.wave;
    if (w.tStart == null) { w.tStart = tStart; w.hop = hop; }
    const i0 = Math.round((tStart - w.tStart) / w.hop);
    const need = (i0 + bands.length / 3) * 3;
    if (need > w.data.length) { const n = new Uint8Array(Math.max(need, w.data.length * 2, 4096)); n.set(w.data); w.data = n; }
    w.data.set(bands, i0 * 3);
    w.n = Math.max(w.n, need / 3);
  }

  waveBacklog() {
    const w = this.wave;
    if (w.tStart == null || !w.n) return null;
    const from = Math.max(0, Math.floor((this.ts.historyStart - w.tStart) / w.hop));
    return { t: 'wave', deck: this.id, tStart: w.tStart + from * w.hop, hop: w.hop, data: Array.from(w.data.subarray(from * 3, w.n * 3)) };
  }

  // ------------------------------------------------------------------ tempo
  tempoInfo() {
    const g = this.tempo ? this.tempo.get() : null;
    const inBpm = g && g.inBpm ? g.inBpm : null;
    // The tracker rescales its tempo the moment an assist step is commanded, so divide by the
    // latest commanded source rate (not the rate at some older input position) to stay consistent.
    const native = inBpm ? inBpm / this.assist.sourceRate : null;
    return { g, native, out: native ? native * (1 + this.params.pitch) : null };
  }
  canBeat() { const g = this.tempo && this.tempo.get(); return !!(g && g.canBeat); }

  desiredRate(p) { return ((1 + this.params.pitch) / this.src.rateAt(p)) * this.nudgeFactor; }
  effRate(p) { const d = this.desiredRate(p); return this.starved ? Math.min(1, d) : d; }
  semis(p) { const s = this.src.rateAt(p); return engineSemitones(this.params.keyLock, s, (1 + this.params.pitch) / s); }

  /** Schedule a change at T, always restating rate/semitones so a pending bend can never stick. */
  sched(T, fields) {
    const p = fields.input !== undefined ? fields.input : this.ts.posAt(T);
    return this.ts.change(this.now(), T, { rate: this.effRate(p), semitones: this.semis(p), ...fields });
  }

  applyRate() {
    if (!this.ts || !this.wantPlay) return;
    this.sched(this.ts.soon(this.now()), {});
  }

  // ------------------------------------------------------------------ transport
  setCue(x) {
    this.cue = this.ts.clampInput(x);
    if (!this.wantPlay) this.ts.change(this.now(), this.ts.soon(this.now()), { active: false, input: this.cue });
  }

  snapToGrid(p) {
    const g = this.grids.at(p);
    if (!g || !this.canBeat()) return p;
    const k = Math.round((p - g.t0) / g.T), b = g.t0 + k * g.T;
    return Math.abs(b - p) <= g.T / 4 ? b : p;
  }

  /** Shift a start position so the deck's beats land on the master clock's beats at time T. */
  alignForStart(p, T) {
    if (!this.syncOn || this.params.syncMode !== 'BEAT' || !this.canBeat() || this.isMaster()) return p;
    const mb = this.engine.clock.beat(T), g = this.grids.at(p);
    if (!mb || !g) return p;
    const rate = this.effRate(p);
    const e = phaseError(lastBeatOut(g, p, rate, T), g.T / rate, mb.lastBeat, mb.period);
    return p + e * rate;
  }

  startAt(T, p) {
    const input = this.ts.clampInput(p);
    this.ts.change(this.now(), T, { active: true, input, rate: this.effRate(input), semitones: this.semis(input) });
    this.wantPlay = true;
    this.hasPlayed = true;
    this.playingSince = T;
    this.settleUntil = T + 0.5;
  }

  isMaster() { return this.engine.clock.assigned === this.id; }

  audible() {
    return this.wantPlay && this.params.fader > 0.01 && this.xfGain.gain.value > 0.01;
  }

  async act(a, arg = {}) {
    if (!this.ts) return fail('The deck is still starting.');
    const now = this.now(), T = this.ts.soon(now);
    switch (a) {
      case 'play': {
        if (this.previewing) { this.previewing = false; return OK; }
        if (this.wantPlay) return OK;
        this.startAt(T, this.alignForStart(this.ts.posAt(T), T));
        return OK;
      }
      case 'pause':
        if (!this.wantPlay) return OK;
        this.ts.change(now, T, { active: false });
        this.wantPlay = false; this.previewing = false; this.playingSince = Infinity;
        return OK;
      case 'syncPlay': {
        if (this.wantPlay && !this.previewing) return OK;
        let start = T;
        const mb = !this.isMaster() ? this.engine.clock.beat(T) : null;
        if (mb) { start = mb.lastBeat + mb.period; while (start < T) start += mb.period; }
        const wasSync = this.syncOn;
        if (mb && this.canBeat()) this.syncOn = true;
        const from = this.snapToGrid(this.cue);
        this.startAt(start, this.alignForStart(from, start));
        this.previewing = false;
        if (!wasSync && this.syncOn) this.syncTick(now);
        return OK;
      }
      case 'cueDown': {
        if (this.wantPlay && !this.previewing) {
          this.ts.change(now, T, { active: false, input: this.cue });
          this.wantPlay = false; this.playingSince = Infinity;
          return OK;
        }
        const p = this.ts.posAt(T);
        if (Math.abs(p - this.cue) < 0.02) { this.startAt(T, this.cue); this.previewing = true; return OK; }
        this.cueAuto = false;
        this.setCue(this.snapToGrid(p));
        return OK;
      }
      case 'cueUp':
        if (this.previewing) {
          this.ts.change(now, T, { active: false, input: this.cue });
          this.wantPlay = false; this.previewing = false; this.playingSince = Infinity;
        }
        return OK;
      case 'live': {
        const target = this.ts.clampInput(this.ts.liveEdge - this.ts.lat - LIVE_RESERVE);
        if (this.wantPlay) this.sched(T, { input: target });
        else this.ts.change(now, T, { active: false, input: target });
        return OK;
      }
      case 'sync': return this.actSync(arg.on, now);
      case 'master':
        if (this.isMaster()) this.engine.clock.release(this.id);
        else { this.engine.clock.follow(this.id); this.syncOn = false; this.phaseMs = null; }
        return OK;
      case 'nudge':
        this.nudge = arg.dir;
        this.nudgeFactor = arg.dir ? 1 + arg.dir * (arg.fine ? 0.01 : 0.04) : 1;
        this.applyRate();
        this.settleUntil = now + (arg.dir ? 1e9 : 1);
        return OK;
      case 'tap': {
        if (!this.tempo) return fail('Waiting for audio.');
        const t = this.engine.ctxTimeAtWall(arg.wallMs ?? this.engine.wallNow());
        this.tempo.tap(Math.round(this.ts.posAt(t) * this.sr));
        this.grids.update(this.tempo.get().grid);
        return OK;
      }
      case 'mult': if (this.tempo) { this.tempo.multiply(arg.factor); this.grids.update(this.tempo.get().grid); } return OK;
      case 'gridShift': if (this.tempo) { this.tempo.shiftGrid(arg); this.grids.update(this.tempo.get().grid); } return OK;
      case 'tap1':
        if (this.tempo) { this.tempo.setBar1(Math.round(this.ts.posAt(this.engine.heardTime()) * this.sr)); this.grids.update(this.tempo.get().grid); }
        return OK;
      case 'rollStart': return this.rollStart(arg.beats, now, T);
      case 'rollEnd': return this.rollEnd(now, T);
      case 'recStart':
        try { this.recorder.start(this.engine.params['rec.format']); return OK; } catch (err) { return fail(`Could not start recording: ${err.message}`); }
      case 'recStop': this.recorder.stop(); return OK;
      case 'eject': this.engine.eject(this.id); return OK;
      case 'clipReset': this.meter.clipUntil = 0; return OK;
      default: return fail(`Unknown action ${a}`);
    }
  }

  actSync(on, now) {
    const want = on == null ? !this.syncOn : on;
    if (!want) { this.syncOn = false; this.phaseMs = null; return OK; }
    if (this.isMaster()) return fail('This deck is the master. Make another deck master to sync this one.');
    if (!this.tempoInfo().native) return fail('No BPM yet. Wait for the deck to lock, or TAP the tempo.');
    const clock = this.engine.clock;
    if (clock.state().mode === 'none') {
      const others = [...this.engine.decks.values()].filter((d) => d !== this).map((d) => ({
        id: d.id, playing: d.wantPlay && !!d.tempoInfo().native, canBeat: d.canBeat(), conf: d.tempo ? d.tempo.get().conf : 0, since: d.playingSince,
      }));
      const pick = pickAutoMaster(others);
      if (pick == null) {
        clock.follow(this.id);
        this.engine.event('info', `Deck ${this.slot} is now the tempo master.`);
        return OK;
      }
      clock.follow(pick);
      this.engine.updateClock(now);
    }
    this.syncOn = true;
    this.settleUntil = 0;
    this.syncTick(now);
    return OK;
  }

  rollStart(beats, now, T) {
    if (!this.wantPlay) return fail('Rolls work while the deck is playing.');
    const p = this.ts.posAt(T), g = this.grids.at(p);
    const L = g ? beats * g.T : beats * 0.5;
    let start = g ? g.t0 + Math.floor((p - g.t0) / L) * L : p;
    if (start + L > this.ts.liveEdge - this.ts.lat - 0.05) start -= L;
    start = Math.max(start, this.ts.historyStart + 0.01);
    this.rollFrom = this.rollFrom || { p, T, rate: this.ts.rateAt(T) };
    this.loop = { start, end: start + L };
    this.roll = beats;
    this.sched(T, { loopStart: start, loopEnd: start + L });
    return OK;
  }

  rollEnd(now, T) {
    if (!this.rollFrom) return OK;
    const slip = this.rollFrom.p + this.rollFrom.rate * (T - this.rollFrom.T);
    this.sched(T, { input: this.ts.clampInput(slip), loopStart: 0, loopEnd: 0 });
    this.roll = null; this.loop = null; this.rollFrom = null;
    this.settleUntil = T + 0.3;
    return OK;
  }

  // ------------------------------------------------------------------ params
  setParam(k, v) {
    if (k === 'pitch') {
      v = clamp(v, -this.params.range, this.params.range);
      if (this.syncOn) { this.syncOn = false; this.phaseMs = null; this.engine.event('info', `Deck ${this.slot}: sync off (tempo moved by hand).`); }
    }
    if (k === 'range') this.params.pitch = clamp(this.params.pitch, -v, v);
    this.params[k] = v;
    this.applyParam(k, v);
  }

  applyParam(k, v) {
    switch (k) {
      case 'trim': this.trimNode.set(v); break;
      case 'eq.hi': case 'eq.mid': case 'eq.low': this.eq.set(k.slice(3), v); break;
      case 'kill.hi': case 'kill.mid': case 'kill.low': this.eq.kill(k.slice(5), v); break;
      case 'filter': case 'filter.res': this.rack.setFilter(this.params.filter, this.params['filter.res']); break;
      case 'fader': glide(this.ctx, this.fader.gain, v * v); break;
      case 'xf': if (this.engine.decks.has(this.id)) this.engine.master.setAssign(this.id, v); break;
      case 'fx.type': case 'fx.beats': case 'fx.level': case 'fx.on': this.applyFx(); break;
      case 'keyLock': case 'pitch': case 'range': this.applyRate(); break;
      default: break;
    }
  }

  applyFx() {
    const bpm = this.tempoInfo().out || 120;
    this.lastFxBpm = bpm;
    this.rack.setFx({ type: this.params['fx.type'], beats: this.params['fx.beats'], level: this.params['fx.level'], on: this.params['fx.on'], bpm });
  }

  // ------------------------------------------------------------------ periodic
  tick(now) {
    if (!this.ts || this.disposed) return;
    const ts = this.ts;
    ts.flush(now);
    const p = ts.posAt(now);
    const res = ts.reserveAt(now);

    if (this.wantPlay) {
      const desired = this.desiredRate(p);
      if (!this.starved && desired > 1 && res < GUARD) {
        this.starved = true;
        this.applyRate();
        this.engine.event('warn', `Deck ${this.slot}: reserve empty, playing at the source's speed until it refills.`, this.id);
      } else if (this.starved && (desired <= 1 || res > GUARD + 1.5)) {
        this.starved = false;
        this.applyRate();
      }
      if (res < 0.15 && now > this.emergencyUntil) {
        this.emergencyUntil = now + 2;
        this.sched(ts.soon(now), { input: ts.clampInput(ts.posAt(ts.soon(now)) - 1) });
      }
      this.scheduleCrossing(now, p);
    }

    // Post-fader meter.
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let pk = 0, sq = 0;
    for (let i = 0; i < this.meterBuf.length; i++) { const x = this.meterBuf[i], a = x < 0 ? -x : x; if (a > pk) pk = a; sq += x * x; }
    this.meter.peak = pk;
    this.meter.rms = Math.sqrt(sq / this.meterBuf.length);
    if (pk >= 0.999) this.meter.clipUntil = now + 2;

    if (now >= this.nextAssist) { this.nextAssist = now + 0.25; this.assistTick(now, res); }
    if (now >= this.nextFxClock) {
      this.nextFxClock = now + 0.5;
      const g = this.grids.at(p), rate = ts.rateAt(now);
      if (g && rate > 0) this.rack.setClock(Math.round(lastBeatOut(g, p, rate, now) * this.sr), (g.T / rate) * this.sr);
      const out = this.tempoInfo().out;
      if (out && Math.abs(out - this.lastFxBpm) > 0.05) this.applyFx();
    }
    this.rack.tick(now);
    if (now >= this.nextTrim) { this.nextTrim = now + 2; this.trim(now, p); }
  }

  /** When the playhead reaches an input position where the source rate changed, change the engine rate exactly there. */
  scheduleCrossing(now, p) {
    const next = this.src.nextChangeAfter(p);
    if (!next || this.crossingFor === next.inPos) return;
    if (this.ts.pendingUntil() >= now) return;
    const rate = this.ts.rateAt(now);
    if (!(rate > 0)) return;
    const tCross = now + (next.inPos - p) / rate;
    if (tCross - now > 0.6) return;
    const T = Math.max(tCross, this.ts.soon(now));
    this.crossingFor = next.inPos;
    this.ts.change(now, T, { rate: this.effRate(next.inPos + 1e-6), semitones: this.semis(next.inPos + 1e-6) });
  }

  assistTick(now, res) {
    const enabled = !!this.engine.params['assist.on'];
    const available = this.agentAvailable();
    const st = assistStep({
      need: this.wantPlay ? 1 + this.params.pitch : 1, reserve: res, sourceRate: this.assist.sourceRate,
      target: this.assist.target, available, playing: this.wantPlay, enabled,
    });
    this.assist.target = st.target;
    if (Math.abs(st.next - this.assist.sourceRate) > 1e-9) {
      const prev = this.assist.sourceRate;
      this.assist.sourceRate = st.next;
      const atIn = this.ts.liveEdge + 0.08;
      this.src.set(atIn, st.next);
      if (this.tempo) {
        this.tempo.sourceRateChanged(st.next / prev, Math.round(atIn * this.sr));
        this.grids.split(atIn, this.tempo.get().grid);
      }
      this.sendAgent(st.next === 1 && st.target === 1 ? { t: 'release' } : { t: 'rate', rate: st.next });
    }
    this.assist.active = this.assist.sourceRate !== 1;
  }

  async trim(now, p) {
    const keepFrom = Math.min(this.cue - 1, p - this.ts.historySec, this.loop ? this.loop.start - 1 : Infinity);
    const r = await this.ts.trim(now, keepFrom);
    if (!r.dropped || this.disposed) return;
    const hs = this.ts.historyStart;
    this.grids.prune(hs);
    this.src.prune(hs);
    if (this.cue < hs) this.cue = hs + 0.05;
    if (!this.wantPlay && this.ts.posAt(this.now()) < hs) {
      this.ts.change(this.now(), this.ts.soon(this.now()), { active: false, input: this.cue });
      this.engine.event('warn', `Deck ${this.slot}: buffer full, the oldest audio was dropped.`, this.id);
    }
  }

  /** Tempo follow for a synced deck (every tick). */
  syncTick(now) {
    if (!this.syncOn || this.isMaster()) return;
    const c = this.engine.clock.state();
    const native = this.tempoInfo().native;
    if (!c.bpm || !native) return;
    const r = syncRatio(c.bpm, native, this.params.range);
    this.outOfRange = r.outOfRange;
    if (Math.abs(r.ratio - (1 + this.params.pitch)) > 2e-5) {
      this.params.pitch = r.ratio - 1;
      if (this.ts.pendingUntil() < now) this.applyRate();
    }
  }

  /** Phase lock for a BEAT-synced playing deck (every 0.5 s). */
  phaseTick(now) {
    this.phaseMs = null;
    if (!this.syncOn || this.params.syncMode !== 'BEAT' || this.outOfRange || !this.wantPlay || this.previewing) return;
    if (this.isMaster() || !this.canBeat() || this.nudge || this.roll) return;
    const starved = this.starved;
    const T = this.ts.soon(now) + 0.02;
    const mb = this.engine.clock.beat(T);
    const p = this.ts.posAt(T), g = this.grids.at(p), rate = this.ts.rateAt(T);
    if (!mb || !g || !(rate > 0)) return;
    const e = phaseError(lastBeatOut(g, p, rate, T), g.T / rate, mb.lastBeat, mb.period);
    this.phaseMs = e * 1000;
    // A starved deck cannot keep up; bending faster would only spend the reserve it is protecting.
    if (starved || now < this.settleUntil || this.ts.pendingUntil() >= now) return;
    const plan = planCorrection(e, { audible: this.audible(), keyLock: this.params.keyLock });
    if (plan.kind === 'bend') this.settleUntil = this.ts.bend(now, T, 1 + plan.bend, plan.duration) + 0.25;
    else if (plan.kind === 'jump') { this.sched(T, { input: this.ts.clampInput(p + plan.seconds * rate) }); this.settleUntil = T + 0.3; }
  }

  masterInfo(now) {
    if (!this.ts) return null;
    const p = this.ts.posAt(now), g = this.grids.at(p), rate = this.ts.rateAt(now), out = this.tempoInfo().out;
    if (!out) return null;
    const playing = this.wantPlay && !this.previewing && this.ts.playingAt(now);
    if (g && rate > 0) return { playing, bpm: out, lastBeat: lastBeatOut(g, p, rate, now), period: g.T / rate };
    return { playing, bpm: out, lastBeat: now, period: 60 / out };
  }

  // ------------------------------------------------------------------ agent (player assist)
  agentAvailable() { for (const a of this.agents.values()) if (a.status && a.status.hasMedia) return true; return false; }

  attachAgent(port, frameId) {
    this.agents.set(frameId, { port, status: null });
    port.onMessage.addListener((raw) => {
      const m = validateAgentMessage(raw);
      if (!m) return;
      const a = this.agents.get(frameId);
      if (a && m.t === 'status') a.status = m;
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; this.agents.delete(frameId); });
    try {
      port.postMessage({ t: 'query' });
      if (this.assist.sourceRate !== 1) port.postMessage({ t: 'rate', rate: this.assist.sourceRate });
    } catch (_) {}
  }

  sendAgent(msg) {
    for (const a of this.agents.values()) {
      if (!a.status || !a.status.hasMedia) continue;
      try { a.port.postMessage(msg); } catch (_) {}
    }
  }

  // ------------------------------------------------------------------ snapshot
  state(now) {
    const ts = this.ts;
    const p = ts ? ts.posAt(now) : 0;
    const info = this.tempoInfo();
    const g = info.g, grid = this.grids.at(p);
    const playingNow = !!ts && ts.playingAt(now);
    return {
      id: this.id, slot: this.slot, tabId: this.tabId, title: this.meta.title, favIconUrl: this.meta.favIconUrl, url: this.meta.url,
      playing: this.wantPlay, previewing: this.previewing, cue: this.cue, playhead: p,
      engineRate: playingNow ? ts.rateAt(now) : 0, liveEdge: ts ? ts.liveEdge : 0, reserve: ts ? ts.reserveAt(now) : 0,
      starved: this.starved, historyStart: ts ? ts.historyStart : 0,
      bpm: { state: g ? g.state : 'SEARCH', native: info.native, out: info.out, conf: g ? g.conf : 0, mult: g ? g.mult : 1, tapped: g ? g.tapped : false },
      grid: grid ? { t0: grid.t0, T: grid.T, bar1: grid.bar1 } : null,
      sync: { on: this.syncOn, mode: this.params.syncMode, isMaster: this.isMaster(), outOfRange: this.syncOn && this.outOfRange, phaseMs: this.phaseMs },
      assist: { available: this.agentAvailable(), active: this.assist.active, sourceRate: this.assist.sourceRate },
      params: { ...this.params },
      roll: this.roll, loop: this.loop, nudge: this.nudge,
      meter: { peak: this.meter.peak, rms: this.meter.rms, clip: now < this.meter.clipUntil },
      rec: this.recorder ? { state: this.recorder.state, format: this.recorder.format, seconds: this.recorder.seconds } : { state: 'idle', format: 'wav', seconds: 0 },
      error: this.error,
    };
  }

  // ------------------------------------------------------------------ teardown
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.sendAgent({ t: 'release' });
    for (const a of this.agents.values()) { try { a.port.disconnect(); } catch (_) {} }
    this.agents.clear();
    if (this.recorder && this.recorder.state !== 'idle') {
      this.recorder.stop();
      const t0 = Date.now();
      while (this.recorder.state !== 'idle' && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    }
    for (const t of this.stream.getTracks()) t.stop();
    const nodes = [this.source, this.inputNode, this.stretch, this.fader, this.xfGain, this.analyser];
    for (const n of nodes) { try { n && n.disconnect(); } catch (_) {} }
    try { this.inputNode && this.inputNode.port.close(); } catch (_) {}
    for (const m of [this.trimNode, this.eq, this.rack]) { try { m && m.dispose(); } catch (_) {} }
    this.engine.master.removeDeck(this.id);
  }
}
```

- [ ] **Step 3: Write `engine/engine.js`**

```js
// engine/engine.js — the offscreen audio engine. Owns the AudioContext, decks, master, clock,
// mix recorder, the UI ports ('jds-ui') and agent ports ('jds-agent'). The service worker
// talks to it with runtime messages {target:'engine'}.
import SignalsmithStretch from '../vendor/signalsmith-stretch/SignalsmithStretch.mjs';
import {
  PORT_UI, PORT_AGENT, MAX_DECKS, TARGET, HUB, ENGINE, DECK_PARAMS, MASTER_PARAMS, BPM_RANGES,
  defaults, validateUiMessage,
} from '../shared/protocol.js';
import { createMaster } from './master.js';
import { Recorder } from './recorder.js';
import { MasterClock } from './sync.js';
import { Deck } from './deck.js';

const STRETCH_URL = new URL('../vendor/signalsmith-stretch/SignalsmithStretch.js', import.meta.url).href;
SignalsmithStretch.moduleUrl = STRETCH_URL;
const workletUrl = (f) => new URL(`../worklets/${f}`, import.meta.url).href;
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

class Engine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.params = defaults(MASTER_PARAMS);
    this.decks = new Map();
    this.nextId = 1;
    this.clock = new MasterClock();
    this.ui = new Set();
    this.serialQ = Promise.resolve();
    this.downloads = new Map();
    this.clipUntil = { L: 0, R: 0 };
    this.mm = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, gr: 0 };
    this.nextPhase = 0;
    this.ready = this.boot();
    this.listen();
  }

  async boot() {
    for (const f of ['deck-input.js', 'beatfx.js', 'recorder.js', 'master.js']) await this.ctx.audioWorklet.addModule(workletUrl(f));
    await this.ctx.audioWorklet.addModule(STRETCH_URL);
    this.silentSink = this.ctx.createGain();
    this.silentSink.gain.value = 0;
    this.silentSink.connect(this.ctx.destination);
    this.master = createMaster(this.ctx);
    this.master.setVolume(this.params['master.volume']);
    this.master.setLimiter(this.params['master.limiter']);
    this.master.setCrossfader(this.params['xfader.pos'], this.params['xfader.curve']);
    this.mixRec = new Recorder(this.ctx, this.master.out, {
      format: this.params['rec.format'], who: 'mix', title: () => 'Master', sink: this.silentSink,
      deliver: (b, f) => this.deliver(b, f), onChange: () => {}, onError: (m) => this.event('error', m),
    });
    this.master.onMeter((m) => this.tick(m));
  }

  createStretch() {
    return withTimeout(
      SignalsmithStretch(this.ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }),
      6000, 'The time-stretcher failed to start',
    );
  }

  wallNow() { return performance.timeOrigin + performance.now(); }

  /** Context time whose audio is being heard now (and the wall clock at that moment). */
  outputStamp() {
    const ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) return { ctxTime: ts.contextTime, wallMs: performance.timeOrigin + ts.performanceTime };
    return { ctxTime: this.ctx.currentTime - (this.ctx.outputLatency || 0), wallMs: this.wallNow() };
  }
  heardTime() { return this.outputStamp().ctxTime; }
  ctxTimeAtWall(wallMs) { const s = this.outputStamp(); return s.ctxTime + (wallMs - s.wallMs) / 1000; }

  serial(fn) {
    const run = this.serialQ.then(fn, fn);
    this.serialQ = run.catch(() => {});
    return run;
  }

  deckByTab(tabId) { for (const d of this.decks.values()) if (d.tabId === tabId) return d; return null; }

  // ------------------------------------------------------------------ messaging
  listen() {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === PORT_UI) {
        this.ui.add(port);
        port.onMessage.addListener((m) => { this.onUi(port, m); });
        port.onDisconnect.addListener(() => { void chrome.runtime.lastError; this.ui.delete(port); });
      } else if (port.name === PORT_AGENT) {
        const d = this.deckByTab(port.sender && port.sender.tab ? port.sender.tab.id : -1);
        if (!d) { try { port.disconnect(); } catch (_) {} return; }
        d.attachAgent(port, port.sender.frameId || 0);
      }
    });
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.target !== TARGET.ENGINE) return false;
      this.onHub(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
      return true;
    });
  }

  post(port, msg) { try { port.postMessage(msg); } catch (_) { this.ui.delete(port); } }
  broadcast(msg) { for (const p of this.ui) this.post(p, msg); }
  event(level, text, deck) { this.broadcast({ t: 'event', level, text, deck }); }
  hub(msg) { return chrome.runtime.sendMessage({ target: TARGET.HUB, ...msg }).catch(() => null); }

  async onUi(port, m) {
    await this.ready;
    const v = validateUiMessage(m);
    const reply = (ok, error) => { if (m && m.id) this.post(port, { t: 'reply', id: m.id, ok, error }); };
    if (!v.ok) { reply(false, v.error); return; }
    if (m.t === 'hello') {
      this.post(port, { t: 'state', s: this.snapshot(this.ctx.currentTime) });
      for (const d of this.decks.values()) { const w = d.waveBacklog(); if (w) this.post(port, w); }
      return;
    }
    if (m.t === 'set') {
      if (m.deck === null) this.setMasterParam(m.key, v.value);
      else { const d = this.decks.get(m.deck); if (d) d.setParam(m.key, v.value); else { reply(false, 'That deck is gone.'); return; } }
      reply(true);
      return;
    }
    let r;
    if (m.deck === null) r = await this.masterAct(m.a);
    else { const d = this.decks.get(m.deck); r = d ? await d.act(m.a, v.arg) : { ok: false, error: 'That deck is gone.' }; }
    reply(r.ok, r.error);
  }

  setMasterParam(k, v) {
    this.params[k] = v;
    switch (k) {
      case 'master.volume': this.master.setVolume(v); break;
      case 'master.limiter': this.master.setLimiter(v); break;
      case 'xfader.pos': case 'xfader.curve': this.master.setCrossfader(this.params['xfader.pos'], this.params['xfader.curve']); break;
      case 'bpm.range': {
        const [lo, hi] = BPM_RANGES[v];
        for (const d of this.decks.values()) if (d.tempo) d.tempo.setRange(lo, hi);
        break;
      }
      case 'buffer.capSec': for (const d of this.decks.values()) if (d.ts) d.ts.capSec = v; break;
      default: break;
    }
  }

  async masterAct(a) {
    switch (a) {
      case 'mixRecStart':
        try { this.mixRec.start(this.params['rec.format']); return { ok: true }; } catch (err) { return { ok: false, error: `Could not start the mix recording: ${err.message}` }; }
      case 'mixRecStop': this.mixRec.stop(); return { ok: true };
      case 'clipReset':
        this.clipUntil = { L: 0, R: 0 };
        for (const d of this.decks.values()) d.meter.clipUntil = 0;
        return { ok: true };
      case 'stopAll':
        this.mixRec.stop();
        for (const id of [...this.decks.keys()]) this.eject(id);
        return { ok: true };
      default: return { ok: false, error: `Unknown action ${a}` };
    }
  }

  async onHub(msg) {
    await this.ready;
    switch (msg.type) {
      case ENGINE.START: return this.serial(() => this.startDeck(msg.tabId, msg.streamId, msg.meta || {}));
      case ENGINE.EJECT: { const d = this.deckByTab(msg.tabId); if (d) await this.eject(d.id, msg.reason); return { ok: true }; }
      case ENGINE.META: { const d = this.deckByTab(msg.tabId); if (d) Object.assign(d.meta, msg.meta || {}); return { ok: true }; }
      case ENGINE.PING: return { ok: true, decks: [...this.decks.values()].map((d) => ({ tabId: d.tabId, slot: d.slot })) };
      case ENGINE.DOWNLOAD_DONE: {
        const t = this.downloads.get(msg.url);
        if (t) { clearTimeout(t.timer); this.downloads.delete(msg.url); URL.revokeObjectURL(msg.url); }
        if (msg.ok) this.event('info', `Saved ${t ? t.filename : 'recording'}.`);
        else this.event('error', `Saving ${t ? t.filename : 'the recording'} failed: ${msg.error || 'download interrupted'}.`);
        return { ok: true };
      }
      case ENGINE.NOTIFY: this.event(msg.level === 'error' || msg.level === 'warn' ? msg.level : 'info', String(msg.text || '').slice(0, 300)); return { ok: true };
      default: return { ok: false, error: `Unknown engine message ${msg.type}` };
    }
  }

  // ------------------------------------------------------------------ decks
  async startDeck(tabId, streamId, meta) {
    const existing = this.deckByTab(tabId);
    if (existing) return { ok: false, error: `That tab is already on deck ${existing.slot}.` };
    if (this.decks.size >= MAX_DECKS) return { ok: false, error: `All ${MAX_DECKS} decks are in use. Eject one first.` };
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
    } catch (err) {
      return { ok: false, error: `Chrome would not share that tab's audio: ${err.message}` };
    }
    const used = new Set([...this.decks.values()].map((d) => d.slot));
    let slot = 1; while (used.has(slot)) slot++;
    const params = defaults(DECK_PARAMS);
    params.range = this.params['pitch.defaultRange'];
    const deck = new Deck(this, { id: this.nextId++, slot, tabId, stream, meta, params });
    try {
      await deck.init();
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      await deck.dispose().catch(() => {});
      return { ok: false, error: `The deck could not start: ${err.message}` };
    }
    this.decks.set(deck.id, deck);
    this.master.addDeck(deck.id, deck.xfGain, deck.params.xf);
    this.hub({ type: HUB.DECKS_CHANGED, decks: [...this.decks.values()].map((d) => ({ tabId: d.tabId, slot: d.slot })) });
    this.hub({ type: HUB.AGENT_CONNECT, tabId });
    this.event('info', `Loaded “${meta.title || 'tab'}” on deck ${slot}. It is cued: press PLAY when you're ready.`, deck.id);
    return { ok: true, deckId: deck.id, slot };
  }

  eject(id, reason) {
    return this.serial(async () => {
      const d = this.decks.get(id);
      if (!d) return;
      this.decks.delete(id);
      this.clock.release(id);
      if (reason) this.event('warn', reason);
      this.hub({ type: HUB.DECKS_CHANGED, decks: [...this.decks.values()].map((x) => ({ tabId: x.tabId, slot: x.slot })) });
      await d.dispose();
    });
  }

  deliver(blob, filename) {
    const url = URL.createObjectURL(blob);
    const timer = setTimeout(() => { URL.revokeObjectURL(url); this.downloads.delete(url); }, 10 * 60 * 1000);
    this.downloads.set(url, { timer, filename });
    this.hub({ type: HUB.DOWNLOAD, url, filename }).then((r) => {
      if (!r || !r.ok) {
        this.event('error', `Saving ${filename} failed: ${(r && r.error) || 'the browser refused the download'}.`);
        clearTimeout(timer); this.downloads.delete(url); URL.revokeObjectURL(url);
      }
    });
  }

  // ------------------------------------------------------------------ clock + tick
  updateClock(now) {
    const a = this.clock.assigned != null ? this.decks.get(this.clock.assigned) : null;
    this.clock.update(now, a ? a.masterInfo(now) : null);
  }

  tick(m) {
    const now = this.ctx.currentTime;
    this.mm = m;
    if (m.peakL >= 0.999) this.clipUntil.L = now + 2;
    if (m.peakR >= 0.999) this.clipUntil.R = now + 2;
    for (const d of this.decks.values()) d.tick(now);
    this.updateClock(now);
    for (const d of this.decks.values()) d.syncTick(now);
    if (now >= this.nextPhase) { this.nextPhase = now + 0.5; for (const d of this.decks.values()) d.phaseTick(now); }
    if (this.ui.size) this.broadcast({ t: 'state', s: this.snapshot(now) });
  }

  snapshot(now) {
    const stamp = this.outputStamp();
    const decks = [...this.decks.values()].sort((a, b) => a.slot - b.slot).map((d) => d.state(stamp.ctxTime));
    const cs = this.clock.state();
    return {
      ctxTime: stamp.ctxTime, wallMs: stamp.wallMs, sampleRate: this.ctx.sampleRate, engineState: this.ctx.state,
      outputLatency: this.ctx.outputLatency || 0, clock: cs,
      master: {
        params: { ...this.params }, peakL: this.mm.peakL, peakR: this.mm.peakR, rmsL: this.mm.rmsL, rmsR: this.mm.rmsR,
        clipL: now < this.clipUntil.L, clipR: now < this.clipUntil.R, gr: this.mm.gr,
        rec: this.mixRec ? { state: this.mixRec.state, format: this.mixRec.format, seconds: this.mixRec.seconds } : { state: 'idle', format: 'wav', seconds: 0 },
      },
      decks,
    };
  }
}

globalThis.__jdsEngine = new Engine();
```

- [ ] **Step 4: Module smoke test**

Run: `node -e "import('./engine/sync.js').then(()=>import('./engine/timeshift.js')).then(()=>import('./engine/tempo.js')).then(()=>console.log('ok'))"`
Expected: `ok`. The full behaviour is verified by the Task 14 E2E suite.

- [ ] **Step 5: Commit**

```bash
git add offscreen.html engine/deck.js engine/engine.js
git commit -m "Add deck and offscreen engine: time-shift transport, sync, assist, recording

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---

## Task 9: Manifest and service-worker hub

**Files:**
- Modify: `manifest.json` (replace the whole file)
- Modify: `background.js` (replace the whole file)
- Test: `tests/browser/hub.test.mjs` (uses the extension harness from Task 14 Step 1, so write
  that step first, or run this test after Task 14)

**Interfaces:**
- Consumes: protocol (Task 1); engine messages (Task 8); agent files (Task 10).
- Produces: the hub message handlers listed in **Shared Contracts → Runtime messages**,
  together with:
  - action click, `add-tab` command and context menu → capture;
  - the deck tab, opened or focused;
  - the badge (number of decks);
  - grant tracking in `chrome.storage.session` (`grants: {tabId: origin}`, `decks: [{tabId, slot}]`);
  - download tracking (`dl: {downloadId: url}`).

- [ ] **Step 1: Replace `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "JD Samps",
  "version": "2.0.0",
  "description": "Multi-tab DJ deck in your browser: load tabs onto decks, beat-sync them on the audio, EQ, FX, crossfader and recording. Made by godspee.",
  "minimum_chrome_version": "119",
  "permissions": ["tabCapture", "offscreen", "tabs", "downloads", "storage", "scripting", "contextMenus"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_title": "JD Samps: add this tab to the deck" },
  "commands": {
    "add-tab": { "suggested_key": { "default": "Alt+Shift+A" }, "description": "Add the current tab to the JD Samps deck" }
  },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["agent/agent-main.js"], "run_at": "document_start", "all_frames": true, "match_origin_as_fallback": true, "world": "MAIN" },
    { "matches": ["<all_urls>"], "js": ["agent/agent-relay.js"], "run_at": "document_start", "all_frames": true, "match_origin_as_fallback": true }
  ],
  "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

- [ ] **Step 2: Replace `background.js`**

```js
// background.js — service-worker hub (ES module).
// * Chrome only lets an extension capture a tab after the user invokes it there, so the
//   toolbar icon, the Alt+Shift+A command and the context-menu item all capture the current
//   tab, then open (or focus) the full-page deck.
// * Owns tabCapture stream ids, the offscreen engine's lifetime, the Sources list, downloads,
//   badge, tab lifecycle and player-assist injection.
// * Registers NO runtime.onConnect listener: a receiver that disconnects a port tears it down
//   for every receiver. UI and agent ports go straight to the offscreen engine.
import { TARGET, HUB, ENGINE } from './shared/protocol.js';

const OFFSCREEN = 'offscreen.html';
const DECK = 'deck.html';
const MENU_ID = 'jds-add-tab';
const EXT = chrome.runtime.getURL('');
const capturable = (url) => /^https?:\/\//i.test(url || '');
const originOf = (u) => { try { return new URL(u).origin; } catch (_) { return ''; } };
const fromExtensionPage = (sender) => !!sender && typeof sender.url === 'string' && sender.url.startsWith(EXT);

// ---------------------------------------------------------------- engine
let creating = null;
async function hasEngine() {
  const c = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN)] });
  return c.length > 0;
}
async function ensureEngine() {
  // A document that is still loading already shows up in getContexts(), so wait for any
  // creation in flight before trusting hasEngine().
  if (creating) { await creating; return; }
  if (await hasEngine()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ['USER_MEDIA'], justification: 'Capture, mix and record audio from browser tabs.' })
      .finally(() => { creating = null; });
  }
  await creating;
}
async function toEngine(msg) {
  await ensureEngine();
  for (let i = 0; ; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: TARGET.ENGINE, ...msg });
    } catch (err) {
      // The engine registers its listener while its module loads; retry briefly.
      if (i >= 20 || !/Receiving end does not exist/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
async function engineDecks() {
  if (!(await hasEngine())) return [];
  const r = await chrome.runtime.sendMessage({ target: TARGET.ENGINE, type: ENGINE.PING }).catch(() => null);
  return r && r.ok ? r.decks : [];
}
const notify = (level, text) => toEngine({ type: ENGINE.NOTIFY, level, text }).catch(() => {});

// ---------------------------------------------------------------- grants
async function getGrants() { return (await chrome.storage.session.get('grants')).grants || {}; }
async function grant(tab) { const g = await getGrants(); g[tab.id] = originOf(tab.url); await chrome.storage.session.set({ grants: g }); }
async function revoke(tabId) { const g = await getGrants(); if (tabId in g) { delete g[tabId]; await chrome.storage.session.set({ grants: g }); } }

// ---------------------------------------------------------------- capture
function streamIdFor(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(id);
    });
  });
}

async function capture(tabId) {
  if (!Number.isInteger(tabId)) return { ok: false, error: 'Bad tab id.' };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: 'That tab is gone.' };
  if (!capturable(tab.url)) return { ok: false, error: 'Only web pages (http/https) can be loaded. Chrome pages cannot be captured.' };
  const on = (await engineDecks()).find((d) => d.tabId === tabId);
  if (on) return { ok: false, error: `That tab is already on deck ${on.slot}.` };
  let streamId;
  try {
    streamId = await streamIdFor(tabId);
  } catch (err) {
    return {
      ok: false,
      error: /invoked|activeTab/i.test(err.message)
        ? 'Chrome needs you to click the JD Samps icon on that tab (or press Alt+Shift+A there) before it can be loaded.'
        : `Chrome refused to capture that tab: ${err.message}`,
    };
  }
  return toEngine({ type: ENGINE.START, tabId, streamId, meta: { title: tab.title || '', url: tab.url || '', favIconUrl: tab.favIconUrl || '' } });
}

async function deckTab() {
  const [t] = await chrome.tabs.query({ url: chrome.runtime.getURL(DECK) });
  return t || null;
}
async function openDeck(focus = true) {
  const t = await deckTab();
  if (t) {
    if (focus) { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); }
    return t;
  }
  return chrome.tabs.create({ url: chrome.runtime.getURL(DECK), active: true });
}

async function invoke(tab, { focusDeck }) {
  const deckOpen = !!(await deckTab());
  if (tab && tab.id != null && capturable(tab.url)) {
    await grant(tab);
    const r = await capture(tab.id);
    if (!r.ok) await notify('warn', r.error);
  }
  await openDeck(focusDeck || !deckOpen);
}

chrome.action.onClicked.addListener((tab) => { invoke(tab, { focusDeck: true }); });
chrome.commands.onCommand.addListener((cmd, tab) => { if (cmd === 'add-tab') invoke(tab, { focusDeck: false }); });
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === MENU_ID) invoke(tab, { focusDeck: false }); });
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Add this tab to JD Samps', contexts: ['page', 'frame', 'audio', 'video'] });
  });
});

// ---------------------------------------------------------------- sources
async function listSources() {
  const [tabs, grants, decks] = await Promise.all([chrome.tabs.query({}), getGrants(), engineDecks()]);
  const slot = new Map(decks.map((d) => [d.tabId, d.slot]));
  const rows = tabs.filter((t) => t.id != null && capturable(t.url)).map((t) => ({
    id: t.id, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || '', audible: !!t.audible,
    granted: grants[t.id] === originOf(t.url), deckSlot: slot.get(t.id) ?? null,
  }));
  rows.sort((a, b) => (a.deckSlot ? 0 : 1) - (b.deckSlot ? 0 : 1) || (b.audible - a.audible));
  return { ok: true, tabs: rows };
}

// ---------------------------------------------------------------- downloads
async function download(url, filename) {
  if (typeof url !== 'string' || !url.startsWith(`blob:${EXT.slice(0, -1)}`)) return { ok: false, error: 'Bad download url.' };
  if (typeof filename !== 'string' || !/^[\w .()-]{1,120}\.(wav|webm)$/.test(filename)) return { ok: false, error: 'Bad file name.' };
  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    const dl = (await chrome.storage.session.get('dl')).dl || {};
    dl[id] = url;
    await chrome.storage.session.set({ dl });
    return { ok: true, downloadId: id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.state || (d.state.current !== 'complete' && d.state.current !== 'interrupted')) return;
  const dl = (await chrome.storage.session.get('dl')).dl || {};
  const url = dl[d.id];
  if (!url) return;
  delete dl[d.id];
  await chrome.storage.session.set({ dl });
  toEngine({ type: ENGINE.DOWNLOAD_DONE, url, ok: d.state.current === 'complete', error: d.error ? d.error.current : undefined }).catch(() => {});
});

// ---------------------------------------------------------------- player-assist agent
async function connectAgent(tabId) {
  const ask = () => chrome.tabs.sendMessage(tabId, { jds: 'connect' });
  try { await ask(); return { ok: true }; } catch (_) { /* not injected yet (tab predates install) */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['agent/agent-main.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['agent/agent-relay.js'] });
    await ask();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Player assist is unavailable on this page: ${err.message}` };
  }
}

// ---------------------------------------------------------------- tab lifecycle
async function deckTabIds() { return ((await chrome.storage.session.get('decks')).decks || []).map((d) => d.tabId); }
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await revoke(tabId);
  if ((await deckTabIds()).includes(tabId) && (await hasEngine())) {
    chrome.runtime.sendMessage({ target: TARGET.ENGINE, type: ENGINE.EJECT, tabId }).catch(() => {});
  }
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url) { const g = await getGrants(); if (g[tabId] && g[tabId] !== originOf(info.url)) await revoke(tabId); }
  if (!(await deckTabIds()).includes(tabId)) return;
  if (info.title || info.favIconUrl || info.url) {
    toEngine({ type: ENGINE.META, tabId, meta: { title: tab.title || '', url: tab.url || '', favIconUrl: tab.favIconUrl || '' } }).catch(() => {});
  }
  if (info.status === 'complete') connectAgent(tabId);
});

async function badge(decks) {
  await chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  await chrome.action.setBadgeText({ text: decks.length ? String(decks.length) : '' });
}

// ---------------------------------------------------------------- router
async function handle(msg) {
  switch (msg.type) {
    case HUB.ENSURE_ENGINE: await ensureEngine(); return { ok: true };
    case HUB.LIST_SOURCES: return listSources();
    case HUB.LOAD_TAB: return capture(msg.tabId);
    case HUB.GOTO_TAB: {
      if (!Number.isInteger(msg.tabId)) return { ok: false, error: 'Bad tab id.' };
      const t = await chrome.tabs.update(msg.tabId, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { ok: true };
    }
    case HUB.DOWNLOAD: return download(msg.url, msg.filename);
    case HUB.AGENT_CONNECT: return Number.isInteger(msg.tabId) ? connectAgent(msg.tabId) : { ok: false, error: 'Bad tab id.' };
    case HUB.DECKS_CHANGED: {
      const decks = Array.isArray(msg.decks) ? msg.decks.filter((d) => Number.isInteger(d.tabId) && Number.isInteger(d.slot)) : [];
      await chrome.storage.session.set({ decks });
      await badge(decks);
      return { ok: true };
    }
    default: return { ok: false, error: `Unknown hub message ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== TARGET.HUB) return false;
  if (!fromExtensionPage(sender)) { sendResponse({ ok: false, error: 'forbidden' }); return false; }
  handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
```

- [ ] **Step 3: Write the hub test** — `tests/browser/hub.test.mjs`

```js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prepareExtension, launchExtension, startTrackServer, openExtPage, hubCall, tabIdFor, waitFor } from './ext-harness.mjs';

let h, server, deck, track;
before(async () => {
  server = await startTrackServer();
  h = await launchExtension({ ext: prepareExtension() });
  track = await h.context.newPage();
  await track.goto(server.url('a'));
  deck = await openExtPage(h, 'deck.html');
});
after(async () => { await h?.close(); await server?.close(); });

test('commands and context menu are registered', async () => {
  const cmds = await h.sw.evaluate(() => chrome.commands.getAll());
  assert.ok(cmds.some((c) => c.name === 'add-tab'));
});

test('sources list shows the track tab as not yet granted', async () => {
  const r = await hubCall(deck, { type: 'LIST_SOURCES' });
  assert.equal(r.ok, true);
  const row = r.tabs.find((t) => t.url.startsWith(server.origin));
  assert.ok(row);
  assert.equal(row.granted, false);
  assert.equal(row.deckSlot, null);
  assert.ok(!r.tabs.some((t) => t.url.startsWith('chrome-extension://')));
});

test('LOAD_TAB captures the tab onto deck 1 (allowlisted test build)', async () => {
  const id = await tabIdFor(h, server.origin);
  const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.slot, 1);
  const again = await hubCall(deck, { type: 'LOAD_TAB', tabId: id });
  assert.equal(again.ok, false);
  assert.match(again.error, /already on deck 1/);
  const list = await hubCall(deck, { type: 'LIST_SOURCES' });
  assert.equal(list.tabs.find((t) => t.id === id).deckSlot, 1);
  assert.equal(await h.sw.evaluate(() => chrome.action.getBadgeText({})), '1');
});

test('chrome pages and bad ids are refused politely', async () => {
  const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: 'x' });
  assert.equal(r.ok, false);
});

test('messages from content scripts are refused', async () => {
  const r = await h.sw.evaluate(async (origin) => {
    const [t] = await chrome.tabs.query({ url: `${origin}/*` });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => chrome.runtime.sendMessage({ target: 'hub', type: 'LIST_SOURCES' }) });
    return res.result;
  }, server.origin);
  assert.deepEqual(r, { ok: false, error: 'forbidden' });
});

test('closing the tab ejects its deck', async () => {
  await track.close();
  await waitFor(async () => (await hubCall(deck, { type: 'LIST_SOURCES' })).ok && (await h.sw.evaluate(() => chrome.action.getBadgeText({}))) === '', 8000);
});
```

- [ ] **Step 4: Run, then commit**

Run: `node --test tests/browser/hub.test.mjs` (after Task 14 Step 1 exists).
Expected: PASS (6 tests).

```bash
git add manifest.json background.js tests/browser/hub.test.mjs
git commit -m "Rewrite service worker hub and manifest for the full-page deck

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---

## Task 10: Player-assist agent (content scripts)

**Files:**
- Create: `agent/agent-main.js`, `agent/agent-relay.js`
- Create: `tests/browser/agent.test.mjs`

**Interfaces:**
- Consumes: agent messages from **Shared Contracts**.
- Produces:
  - **MAIN world (`agent-main.js`):**
    - listens for `window` event `jds-agent-cmd` (`detail` = JSON string of
      `{t:'query'|'rate'|'release', rate?}`);
    - emits `jds-agent-status` (`detail` = JSON string of a status or external-rate message);
    - stays passive (emits nothing) until it receives its first command.
  - **ISOLATED world (`agent-relay.js`):**
    - on `chrome.runtime` message `{jds:'connect'}` it opens port `jds-agent` once the page has
      media;
    - it relays commands down and status up, and stops wanting a port after the engine
      disconnects.

- [ ] **Step 1: Write the failing agent tests** — `tests/browser/agent.test.mjs`

```js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';
import { makeTrackWav } from './ext-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = fs.readFileSync(path.join(ROOT, 'agent/agent-main.js'), 'utf8');
const WAV = makeTrackWav({ bpm: 120, seconds: 4, kind: 'low' });
let server, browser, page; const errors = [];

before(async () => {
  server = await startStaticServer(ROOT, {
    '/tone.wav': (req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(WAV); },
    '/__agent.html': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>agent</title><body>'); },
  });
  browser = await launchPlain();
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(AGENT);
  await page.addInitScript(() => {
    window.__status = [];
    window.addEventListener('jds-agent-status', (e) => window.__status.push(JSON.parse(e.detail)));
    window.__cmd = (m) => window.dispatchEvent(new CustomEvent('jds-agent-cmd', { detail: typeof m === 'string' ? m : JSON.stringify(m) }));
  });
  await page.goto(`${server.origin}/__agent.html`);
});
after(async () => { await browser?.close(); await server?.close(); });

const last = () => page.evaluate(() => window.__status[window.__status.length - 1] || null);

test('passive until commanded, then finds a detached Audio()', async () => {
  await page.evaluate(() => { window.a = new Audio('/tone.wav'); window.a.loop = true; return window.a.play(); });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__status.length), 0, 'no traffic before a command');
  await page.evaluate(() => window.__cmd({ t: 'query' }));
  await page.waitForTimeout(100);
  const s = await last();
  assert.equal(s.t, 'status');
  assert.equal(s.hasMedia, true);
  assert.equal(s.count, 1);
  assert.equal(s.playing, true);
});

test('rate command sets rate with resampling and enforces it against the page', async () => {
  await page.evaluate(() => window.__cmd({ t: 'rate', rate: 1.06 }));
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => [a.playbackRate, a.defaultPlaybackRate, a.preservesPitch]), [1.06, 1.06, false]);
  await page.evaluate(() => { a.playbackRate = 1; });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => a.playbackRate), 1.06);
  assert.ok((await page.evaluate(() => window.__status)).some((m) => m.t === 'external-rate' && m.rate === 1));
});

test('release restores the page player', async () => {
  await page.evaluate(() => window.__cmd({ t: 'release' }));
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => [a.playbackRate, a.preservesPitch]), [1, true]);
  await page.evaluate(() => { a.playbackRate = 1.5; });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => a.playbackRate), 1.5, 'no longer enforcing');
  await page.evaluate(() => { a.playbackRate = 1; });
});

test('hostile or malformed commands are ignored', async () => {
  for (const m of ['garbage', '{"t":"rate","rate":100}', '{"t":"rate","rate":"x"}', 'null', '{"t":"rate","rate":0.1}', JSON.stringify({ t: 'rate', rate: NaN })]) {
    await page.evaluate((x) => window.__cmd(x), m);
  }
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => a.playbackRate), 1);
  assert.deepEqual(errors, []);
});

test('late injection finds an element that was already playing', async () => {
  const p2 = await browser.newPage();
  await p2.goto(`${server.origin}/__agent.html`);
  await p2.evaluate(() => { window.b = new Audio('/tone.wav'); window.b.loop = true; return window.b.play(); });
  await p2.addScriptTag({ content: AGENT });
  await p2.addScriptTag({ content: AGENT }); // idempotent
  await p2.evaluate(() => {
    window.__status = [];
    window.addEventListener('jds-agent-status', (e) => window.__status.push(JSON.parse(e.detail)));
    window.dispatchEvent(new CustomEvent('jds-agent-cmd', { detail: JSON.stringify({ t: 'query' }) }));
  });
  await p2.waitForTimeout(100);
  assert.equal((await p2.evaluate(() => window.__status.at(-1))).hasMedia, false, 'detached element unknown before it is touched');
  await p2.evaluate(() => window.b.currentTime);
  await p2.evaluate(() => window.dispatchEvent(new CustomEvent('jds-agent-cmd', { detail: JSON.stringify({ t: 'query' }) })));
  await p2.waitForTimeout(100);
  const s = await p2.evaluate(() => window.__status.at(-1));
  assert.equal(s.hasMedia, true);
  assert.equal(s.count, 1);
  await p2.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/browser/agent.test.mjs`
Expected: FAIL (`agent/agent-main.js` missing).

- [ ] **Step 3: Implement `agent/agent-main.js`**

```js
// agent/agent-main.js — JD Samps player-assist agent (page MAIN world, every frame, document_start).
// Registers media elements the page plays (including detached `new Audio()` objects) and, only
// when a deck asks, sets their playbackRate (with preservesPitch=false) so the engine can refill a
// deck's buffer. Silent until its first command. Talks to agent-relay.js through window
// CustomEvents carrying JSON strings (objects do not cross JS worlds reliably).
(() => {
  const KEY = Symbol.for('jdsamps.agent');
  if (window[KEY]) return;
  Object.defineProperty(window, KEY, { value: true });

  const seen = new WeakSet();
  let refs = [];
  const st = { active: false, enforcing: false, target: 1, selfSet: 0, queued: false };

  const live = () => { refs = refs.filter((r) => { const el = r.deref(); return !!el && (el.isConnected || !!el.currentSrc); }); return refs.map((r) => r.deref()); };
  const emit = (m) => window.dispatchEvent(new CustomEvent('jds-agent-status', { detail: JSON.stringify(m) }));

  function report() {
    if (!st.active || st.queued) return;
    st.queued = true;
    queueMicrotask(() => {
      st.queued = false;
      const els = live();
      let playing = false, rate = 1, pp = true;
      for (const el of els) if (!el.paused) { playing = true; rate = el.playbackRate; pp = el.preservesPitch !== false; }
      emit({ t: 'status', hasMedia: els.length > 0, playing, rate, preservesPitch: pp, count: els.length });
    });
  }

  function apply(el) {
    try {
      if (el.preservesPitch !== false) el.preservesPitch = false;
      el.defaultPlaybackRate = st.target;
      if (Math.abs(el.playbackRate - st.target) > 1e-6) { st.selfSet++; el.playbackRate = st.target; }
    } catch (_) { /* element in a bad state: ignore */ }
  }

  function onRate(e) {
    const el = e.currentTarget;
    if (st.selfSet > 0) { st.selfSet--; report(); return; }
    if (st.enforcing && Math.abs(el.playbackRate - st.target) > 1e-6) {
      if (st.active) emit({ t: 'external-rate', rate: el.playbackRate });
      apply(el);
    }
    report();
  }

  function register(el) {
    if (!(el instanceof HTMLMediaElement) || seen.has(el)) return;
    seen.add(el);
    refs.push(new WeakRef(el));
    el.addEventListener('ratechange', onRate);
    for (const ev of ['play', 'playing', 'pause', 'emptied', 'loadedmetadata']) {
      el.addEventListener(ev, () => { if (st.enforcing && (ev === 'playing' || ev === 'loadedmetadata')) apply(el); report(); });
    }
    if (st.enforcing) apply(el);
    report();
  }

  const scan = () => { try { for (const el of document.querySelectorAll('audio, video')) register(el); } catch (_) {} };

  const proto = HTMLMediaElement.prototype;
  const origPlay = proto.play;
  proto.play = function play(...args) { try { register(this); } catch (_) {} return origPlay.apply(this, args); };
  // Players poll currentTime/paused for their progress bars: that finds elements that were
  // already playing before a late injection.
  for (const prop of ['currentTime', 'paused']) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (d && d.get && d.configurable) {
      Object.defineProperty(proto, prop, {
        ...d,
        get() { if (!seen.has(this)) { try { register(this); } catch (_) {} } return d.get.call(this); },
      });
    }
  }

  window.addEventListener('jds-agent-cmd', (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 200) return;
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'query') {
      st.active = true; scan(); report();
    } else if (m.t === 'rate') {
      if (typeof m.rate !== 'number' || !Number.isFinite(m.rate) || m.rate < 0.5 || m.rate > 2) return;
      st.active = true; st.target = m.rate; st.enforcing = true; scan();
      for (const el of live()) apply(el);
      report();
    } else if (m.t === 'release') {
      st.enforcing = false; st.target = 1;
      for (const el of live()) {
        try {
          el.defaultPlaybackRate = 1;
          if (el.playbackRate !== 1) { st.selfSet++; el.playbackRate = 1; }
          el.preservesPitch = true;
        } catch (_) {}
      }
      report();
    }
  });
})();
```

- [ ] **Step 4: Implement `agent/agent-relay.js`**

```js
// agent/agent-relay.js — JD Samps relay (ISOLATED world, every frame). Connects this frame to the
// offscreen engine (port 'jds-agent') only after the extension asks ({jds:'connect'}) and only if
// the frame has media. Relays engine commands down to agent-main.js and status up.
(() => {
  if (globalThis.__jdsRelay) return;
  globalThis.__jdsRelay = true;
  let port = null, wanted = false, last = null;
  const toMain = (m) => window.dispatchEvent(new CustomEvent('jds-agent-cmd', { detail: JSON.stringify(m) }));

  function connect() {
    if (port) return;
    try { port = chrome.runtime.connect({ name: 'jds-agent' }); } catch (_) { port = null; return; }
    port.onMessage.addListener((m) => {
      if (m && typeof m === 'object' && (m.t === 'rate' || m.t === 'release' || m.t === 'query')) toMain(m);
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = null; wanted = false; });
    if (last) { try { port.postMessage(last); } catch (_) {} }
  }

  window.addEventListener('jds-agent-status', (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 1000) return;
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    last = m;
    if (wanted && m.hasMedia) connect();
    if (port) { try { port.postMessage(m); } catch (_) {} }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.jds !== 'connect') return false;
    wanted = true;
    toMain({ t: 'query' });
    sendResponse({ ok: true });
    return false;
  });
})();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/browser/agent.test.mjs`
Expected: PASS (5 tests). (`makeTrackWav` comes from the Task 14 harness, so write Task 14 Step 1 first if it doesn't exist yet.)

- [ ] **Step 6: Commit**

```bash
git add agent/agent-main.js agent/agent-relay.js tests/browser/agent.test.mjs
git commit -m "Add player-assist agent and relay content scripts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---

## Task 11: Deck UI foundation: page, design system, connection, controls

The full-page UI is a performance surface:
- dark only, which suits dark venues;
- high-contrast, with large tabular numbers and semantic state colours (PLAY green, CUE amber,
  SYNC blue, MASTER orange, REC and KILL red) plus one accent colour per deck;
- no emoji anywhere: inline SVG icons plus text labels.

Layout, top to bottom:
- top bar;
- waveform stack (one row per deck, every playhead on the same vertical line, so phase can be
  checked by eye);
- deck strips beside the master strip;
- crossfader bar.

Sizes are in `rem`, and the root font size scales with viewport height, so the whole board fits
1280×720 through 2560×1440.

**Files:**
- Create: `deck.html`, `deck.css`, `ui/util.js`, `ui/connection.js`, `ui/controls.js`
- Create: `tests/browser/pages/fake-chrome.js`, `tests/browser/ui-harness.mjs`,
  `tests/browser/ui-controls.test.mjs`

**Interfaces:**
- Consumes: `shared/protocol.js` (Task 1).
- Produces:
  - **`ui/util.js`:** `$`, `$$`, `clone(templateId) → Element`, `fmtBpm`, `fmtPct`,
    `fmtClock(sec)`, `fmtDb`, `wallNow()`, `clamp`, `setText(el, text)` (only writes when
    changed), `toggleAttr(el, name, on)`.
  - **`ui/connection.js`:** `class EngineConnection({onState, onWave, onEvent, onStatus})` with
    `.start()`, `.set(deck, key, value)` (coalesced per animation frame), `.act(deck, a, arg) → Promise<{ok, error?}>`,
    `.hub(type, payload) → Promise<response>`, and `.status` ('connecting'|'up'|'down').
  - **`ui/controls.js`:**
    - `Knob(el, {min, max, value, def, bipolar, label, format, onChange})`;
    - `Fader(el, {orientation, min, max, value, def, label, format, onChange})`.
      Both have `.set(v)` (external value; ignored while dragging) and `.value`.
    - `bindPad(el, {onDown, onUp, latch})`. `latch: true` means tap toggles and hold is
      momentary; `false` means momentary only. It returns `{setOn(on)}`.
    - `bindSeg(el, {onSelect})` returns `{set(value)}`.
  - **DOM contract in `deck.html`:** templates `#tpl-deck`, `#tpl-wave-row`, `#tpl-source-row`;
    icon symbols `#i-play`, `#i-pause`, `#i-eject`, `#i-left`, `#i-right`, `#i-gear`, `#i-help`,
    `#i-list`, `#i-x`, `#i-sound`, `#i-dot`.
  - **Test harness:**
    - `tests/browser/ui-harness.mjs` exports `openUi({state, sources, hubReplies}) → {page, sent(), hubCalls(), push(msg), close()}`;
    - `fake-chrome.js` defines `window.chrome` with `runtime.connect` (fake engine port),
      `runtime.sendMessage` (fake hub), `storage.local`, `runtime.getURL`.

- [ ] **Step 1: Write `deck.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>JD Samps — Deck</title>
  <link rel="icon" href="icons/icon48.png" />
  <link rel="stylesheet" href="deck.css" />
</head>
<body>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <symbol id="i-play" viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></symbol>
    <symbol id="i-pause" viewBox="0 0 24 24"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z" fill="currentColor"/></symbol>
    <symbol id="i-eject" viewBox="0 0 24 24"><path d="M12 5l7.5 9h-15zM4.5 16.5h15V19h-15z" fill="currentColor"/></symbol>
    <symbol id="i-left" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="i-right" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="i-gear" viewBox="0 0 24 24"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.4 4.6l1.9 1.5-2 3.4-2.3-.8a7.6 7.6 0 0 1-1.7 1l-.4 2.4h-3.8l-.4-2.4a7.6 7.6 0 0 1-1.7-1l-2.3.8-2-3.4 1.9-1.5a7.7 7.7 0 0 1 0-2.2L1.7 9.4l2-3.4 2.3.8a7.6 7.6 0 0 1 1.7-1l.4-2.4h3.8l.4 2.4a7.6 7.6 0 0 1 1.7 1l2.3-.8 2 3.4-1.9 1.5a7.7 7.7 0 0 1 0 2.2z" fill="currentColor"/></symbol>
    <symbol id="i-help" viewBox="0 0 24 24"><path d="M9.2 9a2.9 2.9 0 1 1 4.3 2.5c-.9.5-1.5 1.1-1.5 2.1v.6M12 17.6v.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></symbol>
    <symbol id="i-list" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></symbol>
    <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></symbol>
    <symbol id="i-sound" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
    <symbol id="i-dot" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor"/></symbol>
  </svg>

  <header class="topbar">
    <div class="brand">
      <img src="icons/icon48.png" alt="" class="logo" width="28" height="28" />
      <div class="brand-text"><h1>JD Samps</h1><span class="tag">made by godspee</span></div>
    </div>
    <button id="sourcesBtn" class="btn" aria-haspopup="dialog" aria-controls="sources"><svg class="ic"><use href="#i-list"/></svg><span>Sources</span></button>
    <div class="clock" aria-label="Master clock">
      <span class="clock-label">MASTER CLOCK</span>
      <span class="clock-bpm mono" id="clockBpm">—</span>
      <span class="clock-mode" id="clockMode">no master</span>
    </div>
    <div class="spacer"></div>
    <button id="mixRecBtn" class="btn rec" aria-pressed="false"><svg class="ic"><use href="#i-dot"/></svg><span>REC MIX</span><span class="mono rec-time" id="mixRecTime"></span></button>
    <button id="settingsBtn" class="btn ghost icon" aria-label="Settings" aria-haspopup="dialog" aria-controls="settings"><svg class="ic"><use href="#i-gear"/></svg></button>
    <button id="helpBtn" class="btn ghost icon" aria-label="Keyboard shortcuts" aria-haspopup="dialog" aria-controls="help"><svg class="ic"><use href="#i-help"/></svg></button>
    <button id="stopAllBtn" class="btn danger">STOP ALL</button>
    <div class="engine" id="engineStatus" data-status="connecting"><span class="led"></span><span id="engineText">Connecting…</span></div>
  </header>

  <div id="banner" class="banner" role="status" hidden>Reconnecting to the audio engine… your decks keep playing.</div>

  <section class="waves" id="waves" aria-label="Waveforms"></section>

  <main class="board">
    <div class="decks" id="decks">
      <div class="empty" id="empty">
        <h2>Load a tab onto a deck</h2>
        <ol>
          <li>Open a track on YouTube, SoundCloud, Bandcamp or Mixcloud.</li>
          <li>Click the <strong>JD Samps</strong> icon on that tab, press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>, or right-click → <em>Add this tab to JD Samps</em>.</li>
          <li>The deck loads <strong>cued</strong> and starts buffering. Press <strong>PLAY</strong> when you're ready.</li>
        </ol>
        <button class="btn" id="emptySourcesBtn"><svg class="ic"><use href="#i-list"/></svg><span>Open sources</span></button>
      </div>
    </div>
    <aside class="master" id="master" aria-label="Master">
      <h2 class="strip-title">MASTER</h2>
      <div class="master-meters">
        <canvas class="vmeter tall" id="masterMeter" aria-label="Master level"></canvas>
        <div class="gr"><span class="label">GR</span><canvas class="vmeter gr-meter" id="grMeter" aria-label="Limiter gain reduction"></canvas><span class="mono" id="grText">0.0</span></div>
      </div>
      <div class="clips"><button class="clip" id="clipL" aria-label="Clear left clip light">L</button><button class="clip" id="clipR" aria-label="Clear right clip light">R</button></div>
      <div class="knob lg" id="masterVol" data-label="VOLUME"></div>
      <button class="btn toggle" id="limiterBtn" aria-pressed="true">LIMITER</button>
    </aside>
  </main>

  <footer class="xfader-bar">
    <span class="xf-side">A</span>
    <div class="hslider xf" id="crossfader"></div>
    <span class="xf-side">B</span>
    <div class="seg small" id="xfCurve" role="group" aria-label="Crossfader curve"><button data-v="SMOOTH">SMOOTH</button><button data-v="SHARP">SHARP</button></div>
  </footer>

  <aside class="drawer" id="sources" role="dialog" aria-modal="false" aria-labelledby="sourcesTitle" hidden>
    <header class="drawer-head"><h2 id="sourcesTitle">Sources</h2><button class="btn ghost icon" data-close aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button></header>
    <p class="hint">Chrome only lets an extension capture a tab after you invoke it there. Use <strong>Go to tab</strong>, then click the JD Samps icon or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>.</p>
    <ul class="source-list" id="sourceList"></ul>
  </aside>

  <aside class="drawer" id="settings" role="dialog" aria-modal="false" aria-labelledby="settingsTitle" hidden>
    <header class="drawer-head"><h2 id="settingsTitle">Settings</h2><button class="btn ghost icon" data-close aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button></header>
    <div class="setting"><span>Recording format</span><div class="seg" data-setting="rec.format"><button data-v="wav">WAV</button><button data-v="webm">WebM</button></div></div>
    <div class="setting"><span>Default pitch range</span><div class="seg" data-setting="pitch.defaultRange"><button data-v="0.06">±6%</button><button data-v="0.1">±10%</button><button data-v="0.16">±16%</button><button data-v="0.5">WIDE</button></div></div>
    <div class="setting"><span>BPM range</span><div class="seg wrap" data-setting="bpm.range"><button data-v="AUTO">AUTO</button><button data-v="55-115">55–115</button><button data-v="68-135">68–135</button><button data-v="78-155">78–155</button><button data-v="88-175">88–175</button><button data-v="98-195">98–195</button></div></div>
    <div class="setting"><span>Deck buffer</span><div class="seg" data-setting="buffer.capSec"><button data-v="120">2 min</button><button data-v="240">4 min</button><button data-v="480">8 min</button></div></div>
    <div class="setting"><span>Player assist</span><div class="seg" data-setting="assist.on"><button data-v="true">ON</button><button data-v="false">OFF</button></div></div>
    <p class="hint">Player assist briefly speeds up a tab's own player to refill a deck's reserve while it plays faster than the original. Sync itself always works on the audio.</p>
  </aside>

  <div class="overlay" id="help" role="dialog" aria-modal="true" aria-labelledby="helpTitle" hidden>
    <div class="overlay-card">
      <header class="drawer-head"><h2 id="helpTitle">Keyboard shortcuts</h2><button class="btn ghost icon" data-close aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button></header>
      <table class="keys">
        <tbody>
          <tr><td><kbd>1</kbd>–<kbd>6</kbd></td><td>Select deck</td><td><kbd>Space</kbd></td><td>Play / pause</td></tr>
          <tr><td><kbd>Shift</kbd>+<kbd>Space</kbd></td><td>Play on next master beat</td><td><kbd>C</kbd></td><td>Cue (hold to preview)</td></tr>
          <tr><td><kbd>S</kbd></td><td>Sync</td><td><kbd>Shift</kbd>+<kbd>S</kbd></td><td>Master</td></tr>
          <tr><td><kbd>K</kbd></td><td>Key lock</td><td><kbd>T</kbd></td><td>Tap tempo</td></tr>
          <tr><td><kbd>Q</kbd> <kbd>A</kbd> <kbd>Z</kbd></td><td>Kill high / mid / low</td><td><kbd>←</kbd> <kbd>→</kbd></td><td>Nudge (hold)</td></tr>
          <tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>Tempo ±0.1%</td><td><kbd>F</kbd></td><td>FX on (hold = momentary)</td></tr>
          <tr><td><kbd>V</kbd> <kbd>B</kbd> <kbd>N</kbd> <kbd>M</kbd></td><td>Roll 1/8, 1/4, 1/2, 1 (hold)</td><td><kbd>[</kbd> <kbd>]</kbd> <kbd>\</kbd></td><td>Crossfader left / right / centre</td></tr>
          <tr><td><kbd>R</kbd></td><td>Record deck</td><td><kbd>Shift</kbd>+<kbd>R</kbd></td><td>Record mix</td></tr>
          <tr><td><kbd>Shift</kbd>+<kbd>T</kbd></td><td>Mark beat 1 (downbeat)</td><td>Shift-click GRID</td><td>Shift the grid by 10 ms</td></tr>
          <tr><td><kbd>?</kbd></td><td>This help</td><td><kbd>Esc</kbd></td><td>Close panels</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="toasts" id="toasts" role="status" aria-live="polite"></div>

  <template id="tpl-wave-row">
    <div class="wave-row">
      <div class="wave-gutter"><span class="slot" data-slot></span><span class="mono wave-bpm" data-wbpm>—</span></div>
      <canvas class="wave" data-wave></canvas>
    </div>
  </template>

  <template id="tpl-source-row">
    <li class="source">
      <img class="fav" data-fav alt="" width="16" height="16" />
      <div class="source-text"><span class="title" data-title></span><span class="host" data-host></span></div>
      <svg class="ic audible" data-audible aria-label="Playing audio" hidden><use href="#i-sound"/></svg>
      <span class="badge" data-ondeck hidden></span>
      <button class="btn sm" data-load hidden>Load</button>
      <button class="btn sm ghost" data-goto hidden>Go to tab</button>
    </li>
  </template>

  <template id="tpl-deck">
    <section class="deck" aria-label="Deck">
      <header class="deck-head">
        <span class="slot" data-slot></span>
        <img class="fav" data-fav alt="" width="16" height="16" />
        <span class="title" data-title></span>
        <button class="btn ghost icon sm" data-act="eject" aria-label="Eject deck"><svg class="ic"><use href="#i-eject"/></svg></button>
      </header>
      <div class="deck-tempo">
        <div class="bpm"><span class="bpm-val mono" data-bpm>—</span><span class="bpm-unit">BPM</span></div>
        <div class="tempo-meta">
          <span class="badge" data-tstate>SEARCH</span>
          <span class="mono pitch" data-pitch>+0.00%</span>
          <span class="mono native" data-native></span>
        </div>
        <div class="leds" data-leds aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      </div>
      <div class="deck-status">
        <div class="reserve" title="Buffered audio ahead of the playhead (lets the deck play faster than the source)">
          <span class="label">RESERVE</span>
          <span class="reserve-bar"><span data-reserve-fill></span></span>
          <span class="mono" data-reserve-text>0.0s</span>
        </div>
        <span class="badge" data-assist hidden>ASSIST</span>
        <span class="badge warn" data-starved hidden>RESERVE EMPTY</span>
        <div class="phase" data-phase hidden title="Phase offset to the master clock"><span data-phase-dot></span></div>
      </div>
      <div class="transport">
        <button class="btn cue big" data-hold="cue">CUE</button>
        <button class="btn play big" data-act="playToggle" aria-label="Play" aria-pressed="false"><svg class="ic" data-play-icon><use href="#i-play"/></svg></button>
        <button class="btn sync big" data-act="sync" aria-pressed="false">SYNC</button>
        <button class="btn master big" data-act="master" aria-pressed="false">MASTER</button>
      </div>
      <div class="tools">
        <button class="btn sm" data-act="syncPlay" title="Start exactly on the next master beat">SYNC PLAY</button>
        <button class="btn sm" data-act="live" title="Jump to the live edge (lowest latency)">LIVE</button>
        <button class="btn sm" data-act="half" title="Halve the detected tempo">½×</button>
        <button class="btn sm" data-act="double" title="Double the detected tempo">2×</button>
        <button class="btn sm" data-act="tap" title="Tap tempo (Shift-click: mark beat 1)">TAP</button>
        <button class="btn sm" data-act="gridBack" title="Shift the beat grid back half a beat (Shift-click: 10 ms)">GRID −½</button>
        <button class="btn sm" data-act="gridFwd" title="Shift the beat grid forward half a beat (Shift-click: 10 ms)">GRID +½</button>
        <button class="btn sm toggle" data-act="keyLock" aria-pressed="true" title="Key lock: keep the original key when the tempo changes">KEY</button>
        <button class="btn sm toggle" data-act="syncMode" title="BEAT: lock tempo and phase. TEMPO: lock tempo only.">BEAT</button>
      </div>
      <div class="tempo-row">
        <button class="btn sm icon" data-hold="nudge-" aria-label="Nudge back (hold)"><svg class="ic"><use href="#i-left"/></svg></button>
        <div class="hslider pitch" data-ctl="pitch"></div>
        <button class="btn sm icon" data-hold="nudge+" aria-label="Nudge forward (hold)"><svg class="ic"><use href="#i-right"/></svg></button>
        <button class="btn sm range" data-act="range" title="Pitch range">±10</button>
      </div>
      <div class="mixer">
        <div class="knobgrid">
          <div class="knob" data-ctl="trim" data-label="GAIN"></div>
          <div class="knob" data-ctl="filter" data-label="FILTER"></div>
          <div class="eqcol"><div class="knob" data-ctl="eq.hi" data-label="HI"></div><button class="kill" data-kill="hi">KILL</button></div>
          <div class="eqcol"><div class="knob" data-ctl="eq.mid" data-label="MID"></div><button class="kill" data-kill="mid">KILL</button></div>
          <div class="eqcol"><div class="knob" data-ctl="eq.low" data-label="LOW"></div><button class="kill" data-kill="low">KILL</button></div>
        </div>
        <div class="channel">
          <canvas class="vmeter" data-meter aria-label="Channel level"></canvas>
          <div class="vfader" data-ctl="fader"></div>
        </div>
      </div>
      <div class="fx">
        <div class="seg fxtype" data-seg="fx.type" role="group" aria-label="Beat FX">
          <button data-v="ECHO">ECHO</button><button data-v="REVERB">VERB</button><button data-v="GATE">GATE</button><button data-v="FLANGER">FLNG</button><button data-v="CRUSH">CRSH</button>
        </div>
        <div class="fx-row">
          <div class="seg beats" data-seg="fx.beats" role="group" aria-label="FX beat length">
            <button data-v="0.0625">1/16</button><button data-v="0.125">1/8</button><button data-v="0.25">1/4</button><button data-v="0.5">1/2</button><button data-v="0.75">3/4</button><button data-v="1">1</button><button data-v="2">2</button><button data-v="4">4</button>
          </div>
        </div>
        <div class="fx-row">
          <div class="knob sm" data-ctl="fx.level" data-label="LEVEL"></div>
          <button class="pad fxon" data-pad="fx.on" aria-pressed="false">FX ON</button>
        </div>
      </div>
      <div class="rolls" role="group" aria-label="Roll (hold)">
        <button class="pad" data-roll="0.125">1/8</button><button class="pad" data-roll="0.25">1/4</button><button class="pad" data-roll="0.5">1/2</button><button class="pad" data-roll="1">1</button>
      </div>
      <footer class="deck-foot">
        <div class="seg xf" data-seg="xf" role="group" aria-label="Crossfader assign"><button data-v="A">A</button><button data-v="THRU">THRU</button><button data-v="B">B</button></div>
        <button class="btn rec" data-act="rec" aria-pressed="false"><svg class="ic"><use href="#i-dot"/></svg><span>REC</span><span class="mono rec-time" data-rec-time></span></button>
      </footer>
    </section>
  </template>

  <script type="module" src="ui/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `deck.css`**

```css
/* deck.css — JD Samps performance deck. Dark only (venues are dark); sizes in rem,
   root size scales with viewport height so the whole board fits common laptop screens. */
:root {
  color-scheme: dark;
  --bg: #07080b;
  --panel: #0e1016;
  --panel-2: #131620;
  --raised: #1a1e2a;
  --line: #232836;
  --line-2: #30364a;
  --txt: #eef1f7;
  --muted: #8f98ad;
  --dim: #5c6479;
  --play: #22c55e;
  --cue: #f59e0b;
  --sync: #3b82f6;
  --master: #fb923c;
  --rec: #ef4444;
  --warn: #fbbf24;
  --deck: #22d3ee;
  --r: 0.45rem;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
html { font-size: clamp(10px, calc(100vh / 68), 15px); }
* { box-sizing: border-box; }
body {
  margin: 0; height: 100vh; overflow: hidden;
  display: grid; grid-template-rows: auto auto auto 1fr auto;
  background: var(--bg); color: var(--txt);
  font: 1rem/1.25 var(--sans);
  -webkit-font-smoothing: antialiased; user-select: none;
}
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
[hidden] { display: none !important; }
h1, h2 { margin: 0; }
kbd { font: 0.8rem var(--mono); padding: 0.05rem 0.35rem; border: 1px solid var(--line-2); border-bottom-width: 2px; border-radius: 0.3rem; background: var(--raised); }

/* ---------- buttons ---------- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem;
  min-height: 2.3rem; padding: 0 0.8rem;
  font: 600 0.85rem/1 var(--sans); letter-spacing: 0.04em; color: var(--txt);
  background: var(--raised); border: 1px solid var(--line-2); border-radius: var(--r);
  cursor: pointer; transition: background 0.08s, border-color 0.08s, box-shadow 0.08s, color 0.08s;
}
.btn:hover { background: #222736; }
.btn:active { transform: translateY(1px); }
.btn:focus-visible, .pad:focus-visible, .kill:focus-visible, .seg button:focus-visible, [role="slider"]:focus-visible {
  outline: 2px solid #fff; outline-offset: 2px;
}
.btn.sm { min-height: 1.9rem; padding: 0 0.55rem; font-size: 0.75rem; }
.btn.big { min-height: 3rem; font-size: 0.95rem; }
.btn.icon { padding: 0; width: 2.3rem; }
.btn.sm.icon { width: 1.9rem; }
.btn.ghost { background: transparent; border-color: transparent; }
.btn.ghost:hover { background: var(--raised); border-color: var(--line-2); }
.btn.danger { color: #fecaca; border-color: #5f1d1d; }
.btn.danger:hover { background: #3b1414; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ic { width: 1.15rem; height: 1.15rem; flex: none; }
.btn.big .ic { width: 1.5rem; height: 1.5rem; }

.btn.play { color: var(--play); }
.btn.play[aria-pressed="true"] { background: var(--play); color: #04130a; border-color: var(--play); box-shadow: 0 0 1rem rgb(34 197 94 / 0.55); }
.btn.cue { color: var(--cue); }
.btn.cue.on { background: var(--cue); color: #1a1004; border-color: var(--cue); box-shadow: 0 0 1rem rgb(245 158 11 / 0.55); }
.btn.sync { color: var(--sync); }
.btn.sync[aria-pressed="true"] { background: var(--sync); color: #fff; border-color: var(--sync); box-shadow: 0 0 1rem rgb(59 130 246 / 0.6); }
.btn.sync.oor { background: transparent; color: var(--warn); border-color: var(--warn); box-shadow: none; }
.btn.master { color: var(--master); }
.btn.master[aria-pressed="true"] { background: var(--master); color: #1f0d02; border-color: var(--master); box-shadow: 0 0 1rem rgb(251 146 60 / 0.55); }
.btn.rec { color: #fca5a5; }
.btn.rec .ic { color: var(--rec); }
.btn.rec[aria-pressed="true"] { background: var(--rec); color: #fff; border-color: var(--rec); animation: recpulse 1s steps(2, start) infinite; }
.btn.rec[aria-pressed="true"] .ic { color: #fff; }
@keyframes recpulse { 50% { box-shadow: 0 0 1.1rem rgb(239 68 68 / 0.75); } }
.btn.toggle[aria-pressed="true"] { color: var(--deck); border-color: var(--deck); background: color-mix(in srgb, var(--deck) 16%, transparent); }

.pad {
  min-height: 2.6rem; border-radius: var(--r); border: 1px solid var(--line-2);
  background: linear-gradient(180deg, #1d2230, #151923); color: var(--muted);
  font: 700 0.8rem var(--sans); letter-spacing: 0.05em; cursor: pointer;
}
.pad.on, .pad[aria-pressed="true"] { color: #031015; background: var(--deck); border-color: var(--deck); box-shadow: 0 0 1rem color-mix(in srgb, var(--deck) 60%, transparent); }
.kill {
  width: 100%; min-height: 1.6rem; margin-top: 0.25rem; border-radius: 0.35rem;
  border: 1px solid var(--line-2); background: var(--panel-2); color: var(--dim);
  font: 700 0.62rem var(--sans); letter-spacing: 0.08em; cursor: pointer;
}
.kill[aria-pressed="true"] { background: var(--rec); border-color: var(--rec); color: #fff; box-shadow: 0 0 0.8rem rgb(239 68 68 / 0.6); }

.seg { display: inline-flex; border: 1px solid var(--line-2); border-radius: var(--r); overflow: hidden; background: var(--panel-2); }
.seg button {
  flex: 1; min-height: 1.85rem; padding: 0 0.45rem; border: 0; border-right: 1px solid var(--line);
  background: transparent; color: var(--muted); font: 700 0.7rem var(--sans); letter-spacing: 0.04em; cursor: pointer;
}
.seg button:last-child { border-right: 0; }
.seg button[aria-pressed="true"] { background: color-mix(in srgb, var(--deck) 22%, transparent); color: var(--deck); }
.seg.wrap { flex-wrap: wrap; }
.seg.small button { min-height: 1.6rem; font-size: 0.65rem; }

.badge {
  display: inline-flex; align-items: center; min-height: 1.3rem; padding: 0 0.4rem; border-radius: 0.3rem;
  font: 700 0.65rem var(--sans); letter-spacing: 0.06em; color: var(--muted); border: 1px solid var(--line-2);
}
.badge.ok { color: var(--play); border-color: color-mix(in srgb, var(--play) 50%, transparent); }
.badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
.badge.info { color: var(--deck); border-color: color-mix(in srgb, var(--deck) 55%, transparent); }

/* ---------- top bar ---------- */
.topbar { display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem 0.8rem; background: var(--panel); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 0.55rem; margin-right: 0.4rem; }
.logo { width: 2rem; height: 2rem; border-radius: 0.4rem; }
.brand-text h1 { font-size: 1.05rem; letter-spacing: 0.02em; }
.tag { font-size: 0.7rem; color: var(--dim); }
.spacer { flex: 1; }
.clock { display: flex; align-items: baseline; gap: 0.55rem; padding: 0.3rem 0.7rem; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel-2); }
.clock-label { font: 700 0.62rem var(--sans); letter-spacing: 0.1em; color: var(--dim); }
.clock-bpm { font-size: 1.35rem; font-weight: 700; color: var(--master); min-width: 4.5ch; text-align: right; }
.clock-mode { font-size: 0.75rem; color: var(--muted); }
.rec-time { min-width: 4.5ch; font-size: 0.8rem; }
.engine { display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; color: var(--muted); }
.engine .led { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--dim); }
.engine[data-status="up"] .led { background: var(--play); box-shadow: 0 0 0.5rem var(--play); }
.engine[data-status="down"] .led { background: var(--rec); box-shadow: 0 0 0.5rem var(--rec); }
.banner { padding: 0.45rem 0.8rem; background: #3a1414; color: #fecaca; font-weight: 600; border-bottom: 1px solid #5f1d1d; }

/* ---------- waveform stack ---------- */
.waves { display: grid; gap: 1px; background: var(--line); border-bottom: 1px solid var(--line); }
.wave-row { display: grid; grid-template-columns: 4.6rem minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: 3.4rem; overflow: hidden; background: var(--bg); }
.wave-row.selected .wave-gutter { box-shadow: inset 3px 0 0 var(--deck); }
.wave-gutter { display: flex; flex-direction: column; justify-content: center; gap: 0.1rem; padding-left: 0.55rem; background: var(--panel); }
.wave-bpm { font-size: 0.85rem; color: var(--muted); }
/* Canvases always sit in boxes of definite size: an auto-sized canvas grows every time it is
   redrawn at its client size (feedback loop). */
.wave { width: 100%; height: 100%; min-width: 0; min-height: 0; display: block; }

/* ---------- board ---------- */
.board { display: grid; grid-template-columns: 1fr auto; min-height: 0; }
.decks { display: flex; gap: 0.5rem; padding: 0.5rem; overflow-x: auto; overflow-y: auto; min-height: 0; }
.empty { margin: auto; max-width: 34rem; padding: 1.6rem 1.8rem; border: 1px dashed var(--line-2); border-radius: 0.8rem; background: var(--panel); }
.empty h2 { font-size: 1.25rem; margin-bottom: 0.6rem; }
.empty ol { margin: 0 0 1rem 1.1rem; padding: 0; color: var(--muted); line-height: 1.6; }
.empty strong { color: var(--txt); }

.deck {
  flex: 0 0 auto; width: 19.5rem; display: flex; flex-direction: column; gap: 0.45rem;
  padding: 0.55rem; background: var(--panel); border: 1px solid var(--line); border-top: 3px solid var(--deck); border-radius: 0.6rem;
}
.deck.selected { border-color: color-mix(in srgb, var(--deck) 55%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--deck) 35%, transparent), 0 0.4rem 1.6rem rgb(0 0 0 / 0.45); }
.deck-head { display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 0.45rem; }
.slot {
  display: inline-grid; place-items: center; width: 1.6rem; height: 1.6rem; border-radius: 0.35rem;
  background: var(--deck); color: #031015; font: 800 0.9rem var(--sans);
}
.fav { width: 1rem; height: 1rem; border-radius: 0.2rem; background: var(--raised); }
.title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 0.85rem; }

.deck-tempo { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.6rem; }
.bpm { display: flex; align-items: baseline; gap: 0.25rem; }
.bpm-val { font-size: 2.3rem; font-weight: 800; letter-spacing: -0.02em; color: var(--txt); min-width: 5.2ch; text-align: right; }
.bpm-unit { font: 700 0.62rem var(--sans); color: var(--dim); letter-spacing: 0.1em; }
.deck[data-tstate="SEARCH"] .bpm-val, .deck[data-tstate="UNSURE"] .bpm-val { color: var(--dim); }
.tempo-meta { display: flex; flex-direction: column; gap: 0.15rem; align-items: flex-start; }
.pitch { font-size: 0.85rem; color: var(--txt); }
.native { font-size: 0.7rem; color: var(--dim); }
.leds { display: grid; grid-template-columns: repeat(2, 0.65rem); gap: 0.25rem; }
.leds i { width: 0.65rem; height: 0.65rem; border-radius: 0.15rem; background: var(--raised); }
.leds i.on { background: var(--deck); box-shadow: 0 0 0.5rem var(--deck); }
.leds i.on.one { background: #fff; box-shadow: 0 0 0.5rem #fff; }

.deck-status { display: flex; align-items: center; gap: 0.4rem; min-height: 1.4rem; flex-wrap: wrap; }
.reserve { display: flex; align-items: center; gap: 0.35rem; font-size: 0.72rem; color: var(--muted); }
.reserve .label { font: 700 0.6rem var(--sans); letter-spacing: 0.08em; color: var(--dim); }
.reserve-bar { position: relative; width: 4.5rem; height: 0.45rem; border-radius: 0.3rem; background: var(--raised); overflow: hidden; }
.reserve-bar span { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--deck); }
.reserve.low .reserve-bar span { background: var(--warn); }
.phase { position: relative; width: 4.5rem; height: 0.9rem; border-radius: 0.3rem; background: var(--raised); }
.phase::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--dim); }
.phase span { position: absolute; top: 0.15rem; width: 0.6rem; height: 0.6rem; margin-left: -0.3rem; border-radius: 50%; background: var(--sync); left: 50%; }
.phase.locked span { background: var(--play); }

.transport { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.35rem; }
.transport .btn { width: 100%; min-width: 0; padding: 0 0.2rem; font-size: 0.8rem; letter-spacing: 0.02em; overflow: hidden; }
.tools { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.tools .btn { flex: 1 1 auto; }
.tempo-row { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 0.35rem; }

.mixer { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; }
.knobgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.35rem 0.2rem; align-items: start; }
.knobgrid > .knob:nth-child(1) { grid-column: 1; }
.knobgrid > .knob:nth-child(2) { grid-column: 2 / span 2; }
.eqcol { display: flex; flex-direction: column; align-items: stretch; }
.channel { display: flex; gap: 0.35rem; align-items: stretch; height: 11.5rem; overflow: hidden; }
.vmeter { width: 0.7rem; height: 100%; min-height: 0; border-radius: 0.2rem; background: #05060a; display: block; }
.vmeter.tall { width: 1.6rem; }

.fx { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.45rem; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel-2); }
.fx .seg { width: 100%; }
.fx-row { display: flex; align-items: center; gap: 0.45rem; }
.fx-row .pad { flex: 1; }
.seg.beats button { padding: 0 0.15rem; font-size: 0.62rem; }
.rolls { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.3rem; }
.deck-foot { display: flex; justify-content: space-between; align-items: center; gap: 0.4rem; }
.deck-foot .seg { flex: 1; }

/* ---------- knobs & faders ---------- */
.knob { display: flex; flex-direction: column; align-items: center; gap: 0.1rem; touch-action: none; }
.knob svg { width: 3.1rem; height: 3.1rem; cursor: ns-resize; }
.knob.sm svg { width: 2.5rem; height: 2.5rem; }
.knob.lg svg { width: 4.4rem; height: 4.4rem; }
.knob .track { fill: none; stroke: var(--raised); stroke-width: 7; stroke-linecap: round; }
.knob .val { fill: none; stroke: var(--deck); stroke-width: 7; stroke-linecap: round; }
.knob .cap { fill: #1f2433; stroke: var(--line-2); stroke-width: 1.5; }
.knob .ptr { stroke: #fff; stroke-width: 3.5; stroke-linecap: round; }
.knob .k-label { font: 700 0.6rem var(--sans); letter-spacing: 0.08em; color: var(--muted); }
.knob .k-value { font: 0.62rem var(--mono); color: var(--dim); min-height: 0.8rem; }
.knob.active .k-value { color: var(--txt); }
.knob.atdef .val { stroke: var(--line-2); }

.hslider, .vfader { position: relative; touch-action: none; cursor: pointer; }
.hslider { height: 2rem; }
.hslider .rail { position: absolute; left: 0.6rem; right: 0.6rem; top: 50%; height: 0.35rem; margin-top: -0.175rem; border-radius: 0.2rem; background: var(--raised); }
.hslider .center { position: absolute; left: 50%; top: 0.25rem; bottom: 0.25rem; width: 2px; margin-left: -1px; background: var(--dim); }
.hslider .thumb { position: absolute; top: 50%; width: 1.1rem; height: 1.7rem; margin: -0.85rem 0 0 -0.55rem; border-radius: 0.25rem; background: linear-gradient(180deg, #e5e8ef, #a9afbd); box-shadow: 0 1px 4px rgb(0 0 0 / 0.6); }
.hslider .thumb::after { content: ""; position: absolute; left: 50%; top: 0.2rem; bottom: 0.2rem; width: 2px; margin-left: -1px; background: #111; }
.hslider .readout { position: absolute; right: 0; bottom: -0.15rem; font: 0.6rem var(--mono); color: var(--dim); }
.hslider.xf { height: 2.8rem; width: min(46rem, 60vw); }
.hslider.xf .thumb { width: 2.2rem; height: 2.4rem; margin: -1.2rem 0 0 -1.1rem; }
.vfader { width: 2.4rem; height: 100%; }
.vfader .rail { position: absolute; top: 0.8rem; bottom: 0.8rem; left: 50%; width: 0.35rem; margin-left: -0.175rem; border-radius: 0.2rem; background: var(--raised); }
.vfader .tick { position: absolute; left: 0.15rem; right: 0.15rem; height: 1px; background: var(--line-2); }
.vfader .thumb { position: absolute; left: 50%; width: 2.1rem; height: 1.2rem; margin: -0.6rem 0 0 -1.05rem; border-radius: 0.25rem; background: linear-gradient(180deg, #e5e8ef, #a9afbd); box-shadow: 0 1px 4px rgb(0 0 0 / 0.6); }
.vfader .thumb::after { content: ""; position: absolute; top: 50%; left: 0.2rem; right: 0.2rem; height: 2px; margin-top: -1px; background: #111; }

/* ---------- master strip ---------- */
.master { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; width: 9.5rem; padding: 0.7rem 0.6rem; background: var(--panel); border-left: 1px solid var(--line); }
.strip-title { font: 800 0.75rem var(--sans); letter-spacing: 0.14em; color: var(--muted); }
.master-meters { display: flex; gap: 0.6rem; align-items: stretch; flex: 1 1 0; min-height: 0; }
.gr { display: flex; flex-direction: column; align-items: center; gap: 0.25rem; font-size: 0.65rem; color: var(--dim); }
.gr-meter { width: 0.6rem; flex: 1 1 0; min-height: 0; }
.clips { display: flex; gap: 0.4rem; }
.clip { width: 2.6rem; min-height: 1.5rem; border-radius: 0.3rem; border: 1px solid var(--line-2); background: var(--panel-2); color: var(--dim); font: 700 0.65rem var(--sans); cursor: pointer; }
.clip.on { background: var(--rec); border-color: var(--rec); color: #fff; box-shadow: 0 0 0.7rem rgb(239 68 68 / 0.7); }
.master .knob .val { stroke: var(--master); }

/* ---------- crossfader ---------- */
.xfader-bar { display: flex; align-items: center; justify-content: center; gap: 0.8rem; padding: 0.45rem 0.8rem; background: var(--panel); border-top: 1px solid var(--line); }
.xf-side { font: 800 1rem var(--sans); color: var(--muted); }

/* ---------- drawers, overlay, toasts ---------- */
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(30rem, 92vw); z-index: 20; display: flex; flex-direction: column; gap: 0.7rem; padding: 0.9rem; background: var(--panel); border-left: 1px solid var(--line-2); box-shadow: -1rem 0 3rem rgb(0 0 0 / 0.55); overflow-y: auto; }
.drawer-head { display: flex; align-items: center; justify-content: space-between; }
.drawer-head h2 { font-size: 1.05rem; }
.hint { margin: 0; color: var(--muted); font-size: 0.8rem; line-height: 1.45; }
.source-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.source { display: grid; grid-template-columns: auto 1fr auto auto auto; align-items: center; gap: 0.5rem; padding: 0.5rem 0.55rem; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel-2); }
.source-text { display: flex; flex-direction: column; min-width: 0; }
.source .host { font-size: 0.7rem; color: var(--dim); }
.source .audible { color: var(--play); }
.setting { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.8rem; color: var(--muted); }
.overlay { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; background: rgb(3 4 6 / 0.72); }
.overlay-card { width: min(46rem, 94vw); padding: 1rem 1.2rem; border-radius: 0.8rem; background: var(--panel); border: 1px solid var(--line-2); }
.keys { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.keys td { padding: 0.4rem 0.4rem; border-bottom: 1px solid var(--line); }
.keys td:nth-child(odd) { white-space: nowrap; color: var(--muted); }
.toasts { position: fixed; right: 1rem; bottom: 4.6rem; z-index: 40; display: flex; flex-direction: column; gap: 0.4rem; max-width: 26rem; }
.toast { padding: 0.6rem 0.8rem; border-radius: var(--r); background: var(--raised); border: 1px solid var(--line-2); border-left: 4px solid var(--sync); font-size: 0.82rem; box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 0.5); }
.toast.warn { border-left-color: var(--warn); }
.toast.error { border-left-color: var(--rec); }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
```

- [ ] **Step 3: Write `ui/util.js`**

```js
// ui/util.js — small DOM/format helpers. Never use innerHTML with page-derived data.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const wallNow = () => performance.timeOrigin + performance.now();

export function clone(templateId) {
  const t = document.getElementById(templateId);
  return t.content.firstElementChild.cloneNode(true);
}

/** Write text only when it changed (avoids layout work at 60 fps). */
export function setText(el, text) {
  const s = String(text);
  if (el.textContent !== s) el.textContent = s;
}

export function toggleAttr(el, name, on) {
  const v = on ? 'true' : 'false';
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

export const fmtBpm = (b) => (b ? b.toFixed(1) : '—');
export const fmtPct = (p) => `${p < 0 ? '−' : '+'}${Math.abs(p * 100).toFixed(2)}%`;
export const fmtDb = (db) => (db === -Infinity || db < -99 ? '−∞' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}`);
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Write `ui/connection.js`**

```js
// ui/connection.js — the UI's link to the offscreen engine (port 'jds-ui') and the service worker hub.
// Reconnects forever with backoff; while disconnected the engine keeps playing.
import { PORT_UI, TARGET, HUB } from '../shared/protocol.js';

export class EngineConnection {
  constructor({ onState, onWave, onEvent, onStatus }) {
    this.cb = { onState, onWave, onEvent, onStatus };
    this.port = null;
    this.status = 'connecting';
    this.nextId = 1;
    this.pending = new Map();
    this.sets = new Map();
    this.raf = 0;
    this.retry = 250;
    this.lastStateAt = 0;
  }

  start() {
    this.hub(HUB.ENSURE_ENGINE).catch(() => {}).finally(() => this.connect());
  }

  connect() {
    let port;
    try { port = chrome.runtime.connect({ name: PORT_UI }); } catch (_) { this.down(); return; }
    this.port = port;
    port.onMessage.addListener((m) => this.onMessage(m));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (this.port === port) { this.port = null; this.down(); }
    });
    this.post({ t: 'hello' });
  }

  down() {
    for (const [, p] of this.pending) p.resolve({ ok: false, error: 'Audio engine is not connected' });
    this.pending.clear();
    this.setStatus('down');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.retry = Math.min(2000, this.retry * 2);
      this.hub(HUB.ENSURE_ENGINE).catch(() => {}).finally(() => this.connect());
    }, this.retry);
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.cb.onStatus && this.cb.onStatus(s);
  }

  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'state') {
      this.retry = 250;
      this.lastStateAt = performance.now();
      this.setStatus('up');
      this.cb.onState(m.s);
    } else if (m.t === 'wave') this.cb.onWave(m);
    else if (m.t === 'event') this.cb.onEvent(m);
    else if (m.t === 'reply') {
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.resolve({ ok: !!m.ok, error: m.error }); }
    }
  }

  post(msg) {
    if (!this.port) return false;
    try { this.port.postMessage(msg); return true; } catch (_) { return false; }
  }

  /** Continuous controls: only the latest value per key is sent, once per animation frame. */
  set(deck, key, value) {
    this.sets.set(`${deck}|${key}`, { t: 'set', deck, key, value });
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      for (const msg of this.sets.values()) this.post(msg);
      this.sets.clear();
    });
  }

  act(deck, a, arg) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      if (!this.post({ t: 'act', deck, a, arg: arg ?? {}, id })) { resolve({ ok: false, error: 'Audio engine is not connected' }); return; }
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'The audio engine did not answer' }); }, 4000);
      this.pending.set(id, { resolve, timer });
    });
  }

  hub(type, payload = {}) {
    return chrome.runtime.sendMessage({ target: TARGET.HUB, type, ...payload });
  }
}
```

- [ ] **Step 5: Write `ui/controls.js`**

```js
// ui/controls.js — knob, fader, pad and segmented controls tuned for live use:
// vertical drag (Shift = fine), wheel, double-click = default, arrow keys when focused.
// External updates are ignored while the user is dragging, so engine echoes never fight the hand.
import { clamp } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const ARC = 270;
const polar = (cx, cy, r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
function arcPath(r, from, to) {
  const [x1, y1] = polar(32, 32, r, from), [x2, y2] = polar(32, 32, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0, sweep = to > from ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

class Continuous {
  constructor(el, o) {
    this.el = el;
    this.o = { min: 0, max: 1, step: 0.01, fine: 0.002, format: (v) => v.toFixed(2), ...o };
    this.value = this.o.value ?? this.o.def ?? this.o.min;
    this.dragging = false;
    el.setAttribute('role', 'slider');
    el.tabIndex = 0;
    el.setAttribute('aria-label', this.o.label || '');
    el.setAttribute('aria-valuemin', String(this.o.min));
    el.setAttribute('aria-valuemax', String(this.o.max));
    el.addEventListener('dblclick', () => this.commit(this.o.def ?? this.o.min));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? this.o.fine : this.o.step);
      this.commit(this.value + d);
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const big = (this.o.max - this.o.min) / 10;
      const d = { ArrowUp: this.o.step, ArrowRight: this.o.step, ArrowDown: -this.o.step, ArrowLeft: -this.o.step, PageUp: big, PageDown: -big }[e.key];
      if (d != null) { e.preventDefault(); e.stopPropagation(); this.commit(this.value + (e.shiftKey ? d / 5 : d)); }
      else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); this.commit(this.o.min); }
      else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); this.commit(this.o.max); }
    });
  }

  commit(v) {
    const nv = clamp(v, this.o.min, this.o.max);
    if (nv === this.value) return;
    this.value = nv;
    this.render();
    this.o.onChange && this.o.onChange(nv);
  }

  set(v) {
    if (this.dragging || typeof v !== 'number' || v === this.value) return;
    this.value = clamp(v, this.o.min, this.o.max);
    this.render();
  }

  aria() {
    this.el.setAttribute('aria-valuenow', this.value.toFixed(3));
    this.el.setAttribute('aria-valuetext', this.o.format(this.value));
  }

  /** Pointer drag along an axis: pixelsForRange = drag distance for the full range. */
  bindDrag(target, axis, pixelsForRange) {
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.el.classList.add('active');
      let last = axis === 'y' ? e.clientY : e.clientX;
      const move = (ev) => {
        const pos = axis === 'y' ? ev.clientY : ev.clientX;
        const px = axis === 'y' ? last - pos : pos - last;
        last = pos;
        const range = this.o.max - this.o.min;
        this.commit(this.value + (px / pixelsForRange) * range * (ev.shiftKey ? 0.15 : 1));
      };
      const up = () => {
        this.dragging = false;
        this.el.classList.remove('active');
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    });
  }
}

export class Knob extends Continuous {
  constructor(el, o) {
    super(el, o);
    el.classList.add('knob');
    const svg = svgEl('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' });
    this.track = svgEl('path', { class: 'track', d: arcPath(26, -ARC / 2, ARC / 2) });
    this.arc = svgEl('path', { class: 'val' });
    const cap = svgEl('circle', { class: 'cap', cx: 32, cy: 32, r: 17 });
    this.ptr = svgEl('line', { class: 'ptr', x1: 32, y1: 32, x2: 32, y2: 17 });
    svg.append(this.track, this.arc, cap, this.ptr);
    const label = document.createElement('span'); label.className = 'k-label'; label.textContent = this.o.label || '';
    this.readout = document.createElement('span'); this.readout.className = 'k-value';
    el.replaceChildren(svg, label, this.readout);
    this.bindDrag(svg, 'y', 180);
    this.render();
  }
  render() {
    const t = (this.value - this.o.min) / (this.o.max - this.o.min);
    const ang = -ARC / 2 + t * ARC;
    const start = this.o.bipolar ? 0 : -ARC / 2;
    this.arc.setAttribute('d', Math.abs(ang - start) < 0.5 ? '' : arcPath(26, Math.min(start, ang), Math.max(start, ang)));
    this.ptr.setAttribute('transform', `rotate(${ang.toFixed(1)} 32 32)`);
    this.readout.textContent = this.o.format(this.value);
    this.el.classList.toggle('atdef', this.value === this.o.def);
    this.aria();
  }
}

export class Fader extends Continuous {
  constructor(el, o) {
    super(el, { orientation: 'vertical', ...o });
    const rail = document.createElement('div'); rail.className = 'rail';
    this.thumb = document.createElement('div'); this.thumb.className = 'thumb';
    const parts = [rail];
    if (this.o.center) { const c = document.createElement('div'); c.className = 'center'; parts.push(c); }
    if (this.o.ticks) {
      for (const t of this.o.ticks) {
        const k = document.createElement('div'); k.className = 'tick';
        k.style.top = `calc(0.8rem + (100% - 1.6rem) * ${1 - t})`;
        parts.push(k);
      }
    }
    parts.push(this.thumb);
    if (this.o.readout) { this.readout = document.createElement('span'); this.readout.className = 'readout'; parts.push(this.readout); }
    el.replaceChildren(...parts);
    el.setAttribute('aria-orientation', this.o.orientation);
    const vertical = this.o.orientation === 'vertical';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      this.dragging = true;
      el.classList.add('active');
      const span = Math.max(40, (vertical ? el.clientHeight : el.clientWidth) - 24);
      let last = vertical ? e.clientY : e.clientX;
      const move = (ev) => {
        const pos = vertical ? ev.clientY : ev.clientX;
        const px = vertical ? last - pos : pos - last;
        last = pos;
        this.commit(this.value + (px / span) * (this.o.max - this.o.min) * (ev.shiftKey ? 0.15 : 1));
      };
      const up = () => {
        this.dragging = false;
        el.classList.remove('active');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    this.render();
  }
  render() {
    const t = (this.value - this.o.min) / (this.o.max - this.o.min);
    if (this.o.orientation === 'vertical') this.thumb.style.top = `calc(0.8rem + (100% - 1.6rem) * ${(1 - t).toFixed(4)})`;
    else this.thumb.style.left = `calc(0.6rem + (100% - 1.2rem) * ${t.toFixed(4)})`;
    if (this.readout) this.readout.textContent = this.o.format(this.value);
    this.aria();
  }
}

/**
 * Pad / hold button. latch=true: a tap (<250 ms) toggles, a hold is momentary.
 * latch=false: momentary only (down → on, up → off). Keyboard Space/Enter act like the pointer.
 */
export function bindPad(el, { onDown, onUp, latch = false }) {
  let on = false, downAt = 0, wasOn = false, active = false;
  const press = () => {
    if (active) return;
    active = true;
    downAt = performance.now();
    wasOn = on;
    if (!latch || !on) { on = true; onDown && onDown(); }
    paint();
  };
  const release = () => {
    if (!active) return;
    active = false;
    const held = performance.now() - downAt >= 250;
    if (!latch || held || wasOn) { on = false; onUp && onUp(); }
    paint();
  };
  const paint = () => { el.classList.toggle('on', on); el.setAttribute('aria-pressed', on ? 'true' : 'false'); };
  el.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); el.setPointerCapture(e.pointerId); press(); });
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); press(); } });
  el.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); release(); } });
  return {
    press,
    release,
    setOn(v) { if (active) return; on = !!v; paint(); },
  };
}

export function bindSeg(el, { onSelect }) {
  const buttons = Array.from(el.querySelectorAll('button[data-v]'));
  const parse = (s) => (s === 'true' ? true : s === 'false' ? false : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s);
  for (const b of buttons) b.addEventListener('click', () => onSelect(parse(b.dataset.v)));
  return {
    set(value) {
      for (const b of buttons) {
        const v = parse(b.dataset.v) === value ? 'true' : 'false';
        if (b.getAttribute('aria-pressed') !== v) b.setAttribute('aria-pressed', v);
      }
    },
  };
}
```

- [ ] **Step 6: Write the fake Chrome API and UI harness**

Injected with `page.addInitScript` before any page script.

`tests/browser/pages/fake-chrome.js`:

```js
// Fake chrome.* for UI tests: a scriptable engine port + hub. Tests drive it via window.__fake.
(() => {
  const listeners = { msg: [], disc: [] };
  const fake = {
    sent: [],
    hubCalls: [],
    hubReplies: {},
    storage: {},
    connected: false,
    state: null,
    push(msg) { for (const fn of listeners.msg) fn(msg); },
    disconnect() { fake.connected = false; for (const fn of listeners.disc) fn(); },
    reply(id, ok = true, error) { fake.push({ t: 'reply', id, ok, error }); },
    autoReply: true,
  };
  window.__fake = fake;
  const port = {
    name: 'jds-ui',
    postMessage(m) {
      const copy = JSON.parse(JSON.stringify(m));
      fake.sent.push(copy);
      if (m.t === 'hello' && fake.state) setTimeout(() => fake.push({ t: 'state', s: fake.state }), 0);
      if (m.id && fake.autoReply) setTimeout(() => fake.reply(m.id, true), 0);
    },
    onMessage: { addListener(fn) { listeners.msg.push(fn); } },
    onDisconnect: { addListener(fn) { listeners.disc.push(fn); } },
    disconnect() {},
  };
  window.chrome = {
    runtime: {
      lastError: undefined,
      connect() { fake.connected = true; return port; },
      sendMessage(msg) {
        fake.hubCalls.push(JSON.parse(JSON.stringify(msg)));
        const r = fake.hubReplies[msg.type];
        return Promise.resolve(typeof r === 'function' ? r(msg) : r ?? { ok: true });
      },
      getURL: (p) => `/${p}`,
    },
    storage: {
      local: {
        get(keys) { const out = {}; for (const k of [].concat(keys ?? Object.keys(fake.storage))) if (k in fake.storage) out[k] = fake.storage[k]; return Promise.resolve(out); },
        set(obj) { Object.assign(fake.storage, obj); return Promise.resolve(); },
      },
    },
  };
})();
```

`tests/browser/ui-harness.mjs`:

```js
// Opens deck.html from a static server with a fake engine/hub, for UI tests and screenshots.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE = fs.readFileSync(path.join(ROOT, 'tests/browser/pages/fake-chrome.js'), 'utf8');

export async function openUi({ state = null, hubReplies = {}, viewport = { width: 1440, height: 900 }, storage = {} } = {}) {
  const server = await startStaticServer(ROOT);
  const browser = await launchPlain();
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(FAKE);
  await page.addInitScript(([s, h, st]) => { window.__fake.state = s; Object.assign(window.__fake.hubReplies, h); Object.assign(window.__fake.storage, st); }, [state, hubReplies, storage]);
  await page.goto(`${server.origin}/deck.html`);
  return {
    page,
    errors,
    sent: () => page.evaluate(() => window.__fake.sent),
    hubCalls: () => page.evaluate(() => window.__fake.hubCalls),
    push: (msg) => page.evaluate((m) => window.__fake.push(m), msg),
    clearSent: () => page.evaluate(() => { window.__fake.sent.length = 0; }),
    async close() { await browser.close(); await server.close(); },
  };
}
```

- [ ] **Step 7: Write the failing control tests** — `tests/browser/ui-controls.test.mjs`

These tests load `ui/controls.js` on a blank page served by the static server. They don't need
`app.js`.

```js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let server, browser, page;

before(async () => {
  server = await startStaticServer(ROOT, {
    '/__controls.html': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><link rel="stylesheet" href="/deck.css"><body style="padding:40px">
        <div id="k" class="knob"></div><div id="f" class="vfader" style="height:200px"></div><button id="p" class="pad">P</button>
        <div id="s" class="seg"><button data-v="A">A</button><button data-v="THRU">THRU</button><button data-v="0.5">x</button></div>
        <script type="module">
          import { Knob, Fader, bindPad, bindSeg } from '/ui/controls.js';
          window.log = [];
          window.knob = new Knob(document.getElementById('k'), { label: 'HI', def: 0.5, value: 0.5, onChange: (v) => log.push(['k', v]) });
          window.fader = new Fader(document.getElementById('f'), { label: 'FADER', def: 1, value: 1, onChange: (v) => log.push(['f', v]) });
          window.pad = bindPad(document.getElementById('p'), { latch: true, onDown: () => log.push(['down']), onUp: () => log.push(['up']) });
          window.seg = bindSeg(document.getElementById('s'), { onSelect: (v) => log.push(['seg', v]) });
          window.ready = true;
        </script>`);
    },
  });
  browser = await launchPlain();
  page = await browser.newPage();
  await page.goto(`${server.origin}/__controls.html`);
  await page.waitForFunction(() => window.ready);
});
after(async () => { await browser?.close(); await server?.close(); });

const log = () => page.evaluate(() => window.log.splice(0));

test('knob drags up, double-click resets, keys step, aria reflects value', async () => {
  const box = await page.locator('#k svg').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 90, { steps: 6 });
  await page.mouse.up();
  const v = await page.evaluate(() => window.knob.value);
  assert.ok(Math.abs(v - 1) < 0.02, `dragged to ${v}`);
  await page.locator('#k svg').dblclick();
  assert.equal(await page.evaluate(() => window.knob.value), 0.5);
  await page.locator('#k').focus();
  await page.keyboard.press('ArrowUp');
  assert.ok(Math.abs((await page.evaluate(() => window.knob.value)) - 0.51) < 1e-9);
  assert.equal(await page.getAttribute('#k', 'role'), 'slider');
  assert.equal(await page.getAttribute('#k', 'aria-valuenow'), '0.510');
  const l = await log();
  assert.ok(l.length >= 3 && l.every((x) => x[0] === 'k'));
});

test('external set is ignored while dragging', async () => {
  const box = await page.locator('#f').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 80, { steps: 4 });
  await page.evaluate(() => window.fader.set(1));
  const during = await page.evaluate(() => window.fader.value);
  await page.mouse.up();
  assert.ok(during < 0.9, `value during drag ${during}`);
  await page.evaluate(() => window.fader.set(0.25));
  assert.equal(await page.evaluate(() => window.fader.value), 0.25);
});

test('pad: tap latches, second tap releases, hold is momentary', async () => {
  await log();
  await page.locator('#p').click();
  assert.deepEqual(await log(), [['down']]);
  assert.equal(await page.getAttribute('#p', 'aria-pressed'), 'true');
  await page.locator('#p').click();
  assert.deepEqual(await log(), [['up']]);
  const box = await page.locator('#p').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(320);
  await page.mouse.up();
  assert.deepEqual(await log(), [['down'], ['up']]);
  assert.equal(await page.getAttribute('#p', 'aria-pressed'), 'false');
});

test('segmented control parses values and reflects selection', async () => {
  await log();
  await page.locator('#s button[data-v="0.5"]').click();
  assert.deepEqual(await log(), [['seg', 0.5]]);
  await page.evaluate(() => window.seg.set('THRU'));
  assert.equal(await page.getAttribute('#s button[data-v="THRU"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('#s button[data-v="A"]', 'aria-pressed'), 'false');
});
```

- [ ] **Step 8: Run the tests to verify they fail, then pass**

Run: `node --test tests/browser/ui-controls.test.mjs`. It fails before Steps 1–5 exist and
passes after.
Expected after implementation: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add deck.html deck.css ui/util.js ui/connection.js ui/controls.js tests/browser/pages/fake-chrome.js tests/browser/ui-harness.mjs tests/browser/ui-controls.test.mjs
git commit -m "Add deck page, design system, engine connection and performance controls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---
## Task 12: Waveforms, meters and the deck strip

**Files:**
- Create: `ui/waveform.js`, `ui/meters.js`, `ui/deck-strip.js`
- Create: `tests/browser/fixtures/mock-state.mjs`
- (Tests for the strip run through the app in Task 13, `tests/browser/ui-app.test.mjs`.)

**Interfaces:**
- Consumes:
  - `clone`, `setText`, `toggleAttr`, `fmtBpm`, `fmtPct`, `fmtClock`, `wallNow` (Task 11);
  - `Knob`, `Fader`, `bindPad`, `bindSeg` (Task 11);
  - `EngineConnection` (Task 11);
  - `DECK_COLORS`, `PITCH_RANGES` (Task 1).
- Produces:
  - **`ui/waveform.js`:** `class WaveStore` with `.add({tStart, hop, data})` and
    `.at(tIn, span) → [low, mid, high]|null`;
    `drawWave(ctx2d, opts)` and `beatIndex(grid, playhead)`.
  - **`ui/meters.js`:** `class VMeter(canvas, {channels:1|2, mode:'level'|'gr'})` with
    `.update(values)` and `.draw()`. Levels are linear peak/RMS; `gr` is dB ≤ 0.
  - **`ui/deck-strip.js`:**
    - `class DeckStrip(deckState, {conn, toast, onSelect})`;
    - fields `.el` and `.waveRow`;
    - methods `.update(deckState, snapshot)`, `.frame(nowCtx, snapshot)`, `.addWave(msg)`,
      `.setSelected(on)`, `.destroy()`;
    - keyboard helpers `.toggle(name)`, `.hold(name, down, arg)`, `.nudgePitch(delta)`.
  - **`tests/browser/fixtures/mock-state.mjs`:** `makeState({decks}) → Snapshot`;
    `makeWave(deckId, seconds) → wave message`.

- [ ] **Step 1: Write `ui/waveform.js`**

```js
// ui/waveform.js — waveform memory and the scrolling renderer.
// Data arrives as 3 bytes (low, mid, high) per ODF hop on the deck's input timeline.
// The view is centred on the playhead and scaled in *beats* (when a grid exists), so synced
// decks show identical grid spacing and their beats line up vertically across rows.

export class WaveStore {
  constructor() { this.hop = 0; this.t0 = 0; this.data = new Uint8Array(0); this.n = 0; }

  add({ tStart, hop, data }) {
    if (!(hop > 0) || !data || !data.length) return;
    if (!this.hop) { this.hop = hop; this.t0 = tStart; }
    const i0 = Math.round((tStart - this.t0) / this.hop);
    if (i0 < 0) return;
    const count = Math.floor(data.length / 3);
    const need = (i0 + count) * 3;
    if (need > this.data.length) {
      let cap = Math.max(4096, this.data.length);
      while (cap < need) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.data);
      this.data = next;
    }
    this.data.set(data.subarray ? data.subarray(0, count * 3) : data.slice(0, count * 3), i0 * 3);
    this.n = Math.max(this.n, i0 + count);
  }

  /** Max of each band over [tIn, tIn+span). */
  at(tIn, span, out) {
    if (!this.hop) return null;
    let a = Math.floor((tIn - this.t0) / this.hop);
    let b = Math.max(a + 1, Math.ceil((tIn + span - this.t0) / this.hop));
    if (b <= 0 || a >= this.n) return null;
    a = Math.max(0, a); b = Math.min(this.n, b);
    let l = 0, m = 0, h = 0;
    for (let i = a; i < b; i++) {
      const j = i * 3;
      if (this.data[j] > l) l = this.data[j];
      if (this.data[j + 1] > m) m = this.data[j + 1];
      if (this.data[j + 2] > h) h = this.data[j + 2];
    }
    out[0] = l; out[1] = m; out[2] = h;
    return out;
  }
}

export function beatIndex(grid, playhead) {
  return grid ? Math.floor((playhead - grid.t0) / grid.T + 1e-9) : 0;
}

const tmp = [0, 0, 0];
const lvl = (b) => Math.max(0, (b - 40) / 215);

/**
 * opts: {w, h (device px), store, playhead, grid, cue, liveEdge, historyStart, loop, color,
 *        pxPerBeat, pxPerSec, playing}
 */
export function drawWave(g, o) {
  const { w, h } = o;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#05060a';
  g.fillRect(0, 0, w, h);
  const cx = Math.round(w / 2), mid = h / 2;
  const secPerPx = o.grid ? o.grid.T / o.pxPerBeat : 1 / o.pxPerSec;
  const tAt = (x) => o.playhead + (x - cx) * secPerPx;
  const xAt = (t) => cx + (t - o.playhead) / secPerPx;

  // Loop region.
  if (o.loop) {
    g.fillStyle = 'rgba(255,255,255,0.08)';
    const x0 = xAt(o.loop.start), x1 = xAt(o.loop.end);
    g.fillRect(x0, 0, x1 - x0, h);
  }

  // Waveform columns: low (deck colour), mid (lighter), high (white core).
  const midCol = mixWhite(o.color, 0.45);
  for (let x = 0; x < w; x++) {
    const t = tAt(x);
    if (t < o.historyStart || t > o.liveEdge) continue;
    if (!o.store.at(t, secPerPx, tmp)) continue;
    const past = x < cx;
    g.globalAlpha = past ? 0.5 : 1;
    const hl = lvl(tmp[0]) * mid, hm = lvl(tmp[1]) * mid * 0.8, hh = lvl(tmp[2]) * mid * 0.6;
    g.fillStyle = o.color; g.fillRect(x, mid - hl, 1, hl * 2);
    g.fillStyle = midCol; g.fillRect(x, mid - hm, 1, hm * 2);
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(x, mid - hh, 1, hh * 2);
  }
  g.globalAlpha = 1;

  // Region beyond the live edge: no audio yet.
  const xl = xAt(o.liveEdge);
  if (xl < w) {
    g.fillStyle = 'rgba(20,23,32,0.9)';
    g.fillRect(Math.max(0, xl), 0, w - Math.max(0, xl), h);
    g.strokeStyle = 'rgba(251,191,36,0.85)';
    g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(xl + 0.5, 0); g.lineTo(xl + 0.5, h); g.stroke();
    g.setLineDash([]);
  }

  // Beat grid.
  if (o.grid) {
    const { t0, T } = o.grid;
    const k0 = Math.ceil((tAt(0) - t0) / T), k1 = Math.floor((tAt(w) - t0) / T);
    const barRef = o.grid.bar1 != null ? Math.round((o.grid.bar1 - t0) / T) : null;
    for (let k = k0; k <= k1; k++) {
      const x = Math.round(xAt(t0 + k * T)) + 0.5;
      const bar = barRef != null && (((k - barRef) % 4) + 4) % 4 === 0;
      g.fillStyle = bar ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.22)';
      g.fillRect(x - (bar ? 1 : 0.5), 0, bar ? 2 : 1, h);
    }
  }

  // Cue marker.
  const xc = xAt(o.cue);
  if (xc >= -8 && xc <= w + 8) {
    g.fillStyle = '#f59e0b';
    g.beginPath(); g.moveTo(xc - 6, 0); g.lineTo(xc + 6, 0); g.lineTo(xc, 9); g.fill();
    g.beginPath(); g.moveTo(xc - 6, h); g.lineTo(xc + 6, h); g.lineTo(xc, h - 9); g.fill();
  }

  // Playhead.
  g.fillStyle = o.playing ? '#ffffff' : '#f59e0b';
  g.fillRect(cx - 1, 0, 2, h);
}

function mixWhite(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  const m = (c) => Math.round(c + (255 - c) * t);
  return `rgb(${m(r)},${m(gg)},${m(b)})`;
}
```

- [ ] **Step 2: Write `ui/meters.js`**

```js
// ui/meters.js — vertical level / gain-reduction meters with peak hold, drawn on canvas.
const FLOOR_DB = -48;
const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const frac = (db) => Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));

export class VMeter {
  constructor(canvas, { channels = 1, mode = 'level' } = {}) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.channels = channels;
    this.mode = mode;
    this.vals = Array.from({ length: channels }, () => ({ peak: 0, rms: 0, hold: 0, holdAt: 0, clip: false }));
    this.gr = 0;
  }

  update(values) {
    const now = performance.now();
    if (this.mode === 'gr') { this.gr = Math.min(0, values.gr || 0); return; }
    values.forEach((v, i) => {
      const s = this.vals[i];
      s.peak = v.peak; s.rms = v.rms; s.clip = !!v.clip;
      if (v.peak >= s.hold || now - s.holdAt > 1200) { s.hold = v.peak; s.holdAt = now; }
    });
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(this.c.clientWidth * dpr)), H = Math.max(1, Math.round(this.c.clientHeight * dpr));
    if (this.c.width !== W || this.c.height !== H) { this.c.width = W; this.c.height = H; }
    const g = this.g;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#05060a';
    g.fillRect(0, 0, W, H);
    if (this.mode === 'gr') {
      const f = Math.min(1, -this.gr / 20);
      g.fillStyle = '#fb923c';
      g.fillRect(0, 0, W, Math.round(f * H));
      return;
    }
    const gap = Math.max(1, Math.round(dpr)), cw = (W - gap * (this.channels - 1)) / this.channels;
    const grad = g.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, '#22c55e'); grad.addColorStop(0.7, '#a3e635'); grad.addColorStop(0.86, '#fbbf24'); grad.addColorStop(1, '#ef4444');
    this.vals.forEach((s, i) => {
      const x = i * (cw + gap);
      const rh = frac(toDb(s.rms)) * H, ph = frac(toDb(s.peak)) * H, hh = frac(toDb(s.hold)) * H;
      g.globalAlpha = 0.35; g.fillStyle = grad; g.fillRect(x, H - ph, cw, ph);
      g.globalAlpha = 1; g.fillRect(x, H - rh, cw, rh);
      g.fillStyle = s.hold >= 0.999 || s.clip ? '#ef4444' : '#e5e7eb';
      g.fillRect(x, Math.max(0, H - hh - 2 * dpr), cw, 2 * dpr);
    });
    // -6, -12, -24 dB ticks.
    g.fillStyle = 'rgba(0,0,0,0.6)';
    for (const db of [-6, -12, -24]) g.fillRect(0, Math.round(H - frac(db) * H), W, Math.max(1, dpr));
  }
}
```

- [ ] **Step 3: Write `ui/deck-strip.js`**

```js
// ui/deck-strip.js — one deck: its column in the board and its row in the waveform stack.
// All page-derived text goes through textContent; favicons are only set after isSafeIconUrl().
import { DECK_COLORS, PITCH_RANGES, isSafeIconUrl } from '../shared/protocol.js';
import { $, $$, clone, setText, toggleAttr, fmtBpm, fmtPct, fmtClock, wallNow } from './util.js';
import { Knob, Fader, bindPad, bindSeg } from './controls.js';
import { WaveStore, drawWave, beatIndex } from './waveform.js';
import { VMeter } from './meters.js';

const RANGE_LABEL = { 0.06: '±6', 0.1: '±10', 0.16: '±16', 0.5: 'WIDE' };
const STATE_CLASS = { LOCKED: 'ok', SEARCH: '', UNSURE: 'warn', HOLD: 'info' };

export class DeckStrip {
  constructor(d, { conn, toast, onSelect }) {
    this.id = d.id;
    this.conn = conn;
    this.toast = toast;
    this.d = d;
    this.shownBpm = null;
    this.store = new WaveStore();
    this.el = clone('tpl-deck');
    this.waveRow = clone('tpl-wave-row');
    const color = DECK_COLORS[(d.slot - 1) % DECK_COLORS.length];
    for (const n of [this.el, this.waveRow]) n.style.setProperty('--deck', color);
    this.color = color;
    this.el.addEventListener('pointerdown', () => onSelect(this.id), true);
    this.waveRow.addEventListener('pointerdown', () => onSelect(this.id));
    this.q = (sel) => $(sel, this.el);
    this.refs = {
      slot: this.q('[data-slot]'), fav: this.q('[data-fav]'), title: this.q('[data-title]'),
      bpm: this.q('[data-bpm]'), tstate: this.q('[data-tstate]'), pitch: this.q('[data-pitch]'), native: this.q('[data-native]'),
      leds: $$('[data-leds] i', this.el), reserveFill: this.q('[data-reserve-fill]'), reserveText: this.q('[data-reserve-text]'),
      reserve: this.q('.reserve'), assist: this.q('[data-assist]'), starved: this.q('[data-starved]'),
      phase: this.q('[data-phase]'), phaseDot: this.q('[data-phase-dot]'),
      play: this.q('[data-act="playToggle"]'), playIcon: this.q('[data-play-icon] use'),
      cue: this.q('[data-hold="cue"]'), sync: this.q('[data-act="sync"]'), master: this.q('[data-act="master"]'),
      keyLock: this.q('[data-act="keyLock"]'), syncMode: this.q('[data-act="syncMode"]'), range: this.q('[data-act="range"]'),
      rec: this.q('[data-act="rec"]'), recTime: this.q('[data-rec-time]'),
      wslot: $('[data-slot]', this.waveRow), wbpm: $('[data-wbpm]', this.waveRow), wave: $('[data-wave]', this.waveRow),
    };
    setText(this.refs.slot, d.slot);
    setText(this.refs.wslot, d.slot);
    this.waveCtx = this.refs.wave.getContext('2d');
    this.meter = new VMeter(this.q('[data-meter]'));
    this.buildControls(d);
    this.update(d, null);
  }

  set(key, value) { this.conn.set(this.id, key, value); }
  async act(a, arg) {
    const r = await this.conn.act(this.id, a, arg);
    if (!r.ok && r.error) this.toast(r.error, 'warn');
    return r;
  }

  buildControls(d) {
    const p = d.params;
    const knob = (key, o) => new Knob(this.q(`[data-ctl="${key}"]`), { label: this.q(`[data-ctl="${key}"]`).dataset.label, def: 0.5, value: p[key], onChange: (v) => this.set(key, v), ...o });
    const db = (v, max) => { if (v <= 0) return '−∞'; const g = v >= 0.5 ? (max * (v - 0.5)) / 0.5 : 20 * Math.log10((2 * v) ** 3); return `${g >= 0 ? '+' : '−'}${Math.abs(g).toFixed(1)}`; };
    this.knobs = {
      trim: knob('trim', { format: (v) => db(v, 12) }),
      'eq.hi': knob('eq.hi', { format: (v) => db(v, 6) }),
      'eq.mid': knob('eq.mid', { format: (v) => db(v, 6) }),
      'eq.low': knob('eq.low', { format: (v) => db(v, 6) }),
      filter: knob('filter', { min: -1, max: 1, def: 0, bipolar: true, format: (v) => (Math.abs(v) < 0.04 ? 'OFF' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`) }),
      'fx.level': knob('fx.level', { def: 0.5, format: (v) => `${Math.round(v * 100)}%` }),
    };
    this.fader = new Fader(this.q('[data-ctl="fader"]'), { label: 'Channel fader', def: 1, value: p.fader, ticks: [0, 0.25, 0.5, 0.75, 1], onChange: (v) => this.set('fader', v), format: (v) => `${Math.round(v * 100)}%` });
    this.pitch = new Fader(this.q('[data-ctl="pitch"]'), {
      orientation: 'horizontal', label: 'Tempo', min: -1, max: 1, def: 0, value: p.range ? p.pitch / p.range : 0, center: true, readout: true,
      step: 0.005, fine: 0.0005,
      format: (v) => fmtPct(v * this.d.params.range),
      onChange: (v) => this.set('pitch', v * this.d.params.range),
    });
    for (const band of ['hi', 'mid', 'low']) {
      const el = this.q(`[data-kill="${band}"]`);
      const pad = bindPad(el, { latch: true, onDown: () => this.set(`kill.${band}`, true), onUp: () => this.set(`kill.${band}`, false) });
      this[`kill_${band}`] = pad;
    }
    this.fxOn = bindPad(this.q('[data-pad="fx.on"]'), { latch: true, onDown: () => this.set('fx.on', true), onUp: () => this.set('fx.on', false) });
    this.segs = {
      'fx.type': bindSeg(this.q('[data-seg="fx.type"]'), { onSelect: (v) => this.set('fx.type', v) }),
      'fx.beats': bindSeg(this.q('[data-seg="fx.beats"]'), { onSelect: (v) => this.set('fx.beats', v) }),
      xf: bindSeg(this.q('[data-seg="xf"]'), { onSelect: (v) => this.set('xf', v) }),
    };
    this.rolls = $$('[data-roll]', this.el).map((el) => bindPad(el, {
      latch: false,
      onDown: () => this.act('rollStart', { beats: Number(el.dataset.roll) }),
      onUp: () => this.act('rollEnd'),
    }));
    this.cue = bindPad(this.refs.cue, { latch: false, onDown: () => this.act('cueDown'), onUp: () => this.act('cueUp') });
    for (const [sel, dir] of [['[data-hold="nudge-"]', -1], ['[data-hold="nudge+"]', 1]]) {
      bindPad(this.q(sel), { latch: false, onDown: () => this.act('nudge', { dir, fine: false }), onUp: () => this.act('nudge', { dir: 0 }) });
    }
    const on = (sel, fn) => this.q(sel).addEventListener('click', fn);
    on('[data-act="playToggle"]', () => this.act(this.d.playing ? 'pause' : 'play'));
    on('[data-act="sync"]', () => this.act('sync', { on: !this.d.sync.on }));
    on('[data-act="master"]', () => this.act('master'));
    on('[data-act="syncPlay"]', () => this.act('syncPlay'));
    on('[data-act="live"]', () => this.act('live'));
    on('[data-act="half"]', () => this.act('mult', { factor: 0.5 }));
    on('[data-act="double"]', () => this.act('mult', { factor: 2 }));
    on('[data-act="tap"]', (e) => (e.shiftKey ? this.act('tap1') : this.act('tap', { wallMs: wallNow() })));
    on('[data-act="gridBack"]', (e) => this.act('gridShift', e.shiftKey ? { ms: -10 } : { beats: -0.5 }));
    on('[data-act="gridFwd"]', (e) => this.act('gridShift', e.shiftKey ? { ms: 10 } : { beats: 0.5 }));
    on('[data-act="keyLock"]', () => this.set('keyLock', !this.d.params.keyLock));
    on('[data-act="syncMode"]', () => this.set('syncMode', this.d.params.syncMode === 'BEAT' ? 'TEMPO' : 'BEAT'));
    on('[data-act="range"]', () => {
      const i = PITCH_RANGES.indexOf(this.d.params.range);
      this.set('range', PITCH_RANGES[(i + 1) % PITCH_RANGES.length]);
    });
    on('[data-act="rec"]', () => this.act(this.d.rec.state === 'recording' ? 'recStop' : 'recStart'));
    // Eject needs a 500 ms hold: a stray click must never kill a playing deck.
    const ej = this.q('[data-act="eject"]');
    let ejTimer = 0;
    ej.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      ejTimer = setTimeout(() => { ejTimer = 0; this.act('eject'); }, 500);
    });
    const cancel = () => { if (ejTimer) { clearTimeout(ejTimer); ejTimer = 0; this.toast('Hold the eject button to unload this deck.', 'info'); } };
    ej.addEventListener('pointerup', cancel);
    ej.addEventListener('pointerleave', () => { if (ejTimer) { clearTimeout(ejTimer); ejTimer = 0; } });
    ej.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toast('Hold the eject button to unload this deck.', 'info'); } });
  }

  /** Keyboard entry points (Task 13 keys.js). */
  toggle(name) {
    if (name.startsWith('kill.')) this.set(name, !this.d.params[name]);
    else if (name === 'keyLock') this.set('keyLock', !this.d.params.keyLock);
  }
  nudgePitch(delta) {
    const r = this.d.params.range;
    this.set('pitch', Math.max(-r, Math.min(r, this.d.params.pitch + delta)));
  }

  update(d, s) {
    this.d = d;
    const r = this.refs, p = d.params;
    this.el.dataset.tstate = d.bpm.state;
    setText(r.title, d.title || `Tab ${d.tabId}`);
    this.el.title = d.title || '';
    if (isSafeIconUrl(d.favIconUrl)) { if (r.fav.getAttribute('src') !== d.favIconUrl) r.fav.src = d.favIconUrl; r.fav.hidden = false; }
    else r.fav.hidden = true;

    const out = d.bpm.out;
    if (out == null) this.shownBpm = null;
    else if (this.shownBpm == null || Math.abs(out - this.shownBpm) >= 0.07) this.shownBpm = out;
    setText(r.bpm, fmtBpm(this.shownBpm));
    setText(r.wbpm, fmtBpm(this.shownBpm));
    setText(r.tstate, d.bpm.tapped ? 'TAP' : d.bpm.state);
    r.tstate.className = `badge ${d.bpm.tapped ? 'ok' : STATE_CLASS[d.bpm.state] || ''}`;
    setText(r.pitch, fmtPct(p.pitch));
    setText(r.native, d.bpm.native ? `orig ${fmtBpm(d.bpm.native)}${d.bpm.mult !== 1 ? ` ×${d.bpm.mult}` : ''}` : '');

    const resFrac = Math.min(1, d.reserve / 30);
    r.reserveFill.style.width = `${(resFrac * 100).toFixed(1)}%`;
    setText(r.reserveText, `${d.reserve.toFixed(1)}s`);
    r.reserve.classList.toggle('low', d.reserve < 4);
    r.assist.hidden = !(d.assist.active || (!d.assist.available && d.sync.on && d.engineRate > 1));
    setText(r.assist, d.assist.active ? `ASSIST ${d.assist.sourceRate.toFixed(3)}×` : 'ASSIST n/a');
    r.assist.className = `badge ${d.assist.active ? 'info' : 'warn'}`;
    r.starved.hidden = !d.starved;

    toggleAttr(r.play, 'aria-pressed', d.playing);
    r.playIcon.setAttribute('href', d.playing ? '#i-pause' : '#i-play');
    r.play.setAttribute('aria-label', d.playing ? 'Pause' : 'Play');
    r.cue.classList.toggle('on', !d.playing && Math.abs(d.playhead - d.cue) < 0.03);
    toggleAttr(r.sync, 'aria-pressed', d.sync.on);
    r.sync.classList.toggle('oor', d.sync.on && d.sync.outOfRange);
    r.sync.title = d.sync.outOfRange ? 'Tempo is outside the pitch range: widen the range for a full sync' : '';
    toggleAttr(r.master, 'aria-pressed', d.sync.isMaster);
    toggleAttr(r.keyLock, 'aria-pressed', p.keyLock);
    setText(r.syncMode, p.syncMode);
    setText(r.range, RANGE_LABEL[p.range] || '±10');
    const recording = d.rec.state === 'recording';
    toggleAttr(r.rec, 'aria-pressed', recording);
    setText(r.recTime, d.rec.state === 'idle' ? '' : fmtClock(d.rec.seconds));

    for (const k of Object.keys(this.knobs)) this.knobs[k].set(p[k]);
    this.fader.set(p.fader);
    this.pitch.set(p.range ? p.pitch / p.range : 0);
    for (const band of ['hi', 'mid', 'low']) this[`kill_${band}`].setOn(p[`kill.${band}`]);
    this.fxOn.setOn(p['fx.on']);
    for (const k of Object.keys(this.segs)) this.segs[k].set(p[k]);

    r.phase.hidden = !(d.sync.on && d.sync.phaseMs != null && !d.sync.isMaster);
    if (!r.phase.hidden && d.grid) {
      const half = (d.grid.T * 1000) / Math.max(0.25, d.engineRate) / 2;
      const f = Math.max(-1, Math.min(1, d.sync.phaseMs / half));
      r.phaseDot.style.left = `${50 + f * 50}%`;
      r.phase.classList.toggle('locked', Math.abs(d.sync.phaseMs) < 10);
    }
    this.meter.update([d.meter]);
  }

  addWave(m) { this.store.add(m); }

  setSelected(on) { this.el.classList.toggle('selected', on); this.waveRow.classList.toggle('selected', on); }

  frame(nowCtx) {
    const d = this.d;
    const dt = Math.max(0, Math.min(0.25, nowCtx - this.snapCtx));
    const playhead = d.playing ? d.playhead + d.engineRate * dt : d.playhead;
    const c = this.refs.wave, dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(c.clientWidth * dpr)), H = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    drawWave(this.waveCtx, {
      w: W, h: H, store: this.store, playhead, grid: d.grid, cue: d.cue, liveEdge: d.liveEdge, historyStart: d.historyStart,
      loop: d.loop, color: this.color, pxPerBeat: 56 * dpr, pxPerSec: 110 * dpr, playing: d.playing,
    });
    // Beat LEDs: current beat of the bar (beat 1 white when TAP 1 set the downbeat).
    const b = beatIndex(d.grid, playhead);
    const ref = d.grid && d.grid.bar1 != null ? Math.round((d.grid.bar1 - d.grid.t0) / d.grid.T) : 0;
    const beatInBar = (((b - ref) % 4) + 4) % 4;
    this.refs.leds.forEach((led, i) => {
      const lit = !!d.grid && i === beatInBar;
      led.classList.toggle('on', lit);
      led.classList.toggle('one', lit && i === 0 && d.grid.bar1 != null);
    });
    this.meter.draw();
  }

  setSnapshotTime(ctxTime) { this.snapCtx = ctxTime; }

  destroy() { this.el.remove(); this.waveRow.remove(); }
}
```

- [ ] **Step 4: Write `tests/browser/fixtures/mock-state.mjs`**

```js
// Realistic engine snapshots for UI tests and screenshots.
export function deck(over = {}) {
  const base = {
    id: 1, slot: 1, tabId: 101, title: 'Daft Punk — One More Time', favIconUrl: '', url: 'https://www.youtube.com/watch?v=x',
    playing: true, previewing: false, cue: 2.0, playhead: 41.3, engineRate: 1.0323, liveEdge: 63.0, reserve: 21.4, starved: false, historyStart: 0,
    bpm: { state: 'LOCKED', native: 124.0, out: 128.0, conf: 0.92, mult: 1, tapped: false },
    grid: { t0: 2.0, T: 60 / 124, bar1: 2.0 },
    sync: { on: true, mode: 'BEAT', isMaster: false, outOfRange: false, phaseMs: 3.2 },
    assist: { available: true, active: false, sourceRate: 1 },
    params: {
      trim: 0.5, 'eq.hi': 0.5, 'eq.mid': 0.5, 'eq.low': 0.5, 'kill.hi': false, 'kill.mid': false, 'kill.low': false,
      filter: 0, 'filter.res': 0.3, fader: 1, xf: 'THRU', 'fx.type': 'ECHO', 'fx.beats': 0.5, 'fx.level': 0.5, 'fx.on': false,
      keyLock: true, range: 0.1, pitch: 0.0323, syncMode: 'BEAT',
    },
    roll: null, loop: null, nudge: 0,
    meter: { peak: 0.7, rms: 0.3, clip: false },
    rec: { state: 'idle', format: 'wav', seconds: 0 },
    error: null,
  };
  return { ...base, ...over, params: { ...base.params, ...(over.params || {}) } };
}

export function makeState({ decks = [deck()], clock = { mode: 'deck', deckId: 2, bpm: 128 } } = {}) {
  return {
    ctxTime: 100, wallMs: Date.now(), sampleRate: 48000, engineState: 'running', outputLatency: 0.012, clock,
    master: {
      params: { 'master.volume': 0.5, 'master.limiter': true, 'xfader.pos': 0.5, 'xfader.curve': 'SMOOTH', 'rec.format': 'wav', 'bpm.range': 'AUTO', 'buffer.capSec': 240, 'assist.on': true, 'pitch.defaultRange': 0.1 },
      peakL: 0.8, peakR: 0.75, rmsL: 0.35, rmsR: 0.33, clipL: false, clipR: false, gr: -1.2, rec: { state: 'idle', format: 'wav', seconds: 0 },
    },
    decks,
  };
}

export function threeDecks() {
  return makeState({
    decks: [
      deck(),
      deck({ id: 2, slot: 2, tabId: 102, title: 'Peggy Gou — (It Goes Like) Nanana', playhead: 40.2, engineRate: 1, bpm: { state: 'LOCKED', native: 128, out: 128, conf: 0.97, mult: 1, tapped: false }, grid: { t0: 1.1, T: 60 / 128, bar1: null }, sync: { on: false, mode: 'BEAT', isMaster: true, outOfRange: false, phaseMs: null }, params: { pitch: 0, xf: 'B', 'fx.on': true, 'fx.type': 'REVERB' }, rec: { state: 'recording', format: 'wav', seconds: 73.4 } }),
      deck({ id: 3, slot: 3, tabId: 103, title: '<img src=x onerror="window.pwned=1"> Bandcamp exclusive', playing: false, playhead: 2.0, cue: 2.0, reserve: 34.0, liveEdge: 36, bpm: { state: 'SEARCH', native: null, out: null, conf: 0.1, mult: 1, tapped: false }, grid: null, sync: { on: false, mode: 'BEAT', isMaster: false, outOfRange: false, phaseMs: null }, params: { xf: 'A', 'kill.low': true }, meter: { peak: 0, rms: 0, clip: false } }),
    ],
  });
}

/** Synthetic waveform backlog: kick-like low pulses on the beat. */
export function makeWave(deckId, seconds, bpm = 124) {
  const hop = 512 / 48000, n = Math.floor(seconds / hop);
  const data = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i * hop, ph = (t * bpm) / 60 % 1;
    data[i * 3] = Math.round(120 + 135 * Math.exp(-ph * 8));
    data[i * 3 + 1] = Math.round(110 + 60 * Math.exp(-((ph * 2) % 1) * 6));
    data[i * 3 + 2] = Math.round(90 + 80 * Math.exp(-((ph * 4) % 1) * 10));
  }
  return { t: 'wave', deck: deckId, tStart: 0, hop, data };
}
```

`makeWave` returns `data` as a plain array, because messages crossing `page.evaluate` are JSON.
`WaveStore.add` accepts an array (`slice`) as well as a typed array (`subarray`).

- [ ] **Step 5: Commit** (tested together with Task 13)

```bash
git add ui/waveform.js ui/meters.js ui/deck-strip.js tests/browser/fixtures/mock-state.mjs
git commit -m "Add scrolling waveform, meters and deck strip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---
## Task 13: Master strip, sources, keyboard, app bootstrap (+ UI tests)

**Files:**
- Create: `ui/master-strip.js`, `ui/sources.js`, `ui/keys.js`, `ui/app.js`
- Create: `tests/browser/ui-app.test.mjs`
- Modify: `.gitignore` (add `tests/browser/artifacts/`)

**Interfaces:**
- Consumes: everything from Tasks 11–12; `HUB`, `PERSISTED_MASTER_KEYS`, `isSafeIconUrl`
  (Task 1).
- Produces:
  - **`ui/master-strip.js`:** `class MasterStrip({conn, toast, persist})` with `.update(s)`,
    `.frame()`, `.nudgeXf(delta)`, `.setXf(v)` and `.toggleMixRec()`.
  - **`ui/sources.js`:** `class SourcesDrawer({conn, toast})` with `.open()`, `.close()`,
    `.refresh()` and `.isOpen`.
  - **`ui/keys.js`:** `bindKeys({getStrip, selectSlot, conn, master, toggleHelp, closePanels})`.
    It uses physical key codes (`e.code`), so the Q/A/Z kill column stays vertical on any
    layout.
  - **`ui/app.js`:** the entry module (no exports). It owns the strips, selection, toasts,
    persistence, wake lock, `beforeunload` and the animation loop.

- [ ] **Step 1: Write the failing UI tests** — `tests/browser/ui-app.test.mjs`

```js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUi } from './ui-harness.mjs';
import { threeDecks, makeState, makeWave } from './fixtures/mock-state.mjs';

const ART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
const SOURCES = {
  ok: true,
  tabs: [
    { id: 101, title: 'Daft Punk — One More Time', url: 'https://www.youtube.com/watch?v=x', favIconUrl: '', audible: true, granted: true, deckSlot: 1 },
    { id: 201, title: 'Mixcloud — Friday set', url: 'https://www.mixcloud.com/x/', favIconUrl: 'javascript:alert(1)', audible: true, granted: true, deckSlot: null },
    { id: 202, title: 'SoundCloud — Track', url: 'https://soundcloud.com/a/b', favIconUrl: '', audible: false, granted: false, deckSlot: null },
  ],
};

let ui, page;
const acts = async (filter) => (await ui.sent()).filter((m) => m.t === 'act' && (!filter || filter(m)));
const sets = async (filter) => (await ui.sent()).filter((m) => m.t === 'set' && (!filter || filter(m)));
const deckEl = (slot) => page.locator('.deck').nth(slot - 1);

before(async () => {
  ui = await openUi({ state: threeDecks(), hubReplies: { LIST_SOURCES: SOURCES, LOAD_TAB: { ok: true } }, storage: { 'xfader.curve': 'SHARP' } });
  page = ui.page;
  await page.waitForSelector('.deck >> nth=2');
  for (const id of [1, 2, 3]) await ui.push(makeWave(id, 60, id === 2 ? 128 : 124));
  await page.waitForTimeout(150);
});
after(async () => { await ui?.close(); });

test('renders three decks and waveform rows in slot order', async () => {
  assert.equal(await page.locator('.deck').count(), 3);
  assert.equal(await page.locator('.wave-row').count(), 3);
  assert.equal(await page.locator('#empty').isHidden(), true);
  assert.equal((await deckEl(2).locator('[data-title]').textContent()).trim(), 'Peggy Gou — (It Goes Like) Nanana');
  assert.equal(await deckEl(1).locator('[data-bpm]').textContent(), '128.0');
  assert.equal(await deckEl(3).locator('[data-bpm]').textContent(), '—');
  assert.equal(await page.locator('#clockBpm').textContent(), '128.0');
  assert.equal(await page.locator('#clockMode').textContent(), 'DECK 2');
});

test('hostile page titles render as text', async () => {
  const t = deckEl(3).locator('[data-title]');
  assert.equal(await t.textContent(), '<img src=x onerror="window.pwned=1"> Bandcamp exclusive');
  assert.equal(await t.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
});

test('stored settings are restored into the engine on connect', async () => {
  assert.ok((await sets((m) => m.deck === null && m.key === 'xfader.curve' && m.value === 'SHARP')).length >= 1);
});

test('transport and sync buttons send actions', async () => {
  await ui.clearSent();
  await deckEl(3).locator('[data-act="playToggle"]').click();
  await deckEl(1).locator('[data-act="sync"]').click();
  await page.waitForTimeout(50);
  const a = await acts();
  assert.ok(a.some((m) => m.deck === 3 && m.a === 'play'));
  assert.ok(a.some((m) => m.deck === 1 && m.a === 'sync' && m.arg.on === false));
});

test('knob, FX pad, crossfader assign send parameter sets', async () => {
  await ui.clearSent();
  const k = deckEl(1).locator('[data-ctl="eq.hi"] svg');
  const b = await k.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 40, { steps: 4 });
  await page.mouse.up();
  await deckEl(1).locator('[data-pad="fx.on"]').click();
  await deckEl(1).locator('[data-seg="xf"] button[data-v="A"]').click();
  await page.waitForTimeout(60);
  const s = await sets((m) => m.deck === 1);
  assert.ok(s.some((m) => m.key === 'eq.hi' && m.value > 0.6));
  assert.ok(s.some((m) => m.key === 'fx.on' && m.value === true));
  assert.ok(s.some((m) => m.key === 'xf' && m.value === 'A'));
});

test('roll pads are momentary', async () => {
  await ui.clearSent();
  const pad = deckEl(1).locator('[data-roll="0.25"]');
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + 5, b.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(50);
  const a = (await acts((m) => m.deck === 1)).map((m) => [m.a, m.arg]);
  assert.deepEqual(a, [['rollStart', { beats: 0.25 }], ['rollEnd', {}]]);
});

test('eject needs a hold', async () => {
  await ui.clearSent();
  const ej = deckEl(3).locator('[data-act="eject"]');
  await ej.click();
  await page.waitForTimeout(50);
  assert.equal((await acts((m) => m.a === 'eject')).length, 0);
  assert.ok((await page.locator('.toast').allTextContents()).some((t) => /Hold the eject/.test(t)));
  const b = await ej.boundingBox();
  await page.mouse.move(b.x + 5, b.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  assert.equal((await acts((m) => m.a === 'eject' && m.deck === 3)).length, 1);
});

test('keyboard shortcuts drive the selected deck and the mixer', async () => {
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await ui.clearSent();
  await page.keyboard.press('Digit2');
  assert.equal(await deckEl(2).evaluate((e) => e.classList.contains('selected')), true);
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('BracketLeft');
  await page.keyboard.press('Shift+KeyS');
  await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(40); await page.keyboard.up('ArrowLeft');
  await page.keyboard.down('KeyV'); await page.waitForTimeout(40); await page.keyboard.up('KeyV');
  await page.waitForTimeout(60);
  const a = (await acts((m) => m.deck === 2)).map((m) => [m.a, m.arg]);
  assert.deepEqual(a, [['pause', {}], ['master', {}], ['nudge', { dir: -1, fine: false }], ['nudge', { dir: 0 }], ['rollStart', { beats: 0.125 }], ['rollEnd', {}]]);
  const s = await sets();
  assert.ok(s.some((m) => m.deck === 2 && m.key === 'kill.hi' && m.value === true));
  assert.ok(s.some((m) => m.deck === null && m.key === 'xfader.pos' && Math.abs(m.value - 0.45) < 1e-9));
});

test('sources drawer lists tabs with the right action per state', async () => {
  await page.locator('#sourcesBtn').click();
  await page.waitForSelector('#sourceList li >> nth=2');
  const rows = page.locator('#sourceList li');
  assert.equal(await rows.nth(0).locator('[data-ondeck]').textContent(), 'ON DECK 1');
  assert.equal(await rows.nth(1).locator('[data-load]').isVisible(), true);
  assert.equal(await rows.nth(1).locator('[data-fav]').isVisible(), false);
  assert.equal(await rows.nth(2).locator('[data-goto]').isVisible(), true);
  await rows.nth(1).locator('[data-load]').click();
  await page.waitForTimeout(50);
  assert.ok((await ui.hubCalls()).some((c) => c.type === 'LOAD_TAB' && c.tabId === 201));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sources').isHidden(), true);
});

test('settings change the engine and persist', async () => {
  await ui.clearSent();
  await page.locator('#settingsBtn').click();
  await page.locator('[data-setting="rec.format"] button[data-v="webm"]').click();
  await page.waitForTimeout(50);
  assert.ok((await sets((m) => m.deck === null && m.key === 'rec.format' && m.value === 'webm')).length === 1);
  assert.equal(await page.evaluate(() => window.__fake.storage['rec.format']), 'webm');
  await page.keyboard.press('Escape');
});

test('engine disconnect shows the banner and reconnect clears it', async () => {
  await page.evaluate(() => window.__fake.disconnect());
  await page.waitForSelector('#banner:not([hidden])', { timeout: 1000 });
  await page.waitForSelector('#banner[hidden]', { state: 'attached', timeout: 3000 });
});

test('layout fits 1440x900 without scrolling and a screenshot is saved', async () => {
  const fit = await page.evaluate(() => { const d = document.getElementById('decks'); return { sh: d.scrollHeight, ch: d.clientHeight, sw: d.scrollWidth, cw: d.clientWidth }; });
  assert.ok(fit.sh <= fit.ch + 2, `vertical overflow ${JSON.stringify(fit)}`);
  assert.ok(fit.sw <= fit.cw + 2, `horizontal overflow ${JSON.stringify(fit)}`);
  fs.mkdirSync(ART, { recursive: true });
  await page.screenshot({ path: path.join(ART, 'deck-ui-1440x900.png') });
});

test('no console errors', () => { assert.deepEqual(ui.errors, []); });

test('empty state is shown with no decks', async () => {
  const u2 = await openUi({ state: makeState({ decks: [], clock: { mode: 'none', deckId: null, bpm: null } }) });
  try {
    await u2.page.waitForFunction(() => document.getElementById('engineStatus').dataset.status === 'up');
    assert.equal(await u2.page.locator('#empty').isVisible(), true);
    assert.equal(await u2.page.locator('.deck').count(), 0);
    fs.mkdirSync(ART, { recursive: true });
    await u2.page.screenshot({ path: path.join(ART, 'deck-ui-empty.png') });
  } finally { await u2.close(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/browser/ui-app.test.mjs`
Expected: FAIL (`ui/app.js` is missing, so no `.deck` appears).

- [ ] **Step 3: Write `ui/master-strip.js`**

```js
// ui/master-strip.js — master meters/limiter/volume, crossfader bar, REC MIX, clock and settings.
import { $, $$, setText, toggleAttr, fmtBpm, fmtClock } from './util.js';
import { Knob, Fader, bindSeg } from './controls.js';
import { VMeter } from './meters.js';

export class MasterStrip {
  constructor({ conn, toast, persist }) {
    this.conn = conn;
    this.toast = toast;
    this.persist = persist;
    this.params = {};
    this.rec = { state: 'idle' };
    const vdb = (v) => { if (v <= 0) return '−∞'; const g = v >= 0.5 ? (6 * (v - 0.5)) / 0.5 : 20 * Math.log10((2 * v) ** 3); return `${g >= 0 ? '+' : '−'}${Math.abs(g).toFixed(1)} dB`; };
    this.vol = new Knob($('#masterVol'), { label: 'VOLUME', def: 0.5, value: 0.5, format: vdb, onChange: (v) => conn.set(null, 'master.volume', v) });
    this.limiter = $('#limiterBtn');
    this.limiter.addEventListener('click', () => this.setPersisted('master.limiter', !this.params['master.limiter']));
    this.xf = new Fader($('#crossfader'), { orientation: 'horizontal', label: 'Crossfader', min: 0, max: 1, def: 0.5, value: 0.5, center: true, step: 0.02, fine: 0.004, format: (v) => `${Math.round(v * 100)}`, onChange: (v) => conn.set(null, 'xfader.pos', v) });
    this.curve = bindSeg($('#xfCurve'), { onSelect: (v) => this.setPersisted('xfader.curve', v) });
    this.settings = $$('[data-setting]').map((el) => ({ key: el.dataset.setting, seg: bindSeg(el, { onSelect: (v) => this.setPersisted(el.dataset.setting, v) }) }));
    this.meter = new VMeter($('#masterMeter'), { channels: 2 });
    this.gr = new VMeter($('#grMeter'), { mode: 'gr' });
    for (const id of ['#clipL', '#clipR']) $(id).addEventListener('click', () => conn.act(null, 'clipReset'));
    $('#mixRecBtn').addEventListener('click', () => this.toggleMixRec());
  }

  setPersisted(key, value) {
    this.conn.set(null, key, value);
    this.persist(key, value);
  }

  async toggleMixRec() {
    const r = await this.conn.act(null, this.rec.state === 'recording' ? 'mixRecStop' : 'mixRecStart');
    if (!r.ok && r.error) this.toast(r.error, 'warn');
  }

  nudgeXf(delta) { const v = Math.max(0, Math.min(1, this.xf.value + delta)); this.xf.set(v); this.conn.set(null, 'xfader.pos', v); }
  setXf(v) { this.xf.set(v); this.conn.set(null, 'xfader.pos', v); }

  update(s) {
    const m = s.master, p = m.params;
    this.params = p;
    this.rec = m.rec;
    this.vol.set(p['master.volume']);
    toggleAttr(this.limiter, 'aria-pressed', p['master.limiter']);
    this.xf.set(p['xfader.pos']);
    this.curve.set(p['xfader.curve']);
    for (const st of this.settings) st.seg.set(p[st.key]);
    const recBtn = $('#mixRecBtn');
    toggleAttr(recBtn, 'aria-pressed', m.rec.state === 'recording');
    setText($('#mixRecTime'), m.rec.state === 'idle' ? '' : fmtClock(m.rec.seconds));
    $('#clipL').classList.toggle('on', m.clipL);
    $('#clipR').classList.toggle('on', m.clipR);
    setText($('#grText'), m.gr < -0.05 ? m.gr.toFixed(1) : '0.0');
    this.meter.update([{ peak: m.peakL, rms: m.rmsL, clip: m.clipL }, { peak: m.peakR, rms: m.rmsR, clip: m.clipR }]);
    this.gr.update({ gr: m.gr });
    const c = s.clock;
    setText($('#clockBpm'), c.bpm ? fmtBpm(c.bpm) : '—');
    const slot = c.mode === 'deck' ? (s.decks.find((d) => d.id === c.deckId) || {}).slot : null;
    setText($('#clockMode'), c.mode === 'deck' ? `DECK ${slot ?? '?'}` : c.mode === 'free' ? 'FREE RUNNING' : 'no master');
  }

  frame() { this.meter.draw(); this.gr.draw(); }
}
```

- [ ] **Step 4: Write `ui/sources.js`**

```js
// ui/sources.js — the Sources drawer: open tabs, which are on decks, which can be loaded.
import { HUB, isSafeIconUrl } from '../shared/protocol.js';
import { $, clone, setText } from './util.js';

export class SourcesDrawer {
  constructor({ conn, toast }) {
    this.conn = conn;
    this.toast = toast;
    this.el = $('#sources');
    this.list = $('#sourceList');
    this.timer = 0;
    for (const id of ['#sourcesBtn', '#emptySourcesBtn']) $(id).addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    this.el.querySelector('[data-close]').addEventListener('click', () => this.close());
  }

  get isOpen() { return !this.el.hidden; }

  open() {
    this.el.hidden = false;
    $('#sourcesBtn').setAttribute('aria-expanded', 'true');
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), 1500);
  }

  close() {
    this.el.hidden = true;
    $('#sourcesBtn').setAttribute('aria-expanded', 'false');
    clearInterval(this.timer);
  }

  async refresh() {
    let r;
    try { r = await this.conn.hub(HUB.LIST_SOURCES); } catch (_) { r = null; }
    if (!r || !r.ok) { this.toast('Could not list browser tabs.', 'warn'); return; }
    this.list.replaceChildren(...r.tabs.map((t) => this.row(t)));
  }

  row(t) {
    const li = clone('tpl-source-row');
    setText(li.querySelector('[data-title]'), t.title || t.url || `Tab ${t.id}`);
    let host = '';
    try { host = new URL(t.url).host; } catch (_) {}
    setText(li.querySelector('[data-host]'), host);
    const fav = li.querySelector('[data-fav]');
    if (isSafeIconUrl(t.favIconUrl)) fav.src = t.favIconUrl; else fav.hidden = true;
    li.querySelector('[data-audible]').hidden = !t.audible;
    const onDeck = li.querySelector('[data-ondeck]'), load = li.querySelector('[data-load]'), go = li.querySelector('[data-goto]');
    if (t.deckSlot) { onDeck.hidden = false; setText(onDeck, `ON DECK ${t.deckSlot}`); }
    else if (t.granted) load.hidden = false;
    else go.hidden = false;
    load.addEventListener('click', async () => {
      load.disabled = true;
      const res = await this.conn.hub(HUB.LOAD_TAB, { tabId: t.id }).catch((e) => ({ ok: false, error: e.message }));
      if (res && res.ok) this.toast('Loaded onto a deck. It is cued: press PLAY when ready.', 'info');
      else this.toast((res && res.error) || 'Could not load that tab.', 'warn');
      this.refresh();
    });
    go.addEventListener('click', () => this.conn.hub(HUB.GOTO_TAB, { tabId: t.id }));
    return li;
  }
}
```

- [ ] **Step 5: Write `ui/keys.js`**

```js
// ui/keys.js — performance keyboard map (physical keys via e.code).
// Captured at the window so a focused button never also reacts to Space.

const ROLL = { KeyV: 0.125, KeyB: 0.25, KeyN: 0.5, KeyM: 1 };
const KILL = { KeyQ: 'kill.hi', KeyA: 'kill.mid', KeyZ: 'kill.low' };

export function bindKeys({ getStrip, selectSlot, conn, master, toggleHelp, closePanels }) {
  const held = new Map();
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  // Tap = toggle, hold ≥ 250 ms = momentary (same feel as the on-screen pads).
  const latchDown = (code, strip, key) => {
    const wasOn = !!strip.d.params[key];
    held.set(code, { at: performance.now(), wasOn, strip, key });
    if (!wasOn) strip.set(key, true);
  };
  const latchUp = (code) => {
    const h = held.get(code);
    if (!h) return;
    held.delete(code);
    if (h.wasOn || performance.now() - h.at >= 250) h.strip.set(h.key, false);
  };

  window.addEventListener('keydown', (e) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const c = e.code;
    if (/^Digit[1-6]$/.test(c)) { selectSlot(Number(c.slice(5))); e.preventDefault(); return; }
    if (c === 'Slash' && e.shiftKey) { toggleHelp(); e.preventDefault(); return; }
    if (c === 'Escape') { closePanels(); return; }
    if (c === 'BracketLeft') { master.nudgeXf(-0.05); e.preventDefault(); return; }
    if (c === 'BracketRight') { master.nudgeXf(0.05); e.preventDefault(); return; }
    if (c === 'Backslash') { master.setXf(0.5); e.preventDefault(); return; }
    if (c === 'KeyR' && e.shiftKey) { if (!e.repeat) master.toggleMixRec(); e.preventDefault(); return; }
    const strip = getStrip();
    if (!strip) return;
    const d = strip.d;
    const once = !e.repeat;
    let handled = true;
    switch (c) {
      case 'Space':
        if (once) strip.act(e.shiftKey ? 'syncPlay' : d.playing ? 'pause' : 'play');
        break;
      case 'KeyC': if (once) { held.set(c, { cue: true, strip }); strip.act('cueDown'); } break;
      case 'KeyS': if (once) { if (e.shiftKey) strip.act('master'); else strip.act('sync', { on: !d.sync.on }); } break;
      case 'KeyK': if (once) strip.toggle('keyLock'); break;
      case 'KeyT': if (once) { if (e.shiftKey) strip.act('tap1'); else strip.act('tap', { wallMs: performance.timeOrigin + performance.now() }); } break;
      case 'KeyQ': case 'KeyA': case 'KeyZ': if (once) latchDown(c, strip, KILL[c]); break;
      case 'KeyF': if (once) latchDown(c, strip, 'fx.on'); break;
      case 'KeyV': case 'KeyB': case 'KeyN': case 'KeyM': if (once) { held.set(c, { roll: true, strip }); strip.act('rollStart', { beats: ROLL[c] }); } break;
      case 'ArrowLeft': case 'ArrowRight': if (once) { held.set(c, { nudge: true, strip }); strip.act('nudge', { dir: c === 'ArrowLeft' ? -1 : 1, fine: e.shiftKey }); } break;
      case 'ArrowUp': strip.nudgePitch(0.001); break;
      case 'ArrowDown': strip.nudgePitch(-0.001); break;
      case 'KeyR': if (once) strip.act(d.rec.state === 'recording' ? 'recStop' : 'recStart'); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  window.addEventListener('keyup', (e) => {
    const c = e.code;
    if (c === 'Space') { if (!typing(e.target)) e.preventDefault(); return; }
    const h = held.get(c);
    if (!h) return;
    if (h.cue) { held.delete(c); h.strip.act('cueUp'); }
    else if (h.roll) { held.delete(c); h.strip.act('rollEnd'); }
    else if (h.nudge) { held.delete(c); h.strip.act('nudge', { dir: 0 }); }
    else latchUp(c);
    e.preventDefault();
  }, true);

  // Releasing everything if the window loses focus mid-hold avoids stuck rolls/nudges.
  window.addEventListener('blur', () => {
    for (const [c, h] of held) {
      if (h.cue) h.strip.act('cueUp');
      else if (h.roll) h.strip.act('rollEnd');
      else if (h.nudge) h.strip.act('nudge', { dir: 0 });
      else latchUp(c);
    }
    held.clear();
  });
}
```

- [ ] **Step 6: Write `ui/app.js`**

```js
// ui/app.js — deck page entry point.
import { PERSISTED_MASTER_KEYS } from '../shared/protocol.js';
import { $, setText, wallNow } from './util.js';
import { EngineConnection } from './connection.js';
import { DeckStrip } from './deck-strip.js';
import { MasterStrip } from './master-strip.js';
import { SourcesDrawer } from './sources.js';
import { bindKeys } from './keys.js';

const strips = new Map();
let snap = null;
let selected = null;
let restored = false;
let wakeLock = null;

function toast(text, level = 'info') {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${level}`;
  t.textContent = String(text);
  box.append(t);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(() => t.remove(), level === 'error' ? 8000 : 4000);
}

const persist = (key, value) => { try { chrome.storage.local.set({ [key]: value }); } catch (_) {} };

const conn = new EngineConnection({
  onState,
  onWave: (m) => { const st = strips.get(m.deck); if (st) st.addWave(m); },
  onEvent: (e) => toast(e.text, e.level),
  onStatus,
});
const master = new MasterStrip({ conn, toast, persist });
const sources = new SourcesDrawer({ conn, toast });

function select(id) {
  selected = id;
  for (const [k, st] of strips) st.setSelected(k === id);
}

function onStatus(status) {
  $('#engineStatus').dataset.status = status;
  $('#banner').hidden = status !== 'down';
  if (status === 'down') setText($('#engineText'), 'Engine offline');
}

async function restoreSettings(s) {
  restored = true;
  let stored = {};
  try { stored = await chrome.storage.local.get([...PERSISTED_MASTER_KEYS]); } catch (_) {}
  for (const k of PERSISTED_MASTER_KEYS) if (k in stored && stored[k] !== s.master.params[k]) conn.set(null, k, stored[k]);
}

function onState(s) {
  snap = s;
  if (!restored) restoreSettings(s);
  const ids = new Set(s.decks.map((d) => d.id));
  for (const [id, st] of strips) if (!ids.has(id)) { st.destroy(); strips.delete(id); }
  const decksEl = $('#decks'), wavesEl = $('#waves');
  s.decks.forEach((d, i) => {
    let st = strips.get(d.id);
    if (!st) {
      st = new DeckStrip(d, { conn, toast, onSelect: select });
      strips.set(d.id, st);
    }
    if (decksEl.children[i + 1] !== st.el) decksEl.insertBefore(st.el, decksEl.children[i + 1] || null);
    if (wavesEl.children[i] !== st.waveRow) wavesEl.insertBefore(st.waveRow, wavesEl.children[i] || null);
    st.setSnapshotTime(s.ctxTime);
    st.update(d, s);
  });
  if (!strips.has(selected)) select(s.decks.length ? s.decks[0].id : null);
  else select(selected);
  $('#empty').hidden = s.decks.length > 0;
  master.update(s);
  setText($('#engineText'), `${s.engineState === 'running' ? 'Engine' : `Engine ${s.engineState}`} · ${(s.sampleRate / 1000).toFixed(1)} kHz · ${Math.round(s.outputLatency * 1000)} ms`);
  const n = s.decks.length;
  document.title = n ? `JD Samps — ${n} deck${n > 1 ? 's' : ''}` : 'JD Samps — Deck';
  if (n && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
    navigator.wakeLock.request('screen').then((l) => { wakeLock = l; l.addEventListener('release', () => { wakeLock = null; }); }).catch(() => {});
  } else if (!n && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function frame() {
  requestAnimationFrame(frame);
  if (!snap) return;
  const now = snap.ctxTime + Math.min(0.25, Math.max(0, (wallNow() - snap.wallMs) / 1000));
  for (const st of strips.values()) st.frame(now);
  master.frame();
}

function toggle(el, open) { el.hidden = open == null ? !el.hidden : !open; }
const settings = $('#settings'), help = $('#help');
$('#settingsBtn').addEventListener('click', () => toggle(settings));
settings.querySelector('[data-close]').addEventListener('click', () => toggle(settings, false));
$('#helpBtn').addEventListener('click', () => toggle(help));
help.querySelector('[data-close]').addEventListener('click', () => toggle(help, false));
help.addEventListener('click', (e) => { if (e.target === help) toggle(help, false); });
$('#stopAllBtn').addEventListener('click', async () => {
  if (!snap || !snap.decks.length) return;
  if (!confirm('Stop all decks and finish all recordings?')) return;
  const r = await conn.act(null, 'stopAll');
  if (!r.ok && r.error) toast(r.error, 'warn');
});

bindKeys({
  getStrip: () => strips.get(selected) || null,
  selectSlot: (slot) => { const d = snap && snap.decks.find((x) => x.slot === slot); if (d) select(d.id); },
  conn,
  master,
  toggleHelp: () => toggle(help),
  closePanels: () => { toggle(help, false); toggle(settings, false); sources.close(); },
});

window.addEventListener('beforeunload', (e) => {
  if (snap && snap.decks.length) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && snap && snap.decks.length && !wakeLock && navigator.wakeLock) {
    navigator.wakeLock.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
  }
});

conn.start();
requestAnimationFrame(frame);
```

`#decks` keeps `#empty` as its first child, which is why deck strips are inserted at index
`i + 1`.

- [ ] **Step 7: Ignore test artifacts**

Append to `.gitignore` (create it if it doesn't exist):

```
tests/browser/artifacts/
node_modules/
```

- [ ] **Step 8: Run all UI tests and look at the screenshots**

Run: `node --test tests/browser/ui-controls.test.mjs tests/browser/ui-app.test.mjs`
Expected: PASS. Then open `tests/browser/artifacts/deck-ui-1440x900.png` and
`deck-ui-empty.png` and check them against the spec's layout (§3.9):
- waveform rows with aligned centre playheads and beat grids;
- three deck columns with colour accents;
- master strip on the right;
- crossfader at the bottom;
- deck 3 with the hostile title shown as literal text;
- a REC timer on deck 2.

Fix any visual defect before committing.

- [ ] **Step 9: Commit**

```bash
git add ui/master-strip.js ui/sources.js ui/keys.js ui/app.js tests/browser/ui-app.test.mjs .gitignore
git commit -m "Add master strip, sources drawer, keyboard map and deck app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---
## Task 14: Extension harness, end-to-end suite, README, cleanup

**Files:**
- Create: `tests/browser/ext-harness.mjs`, `tests/browser/e2e.test.mjs`
- Modify: `README.md` (rewrite), `package.json` (add the `test:e2e` script)
- Delete: `popup.html`, `popup.css`, `popup.js`, `offscreen.js`, `recorder-worklet.js`

**Interfaces:**
- Produces (`tests/browser/ext-harness.mjs`):
  - setup: `prepareExtension({src, dest}) → {dir, id}`,
    `launchExtension({ext, headless=true, downloadsDir}) → h {context, sw, extId, userDataDir, downloadsDir, close()}`,
    `startTrackServer() → {origin, url(name), close()}`;
  - pages and messaging: `openExtPage(h, path)`, `hubCall(page, msg)`, `installClient(page)`,
    `act(page, deck, a, arg)`, `set(page, deck, key, value)`, `state(page)`, `events(page)`;
  - waiting: `tabIdFor(h, prefix)`, `waitFor(fn, ms)`;
  - downloads: `downloadIds(h)`, `waitForDownload(h, knownIds, ms)`;
  - audio: `makeTrackWav({bpm, seconds, kind:'low'|'high'|'mid'})`, `parseWav(buf)`,
    `bandOnsets(mono, sr, band)`, `bandRms(mono, sr, band)`, `medianBpm(onsets)`;
  - engine internals: `offscreenEval(h, expr)`.

The harness launches Chromium with `--allowlisted-extension-id=<id>`. That is Chromium's own
switch for skipping the per-tab invocation check: automation cannot click the toolbar icon
(`Extensions.triggerAction` does not exist in this build). It also removes Playwright's default
`--mute-audio`, which would make captured audio digital silence.

- [ ] **Step 1: Write `tests/browser/ext-harness.mjs`**

```js
// Harness for driving the real extension in headless Chromium (verified on Chromium 141 /
// Playwright 1.56). See the plan's Task 14 notes for the switches it relies on.
import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = /(^|\/)(\.git|tests|docs|node_modules)(\/|$)/;

export function extensionIdForPath(absDir) {
  const hex = crypto.createHash('sha256').update(absDir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function prepareExtension({ src = ROOT, dest } = {}) {
  dest = dest || fs.mkdtempSync(path.join(os.tmpdir(), 'jds-ext-'));
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !SKIP.test(path.relative(src, p)) });
  const abs = fs.realpathSync(dest);
  return { dir: abs, id: extensionIdForPath(abs) };
}

export async function launchExtension({ ext, headless = process.env.HEADLESS !== '0', downloadsDir } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jds-profile-'));
  downloadsDir = downloadsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'jds-dl-'));
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: downloadsDir },
  }));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${ext.dir}`, `--load-extension=${ext.dir}`,
      '--autoplay-policy=no-user-gesture-required', `--allowlisted-extension-id=${ext.id}`, '--remote-debugging-port=0',
    ],
    ignoreDefaultArgs: ['--mute-audio'],
    acceptDownloads: true,
  });
  let sw = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${ext.id}/`));
  if (!sw) sw = await context.waitForEvent('serviceworker', { predicate: (w) => w.url().startsWith(`chrome-extension://${ext.id}/`), timeout: 15000 });
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  return {
    context, sw, extId: ext.id, userDataDir, downloadsDir,
    async close() { await context.close(); fs.rmSync(userDataDir, { recursive: true, force: true }); fs.rmSync(ext.dir, { recursive: true, force: true }); },
  };
}

// ---------------------------------------------------------------- test audio
/** 16-bit mono WAV, 48 kHz, an exact whole number of beats so `loop` is seamless.
 *  kind: 'low' = pitched kick (all energy < 200 Hz), 'high' = 3 kHz click, 'mid' = 800 Hz blip. */
export function makeTrackWav({ bpm, seconds = 60, kind = 'low', sr = 48000 }) {
  const beat = 60 / bpm, beats = Math.round(seconds / beat), n = Math.round(beats * beat * sr);
  const buf = Buffer.alloc(44 + n * 2);
  for (let i = 0; i < n; i++) {
    const t = (i / sr) % beat;
    let v = 0;
    if (kind === 'low' && t < 0.2) v = 0.8 * Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-t * 35)) * t) * Math.exp(-t * 18);
    else if (kind === 'high' && t < 0.04) v = 0.6 * Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-t * 90);
    else if (kind === 'mid' && t < 0.08) v = 0.6 * Math.sin(2 * Math.PI * 800 * t) * Math.exp(-t * 50);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

const TRACKS = { a: { bpm: 124, kind: 'low' }, b: { bpm: 128, kind: 'high' }, c: { bpm: 120, kind: 'mid' } };

/** /a, /b: <audio loop autoplay> pages (124 BPM low kick, 128 BPM high click).
 *  /c: Web-Audio-only page (AudioBufferSourceNode, no media element) at 120 BPM. */
export async function startTrackServer() {
  const wavs = Object.fromEntries(Object.entries(TRACKS).map(([k, t]) => [k, makeTrackWav(t)]));
  const media = (k) => `<!doctype html><title>Track ${k.toUpperCase()} ${TRACKS[k].bpm} BPM</title><audio id="a" src="/${k}.wav" loop autoplay></audio>
<script>window.__media = () => { const a = document.getElementById('a'); return { t: a.currentTime, rate: a.playbackRate, pp: a.preservesPitch, paused: a.paused }; };</script>`;
  const webaudio = `<!doctype html><title>Track C ${TRACKS.c.bpm} BPM (Web Audio)</title><script>
  (async () => { const ctx = new AudioContext(); const buf = await ctx.decodeAudioData(await (await fetch('/c.wav')).arrayBuffer());
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(ctx.destination); s.start(); window.__ctx = ctx; })();
  </script>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = u.pathname.match(/^\/([abc])\.wav$/);
    if (m) { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wavs[m[1]]); return; }
    if (u.pathname === '/a' || u.pathname === '/b') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(media(u.pathname.slice(1))); return; }
    if (u.pathname === '/c') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(webaudio); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: (name) => `${origin}/${name}`, close: () => new Promise((r) => server.close(r)) };
}

// ---------------------------------------------------------------- pages + messaging
export async function openExtPage(h, p) {
  const page = await h.context.newPage();
  await page.goto(`chrome-extension://${h.extId}/${p}`);
  return page;
}
export const hubCall = (page, msg) => page.evaluate((m) => chrome.runtime.sendMessage({ target: 'hub', ...m }), msg);
export async function tabIdFor(h, prefix) {
  return h.sw.evaluate((p) => chrome.tabs.query({}).then((ts) => (ts.find((t) => (t.url || '').startsWith(p)) || {}).id), prefix);
}
export async function waitFor(fn, ms = 10000, step = 100) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`waitFor timed out after ${ms} ms`);
}

/** Second UI port inside an extension page, for tests to read state and send commands. */
export async function installClient(page) {
  await page.evaluate(() => {
    const c = { last: null, events: [], next: 1, pending: new Map() };
    c.port = chrome.runtime.connect({ name: 'jds-ui' });
    c.port.onMessage.addListener((m) => {
      if (m.t === 'state') c.last = m.s;
      else if (m.t === 'event') c.events.push(m);
      else if (m.t === 'reply') { const r = c.pending.get(m.id); if (r) { c.pending.delete(m.id); r({ ok: m.ok, error: m.error }); } }
    });
    c.port.postMessage({ t: 'hello' });
    window.__c = c;
  });
  await waitFor(() => page.evaluate(() => !!window.__c.last), 10000);
}
export const act = (page, deck, a, arg = {}) => page.evaluate(([d, x, g]) => new Promise((res) => {
  const c = window.__c, id = c.next++;
  c.pending.set(id, res);
  c.port.postMessage({ t: 'act', deck: d, a: x, arg: g, id });
}), [deck, a, arg]);
export const set = (page, deck, key, value) => page.evaluate(([d, k, v]) => window.__c.port.postMessage({ t: 'set', deck: d, key: k, value: v }), [deck, key, value]);
export const state = (page) => page.evaluate(() => window.__c.last);
export const events = (page) => page.evaluate(() => window.__c.events);

// ---------------------------------------------------------------- downloads
export const downloadIds = (h) => h.sw.evaluate(() => chrome.downloads.search({}).then((xs) => xs.map((d) => d.id)));
export async function waitForDownload(h, known, ms = 20000) {
  return waitFor(async () => {
    const items = await h.sw.evaluate((k) => chrome.downloads.search({}).then((xs) => xs.filter((d) => !k.includes(d.id))
      .map((d) => ({ id: d.id, state: d.state, filename: d.filename, error: d.error }))), known);
    const bad = items.find((d) => d.state === 'interrupted');
    if (bad) throw new Error(`download interrupted: ${bad.error}`);
    return items.find((d) => d.state === 'complete') || null;
  }, ms, 200);
}

// ---------------------------------------------------------------- audio analysis
export function parseWav(buf) {
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(off + 10), sr: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('unsupported WAV');
  const frames = Math.floor(data.length / (2 * fmt.ch)), mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2) / 32768; mono[i] = s / fmt.ch; }
  return { sr: fmt.sr, ch: fmt.ch, mono, seconds: frames / fmt.sr, declaredBytes: buf.readUInt32LE(40) };
}

function bandFilter(x, sr, band) {
  const y = new Float32Array(x.length);
  const a = (fc) => Math.exp((-2 * Math.PI * fc) / sr);
  if (band === 'low') {            // 4-pole low-pass at 150 Hz
    const k = a(150); let s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 0; i < x.length; i++) { s1 = (1 - k) * x[i] + k * s1; s2 = (1 - k) * s1 + k * s2; s3 = (1 - k) * s2 + k * s3; s4 = (1 - k) * s3 + k * s4; y[i] = s4; }
  } else {                         // high: x minus 4-pole low-pass at 1.5 kHz (≈ high-pass)
    const k = a(1500); let s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 0; i < x.length; i++) { s1 = (1 - k) * x[i] + k * s1; s2 = (1 - k) * s1 + k * s2; s3 = (1 - k) * s2 + k * s3; s4 = (1 - k) * s3 + k * s4; y[i] = x[i] - s4; }
  }
  return y;
}

export function bandRms(mono, sr, band) {
  const y = bandFilter(mono, sr, band);
  let s = 0; for (let i = 0; i < y.length; i++) s += y[i] * y[i];
  return Math.sqrt(s / Math.max(1, y.length));
}

/** Onset times (s) in one band: 2 ms envelope, rising through 35% of max, 150 ms refractory. */
export function bandOnsets(mono, sr, band) {
  const y = bandFilter(mono, sr, band);
  const hop = Math.round(sr * 0.002), env = [];
  for (let i = 0; i + hop <= y.length; i += hop) { let m = 0; for (let j = 0; j < hop; j++) m = Math.max(m, Math.abs(y[i + j])); env.push(m); }
  const max = Math.max(...env), thr = max * 0.35, out = [];
  for (let i = 1; i < env.length; i++) if (env[i] >= thr && env[i - 1] < thr && (!out.length || i * 0.002 - out[out.length - 1] > 0.15)) out.push(i * 0.002);
  return out;
}

export function medianBpm(onsets) {
  const iv = onsets.slice(1).map((t, i) => t - onsets[i]).sort((a, b) => a - b);
  return iv.length ? 60 / iv[Math.floor(iv.length / 2)] : null;
}

// ---------------------------------------------------------------- engine internals (CDP)
export async function offscreenEval(h, expression) {
  const [port, wsPath] = fs.readFileSync(path.join(h.userDataDir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed')); });
  let seq = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const cb = m.id && pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    const { targetInfos } = await send('Target.getTargets');
    const t = targetInfos.find((x) => x.url === `chrome-extension://${h.extId}/offscreen.html`);
    if (!t) throw new Error('offscreen engine not running');
    const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  } finally { ws.close(); }
}
```

- [ ] **Step 2: Write the end-to-end suite** — `tests/browser/e2e.test.mjs`

```js
// End-to-end: real extension, real captured tabs, real engine. About 3 minutes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareExtension, launchExtension, startTrackServer, openExtPage, hubCall, tabIdFor, waitFor, installClient,
  act, set, state, events, downloadIds, waitForDownload, parseWav, bandOnsets, bandRms, medianBpm,
} from './ext-harness.mjs';

const ART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
let h, server, deck, tabs = {};
const deckBy = (s, slot) => s.decks.find((d) => d.slot === slot);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function record(target, seconds) {
  const known = await downloadIds(h);
  const start = target === 'mix' ? await act(deck, null, 'mixRecStart') : await act(deck, target, 'recStart');
  assert.equal(start.ok, true, JSON.stringify(start));
  await sleep(seconds * 1000);
  if (target === 'mix') await act(deck, null, 'mixRecStop'); else await act(deck, target, 'recStop');
  const dl = await waitForDownload(h, known);
  return { dl, wav: parseWav(fs.readFileSync(dl.filename)) };
}

before(async () => {
  server = await startTrackServer();
  h = await launchExtension({ ext: prepareExtension() });
  for (const k of ['a', 'b']) { tabs[k] = await h.context.newPage(); await tabs[k].goto(server.url(k)); }
  deck = await openExtPage(h, 'deck.html');
  for (const k of ['a', 'b']) {
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: await tabIdFor(h, server.url(k)) });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  await installClient(deck);
});
after(async () => { await h?.close(); await server?.close(); });

test('two tabs load as cued decks and start buffering', async () => {
  const s = await state(deck);
  assert.equal(s.decks.length, 2);
  for (const d of s.decks) assert.equal(d.playing, false);
  await sleep(1500);
  const s2 = await state(deck);
  for (const d of s2.decks) assert.ok(d.liveEdge > 1 && d.reserve > 0.5, JSON.stringify({ liveEdge: d.liveEdge, reserve: d.reserve }));
  assert.equal(await deck.locator('.deck').count(), 2);
});

test('tempo locks on both decks', async () => {
  await waitFor(async () => {
    const s = await state(deck);
    const a = deckBy(s, 1), b = deckBy(s, 2);
    return a.bpm.state === 'LOCKED' && b.bpm.state === 'LOCKED' && Math.abs(a.bpm.native - 124) < 0.3 && Math.abs(b.bpm.native - 128) < 0.3;
  }, 25000);
});

test('SYNC PLAY matches tempo and phase to the master', async () => {
  assert.equal((await act(deck, 2, 'master')).ok, true);
  assert.equal((await act(deck, 2, 'play')).ok, true);
  await sleep(1000);
  assert.equal((await act(deck, 1, 'sync', { on: true })).ok, true);
  assert.equal((await act(deck, 1, 'syncPlay')).ok, true);
  await sleep(6000);
  const s = await state(deck);
  const a = deckBy(s, 1);
  assert.equal(s.clock.mode, 'deck');
  assert.ok(Math.abs(a.params.pitch - (128 / 124 - 1)) < 0.0025, `pitch ${a.params.pitch}`);
  assert.ok(Math.abs(a.bpm.out - s.clock.bpm) < 0.02, `out ${a.bpm.out} vs clock ${s.clock.bpm}`);
  assert.ok(Math.abs(a.bpm.out - 128) < 0.3, `out ${a.bpm.out}`);
  const ph = [];
  for (let i = 0; i < 10; i++) { const d = deckBy(await state(deck), 1); if (d.sync.phaseMs != null) ph.push(Math.abs(d.sync.phaseMs)); await sleep(200); }
  ph.sort((x, y) => x - y);
  assert.ok(ph.length && ph[Math.floor(ph.length / 2)] < 15, `phase ${JSON.stringify(ph)}`);
});

test('the mix recording has both decks at 128 BPM with aligned beats', async () => {
  const { wav } = await record('mix', 8);
  assert.ok(wav.seconds > 7 && wav.sr > 0);
  const lo = bandOnsets(wav.mono, wav.sr, 'low'), hi = bandOnsets(wav.mono, wav.sr, 'high');
  assert.ok(Math.abs(medianBpm(lo) - 128) < 1, `low ${medianBpm(lo)}`);
  assert.ok(Math.abs(medianBpm(hi) - 128) < 1, `high ${medianBpm(hi)}`);
  const offs = lo.map((t) => Math.min(...hi.map((u) => Math.abs(u - t)))).sort((x, y) => x - y);
  const med = offs[Math.floor(offs.length / 2)] * 1000;
  assert.ok(med < 25, `median beat offset ${med.toFixed(1)} ms`);
});

test('crossfader isolates A from B', async () => {
  set(deck, 1, 'xf', 'A'); set(deck, 2, 'xf', 'B'); set(deck, null, 'xfader.pos', 0.5);
  await sleep(300);
  const both = await record('mix', 3);
  set(deck, null, 'xfader.pos', 1);
  await sleep(300);
  const onlyB = await record('mix', 3);
  const drop = 20 * Math.log10(bandRms(onlyB.wav.mono, onlyB.wav.sr, 'low') / bandRms(both.wav.mono, both.wav.sr, 'low'));
  assert.ok(drop < -30, `A drop ${drop.toFixed(1)} dB`);
  set(deck, null, 'xfader.pos', 0.5); set(deck, 1, 'xf', 'THRU'); set(deck, 2, 'xf', 'THRU');
});

test('low kill removes the kick from the deck recording', async () => {
  const on = await record(1, 3);
  set(deck, 1, 'kill.low', true);
  await sleep(200);
  const killed = await record(1, 3);
  set(deck, 1, 'kill.low', false);
  const drop = 20 * Math.log10(bandRms(killed.wav.mono, killed.wav.sr, 'low') / bandRms(on.wav.mono, on.wav.sr, 'low'));
  assert.ok(drop < -25, `low drop ${drop.toFixed(1)} dB`);
  assert.match(path.basename(on.dl.filename), /^JDSamps-D1-Track A 124 BPM-\d{8}-\d{6}.*\.wav$/);
});

test('the limiter holds the master under -1 dBFS with +12 dB trims', async () => {
  set(deck, 1, 'trim', 1); set(deck, 2, 'trim', 1);
  await sleep(500);
  const { wav } = await record('mix', 3); // the mix tap is after the limiter: check every sample
  set(deck, 1, 'trim', 0.5); set(deck, 2, 'trim', 0.5);
  let peak = 0;
  for (const x of wav.mono) peak = Math.max(peak, Math.abs(x));
  assert.ok(peak <= 10 ** (-1 / 20) + 2 / 32768, `peak ${peak}`);
  assert.ok(peak > 0.8, `peak ${peak} (limiting engaged)`);
  const gr = Math.min(...(await Promise.all([0, 1, 2, 3, 4].map(() => state(deck)))).map((s) => s.master.gr));
  assert.ok(gr <= 0, `gr ${gr}`);
});

test('player assist refills the reserve on a media-element page', async () => {
  // LIVE leaves ~0.6 s of reserve; deck 1 must run +3.2 %, so assist has to keep it fed.
  assert.equal((await act(deck, 1, 'live')).ok, true);
  await waitFor(async () => (await tabs.a.evaluate(() => window.__media())).rate > 1.01, 15000, 250);
  const m = await tabs.a.evaluate(() => window.__media());
  assert.equal(m.pp, false);
  await sleep(1500); // the LIVE jump lands ~0.15 s after the call; let it settle
  const d0 = deckBy(await state(deck), 1);
  assert.equal(d0.assist.active, true);
  assert.ok(d0.reserve < 3, `reserve after LIVE ${d0.reserve}`);
  await sleep(6000);
  const d1 = deckBy(await state(deck), 1);
  assert.ok(d1.reserve > d0.reserve, `reserve ${d0.reserve} -> ${d1.reserve}`);
  assert.equal(d1.starved, false);
  assert.ok(Math.abs(d1.bpm.out - 128) < 0.4, `out ${d1.bpm.out}`);
  assert.ok(Math.abs(d1.bpm.native - 124) < 0.4, `native ${d1.bpm.native}`);
  // Phase lock is regained after the LIVE jump while assist runs: median of 5 readings < 15 ms.
  const recent = [];
  await waitFor(async () => {
    const p = deckBy(await state(deck), 1).sync.phaseMs;
    if (p != null) recent.push(Math.abs(p));
    const last = recent.slice(-5).sort((x, y) => x - y);
    return last.length === 5 && last[2] < 15;
  }, 15000, 300);
});

test('a Web-Audio-only page has no assist and the reserve stays protected', async () => {
  tabs.c = await h.context.newPage();
  await tabs.c.goto(server.url('c'));
  await sleep(500);
  assert.equal((await hubCall(deck, { type: 'LOAD_TAB', tabId: await tabIdFor(h, server.url('c')) })).ok, true);
  const early = await act(deck, 3, 'sync', { on: true }); // the tracker needs >= 4 s of audio first
  assert.equal(early.ok, false);
  assert.match(early.error, /No BPM yet/);
  await waitFor(async () => { const d = deckBy(await state(deck), 3); return d && d.bpm.state === 'LOCKED'; }, 25000);
  await act(deck, 3, 'live');
  assert.equal((await act(deck, 3, 'sync', { on: true })).ok, true);
  assert.equal((await act(deck, 3, 'play')).ok, true);
  // Needs +6.7 % with no player to drive: the small LIVE reserve drains, then the deck is held at 1×.
  await waitFor(async () => deckBy(await state(deck), 3).starved, 20000, 250);
  await sleep(600); // the 1x clamp is scheduled ~0.15 s ahead and reported at the heard time
  for (let i = 0; i < 10; i++) {
    const d = deckBy(await state(deck), 3);
    assert.equal(d.assist.available, false);
    assert.equal(d.playing, true);
    assert.equal(d.starved, true);
    assert.ok(d.reserve >= 0 && d.engineRate <= 1.0001, JSON.stringify({ reserve: d.reserve, rate: d.engineRate }));
    await sleep(200);
  }
});

test('reloading the deck page keeps the engine playing', async () => {
  const before = deckBy(await state(deck), 2).playhead;
  const t0 = Date.now();
  await deck.reload();
  await deck.waitForSelector('.deck >> nth=2', { timeout: 10000 });
  await installClient(deck);
  const after = deckBy(await state(deck), 2).playhead;
  assert.ok(after - before > (Date.now() - t0) / 1000 - 0.8, `playhead ${before} -> ${after}`);
  fs.mkdirSync(ART, { recursive: true });
  await sleep(500);
  await deck.screenshot({ path: path.join(ART, 'e2e-deck.png') });
});

test('closing a recording tab saves its recording and frees the master clock', async () => {
  const known = await downloadIds(h);
  assert.equal((await act(deck, 2, 'recStart')).ok, true);
  await sleep(2000);
  await tabs.b.close();
  const dl = await waitForDownload(h, known, 15000);
  assert.match(path.basename(dl.filename), /^JDSamps-D2-/);
  const wav = parseWav(fs.readFileSync(dl.filename));
  assert.ok(wav.seconds > 1.5, `seconds ${wav.seconds}`);
  await waitFor(async () => (await state(deck)).decks.length === 2, 8000);
  assert.equal((await state(deck)).clock.mode, 'free');
});

test('stop all ejects everything; no engine errors were reported', async () => {
  assert.equal((await act(deck, null, 'stopAll')).ok, true);
  await waitFor(async () => (await state(deck)).decks.length === 0, 8000);
  const errs = (await events(deck)).filter((e) => e.level === 'error');
  assert.deepEqual(errs, []);
});
```

- [ ] **Step 3: Add the script and run every suite**

In `package.json`, set `"scripts"` to:

```json
{
  "test:unit": "node --test \"tests/unit/*.test.mjs\"",
  "test:browser": "node --test --test-concurrency=1 tests/browser/offline.test.mjs tests/browser/ui-controls.test.mjs tests/browser/ui-app.test.mjs tests/browser/agent.test.mjs tests/browser/hub.test.mjs",
  "test:e2e": "node --test --test-concurrency=1 tests/browser/e2e.test.mjs",
  "test": "npm run test:unit && npm run test:browser && npm run test:e2e"
}
```

Run: `npm test`
Expected: every suite passes. Look at `tests/browser/artifacts/e2e-deck.png`, which shows the
real engine driving the UI.

- [ ] **Step 4: Rewrite `README.md`**

```markdown
# JD Samps

*made by godspee*

A DJ deck for your browser. Load any tab that plays audio onto a **deck**, beat-sync decks
**on the audio itself**, shape them with a DJ isolator EQ and per-deck effects, mix with a
crossfader and record everything, from one full-page performance surface.

## Features

- **Up to 6 decks**, one per captured tab, each with its own colour, waveform and controls.
- **Audio-based BPM sync** (works with any site's player):
  - each deck keeps a time-shift buffer of its tab's audio and plays it through a
    high-quality time-stretcher (Signalsmith Stretch);
  - **SYNC** matches tempo (half/double aware) and locks phase; **MASTER** picks the tempo
    master; **SYNC PLAY** starts exactly on the next master beat;
  - **KEY** lock, tempo fader with ±6/10/16 % and WIDE ranges, nudge, ½× / 2×, TAP tempo
    and GRID ±½ beat.
- **Deck transport for every source:**
  - decks load **cued** and keep buffering while you prepare;
  - CUE (CDJ style: hold to preview), PLAY/PAUSE, LIVE (jump to the newest audio);
  - ROLL pads (1/8–1 beat) that slip back in time when released.
- **Player assist:**
  - a deck can only play faster than its source while it has buffered audio in reserve
    (shown as the RESERVE gauge);
  - on YouTube, SoundCloud, Bandcamp, Mixcloud and other sites with a normal media player,
    JD Samps quietly runs the tab's own player slightly faster to keep that reserve topped up;
  - sync itself never depends on the player.
- **3-band isolator EQ** per deck (Linkwitz–Riley, 250 Hz / 2.5 kHz): knobs from silence up
  to +6 dB, and **KILL** buttons that remove a band completely.
- **FX** per deck:
  - one-knob **FILTER** (low-pass ↔ high-pass);
  - a Beat FX slot: ECHO, REVERB, GATE, FLANGER or CRUSH, synced to the deck's tempo.
- **Mixer:**
  - channel faders;
  - **crossfader** with an A / THRU / B assign per deck and SMOOTH or SHARP curves;
  - master volume, a brickwall **limiter** at −1 dBFS, L/R meters with clip lights.
- **Recording:**
  - any deck (after FX, before the fader) or the full mix (after the limiter);
  - WAV (streamed, flat memory) or WebM;
  - saved automatically via Downloads.
- **Built for live use:**
  - full-page deck that keeps running if you close or reload it;
  - keyboard shortcuts (press `?`);
  - hold-to-eject, Stop All confirmation, screen kept awake;
  - automatic reconnection.

## Install (developer mode)

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Pin JD Samps.

Chrome 119 or newer is required.

## Use

1. Open a track in a tab (YouTube, SoundCloud, Bandcamp, Mixcloud…).
2. **Click the JD Samps icon on that tab.** You can also press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>
   or right-click → *Add this tab to JD Samps*. The tab loads onto the next free deck and the
   deck page opens.
   - Chrome only lets an extension capture a tab after you invoke it on that tab, so tabs in
     **Sources** that you haven't invoked show **Go to tab**.
3. The deck is **cued** and buffering. Press **PLAY**, or **SYNC PLAY** to drop it in on the
   beat of the master deck.
4. Use **SYNC** and **MASTER** to beat-match, then the EQ, FILTER, FX, faders and crossfader
   to mix.
5. Press **REC** on a deck or **REC MIX** in the top bar to record.

### Keyboard

| Keys | Action |
|---|---|
| `1`–`6` | Select deck |
| `Space` | Play / pause |
| `Shift+Space` | SYNC PLAY |
| `C` | Cue (hold to preview) |
| `S` | Sync |
| `Shift+S` | Master |
| `K` | Key lock |
| `T` / `Shift+T` | Tap tempo / mark beat 1 |
| `Q` / `A` / `Z` | Kill high / mid / low (tap = toggle, hold = momentary) |
| `←` `→` | Nudge (hold) |
| `↑` `↓` | Tempo ±0.1 % |
| `F` | FX on |
| `V` `B` `N` `M` | Roll 1/8, 1/4, 1/2, 1 beat (hold) |
| `[` / `]` / `\` | Crossfader left / right / centre |
| `R` | Record deck |
| `Shift+R` | Record mix |

## Notes and limits

- **Reserve.**
  - Slowing a deck down always works.
  - Speeding it up uses buffered audio: about 2 s of reserve per minute at +3 %.
  - Where a site's player can't be driven (Web-Audio-only players), a deck whose reserve runs
    out plays at the source's speed and shows **RESERVE EMPTY** until the reserve refills.
    Pause or cue a deck to build reserve.
- **Real-world tempo.** BPM detection is tuned for music with a steady beat. Rubato or live
  recordings may stay **UNSURE**; use TAP and GRID.
- **Resources.** Each deck keeps up to 4 minutes of audio (Settings → Deck buffer), about
  21 MB per minute, and uses roughly 4–5 % of one CPU core for time-stretching.
- **Site access.** JD Samps asks for access to all sites only to drive tab players for
  player assist. Capture, sync, EQ and FX work on the audio.

## Development

- `npm run test:unit`: tempo tracking, sync maths, playhead model, recorder, protocol (Node).
- `npm run test:browser`: offline Web Audio graphs, UI against a fake engine, agent, hub
  (headless Chromium).
- `npm run test:e2e`: the real extension with captured tabs, sync, assist, recording, mixing.

Uses [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) (MIT), vendored with
a streaming fix. See `vendor/signalsmith-stretch/README.md`.
```

- [ ] **Step 5: Delete the v1 files and commit**

```bash
git rm popup.html popup.css popup.js offscreen.js recorder-worklet.js
git add tests/browser/ext-harness.mjs tests/browser/e2e.test.mjs README.md package.json
git commit -m "Add end-to-end suite and harness, rewrite README, remove v1 popup and engine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01489sELJLyt5c1K8Q86H6QU"
```

---

## Task 15: Whole-branch verification

- [ ] **Step 1: Run every suite from a clean checkout of the branch**

Run: `npm test`
Expected: all unit, browser and E2E suites pass.

- [ ] **Step 2: Manifest and package sanity**

Run: `node -e "const m=require('./manifest.json');console.log(m.version,m.minimum_chrome_version,m.permissions.join(','))"`
Expected: `2.0.0 119 tabCapture,offscreen,tabs,downloads,storage,scripting,contextMenus`

Run: `git ls-files | grep -E 'popup|recorder-worklet|^offscreen.js' || echo clean`
Expected: `clean`

- [ ] **Step 3: Visual review**

Open `tests/browser/artifacts/deck-ui-1440x900.png`, `deck-ui-empty.png` and `e2e-deck.png`.
Check them against spec §3.9. Fix anything that is clipped, overlapping or unreadable.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin claude/jdsamps-v2-deck
```
