# Movie Maker (web)

A browser re-creation of **Windows Live Movie Maker 2011**. It works in desktop browsers and in
**phone browsers** (iPhone Safari, Chrome on Android). Everything runs on your device. Nothing is
uploaded, there is no build step, and once loaded it works offline (installable as an app).

*Fan project, not affiliated with Microsoft.*

## Run it

Serve the `moviemaker/` folder over http(s), then open it:

```sh
npx http-server moviemaker -p 8080
# open http://localhost:8080  (or http://<your-computer-ip>:8080 on your phone, same Wi-Fi)
```

Or turn on **GitHub Pages** for this repository and open `https://<user>.github.io/<repo>/moviemaker/`.
On a phone, use *Share → Add to Home Screen* to install it.

## What's in it

- **Ribbon** with Home, Animations, Visual Effects, Project and View tabs. Contextual tabs
  (*Video Tools › Edit*, *Music Tools › Options*, *Text Tools › Format*, *Trim Tool*) appear
  when you select an item.
- **Add** videos and photos, webcam video, recorded narration, snapshots, music, titles,
  captions and credits (Director, Starring, Location, Soundtrack).
- **AutoMovie themes**, 30+ **transitions**, **pan & zoom**, 20+ **visual effects** and brightness.
  Hovering a gallery item previews it live on the monitor.
- **Editing**: trim tool, split, set start/end points, speed, volume, fade in/out, photo
  durations, rotate, cut/copy/paste and undo/redo.
- **Text**: edit right on the preview. Drag and resize captions, change font, size, colour,
  outline, transparency, alignment, and pick text effects (fly-in, typewriter, scrolling credits…).
- **Audio**: music and narration lanes with waveforms, Audio mix, Emphasize, and Fit to music.
- **Project**: aspect ratios 16:9, 4:3, 9:16 (portrait) and 1:1. Autosave to the browser, open
  saved projects, and export or import a single `.wlmmweb` project file.
- **Save movie**: renders to MP4 (H.264/AAC where the browser supports it) or WebM, at sizes
  from 1080p down to *For email*. On phones the result is saved through the share sheet.

### Phone tips

- Tap a clip to select it. Hold and drag to reorder it.
- Scroll the filmstrip to move through the movie. Pinch to zoom.
- Tap a caption on the preview to edit it. Return adds a new line; press **Done** to finish.
- Saving a movie records in real time, so keep the screen on until it finishes.

## Notes

- Which formats you can import depends on the browser. iPhone HEVC `.mov` files need a browser
  that can play HEVC, such as Safari.
- Safari may clear website storage for sites you haven't used in 7 days unless the app is added
  to the Home Screen. Use *Export project file* to keep a backup.

## Development

Architecture and module contract: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```sh
cd moviemaker
node tests/core.test.mjs && node tests/commands.test.mjs && node tests/fuzz.test.mjs
NODE_PATH=$(npm root -g) node tests/e2e.mjs            # Playwright: desktop, phone, landscape
```
