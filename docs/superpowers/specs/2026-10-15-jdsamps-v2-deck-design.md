# JD Samps v2 — Performance Deck: Design Spec

Date: 2026-10-15 · Status: approved in conversation, pending written-spec review

## 1. Purpose

JD Samps captures audio from browser tabs. v2 turns it into a **live DJ performance tool**:
each captured tab becomes a *deck* with audio-based BPM sync, a 3-band isolator EQ, per-deck
effects, a crossfader and a master section, all driven from a **full-page deck UI** instead of
the popup.

Success means a DJ can open YouTube, SoundCloud, Bandcamp or Mixcloud tracks in tabs, load
each one onto a deck, beat-match them with one SYNC press, and mix them with EQ, FX and the
crossfader through a whole set, without the UI closing, the engine running out of memory or
the recording clipping silently.

### 1.1 Decisions made with the user

| Topic | Decision |
|---|---|
| Target sites | YouTube, SoundCloud, Bandcamp, Mixcloud. Any other site works through the audio path. |
| BPM matching | **Based on the captured audio, not the player.** Every deck is a time-shift buffer played through a time-stretcher. |
| Speed-up reserve | **Audio plus player assist.** Sync always runs on the audio. Where a site's media element can be driven, the engine plays the source slightly faster in the background to refill the deck's reserve. |
| New deck state | **Load cued.** The deck holds and buffers; PLAY or SYNC-PLAY brings it in. |
| Site permission | Granted at install (`host_permissions: <all_urls>`), used only for player assist. |
| Toolbar icon | Opens the full-page deck directly. No popup. |
| Extras in scope | Crossfader and master section (volume, limiter, meter). Headphone cue and MIDI are out of scope. |

### 1.2 Non-goals

- Headphone cue / second output device, MIDI mapping, sample pads, track library.
- Automatic downbeat detection. A manual "tap 1" / grid shift is provided instead.
- Spotify-specific handling beyond the generic audio path.

## 2. Platform constraints that shape the design

These were verified against Chromium source and/or in headless Chromium 141; details are in the
research notes.

1. **Tab capture needs a per-tab user gesture.** `tabCapture.getMediaStreamId({targetTabId})`
   succeeds only for tabs holding Chrome's internal `tabCaptureForTab` grant. Only an action
   click, a keyboard command or a context-menu click on that tab grants it. Host permissions do
   not. The grant survives same-origin navigation and is lost on cross-origin navigation or tab
   close. Stream IDs are single-use and expire after about 10 s.
2. **A live stream cannot play faster than real time.** Playing a deck faster than the source
   consumes buffered audio. Slowing down builds it up.
3. **Offscreen documents only get `chrome.runtime`.** Tabs, scripting and downloads stay in the
   service worker.
4. **Extension CSP.** WASM needs `'wasm-unsafe-eval'` in `extension_pages`. `blob:` worklet
   modules are not allowed, so every worklet is loaded from a packaged file.
5. **Media element rate** (assist only). The valid range is 0.0625–16. Rates within about
   ±0.1% of 1.0 are silently treated as 1.0 when `preservesPitch` is true. Changing
   `preservesPitch` while playing can pop.
6. **Web Audio biquad Q** for `lowpass`/`highpass` is in dB. A Butterworth stage is
   `Q = -3.0103`, not 0.7071.

## 3. Architecture

```
 toolbar click / Alt+Shift+A / context menu
             │ (grants tab capture for that tab)
             ▼
 ┌──────────────────────┐  START{streamId}   ┌─────────────────────────────────────────┐
 │ background.js (SW)   │ ─────────────────► │ offscreen engine (engine/*.js)          │
 │ capture grants,      │ ◄── DOWNLOAD ────  │  AudioContext, decks, master, sync,     │
 │ tab list, assist     │ ◄── ASSIST cmd ──  │  recorders; source of truth for state   │
 │ injection, downloads │                    └──────▲───────────────────────▲──────────┘
 └──────┬───────────────┘                           │ port 'jds-ui'         │ port 'jds-agent'
        │ opens/focuses                              │ (state 30 Hz,         │ (media status,
        ▼                                            │  waveform, commands)  │  rate commands)
 ┌──────────────────────┐                            │                ┌──────┴───────────────┐
 │ deck.html (UI page)  │ ───────────────────────────┘                │ tab agent (content   │
 │ decks, master, xfade │                                             │ scripts, MAIN+ISOL.) │
 └──────────────────────┘                                             └──────────────────────┘
```

- **The engine stays in the offscreen document,** so closing or reloading the deck page never
  stops the music.
- **The deck UI connects to the engine directly** with `chrome.runtime.connect({name:'jds-ui'})`.
  No polling through the service worker. The UI reconnects automatically if the port drops.
- **The tab agent connects to the engine directly** (`jds-agent` port, verified). The engine
  asks the service worker to inject or poke the agent.

### 3.1 Adding tabs

- **`chrome.action.onClicked(tab)`:** if `tab` is a capturable http(s) page that isn't already
  on a deck, capture it as a new cued deck. In every case, open the deck page or focus it if
  it's already open. Clicking the icon while the deck page is the active tab only focuses it.
- **`commands`:** `add-tab` (suggested Alt+Shift+A) does the same as the action click, without
  stealing focus if the deck is already open.
- **`contextMenus`:** "Add this tab to JD Samps" (contexts page, frame, audio, video), same
  behaviour as the command.
- **Grant tracking:** the service worker records invoked tabs in `chrome.storage.session` and
  drops them on cross-origin navigation or close. The deck's **Sources** drawer lists open tabs:
  - granted tabs get **Load**;
  - other tabs get **Go to tab** plus a hint ("click the JD Samps icon there, or press
    Alt+Shift+A").
- **Errors are actionable,** for example "Already on deck 2", "Chrome pages can't be captured",
  "Click the icon on that tab first".
- The service worker never mints a stream ID for a tab that is already captured. That avoids
  the "active stream" error.

### 3.2 Deck model: a time-shift buffer

```
tab MediaStream ─► MediaStreamSource ─► deck-input worklet ──(stereo chunks, ODF, wave bands)──► engine main
                                                                                                    │ addBuffers
                                                                       Signalsmith Stretch node ◄───┘
                                                                       (buffer mode: input position,
                                                                        rate, semitones, loops)
                                                                                 │
   trim ─► EQ isolator ─► filter ─► beatfx worklet (gate, crush) ─► mod (flanger) ─► pre-fader bus ─┬─► deck recorder
                                                                                                    ├─► echo send ─► echo ─┐
                                                                                                    ├─► verb send ─► verb ─┤
                                                                                                    └────────────── dry ───┴─► channel fader ─► xfader gain ─► master bus
```

Echo and reverb returns sit before the channel fader, so the fader controls the whole channel,
and the sends are post-FX-insert. Echo-out and reverb tails keep ringing after the effect is
switched off.

- **Input timeline.** Seconds of captured audio since the deck was loaded. The deck-input
  worklet counts samples exactly; all beat-grid maths uses this timeline.
- **Playhead.** The stretch node's input position. The engine keeps a piecewise-linear model
  `p(t_out)` from everything it schedules (rate changes, jumps, loops) and checks it against the
  node's reported `inputTime`.
- **Live edge.** The end of buffered input. **Reserve** = live edge − playhead − safety margin
  (the stretcher's latency plus one chunk). The playhead never runs into the live edge: when the
  reserve hits zero the deck rate is clamped to ≤ 1.0 and a warning is shown.
- **Memory bound.** Up to 4 minutes of stereo audio per deck (configurable), about 90 MB at
  48 kHz in float32. Audio more than 60 s behind the playhead is dropped (`dropBuffers`). If a
  paused deck's reserve reaches the cap, the cue/playhead is pushed forward, ring-buffer style,
  and the user is told.
- **Transport** (engine-level; works for every source):
  - **PLAY / PAUSE.** Pausing stops the playhead while buffering continues.
  - **CUE**, CDJ style. While paused, CUE sets the cue point. While playing, CUE jumps back to
    the cue point and pauses. Holding CUE while paused previews from the cue point and returns
    on release.
  - **SYNC-PLAY.** Starts the deck exactly on the next master beat, phase-aligned (scheduled with
    sample accuracy).
  - **LIVE.** Jumps to the live edge (minimum latency).
  - **Auto-cue on load.** The cue point is the first audible sample, moved to the first grid
    beat once BPM locks.
- **Key lock (KEY)** is on by default. Engine pitch shift: `semitones = keyLock ?
  -12·log2(sourceRate) : 12·log2(deckRate)`, where `sourceRate` is the assist rate (§3.4).
- **Stretcher:** Signalsmith Stretch 1.3.2, vendored with a two-line fix. The probe found its
  buffer-streaming mode reads wrong samples (or kills the node) whenever its read window spans
  two `addBuffers()` chunks, and upstream HEAD still has the bug. It loads under MV3 with
  `'wasm-unsafe-eval'`. Measured costs:
  - about 0.12 s total latency;
  - about 4.5 % of one core per deck;
  - its playhead model `p(t) = input + rate·(t − output)` is accurate to about 2 ms.
  It allows only one pending scheduled change at a time, and the engine respects that.

### 3.3 BPM, beat grid and SYNC

This uses the algorithm validated by the research prototype (11 synthetic genres: BPM within
0.03, phase within ±2 ms mean, first lock about 5 s).

- **Onset detection function (ODF), in the deck-input worklet** on the input (before the
  stretcher, so it measures the source's own tempo):
  - decimate to 12 kHz, 512-point FFT, hop 128;
  - SuperFlux-lite spectral flux, plus a kick-weighted low-band flux;
  - frames batched to the main thread (about 12 messages/s) with exact input-timeline stamps;
  - no allocation inside `process()`.
- **TempoTracker (pure JS, unit-tested):**
  - autocorrelation over 8 s;
  - 4-harmonic comb on a 0.05 BPM grid from 55 to 220;
  - log-Gaussian prior centred on 120;
  - octave fold into the BPM range setting (Auto 70–180, or one-octave presets);
  - lock with hysteresis;
  - fine tempo from least-squares regression on beat times.
  - Confidence states: SEARCH, LOCKED, UNSURE, HOLD.
- **BeatClock / grid.** The anchor `t0` and period `T` live on the input timeline, smoothed by
  a PLL that rejects outliers. Manual tools: **½× / 2×**, **TAP** (median of the last 8 taps),
  **GRID ◀ ▶** (shift by ±½ beat or ±10 ms), and **TAP 1** to set the downbeat for a bar counter.
- **Deck phase** at output time `t` = `((p(t) − t0) / T) mod 1`. This is exact given the grid,
  because the engine owns the playhead.
- **Master clock** (Traktor model):
  - **MASTER** makes a deck the clock source.
  - Pressing **SYNC** with no master picks the best playing, locked deck.
  - If the master pauses or is ejected, the clock goes **free**: it keeps its tempo and phase.
  - Moving a synced deck's tempo fader turns its SYNC off.
- **SYNC on deck S:**
  - `m*` ∈ {½, 1, 2} minimises `|log2(B_master·m / S.bpm)|`, then `S.rate = B_master·m* / S.bpm`
    (half/double aware).
  - If `|rate − 1|` exceeds the deck's range (±6/±10/±16/WIDE = 50%), S is clamped and marked
    out of range.
  - **BEAT mode** (default) also locks phase. **TEMPO mode** matches rate only.
- **How phase is aligned:**
  - Deck **paused/cued:** the playhead is moved directly before play, so SYNC-PLAY lands exactly
    on the beat.
  - Deck **playing and audible:** a timed rate bend of up to ±4% (key lock) or ±2% (vinyl), with
    duration chosen so `bend × duration = phase error`. Each step is scheduled on the audio clock
    through the stretch node, so there is no messaging jitter.
  - Deck **playing but silent** (fader or crossfader at zero): a direct playhead jump with a
    short crossfade.
  - A continuous loop holds lock (dead band 3 ms).
- **Nudge ◀ ▶:** hold to bend ±4% (Shift: ±1%). In BEAT sync, the phase loop pauses while held
  and then re-locks.

### 3.4 Player assist (refilling the reserve)

- **Agent:** two content scripts declared in the manifest, `document_start`, `all_frames`,
  `match_origin_as_fallback`, `<all_urls>`:
  - `agent-main.js` (MAIN world) wraps `HTMLMediaElement.prototype.play/pause/load` to register
    every media element, including detached `new Audio()` instances, and applies rate commands;
  - `agent-relay.js` (ISOLATED world) bridges it to the engine port with CustomEvents.
- Tabs opened before install or reload get the same files injected on load via
  `scripting.executeScript`.
- The agent is passive until a deck asks. It never reports page content beyond media status:
  rate, paused, presence, `ratechange` cause. Everything it sends is validated as untrusted.
- **Policy** (engine, pure function, unit-tested):
  - **Engage** when a playing deck has rate > 1 and reserve < 8 s: ramp the source's
    `playbackRate` in 0.25% steps up to `deckRate + 0.03` (capped at 1.25).
  - **Disengage** (ramp back to 1.0) when reserve > 20 s or the deck rate ≤ 1.
  - Source `preservesPitch` is set to **false**, which uses Chrome's clean resampler, and the
    engine compensates pitch (§3.2).
  - Every source-rate step is reported to the TempoTracker and grid (`rateChanged`), so BPM and
    phase stay continuous.
- If no controllable media element is found, the deck shows **ASSIST n/a** and works from the
  reserve alone.

### 3.5 EQ (per deck)

- 3-band **Linkwitz–Riley isolator** with crossovers at 250 Hz and 2.5 kHz:
  - LR4 low-pass and high-pass stages are cascaded biquads (`Q = -3.0103`);
  - an allpass at 2.5 kHz (`Q = 0.7071`) phase-compensates the low band.
- The bands sum flat (±0.00 dB, verified numerically).
- Knob law: centre = 0 dB, right end = +6 dB, left side = `(2k)^3`, so the left end is −∞.
- **KILL** per band ramps in 5 ms. Kill depth is ≥ 30 dB in-band.
- All parameter changes use `setTargetAtTime`, which removes the zipper noise.
- The **GAIN** trim knob (−∞ to +12 dB) sits in front.

### 3.6 FX (per deck)

- **FILTER** knob on every deck:
  - one-knob DJ filter: low-pass to the left, high-pass to the right;
  - dead zone at centre;
  - 4-pole response with a resonance setting.
- **Beat FX slot:** pick one of ECHO, REVERB, GATE, FLANGER, CRUSH. Controls: beat length
  (1/16 to 2 beats, effect-dependent), LEVEL/DEPTH, and ON (tap = latch, hold = momentary).
  - **ECHO:** tempo-synced delay with filtered feedback and saturation; send/return, so trails
    ring out.
  - **REVERB:** convolver with a generated impulse (Room, Hall, Wash), send/return. It is built
    when first used and torn down after its tail.
  - **GATE:** a 16-step pattern from the beatfx worklet, sample-locked to the grid.
  - **FLANGER:** feed-forward, with the LFO period in beats re-phased on a beat.
  - **CRUSH:** bit depth and sample-rate reduction in the beatfx worklet.
- **ROLL pads** 1/8, 1/4, 1/2, 1 beat (hold):
  - loop the deck's own input buffer between grid lines (`loopStart/loopEnd` on the stretch
    node);
  - on release, return in slip mode to where the track would have been;
  - without a beat lock, fall back to millisecond loops.
- None of these effects add latency to the dry path, so engaging FX never shifts a deck's phase.

### 3.7 Crossfader and master

- Each deck gets an assign switch **A / THRU / B**.
- **Crossfader** curves:
  - **SMOOTH** (equal power, the default);
  - **SHARP** (full level until about 5% from the far end, then a fast cut);
  - each deck's crossfader gain ramps over 10 ms.
- **Master:** volume knob, then **LIMITER**, then the destination. The limiter is a 5 ms
  lookahead brickwall worklet with a −1 dBFS ceiling and 100 ms release, and can be switched
  off.
  - It is not a DynamicsCompressor: the Web Audio compressor applies automatic makeup gain,
    so it cannot guarantee a ceiling.
  - The same worklet produces the true per-channel meters and the engine's throttle-proof
    tick.
  - It shows gain-reduction metering and an L/R peak + RMS meter.
  - Clip lights latch for 2 s, then clear; clicking clears them immediately.
- Each deck meter shows post-fader level, and its clip light is reset the same way.

### 3.8 Recording

- **Per-deck REC** taps the deck after FX and before the fader. **Mix REC** taps the master
  after the limiter, so the file matches what was heard.
- **WAV:**
  - the recorder worklet converts to interleaved Int16 in a preallocated buffer and transfers
    batches;
  - the engine appends each batch as a Blob part and builds the header from a frame counter
    at stop;
  - memory stays flat, the main thread is never blocked, and files roll over before 4 GB.
- **WebM:** MediaRecorder with a timeslice. The recording state machine is explicit
  (idle → recording → finalising → idle), with try/finally and an error event if something
  fails.
- Downloads go through the service worker with sanitised filenames
  (`JDSamps-<deck>-<title>-<stamp>.wav`). Download failures are reported to the UI. Blob URLs
  are revoked only after the download completes or fails.

### 3.9 Deck UI (`deck.html`)

The layout is designed for a laptop screen of 1280–1920 px, landscape.

```
┌ JD SAMPS ▸ [Sources] ───── MASTER CLOCK 128.00 ▸ ◉ REC MIX  [WAV]  ⏻ ───── engine ok · 48 kHz ┐
│┌ DECK 1 ───────────┐┌ DECK 2 ───────────┐┌ DECK 3 ┐┌ DECK 4 ┐  ┌ MASTER ──────┐                │
││ ▣ title           ││                   ││        ││        │  │ L▮▮▮ R▮▮▮    │                │
││ 128.0 BPM  +1.56% ││   scrolling 3-band waveform, centred  │  │ GR −1.2 dB   │                │
││ ●●●● reserve 22s  ││   on the playhead, beat grid lines,   │  │ (VOL)        │                │
││ waveform+grid     ││   upcoming audio shown up to live     │  │ LIMIT ON     │                │
││ [CUE][▶][SYNC▶]   ││   edge                                │  │ REC MIX ◉    │                │
││ [SYNC][MASTER]KEY ││                                       │  │ format · curve│               │
││ ½× 2× TAP GRID◀▶  │└───────────────────┘└────────┘└────────┘  └──────────────┘                │
││ TEMPO ═══╪═══ ±8 ││                                                                          │
││ (GAIN)(HI)(MID)(LO) + KILLs                                                                  │
││ (FILTER)  FX[ECHO▾] 1/2  (LVL) [ON]   ROLL [1/8][1/4][1/2][1]                                 │
││ meter ▮  fader ┃   A | THRU | B   REC ◉   ⏏                                                   │
│└───────────────────┘                                                                          │
│                              A ◀════════ CROSSFADER ════════▶ B                               │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Visual language:**
  - near-black background with high-contrast text;
  - one accent colour per deck (1 cyan, 2 amber, 3 magenta, 4 lime, 5 orange, 6 blue);
  - large tabular-number BPM readouts and beat LEDs;
  - lit states with glow for ON, SYNC, MASTER and REC;
  - no emoji: inline SVG icons plus text labels;
  - minimum hit target 32 px.
- **Controls:**
  - knobs and faders: vertical drag, Shift for fine moves, scroll wheel, double-click to reset,
    arrow keys when focused;
  - each has `role="slider"` with `aria-valuetext`;
  - drag updates are sent to the engine at most once per frame.
- **Rendering:**
  - one requestAnimationFrame loop draws every canvas (waveforms, meters, LEDs);
  - the playhead is extrapolated from the engine clock between 30 Hz snapshots;
  - canvases are sized for the device pixel ratio;
  - DOM nodes are updated only when their values change.
- **Waveform:** 3-band (low, mid, high) energy per ODF hop, sent incrementally. It scrolls
  centred on the playhead, with beat-grid lines and bar numbers. Audio buffered ahead of the
  playhead is drawn, and the live edge is marked.
- **Keyboard** (a `?` overlay lists everything):

  | Key | Action |
  |---|---|
  | 1–6 | select deck |
  | Space | play/pause |
  | Shift+Space | SYNC-PLAY |
  | C | CUE |
  | S | SYNC |
  | Shift+S | MASTER |
  | K | KEY |
  | Q / A / Z | kill HIGH / MID / LOW (toggle) |
  | ← / → | nudge (hold) |
  | ↑ / ↓ | tempo ±0.1% |
  | F | FX on (hold = momentary) |
  | V / B / N / M | roll 1/8, 1/4, 1/2, 1 (hold) |
  | [ / ] | crossfader left / right |
  | \ | crossfader centre |
  | R | record deck |
  | Shift+R | record mix |
  | T | tap tempo |

- **Safety:**
  - STOP ALL needs a confirmation;
  - `beforeunload` warns while decks are loaded;
  - Screen Wake Lock is held while decks are loaded;
  - space and keys never trigger a focused button twice;
  - every page-derived string is set through `textContent`;
  - favicons are assigned to `img.src` only after a URL check, with no inline handlers.
- **Settings** (`chrome.storage.local`), each with a default:
  - record format;
  - crossfader curve;
  - default pitch range;
  - BPM range;
  - limiter on;
  - buffer cap;
  - assist on.
- **Engine-down state:** a banner that reconnects automatically. The UI re-reads the full state
  on connect.

### 3.10 Files

```
manifest.json                 v2.0.0; no popup; permissions: tabCapture, offscreen, tabs, downloads,
                              storage, scripting, contextMenus; host_permissions <all_urls>;
                              commands; content_scripts (agent); CSP with 'wasm-unsafe-eval';
                              minimum_chrome_version 116
background.js                 service worker hub
offscreen.html                loads engine/engine.js (type=module)
engine/engine.js              context, deck registry, ports, protocol dispatch, state snapshots
engine/deck.js                Deck: capture source, timeshift + stretch, chain, transport
engine/timeshift.js           buffer feeding, playhead model, reserve, loops, scheduling
engine/tempo.js               TempoTracker + BeatClock (pure)
engine/sync.js                master clock, sync maths, phase controller, assist policy (pure)
engine/eq.js  engine/fx.js  engine/master.js  engine/recorder.js
shared/protocol.js            message names + validators shared by UI, engine and hub
worklets/deck-input.js        chunker + ODF + waveform bands
worklets/beatfx.js            gate + crush
worklets/recorder.js          Int16 interleave, transferable batches
vendor/signalsmith-stretch/   SignalsmithStretch.js (+ LICENSE, MIT)
agent/agent-main.js  agent/agent-relay.js
deck.html  deck.css  ui/*.js  (app, deck-strip, master-strip, controls, waveform, meters, sources, keys, connection)
tests/unit/*.test.mjs         node --test
tests/e2e/*.mjs               Playwright + headless Chromium harness
package.json                  scripts only (test:unit, test:e2e), no runtime deps
README.md
```

The popup files (`popup.html`, `popup.css`, `popup.js`) and the old `recorder-worklet.js` are
removed.

## 4. Error handling

- Every engine command returns `{ok, error}`, and the hub propagates engine errors instead of
  reporting success. The UI shows errors as toasts and, where relevant, as deck badges.
- Capture lifecycle:
  - **track ended or tab closed:** the deck is ejected and any active recording is finalised;
  - **cross-origin navigation:** the deck's title and favicon update, and the capture continues.
- Worklet load failure leaves the deck unusable with a clear message. A failed recording start
  is reported, not silently ignored.
- Agent data is untrusted: types and numeric ranges are validated, and anything unknown is
  ignored.

## 5. Testing

- **Unit** (`node --test`):
  - TempoTracker and BeatClock on synthetic onset curves, ported from the prototype suite
    (house, techno, boom-bap, trap, pop, dembow, 75 BPM, noisy, DnB with range, ambient);
  - the deck-input worklet run under a Node shim of `AudioWorkletProcessor` against synthetic
    audio;
  - sync maths (half/double, ranges);
  - phase-controller simulation;
  - assist policy;
  - crossfader curves, EQ knob law, WAV header/streaming writer;
  - protocol validators.
- **E2E** (headless Chromium, `--allowlisted-extension-id`, `--mute-audio` removed): local
  pages playing synthetic tracks at 124 and 128 BPM (one `<audio>` page, one Web-Audio-only
  page). Assertions:
  - capture via the hub and engine;
  - BPM detection within ±0.2;
  - SYNC: from separate deck recordings, the follower's tempo matches within 0.2% and the
    onset offset between decks is ≤ 20 ms after convergence;
  - reserve drains at rate − 1 and assist engages on the `<audio>` page;
  - the Web-Audio-only page still syncs (assist n/a);
  - EQ LOW KILL cuts low-band energy by ≥ 30 dB;
  - filter and every FX change the output;
  - crossfader extremes isolate the A and B sides;
  - limiter peak ≤ −0.9 dBFS;
  - a 60 s WAV recording has a valid header and engine memory stays flat;
  - the deck UI renders with no console errors (screenshots are saved for design review).
- **Not testable here:** the real YouTube, SoundCloud, Bandcamp and Mixcloud players (no
  network access). The user verifies them on real sites.

## 6. Bug fixes from the v1 review (all included)

All 38 confirmed findings are addressed, most by the redesign itself:

| # | Finding | Fixed by |
|---|---|---|
| 1 | Capture fails for any tab the extension wasn't invoked on | §3.1 grant flow |
| 2 | Unbounded WAV memory and a blocking encode | §3.8 streaming recorder |
| 3 | Favicon HTML injection | §3.9, `textContent`/`img.src` only |
| 4 | Popup closes on focus loss | full-page deck |
| 5 | Spurious 44-byte WAV on stop | explicit recorder state machine |
| 6 | Unmetered mix clipping | limiter and master meter |
| 7 | Clip latch never resets | latch for 2 s plus click to reset |
| 8 | Engine errors reported as success | §4 |
| 9 | No tab lifecycle handling | §4 |
| 10 | Zipper noise | `setTargetAtTime` everywhere |
| 11 | Gain slider floods messages | at most one message per frame |
| 12 | Recording toggles a silent no-op | errors reported |
| 13 | "Monitor off" still in the mix | monitor replaced by fader and crossfader |
| 14 | Stop All has no guard | confirmation |
| 15 | Inline `onerror` blocked by CSP | no inline handlers |
| 16 | Invalid download filenames | filenames sanitised |
| 17 | Worklet node leak | nodes disconnected and ports closed |
| 18 | Per-block allocations in worklets | preallocated buffers |
| 19 | `startTab` not transactional | start and stop serialised |
| 20 | Metering loop always on | engine only streams to a connected UI |
| 21 | Linear spectrum binning | replaced by the 3-band waveform |
| 22 | Fixed canvas size | DPR-aware canvases |
| 23 | Emoji-only buttons | ARIA labels and states |
| 24 | Settings not persisted | `chrome.storage` |
| 25 | Unused permission and README errors | manifest and README rewritten |

The remaining low-severity items follow the same pattern.

## 7. Open risks

1. **Signalsmith under MV3 CSP, and its CPU cost with 4–6 decks.** Resolved by the probe: it
   works with the vendored fix, and costs about 18 % of a core for 4 decks.
2. **Real-track BPM accuracy.** Validated on synthetic material only. UNSURE state, TAP and
   GRID tools mitigate it.
3. **Whether content-script ports reach the offscreen document.** Resolved: they do. The
   service worker must register no `onConnect` listener, because one receiver disconnecting
   tears the port down for all of them.
4. **Hidden-document timer throttling in the offscreen document.** All timing comes from
   worklet messages and the audio clock; there are no `setInterval` loops on critical paths.
