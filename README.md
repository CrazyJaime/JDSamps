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
  recordings may stay **UNSURE**; use TAP and GRID. Until the beat grid is confident (or
  TAPped), SYNC in BEAT mode is refused with a reason; TEMPO mode still matches tempo.
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
