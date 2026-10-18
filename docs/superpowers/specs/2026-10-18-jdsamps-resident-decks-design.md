# JD Samps — Resident Decks: Design

**Date:** 2026-10-18 · **Status:** approved direction ("do both deck controls and resident tracks"), proceeding · **Base:** `claude/jdsamps-v2-deck` at `8b3bd44`

## 1. The principle

> **A deck owns its audio. The tab is a source, not a dependency.**

Today every deck is a live recording of a tab. Most of what the DJ has reported in practice traces back to that:

- moving the tab's own player makes the deck jump, because the jump is in the recording;
- the deck cannot be moved around in, because only a moving window of audio exists;
- SoundCloud and others pause the tab, and the deck starves;
- BPM is estimated from a 12-second window at the live edge and is wrong on real material even after every live-tracker fix ("I was using the most recent version").

A **resident deck** holds the whole track, decoded, from the moment it is ready. After that the tab can pause, seek, close or be paused by its site and the deck does not notice. The whole track is analysed once, so the beat grid is fitted to all of it.

Live decks stay, for genuinely live sources and as the fallback when a track cannot be made resident. They are no longer the default.

### What the user decided
| Decision | Source |
|---|---|
| Fetch the whole track rather than stream it; personal use | "it is okay build" |
| Once loaded, the deck must not be bound to the tab at all | "even if tab pauses the player it shouldn't matter to us" |
| 90 seconds of loading is too slow | "90 seconds is still so slow" |
| Build resident decks and deck controls together | "do both" |

### Hard lines that stay
- No YouTube signature decipher and no site-specific extractor that reverse-engineers a site's protocol. Everything here either reads a URL the page itself exposes, re-requests a URL the page itself already requested, or captures bytes the page's own player handed to the browser.
- Nothing is uploaded anywhere. Captured audio lives in memory, and on disk only through the existing recorder or an explicit save.

## 2. Measured facts this design rests on

Five probes ran against the real code in headless Chromium 141. Real sites were **not** reachable from the build machine (the proxy refuses YouTube, SoundCloud, Bandcamp, Mixcloud and their CDNs), so every site-specific claim below is documentary or modelled and is listed again in §14 for the user to verify.

| Fact | Evidence |
|---|---|
| A MAIN-world `SourceBuffer.prototype.appendBuffer` hook at document_start captures every byte a player appends, in order, init segment included, byte-identical to what the server sent — including when the page snapshots the native method first. | tap probe: SHA-256 match against the files on disk |
| `decodeAudioData([init + N media segments])` returns PCM that is **sample-exact** against the unfragmented original. No remuxer is needed. | max abs diff 0.0 over 8,640,648 samples |
| `decodeAudioData` ignores `tfdt`: a mid-track run decodes as if it started at zero. Placement on the timeline is our job. | segments 10–12 decoded as 0–12 s |
| Out-of-order, duplicated, gapped or truncated concatenation decodes **silently wrong** — no exception. | the decoder closes holes and drops duplicates without error |
| `instanceof ArrayBuffer` drops cross-realm buffers silently; a brand check (`Object.prototype.toString.call(x) === '[object ArrayBuffer]'`) does not. Bytes land in the tap of whichever frame's realm supplied the method, so captures must be aggregated per tab. | tap probe |
| MSE inside a DedicatedWorker is invisible to any content-script hook. | tap probe |
| Moving bytes as a page-minted `blob:` URL that the offscreen document fetches takes 8.7 ms for 3 MB; the agent port takes 888 ms. | tap probe |
| The extension's own fetches do not reuse the page's HTTP cache. | tap probe |
| Back-filling the remaining segments: concurrency 8 is the knee; about 1.5 s on 20 Mbps and 6 s on 5 Mbps for a 3-minute 128 kbps track. | tap probe |
| The stretcher takes a whole 5-minute track in **one** `addBuffers` call (0.7–0.9 ms main thread, O(1) audio thread). Per-block cost is identical whether the track arrives as 1 chunk or 7032. `dropBuffers` drops whole chunks only. | engine probe |
| Seeking anywhere is already `this.sched(T, {input})`. Scrubbing is limited by the 0.15 s `soon()` lead, not by the single-pending invariant. | engine probe |
| Whole-track analysis: OdfCore runs at 300–350× realtime; a 5-minute track is analysed in under a second in a Worker. A staged grid fit gives BPM error ≤ 0.001 % and phase error 0.1–1.9 ms median across the whole track, against up to 15 ms p95 for the live tracker near its live edge. A single global grid drifts on anything not constant-tempo; a piecewise grid holds 1–25 ms. | analysis probe |
| Automatic bar 1: detecting *whether* a 4-beat unit exists is reliable; choosing *which* beat is bar 1 is near chance. | analysis probe |
| Chromium emits audio at every `playbackRate` up to the API maximum of 16. Capturing the *output* of a sped-up player loses bandwidth: content above (media sample rate ÷ 2) ÷ N is gone (2× keeps 12 kHz, 4× keeps 6 kHz). Capturing the *encoded bytes* the player appends has no such loss. | fallback probe |
| Bandcamp exposes its stream MP3 URL in the page (`data-tralbum` → `trackinfo[N].file['mp3-128']`). Mixcloud and SoundCloud expose replayable media URLs to a runtime tap. YouTube's web client uses SABR: there are no segment URLs, and audio arrives framed inside POST responses. Some SoundCloud tracks are DRM-encrypted or preview-only. | sites survey (documentary, low confidence) |

## 3. Deck kinds and lifecycle

```
            ┌──────────── load succeeds (whole track decoded) ───────────┐
LOAD ──► LOADING ──► (slow path: partial, playable over what is resident) ─┤──► RESIDENT
            │                                                               │
            └──── every resident strategy fails ──► LIVE (today's deck) ◄──┘ (never back)
```

| Kind | Holds | Bound to the tab | Can seek | Reserve / starvation / assist |
|---|---|---|---|---|
| `resident` | the whole track, decoded | no | anywhere | none |
| `loading` | whatever has arrived | only while loading | over what has arrived | the existing reserve model applies to the loaded region |
| `live` | today's moving window | yes | within the buffer | as today |

- **Load a tab** (toolbar icon, Alt+Shift+A, context menu, Sources → Load) now means *try to make it resident*. It falls back to live only when every strategy fails, and says why.
- **Drag an audio file** onto a deck slot or the board, or **paste a link** to an audio file in Sources: resident directly.
- A `loading` deck shows its progress, the strategy in use, and a cancel. On the fast paths it lasts seconds.
- When a tab-sourced deck becomes resident, the tab is released: its player is given back its own rate and position, paused (reusing the eject `STOP_TAB` path, so it is silenced before the capture goes), and any mute we applied is undone. From then on the tab is not consulted.
- A resident deck never turns back into a live deck.

## 4. Getting the audio: the strategy ladder

The loader tries strategies in order and stops at the first that yields a complete, verified track. Per-site knowledge is kept to a small declarative table (§4.6), not extractor code.

### 4.1 Direct file (fastest, certain)
- **Local file**: `File` from drag-and-drop or a picker → `blob:` URL → offscreen fetch → decode.
- **Pasted link**: fetched by the offscreen document (host permission `<all_urls>` already exists) → decode. A link that is not audio, or does not decode, is refused with a reason.
- **Bandcamp**: a content script reads the page's own `data-tralbum` JSON and takes the stream URL for the playing track. It fetches it from the page context first (Bandcamp is reported to fingerprint synthetic clients), falling back to the extension context. Then it hands a `blob:` URL to the engine.

### 4.2 Active re-fetch of what the page requested
The page tap (§5) records the media URLs the player requests, with their `Range` headers. When the captured format is directly decodable — progressive MP3/M4A/WebM, or HLS/DASH whose segments are MP3, ADTS-AAC, fMP4 or WebM — the loader:
1. takes the manifest or URL template the page used;
2. fetches the segments the page has not played yet, from the **page context** (signed CDN URLs are bound to the session that minted them), at concurrency 8;
3. never re-fetches a segment the page already downloaded — those bytes come from the tap for free.

Expected for Mixcloud and most SoundCloud: seconds. MPEG-TS segments are **not** decodable by `decodeAudioData`; for those this rung is skipped and §4.3 is used, because an MSE player has to transmux TS into a decodable form before appending it.

### 4.3 Drive the player, capture its bytes (format-agnostic)
Whatever a site's network format — including YouTube's SABR — an MSE player must append decodable media (fMP4, WebM, MP3, ADTS) to a `SourceBuffer`, and the byte tap captures exactly that. To get the *whole* track rather than only what the player happens to buffer:
1. **Mute the tab** (recorded, undone afterwards; the existing STOP_TAB mute bookkeeping).
2. **Seek-hop**: seek the player through the track in steps sized to its buffering goal, waiting at each hop until its buffered range covers the step. Every fetched segment is appended and captured, and its timeline position comes from the segment itself (§6).
3. If seek-hopping stalls or the player refuses it, **accelerate**: raise `playbackRate` (up to 16) with `preservesPitch=false`, using the existing assist rate machinery and its back-off when a page fights the rate. Byte capture is lossless at any rate.
4. Restore the player's rate, position and mute state when done (§3).

This rung is the generic answer for YouTube. Its speed depends on how fast each player buffers ahead, which cannot be measured here. Target: a 5-minute track resident in under 30 s.

### 4.4 Output capture (last resort, opt-in)
For pages whose audio never touches MSE or a media URL (Web-Audio-only players), and for DRM-protected media, bytes cannot be had. The deck becomes **live** by default (full quality, bound to the tab, labelled `LIVE`). It offers an explicit action, **"Record whole track (2×, reduced highs)"**: speed-capture the tab's output at 2×, resample back, and keep 12 kHz of bandwidth. This is labelled honestly and is never automatic.

### 4.5 Refusals that must never be silent
- **DRM**: an `encrypted` event, or `addSourceBuffer` with an encrypted type → "protected audio — playing live instead". Never produce noise.
- **Preview-only** (SoundCloud `snipped`, `/preview/` or 30 s paths) → "SoundCloud preview only — 30 s" before committing a deck.
- **Too long for the memory budget** (§10) → "this is a 74-minute mix; loading the first 15 minutes" or live, per the setting.
- **Worker-hosted MSE** (nothing captured while the page plays) → fall through to §4.4 and say why.
- **A genuinely live stream** (no finite duration on the element or manifest — radio, a livestream) can never be complete → becomes a live deck immediately, without trying the slower rungs.

### 4.6 Site table (declarative, the only per-site knowledge)
| Site | First rung | Notes |
|---|---|---|
| Bandcamp | 4.1 page JSON | reference implementation; ship first |
| Mixcloud | 4.2 re-fetch | XOR-obscured URLs are plaintext at runtime, and the tap sees them |
| SoundCloud | 4.2 re-fetch → 4.3 | check preview and DRM tier first |
| YouTube | 4.3 drive + capture | no URL rung; SABR is not parsed |
| anything else | 4.2 → 4.3 → 4.4 | the ladder is generic |

## 5. The page tap (MAIN world)

Lives in `agent/agent-main.js` and follows its existing rules: dormant and transparent at document_start, no globals, native-looking wrappers, active only on command.

- **Byte layer**: wrap `SourceBuffer.prototype.appendBuffer` (and `appendBufferAsync` if present). Copy each appended `ArrayBuffer` or view, using **brand checks** only. Record per SourceBuffer: the mime from `MediaSource.prototype.addSourceBuffer`, the bytes, and the append order.
- **URL layer**: wrap `fetch` and `XMLHttpRequest` to record media request URLs, methods, `Range` headers and response sizes. Bodies are taken only for progressive media, where the byte layer may not see them.
- **Element layer**: the existing play/pause/load wrappers, plus `encrypted` event detection.
- **Aggregation**: each frame's tap reports to its relay; the engine merges a tab's frames (the deck already keys agents by frame id).
- **Transport**: bytes never travel on the agent port. The MAIN world mints `URL.createObjectURL(new Blob(parts))` and sends only the URL string on the private channel. The offscreen engine fetches it promptly, because a blob URL dies with the page.
- **Commands**: `{t:'tap', on}`, `{t:'drive', mode:'seekhop'|'accelerate', ...}`, `{t:'release'}` restoring everything.
- **Statuses**: progress (bytes and buffered seconds), `tap-ready {parts:[{blobUrl, mime, kind}]}`, errors (`drm`, `worker`, `preview`).
- The fingerprint gaps the tap probe found in the shipped disguise (`Function.prototype.toString.call` reveals the source; the own `toString` property; `length` 0 on `(...args)` wrappers) are fixed as part of this work, since the tap adds more wrappers.

## 6. Assembly and decode (offscreen engine)

Because the decoder fails silently on bad input, assembly has to be strict.

1. **Group** captured fMP4/WebM media into *runs*: an init segment and the media segments appended after it, until the next init (an ABR switch starts a new run).
2. **Place** each media segment on the media timeline with a minimal ISO-BMFF reader: `moof → traf → tfdt.baseMediaDecodeTime`, scaled by the timescale from the init's `mdhd`. For WebM, the cluster timecode. For MP3/ADTS, cumulative frame durations.
3. **Choose** one segment per time span: prefer the highest-bitrate run covering it, and drop duplicates.
4. **Verify contiguity**: no gaps, no overlaps beyond one frame, covering 0 to duration (the duration comes from the media element or manifest). A track that is not contiguous is **not ready**; the loader keeps fetching or reports exactly which span is missing. Never build a deck from a gapped set.
5. **Decode** each run as `[init + its segments]`, then stitch the PCM at the placed offsets. Measure boundary seams between runs; if priming or padding causes audible seams, trim by the codec delay (AAC priming, Opus pre-skip) and crossfade at most a few ms.
6. **Progressive decode** (§4.3/§4.4 slow paths only): decode as runs complete, without re-decoding the whole prefix each time if it can be avoided, and with no audible seams.
7. Resample to the context rate if the decoded rate differs.

## 7. The resident deck in the engine

A resident deck is the existing `Deck` with its buffer full. The engine probe gives the full inventory; the essentials:

- **Entry point**: `Engine.startResidentDeck({source, meta, pcm:{L, R, sampleRate}})` beside `startDeck`. It shares the MAX_DECKS check, the slot search, default params and `new Deck`. Identity is the deck id; `tabId` may be null. `deckByTab` must not match null, or a second resident deck is refused.
- **Load shape**: push the whole track in **one** `addBuffers([L, R])`. Slow paths push in large chunks as they decode, with trim disabled so `dropBuffers` cannot eat the head.
- **Disabled for resident decks** (gated on `kind === 'resident'`, never merely retuned):
  - trim and the buffer cap, including the whole-bar cap skip, which would otherwise jump about 180 s on the first PLAY of a 5-minute track;
  - starvation and the emergency jump, which would otherwise loop the last 2 s forever;
  - the dry-audio notice;
  - player assist and its tick;
  - the input worklet and its worklet-to-worklet feed, since there is no capture and the registry entry would leak.
- **End of track**: schedule `active:false` at the duration. The deck stops at the end, showing the end, with no dry notices and no looping. (A later setting may offer loop or auto-cue.)
- **LIVE** has no meaning on a resident deck. The button is hidden; the deck shows elapsed and remaining time instead.
- **`clampInput`** must let the last frames be reached on a resident deck (today about 0.42 s is unreachable).
- **Eject**: no capture to release. If the source tab is still open and was ours, it is already released (§3).
- **Recorder** titles use the track title, not `Tab null`.
- **Snapshot** gains `kind`, `duration`, and `load {state, progress, strategy, error}`.

## 8. Whole-track analysis

1. Downmix the decoded PCM to mono and transfer it to a **Worker**.
2. Run `OdfCore` there verbatim, collecting the onset function and the waveform band bytes in one pass.
3. Back on the main thread (≤ 45 ms):
   - coarse BPM from a whole-track autocorrelation and comb;
   - the octave decided by the existing exported `pickOctave()` (it was written to be reused);
   - phase combs over 10 s windows every 5 s, unwrapped beat numbers, then a clarity-weighted least-squares fit.
4. **Build a piecewise grid** with `GridMap.split` per anchor; `GridMap` already models this.
5. **Segmentation** for files holding more than one tempo (mixes, albums as one file): coarse tempo per 20 s block, merge related tempi, split at change points, refit each segment.
6. **Bar 1**: offer an automatic suggestion only when the bar-position score has real contrast, labelled as a suggestion. TAP 1 stays primary.
7. **Expose the fit residuals** as a stability diagnostic. A large residual means "not constant tempo — using a piecewise grid".
8. The manual tools all stay: TAP, ½×, 2×, GRID, typed native BPM, and the confidence gate. Offline analysis improves the grid but does not remove the need to correct its octave.

The resident deck uses this grid from the moment it is ready. There is no 5-second lock wait and no live tracker.

## 9. Waveform and overview

- The analysis pass fills the deck's waveform for the whole track at once. One existing `{t:'wave'}` message delivers it (about 301 KB), with no protocol or WaveStore change.
- The whole-buffer overview strip from the deck-controls work shows the whole track on a resident deck, the loaded portion during loading, and the moving window on a live deck.

## 10. Memory policy

- Decoded stereo float32 costs about 22 MiB per minute. A new setting, **Resident track limit**, defaults to 15 minutes per deck (about 330 MiB).
- A longer source loads its first *limit* minutes with a clear notice, or plays live — the setting chooses, default "first part".
- Compressed bytes are kept (they are tiny), so a later phase can decode a sliding window for long mixes without re-fetching.
- The mono analysis copy is freed as soon as the Worker finishes.
- With six full decks the engine can hold about 2 GB. The top bar shows a warning when total resident audio passes 1.5 GiB.

## 11. UI

- **Loading deck**: shows `LOADING · 42%`, the strategy in plain words ("reading the page", "fetching", "fast-forwarding the player", "recording at 2×") and a cancel. Controls are inert except eject.
- **Kind badge**: `TRACK` for resident, `LIVE` for live, so it is always clear whether the tab still matters.
- **Resident deck**: elapsed and remaining time; no LIVE button; END reached shows clearly.
- **Errors**: actionable, one line, deck-named (§4.5).
- **Load affordances**: drag an audio file onto a deck slot or the board; a "Load link" field in the Sources drawer; the existing tab loading.
- **Copy load report**: in the loading and error states, one click copies a short plain-text report — strategies tried, mime types, segment and run counts, the first failure. The build machine cannot see real sites, so this is how real-site failures get back for fixing.
- **Setting**: Resident track limit (§10), and "Record whole track at 2× when bytes are unavailable" (default off).

## 12. Protocol additions (all validated in `shared/protocol.js`)

- **UI → engine**: `loadFile {name, blobUrl}`, `loadUrl {url}`, `loadCancel {deckId}`, `recordWhole {deckId}`.
- **Hub → engine**: `START` gains `mode: 'resident' | 'live'` (default resident).
- **Engine → hub**: `TAP {tabId, on}`, `DRIVE {tabId, mode}`, `RELEASE_SOURCE {tabId}`. The last restores rate and position, pauses, and unmutes.
- **Agent ↔ relay ↔ engine**: `tap`, `drive`, `tap-progress`, `tap-ready`, `tap-error`.
- **Snapshot**: per-deck `kind`, `duration`, `load`; master `residentBytes`.

## 13. Testing

The build machine cannot reach real sites, so the harness models them. `tests/browser/ext-harness.mjs`'s track server gains:
- a **progressive MP3** page;
- an **MSE fMP4** page with its own tiny player that buffers ahead;
- a **DASH page with an ABR switch** (two representations, two init segments);
- a page whose player **resets playbackRate**;
- a page that plays **MSE inside a Worker**;
- an **encrypted** page (fires `encrypted`);
- a **preview-only** page;
- a **Web-Audio-only** page (already exists).

Each strategy gets RED-first tests. The acceptance test for the whole feature: load each model page and assert that the deck becomes resident with the right duration, that its audio matches the source (sample-exact where the format allows, otherwise correlated with a bounded error), that the tab is released, and that pausing, seeking or closing the tab afterwards changes nothing in the deck. Unit tests cover assembly (gaps, overlaps, ABR runs, tfdt placement), the analysis fit against ground truth, and the resident-deck engine branches (no cap skip, no emergency loop, end of track).

AAC cannot be decoded by the headless Chromium here, so AAC-specific behaviour is verified on the user's Chrome (§14).

## 14. Unverified — the user's checklist

These could not be tested from the build machine and need a real Chrome on the real sites. Each failure should come back as a "Copy load report":
1. Bandcamp: does the page JSON still carry the stream URL, and does the page-context fetch succeed?
2. Mixcloud and SoundCloud: are captured segment URLs replayable from the page context, and does back-fill complete?
3. YouTube: does seek-hopping or acceleration make the player buffer the whole track, and how long does it take?
4. AAC fMP4 from real sites decodes, and runs stitch without audible seams.
5. SoundCloud preview and DRM detection fire correctly.
6. After a deck turns resident, pausing, seeking or closing the tab changes nothing.

## 15. Work breakdown (for the plan)

| Stream | Scope | Depends on |
|---|---|---|
| **R1 Resident engine + direct files** | §7, §10, plus local file and pasted link end to end (§4.1 minus Bandcamp). The first vertical slice. | — |
| **R2 Whole-track analysis** | §8 and the waveform fill in §9 | its output plugs into R1 |
| **R3 Page tap + assembly** | §5, §6 | — |
| **R4 Loader ladder + site table** | §4.1 Bandcamp, §4.2–§4.6, release of the source, the load report | R1, R3 |
| **R5 Resident UI** | §11 | R1's snapshot fields; can start on mock state |
| **R6 Model-site harness + acceptance E2E** | §13 | R1–R4 for the acceptance runs; the harness itself can start at once |

The deck-controls work (seek, beat-jump, scrub, overview, typed BPM, fader) runs alongside and is designed against the buffer bounds, so it reaches the whole track on resident decks with no further change.
