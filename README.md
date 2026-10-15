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
  - CUE (CDJ style: hold to preview; PLAY while previewing keeps playing), PLAY/PAUSE,
    LIVE (jump to the newest audio);
  - ROLL pads (1/8–1 beat) that slip back in time when released; hold several to build a roll
    down (1/2 → 1/4 → 1/8) and release them in any order;
  - **ejecting a deck stops its tab**: the tab's player is paused before the capture is
    released, or, when nothing on the page can be paused, the tab is muted (and unmuted again
    when you load it next time).
- **Player assist:**
  - a deck can only play faster than its source while it has buffered audio in reserve
    (shown as the RESERVE gauge);
  - on sites whose sound comes from a normal media player (the targets are YouTube, SoundCloud,
    Bandcamp and Mixcloud), JD Samps runs the tab's own player slightly faster to keep that
    reserve topped up. It engages only when the tab has exactly one playing, audible player at
    normal speed, counts a speed step only once the page confirms it, backs off if the page
    resets its own speed, and gives the page its speed back when it stops;
  - assist has been tested against local test pages; the real sites' players could not be
    tested in this environment;
  - sync itself never depends on the player.
- **3-band isolator EQ** per deck (Linkwitz–Riley, 250 Hz / 2.5 kHz): knobs from silence up
  to +6 dB, and **KILL** buttons that cut a band by at least 30 dB (about 40 dB measured).
- **FX** per deck:
  - one-knob **FILTER** (low-pass ↔ high-pass) with a **RES** (resonance) knob;
  - a Beat FX slot: ECHO, REVERB, GATE (a 16-step pattern), FLANGER (its sweep starts on a
    beat) or CRUSH, synced to the deck's tempo.
- **Mixer:**
  - channel faders;
  - **crossfader** with an A / THRU / B assign per deck and SMOOTH or SHARP curves;
  - master volume, a brickwall **limiter** at −1 dBFS (gain ramped across a 5 ms lookahead,
    so it does not click), L/R meters with clip lights; click a deck's meter to clear its clip
    light.
- **Recording:**
  - any deck (after FX, before the fader) or the full mix (after the limiter);
  - WAV (streamed, flat memory) or WebM;
  - saved automatically via Downloads.
- **Built for live use:**
  - full-page deck that keeps running if you close or reload it; held controls are let go if
    the page closes or loses focus;
  - the audio path does not depend on the page's main thread: a busy or briefly frozen browser
    page does not starve a deck (a deck that ever runs dry says so);
  - fits 1–6 decks on 1280×720 and larger screens, with 32 px hit targets;
  - keyboard shortcuts (press `?`);
  - hold-to-eject, hold-to-stop recording, Stop All confirmation, screen kept awake;
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
| `R` | Record deck (hold to stop) |
| `Shift+R` | Record mix (hold to stop) |
| `?` | Help |

Arrow keys on a focused knob or fader adjust that control instead.

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
  21 MB per minute, and uses roughly 5 % of one CPU core for time-stretching. A deck that runs
  slower than its source for a long time skips ahead whole bars when its buffer is full (you
  are warned first). With no decks and no deck page, the engine goes idle.
- **Background tabs.** Chrome keeps captured tabs running at full speed. While the deck page
  is hidden it gets fewer updates; the audio is not affected.
- **Incognito.** JD Samps does not run in incognito windows.
- **Site access.** JD Samps asks for access to all sites only to drive tab players for
  player assist and to pause a tab's player when its deck is ejected. Capture, sync, EQ and FX
  work on the audio.

## Development

- `npm run test:unit`: tempo tracking, sync maths, playhead model, recorder, protocol (Node).
- `npm run test:browser`: offline Web Audio graphs, worklet lifecycle and audio path, UI
  against a fake engine (controls, keys, layout, performance), agent, hub (headless Chromium).
- `npm run test:e2e`: the real extension with captured tabs, sync measured on the recordings,
  assist, recording (60 s), mixing, ejecting, main-thread stalls.

Uses [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) (MIT), vendored with
small patches (streaming, teardown, constant per-block cost, a direct input feed). See
`vendor/signalsmith-stretch/README.md`.
