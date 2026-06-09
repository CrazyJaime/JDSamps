# JD Samps

*made by godspee*

A Manifest V3 Chrome extension that captures audio from **multiple tabs at the
same time**, keeping each tab's audio as a **separate stream** so you can meter,
adjust, record and mix them independently.

## How simultaneous separation works

`chrome.tabCapture.capture()` only grabs the active tab. To capture several tabs
at once *and keep them apart*, this extension:

1. Asks the service worker for a distinct **stream ID per tab** via
   `chrome.tabCapture.getMediaStreamId({ targetTabId })`.
2. Hands each ID to a single **offscreen document**, which calls `getUserMedia()`
   with `chromeMediaSource: 'tab'`. That yields one isolated `MediaStream` per tab.
3. Builds a separate Web Audio graph per tab:

   ```
   MediaStreamSource → Gain → ┬→ Analyser  (level metering)
                              ├→ Monitor   (so the tab stays audible)
                              ├→ Recorder  (per-tab file)
                              └→ Mix bus    (combined recording)
   ```

The worker (which owns `tabCapture`) and the offscreen document (which owns
`getUserMedia` / `AudioContext` / `MediaRecorder`) talk over `chrome.runtime`
messages; the popup is pure UI and only talks to the worker.

## Features

- **Capture any number of tabs at once**, each on its own track.
- **Live per-tab visualizer** — a real-time canvas showing a frequency spectrum
  (green→red bars) with the waveform overlaid, plus a VU meter with RMS bar,
  floating peak marker, dB readout and a red clip indicator.
- **Per-tab gain** slider (shown in dB) — boost or attenuate without touching the
  source tab.
- **Monitor toggle** per tab (capturing a tab normally mutes it for you; this
  re-routes it to your speakers so you keep hearing it).
- **Record any single tab** to a timestamped file.
- **Record a combined mix** of every captured tab to one file.
- **WAV or WebM** output, toggled in the toolbar. WAV is uncompressed 16-bit
  stereo PCM, captured sample-accurate via an `AudioWorklet`; WebM is Opus via
  `MediaRecorder`.
- Recordings are saved automatically via the Downloads API.
- Auto-cleanup when a captured tab is closed or navigates away.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this `multitab-audio-sampler/` folder.
4. Pin the extension and click its icon to open the popup.

## Use

1. Click the icon to open the popup. Capturable tabs appear under **Available
   tabs**.
2. Click **+ Capture** on each tab you want. A card appears under **Capturing**
   with a live meter.
3. Adjust gain / monitoring per tab. Hit the **●** on a card to record just that
   tab, or **● Mix** in the toolbar to record everyone together.
4. **■ Stop all** tears everything down.

## Notes & limitations

- Only `http(s)` / `file` tabs can be captured — `chrome://` pages and the Web
  Store are off-limits to all extensions.
- Output is **WAV** (uncompressed PCM) or **WebM/Opus**, selectable in the
  toolbar. WAV files are larger but lossless.
- Browser audio capture is subject to Chrome's tab-capture rules; the popup must
  be opened (a user gesture) to start a capture.
