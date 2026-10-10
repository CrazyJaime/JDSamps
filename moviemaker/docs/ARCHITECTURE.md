# Movie Maker (web) — Architecture & Module Contract

A faithful, browser-based re-creation of **Windows Live Movie Maker (2011/2012)** —
ribbon UI, preview monitor, storyboard, transitions, pan & zoom, visual effects,
titles / captions / credits, music & narration, AutoMovie, and "Save movie" export —
that runs entirely client-side and works on **phone browsers** (iOS Safari 15+,
Chrome Android) as well as desktop.

**Hard rules for every module**

- Plain modern JavaScript **ES modules**, no build step, no frameworks, no CDN or
  network dependencies (must work offline as a PWA). `import` paths are relative
  and include the `.js` extension.
- Must run in Chrome, Safari (iOS 15+), Firefox. Feature-detect; never assume
  `ctx.filter`, `OffscreenCanvas`, `showSaveFilePicker`, `requestVideoFrameCallback`,
  `navigator.wakeLock` or WebCodecs exist.
- Touch first: use **Pointer Events** (not mouse events) for all interaction; tap
  targets ≥ 40px on mobile; no hover-only affordances.
- All media is processed locally; nothing is uploaded anywhere.
- No `alert()/prompt()/confirm()` — use the dialog helpers in `ui/dialogs.js`.
- Times are always **seconds (float)**. Colors are CSS strings (`#rrggbb`).
- Each module owns only its own files. Do not edit files you do not own; if you
  need something from another module that the contract does not provide, code
  defensively and note it in your final report.

## File layout & ownership

```
moviemaker/
  index.html                 D  page shell (title bar, ribbon host, preview, storyboard, status bar)
  manifest.webmanifest       F  PWA manifest
  sw.js                      F  service worker (offline cache of app shell)
  icons/                     F  icon.svg, icon-192.png, icon-512.png, apple-touch-icon.png
  css/moviemaker.css         D  all styles (Aero/WLMM look + responsive phone layout)
  js/model.js                A  constants, factories, computeTimeline (pure, no DOM)
  js/store.js                A  Store: project state, selection, view state, undo/redo, events
  js/persist.js              A  IndexedDB persistence (projects + media blobs), autosave
  js/media.js                A  import files → Media records (metadata, thumbnails, filmstrip, waveform)
  js/catalog.js              B  catalogs: TRANSITIONS, PANZOOM, EFFECTS, TEXT_EFFECTS, AUTOMOVIE_THEMES
  js/renderer.js             B  renderFrame(): composites one frame of the movie onto a canvas
  js/transitions.js          B  transition drawing functions
  js/effects.js              B  visual effects (ctx.filter with pixel fallback), pan & zoom math
  js/text.js                 B  title / caption / credits text layout & animated drawing
  js/gallery.js              B  renderGalleryThumb(): little animated preview icons for ribbon galleries
  js/audio.js                C  AudioEngine: decode & schedule all audio via Web Audio
  js/player.js               C  Player: playback clock, video element pool, scrubbing, drawing
  js/exporter.js             C  Exporter: real-time render to MediaRecorder (mp4 or webm)
  js/ui/dom.js               D  tiny DOM helpers (h(), icons) — others may import
  js/ui/icons.js             D  inline SVG icon set, keyed by name — others may import
  js/ui/ribbon.js            D  ribbon (tabs, groups, galleries, contextual tabs), quick access toolbar
  js/ui/storyboard.js        E  storyboard (wrapped timeline on desktop, filmstrip on phone)
  js/ui/preview.js           E  preview monitor, transport controls, seek bar, inline text editing
  js/commands.js             G  command registry: every editing action as a named command
  js/automovie.js            G  AutoMovie themes
  js/ui/dialogs.js           F  modal/sheet dialogs, toasts, app (file) menu, export dialog,
                                webcam + narration recording, trim mode
  js/app.js                  F  bootstrap: wires everything together
```

## Data model (`js/model.js`)

```js
export const ASPECTS = { '16:9': 16/9, '4:3': 4/3, '9:16': 9/16, '1:1': 1 };
export const FADE_SPEEDS = { none: 0, slow: 2, medium: 1, fast: 0.5 };  // seconds
export const SPEEDS = [0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8];
export const DEFAULT_IMAGE_DURATION = 7;     // WLMM default photo duration
export const DEFAULT_TITLE_DURATION = 7;
export const DEFAULT_CAPTION_DURATION = 3.5;
export const DEFAULT_TRANSITION_DURATION = 1.5;
export function uid(prefix='id')             // short unique id
export function createProject(name='My Movie') -> Project
export function createVisualItem(kind, props={}) -> VisualItem   // kind: 'video'|'image'|'title'
export function createTextItem(kind, props={})   -> TextItem      // kind: 'caption'|'credits'
export function createMusicItem(props={})        -> MusicItem
export function defaultTextStyle(kind) -> TextStyle
export function itemDuration(item, media) -> seconds on the timeline
export function computeTimeline(project, mediaMap) -> Timeline
export function formatTime(t) -> "MM:SS.ss" (WLMM style e.g. "01:05.37")
```

```ts
Project = {
  version: 1, id: string, name: string,
  aspect: '16:9'|'4:3'|'9:16'|'1:1',
  audioMix: number,          // -1..1; -1 = video sound only, 0 = equal, 1 = music only
  items: VisualItem[],       // storyboard order
  texts: TextItem[],         // captions & credits overlays (absolute timeline start)
  music: MusicItem[],        // music & narration (absolute timeline start)
  createdAt: number, updatedAt: number,
  emphasize?: 'narration'    // optional: "Emphasize narration" — music is ducked to 30% while narration plays
                             // (set by the `emphasize` command, read by audio.js; kept by normalizeProject)
}
VisualItem = {
  id, kind: 'video'|'image'|'title',
  mediaId: string|null,      // null for 'title'
  // video only
  trimStart: number,         // seconds into source
  trimEnd: number|null,      // null = end of source
  speed: number,             // playback rate, default 1
  volume: number,            // 0..1 (video's own sound)
  fadeIn: 'none'|'slow'|'medium'|'fast', fadeOut: same,   // audio fades
  // image & title
  duration: number,          // seconds (ignored for video)
  // title only
  background: string,        // color, default '#000000'
  text: string, style: TextStyle, textEffect: string,    // title text (title kind only)
  // all
  transition: { type: string, duration: number },  // transition INTO this item from the previous one ('none' allowed)
  panZoom: string,           // id from PANZOOM ('none' default)
  effect: string,            // id from EFFECTS ('none' default)
  brightness: number,        // -100..100, default 0
  rotation: 0|90|180|270
}
TextItem = {
  id, kind: 'caption'|'credits',
  text: string,              // may contain '\n'
  start: number, duration: number,
  style: TextStyle, effect: string   // effect id from TEXT_EFFECTS ('none' | 'fade' | 'scroll' ...)
}
TextStyle = {
  font: string,              // CSS family, e.g. 'Segoe UI, Arial, sans-serif'
  size: number,              // relative: percent of output frame HEIGHT (e.g. 8 = 8% of height)
  bold: boolean, italic: boolean,
  color: string, outline: 'none'|'thin'|'medium'|'thick', outlineColor: string,
  align: 'left'|'center'|'right',
  valign: 'top'|'middle'|'bottom',
  opacity: number,           // 0..1  (WLMM "transparency" = 1 - opacity)
  background: string|null    // optional box behind text
}
MusicItem = {
  id, mediaId, kind: 'music'|'narration',
  start: number,             // timeline start
  trimStart: number, trimEnd: number|null,   // source in/out
  volume: number, fadeIn, fadeOut           // same fade enum
}
Media = {                    // runtime record; persisted blob + metadata
  id, type: 'video'|'image'|'audio', name: string, mime: string,
  blob: Blob, url: string,   // url = URL.createObjectURL(blob) (runtime only, not persisted)
  duration: number,          // video/audio seconds; 0 for image
  width: number, height: number,
  hasAudio: boolean,         // best-effort (video)
  thumb: string,             // small JPEG dataURL (~160px wide)
  filmstrip: string[],       // video: up to 8 JPEG dataURLs evenly spaced; image: [thumb]
  peaks: number[]|null       // audio/video: ~ 1 peak per 0.05s normalized 0..1 (for waveform), may be null until computed
}
Timeline = {
  duration: number,
  segments: Segment[],       // one per VisualItem, same order
  texts: [{ item: TextItem, start, end }],
  music: [{ item: MusicItem, start, end }]  // end = start + (trimEnd - trimStart)
}
Segment = {
  item: VisualItem, index: number,
  start: number, end: number, duration: number,
  transitionIn: { type, duration } | null,  // overlap with previous segment, clamped
  sourceIn: number, sourceOut: number       // video: source seconds; else 0..duration
}
```

`computeTimeline` rules (WLMM semantics): segment *i* starts at `segments[i-1].end - transIn.duration`
where `transIn.duration = min(item.transition.duration, prev.duration/2, cur.duration/2)` and is
`null` when type is `'none'` or i == 0. Video duration on the timeline = `(trimEnd - trimStart) / speed`
(trimEnd null → media.duration). Missing media → duration 0 (segment still present). Timeline
duration = max(last visual end, end of every text and music item). Captions and music may
extend beyond the visuals (renderer draws black there).

## Store (`js/store.js`)

```js
export class Store extends EventTarget {
  constructor()
  project: Project
  media: Map<string, Media>
  selection: { type: 'item'|'text'|'music'|null, ids: string[] }   // ids: one or many (select all)
  view: { zoom: number /* px per second, default 40 */, thumbSize: 'small'|'medium'|'large',
          showWaveforms: boolean, previewSize: 'normal'|'large' }
  clipboard: any
  get timeline(): Timeline           // cached; recomputed after any change
  update(mutator: (project) => void, { label?: string, coalesceKey?: string } = {})
     // snapshot for undo (structuredClone of project BEFORE mutation), apply mutator to a draft
     // (the live project), set updatedAt, invalidate timeline, emit 'change' {detail:{label}}
     // consecutive updates with the same coalesceKey within 800ms merge into one undo step (sliders)
  undo(), redo(), get canUndo, get canRedo        // emit 'change' with label 'undo'/'redo'
  replaceProject(project, mediaMap?)              // load; clears undo; emits 'change' {label:'load'}
  addMedia(media) / removeMedia(id) / getMedia(id) // emits 'media'
  select(type, ids)  // ids string or array; emits 'selection'
  selectedItems(): VisualItem[] | TextItem[] | MusicItem[]  (resolved objects of current selection)
  find(id) -> { type:'item'|'text'|'music', obj, index } | null
  setView(partial)   // emits 'view'
}
```

Events (all `CustomEvent` on the store): `change`, `selection`, `media`, `view`.
Player time is **not** in the store; ask `app.player.currentTime`.

## Persistence (`js/persist.js`)

IndexedDB database `wlmm-web`, stores `projects` (key = project.id, value `{id, name, updatedAt,
project}`) and `media` (key = media.id, value `{id, projectIds?, type, name, mime, blob, duration,
width, height, hasAudio, thumb, filmstrip, peaks}`).

```js
export async function saveProject(project, mediaMap)   // also saves any media blobs not yet stored
export async function loadProject(id) -> { project, media: Map }   // recreates object URLs
export async function listProjects() -> [{id, name, updatedAt, thumb}] newest first
export async function deleteProject(id)
export async function getLastProjectId() / setLastProjectId(id)   // localStorage, try/catch
export function enableAutosave(store, delayMs=1500)   // debounce saveProject on 'change'/'media'
export async function exportProjectFile(project, mediaMap) -> Blob   // single-file .wlmmweb (JSON w/ base64 media) — optional large
export async function importProjectFile(file) -> { project, media }
```
All IndexedDB failures (private mode, quota) must be caught and reported via a returned/thrown
Error with a friendly message — never crash the app.

## Media import (`js/media.js`)

```js
export const ACCEPT_VISUAL = 'video/*,image/*'
export const ACCEPT_AUDIO  = 'audio/*,video/*'   // music may come from a video file's soundtrack
export function pickFiles(accept, multiple=true) -> Promise<File[]>   // hidden <input type=file>, must be called in a user gesture
export async function importFile(file, { onProgress }={}) -> Media    // type detection by mime then extension (.mov/.m4v/.mkv/.heic …)
export async function importFiles(files, opts) -> Media[]              // sequential, skips failures, returns successes; throws AggregateError-like info via opts.onError(file, err)
export async function computePeaks(media, audioCtx?) -> number[]|null  // decode audio to peaks
export function revokeMedia(media)
```
Video metadata: create `<video muted playsinline preload=metadata>`, wait `loadedmetadata`
(with timeout 15s; iOS sometimes needs `load()`), read duration/width/height; seek to times for
filmstrip and draw to a canvas. Unsupported codecs → reject with friendly error
("This video format isn't supported by your browser"). Images: `createImageBitmap` or `<img>`
decode; respect EXIF orientation (modern browsers do via `image-orientation: from-image`).
HEIC: try; on failure, friendly error.

## Rendering (`js/renderer.js`, `transitions.js`, `effects.js`, `text.js`, `catalog.js`, `gallery.js`)

```js
// catalog.js — every entry: { id, name, group }  (groups mirror WLMM gallery groups)
export const TRANSITIONS   // >= 24 incl. 'none','crossfade','fade-black','fade-white','wipe-left','wipe-right',
                           // 'wipe-up','wipe-down','slide-left','slide-right','push-left','push-right','iris-in',
                           // 'iris-out','diamond','clock','blinds-h','blinds-v','checkerboard','dissolve',
                           // 'zoom-in','zoom-out','diagonal-box','heart','barn-doors','page-curl'(approx), 'filmstrip'
export const PANZOOM       // 'none','auto','zoom-in','zoom-out','zoom-in-left','zoom-in-right','zoom-out-left','zoom-out-right',
                           // 'pan-left','pan-right','pan-up','pan-down'
export const EFFECTS       // 'none','bw','bw-orange','bw-red','bw-yellow','sepia','cyan','invert','blur','edge',
                           // 'posterize','pixelate','threshold','warm','cool','vintage','emboss','fade-in-black',
                           // 'fade-out-black','fade-in-white','fade-out-white','mirror-h','mirror-v','spin-360'(optional)
export const TEXT_EFFECTS  // 'none','fade','fly-left','fly-right','fly-up','zoom-in','zoom-out','typewriter',
                           // 'stretch','swing','wipe','scroll' (credits),'cinematic' (letterbox+fade)
export const AUTOMOVIE_THEMES // { id, name, transition, panZoom, effect, titleStyle, creditsStyle } e.g.
                           // 'default','contemporary','cinematic','fade','pan-zoom','sepia','black-white'
export function byId(list, id)

// renderer.js
export function renderFrame(ctx, t, {
  project, timeline, width, height,           // output size in CSS pixels of ctx's canvas
  getSource,   // (segment) => CanvasImageSource|null  (video element / image bitmap); null → draw placeholder
  getMedia,    // (mediaId) => Media|undefined
  quality: 'preview'|'export',                // preview may use cheaper effects
  hideTextIds?: Set<string>                   // texts being edited inline are skipped
}) -> void
// - clears to black; finds up to 2 active segments; draws with drawSegment (fit "contain",
//   letterbox in black, honoring rotation, panZoom progress, effect, brightness);
//   applies transition between outgoing (prev) and incoming (cur) using transitions.js;
//   draws title items (background + text), then active captions/credits (text.js) on top.
export function drawSegment(ctx, segment, source, localT, w, h, opts)
export function activeSegmentsAt(timeline, t) -> Segment[]   // 1 or 2 (prev, cur) during overlap
export function sourceTimeAt(segment, t) -> seconds into source media for a video segment

// transitions.js
export function drawTransition(ctx, type, p /*0..1*/, drawFrom: (ctx)=>void, drawTo: (ctx)=>void, w, h)
// effects.js
export function supportsCtxFilter() -> boolean
export function applyEffect(ctx, effectId, w, h, { brightness, localT, duration })  // post-process region
export function panZoomRect(panZoomId, p, srcW, srcH, dstW, dstH, index) -> {sx,sy,sw,sh}
// text.js
export function drawText(ctx, { text, style, effect, localT, duration, w, h, kind })
export function measureTextBox(ctx, {text, style, w, h}) -> {x,y,width,height}  // for hit-testing & inline editor
// gallery.js
export function renderGalleryThumb(canvas, kind /*'transition'|'panzoom'|'effect'|'text'|'automovie'*/, id, p /*0..1*/)
```
`ctx.filter` is unsupported on older Safari — effects must fall back to `getImageData`
pixel processing (on a scratch canvas, at reduced resolution for `quality:'preview'`). Images
are drawn with smoothing on; avoid per-frame allocations (reuse scratch canvases).

## Audio, playback, export (`js/audio.js`, `js/player.js`, `js/exporter.js`)

**All sound goes through Web Audio from decoded `AudioBuffer`s** (video soundtracks are decoded
with `decodeAudioData` from the video file's bytes). Video elements are therefore always
`muted` + `playsinline`, which keeps autoplay working on iOS and Android.

```js
// audio.js
export class AudioEngine {
  constructor()
  get context()            // lazily created AudioContext (webkitAudioContext fallback)
  async unlock()           // call inside a user gesture: resume() + play 1-sample silent buffer
  async getBuffer(media)   // decode & cache by media.id; null if no audio / decode fails
  async prepare(project, store)   // pre-decode every referenced media in background
  start(project, timeline, fromTime, { destination }?) // schedule all audible sources from fromTime;
                           // applies item volume, fades (gain ramps), speed (playbackRate, pitch not preserved is OK),
                           // audioMix (video vs music balance), master gain; returns ctx time at which t=fromTime
  stop()                   // stop all scheduled sources
  get masterGain()         // GainNode → context.destination (and to extra destinations during export)
  createStreamDestination() -> MediaStreamAudioDestinationNode connected from master
}
// player.js
export class Player extends EventTarget {
  constructor({ store, audio, canvas, mediaHost /* hidden DOM element to park <video>s in */ })
  get currentTime(), get duration(), get playing()
  async play()    // must be callable from a gesture: unlock audio, start clock, start video elements
  pause(), toggle(), async seek(t), stepFrame(dir /* ±1 */)   // 1/30s
  setOutput(canvas | null)   // temporarily render to another canvas (export); null = restore preview canvas
  renderNow()                // redraw current frame (after edits)
  setOverlayHook(fn(ctx, t, w, h))   // optional extra drawing (e.g. trim mode markers)
  set loopRange({start,end}|null)    // for trim mode preview
  events: 'timeupdate' {detail:{time}}, 'play', 'pause', 'ended', 'durationchange'
}
```
Player details: master clock = `audio.context.currentTime` while playing (fallback
`performance.now()`); a rAF loop renders frames and keeps each active segment's `<video>`
synced (`playbackRate = speed`; re-seek if drift > 0.25s; pre-roll the next segment's video ~1s
before it becomes active). One pooled `<video>` per VisualItem id (created lazily, `muted`,
`playsinline`, `preload=auto`, appended to `mediaHost`), released when the item disappears.
Images: decode once to `ImageBitmap`/`HTMLImageElement` and cache by mediaId. When paused,
`seek()` sets `currentTime` on needed videos and redraws on `seeked`. The player listens to
store `change` to recompute and redraw. Canvas backing store = CSS size × devicePixelRatio
(cap 2) while keeping the project aspect ratio.

```js
// exporter.js
export const EXPORT_PRESETS = [   // WLMM "Save movie" menu
  { id:'recommended', name:'Recommended for this project', height: 720 },
  { id:'hd1080', name:'High definition (1080p)', height:1080 },
  { id:'hd720', name:'High definition (720p)', height:720 },
  { id:'wide480', name:'Widescreen (480p)', height:480 },
  { id:'mobile', name:'For mobile phone', height:480 },
  { id:'email', name:'For email', height:240 },
]
export function supportedFormats() -> [{ mime, ext, label }]   // probes MediaRecorder.isTypeSupported:
       // prefer 'video/mp4;codecs=avc1,mp4a' / 'video/mp4' (Safari, new Chrome), then webm vp9/vp8+opus
export class Exporter extends EventTarget {
  constructor({ store, player, audio })
  async exportMovie({ presetId, mime, fps=30, onProgress(p 0..1, t) , signal }) -> Blob
     // real-time: pause player, size an export canvas (even dims, project aspect), player.setOutput(canvas),
     // canvas.captureStream(fps) + audio.createStreamDestination() track → MediaRecorder,
     // seek(0), play, stop at 'ended'; request screen Wake Lock if available; restore everything after,
     // also on error/abort. If MediaRecorder is missing, throw a friendly Error.
  snapshot(t) -> Promise<Blob>  // PNG of the current frame at export resolution (WLMM "Snapshot")
}
export function downloadBlob(blob, filename)   // <a download>; on iOS falls back to navigator.share({files}) when available
```

## Commands (`js/commands.js`, `js/automovie.js`)

```js
export function createCommands(app) -> {
  run(name, arg) -> any|Promise,  // unknown name → console.warn
  isEnabled(name) -> boolean,
  isChecked(name, arg) -> boolean // e.g. current transition/effect/aspect highlighting
  list() -> string[]
}
```
`app` = `{ store, player, audio, exporter, dialogs, persist, media }` (see app.js).

Command names (the ribbon/storyboard/preview/keyboard invoke exactly these):

| name | arg | behaviour |
|---|---|---|
| `addMedia` | `File[]?` | no arg → `media.pickFiles(ACCEPT_VISUAL)`; import, insert video/image items after the current selection (or at end), select them |
| `addMusic` | `File[]?` | import audio; add MusicItem at the start of the project (WLMM "Add music") placing multiple files back to back |
| `addMusicAtPlayhead` | `File[]?` | same, starting at player.currentTime |
| `webcam` / `narration` | – | open recording dialogs (`dialogs.openWebcam()` / `dialogs.openNarration()`); result inserted as video item / narration MusicItem at playhead |
| `snapshot` | – | exporter.snapshot(now) → image Media → image item after selection |
| `addTitle` | – | title item before the selected item (or at start), select it, open inline edit |
| `addCaption` | – | caption at playhead (duration 3.5s) |
| `addCredits` | – | credits item at end ('scroll' effect, text "CREDITS\nDirector\n…") |
| `autoMovie` | themeId | apply theme (automovie.js) |
| `cut` `copy` `paste` | – | clipboard for visual items / texts / music (deep copy with new ids) |
| `remove` | – | delete selection |
| `selectAll` | – | select all visual items |
| `rotateLeft` `rotateRight` | – | rotate selected visual items |
| `moveItem` | `{id, toIndex}` | reorder visual item (storyboard drag) |
| `moveText` / `moveMusic` | `{id, start}` | change start time (storyboard drag) |
| `setTransition` | id | on selected items (`transition.type`); if duration 0 use default |
| `setTransitionDuration` | seconds | selected |
| `applyTransitionAll` | – | copy the selected item's transition to all items |
| `setPanZoom` / `applyPanZoomAll` | id / – | |
| `setEffect` / `applyEffectAll` | id / – | |
| `setBrightness` | -100..100 | coalesced |
| `setAspect` | '16:9'... | |
| `setAudioMix` | -1..1 | coalesced |
| `emphasize` | 'video'\|'music'\|'narration' | sets audioMix (-0.6 / 0.6 / special: lowers music volume to 0.3 for music items while narration plays) |
| `fitToMusic` | – | scale image/title durations so visuals end with music |
| `zoomIn` `zoomOut` | – | view.zoom ×/÷ 1.5 clamp 5..400 |
| `setThumbSize` / `toggleWaveforms` / `setPreviewSize` | value | view |
| `setVolume` `setFadeIn` `setFadeOut` `setSpeed` `setDuration` | value | selected visual items (video tools) |
| `split` | – | split selected video/image/title at playhead into two items (videos: trim halves) |
| `trimTool` | – | `dialogs.openTrim(itemId)` |
| `setStartPoint` / `setEndPoint` | – | trim selected video so it starts/ends at playhead |
| `setBackground` | color | title background |
| `musicVolume` `musicFadeIn` `musicFadeOut` | value | selected music |
| `musicStartTime` | seconds? | default playhead |
| `musicSetStartPoint` `musicSetEndPoint` `musicSplit` | – | at playhead |
| `textSet` | `{key, value}` | key ∈ TextStyle keys; applies to selected caption/credits, or title item's `style` |
| `textEdit` | `string?` | with arg: set text; without: request inline editing (`app.preview.editText(id)`) |
| `textDuration` / `textStartTime` / `textEffect` | value | |
| `undo` `redo` | | |
| `play` `pause` `togglePlay` `seek`(t) `prevFrame` `nextFrame` `goStart` `goEnd` `prevItem` `nextItem` | | |
| `newProject` `openProject` `saveProject` `saveProjectAs` `importProjectFile` `exportProjectFile` | | via persist + dialogs |
| `saveMovie` | presetId? | `dialogs.openExport(presetId)` |
| `about` / `help` | | dialogs |

Keyboard (desktop, in app.js): Space play/pause, Ctrl+Z/Y undo/redo, Ctrl+X/C/V, Delete remove,
Ctrl+A select all, Left/Right frame step, Home/End, `M` split, Ctrl+S save project.

## UI (`index.html`, `css/moviemaker.css`, `js/ui/*`)

Visual language: **Windows Live Movie Maker 2011** on Windows 7 — light-blue Aero title bar with a
blue "file" app-menu button and a quick access toolbar (save, undo, redo), ribbon with tabs
**Home · Animations · Visual Effects · Project · View** plus colored *contextual* tabs
**Video Tools › Edit** (orange-yellow), **Music Tools › Options** (green), **Text Tools › Format**
(orange-red) that appear only for the matching selection. Ribbon groups have a caption label
under them and large/small buttons with icons; galleries are rows of thumbnails with a hover
(desktop)/tap animated preview. Main area: **preview monitor** on the left (black stage,
time "00:00.00/00:00.00", big round blue play button, prev/next frame buttons, seek slider) and
the **storyboard** on the right (light gray background, thumbnails with a filmstrip look,
transition marker in front of items that have one, pan/zoom marker, green music bars and orange
caption bars below the items, a vertical black playhead). Status bar at the bottom: "Item 2 of 7",
zoom slider, thumbnail-size buttons.

**Phone layout** (`max-width: 760px` or `(pointer:coarse) and (max-width: 1024px)` in portrait):
title bar shrinks to 44px (app-menu button, title, undo/redo, Save movie); ribbon tabs become a
horizontally scrolling tab strip and each tab's commands a single horizontally scrolling row of
44px buttons (galleries open as a bottom sheet grid); preview sits on top at full width
(aspect-ratio of project, max 45vh); transport row below; storyboard is a **single horizontal
filmstrip lane** (scroll horizontally, playhead centered, scrolling seeks — like phone editors)
with music/caption lanes beneath; status bar hidden. Use `100dvh`, `env(safe-area-inset-*)`,
`touch-action` appropriately, `-webkit-tap-highlight-color: transparent`, no zoom on input focus
(font-size ≥ 16px for inputs on mobile).

DOM ids (D writes them in index.html; E/F mount into them):
```
#app, #titlebar, #qat (quick access toolbar), #app-menu-btn, #doc-title,
#ribbon (D renders inside), #main, #preview-pane (E), #storyboard-pane (E),
#statusbar, #status-text, #media-host (hidden parking for <video>s, F creates if missing),
#dialog-root (F), #toast-root (F), #drop-overlay (F: drag & drop files over window)
```

```js
// ui/ribbon.js (D)
export class Ribbon { constructor(rootEl, app); refresh(); }   // refresh on store change/selection/view
// reads app.store for state, app.commands for isEnabled/isChecked; galleries use gallery.js thumbs.
// Contextual tab auto-activates when selection type changes (like WLMM).
// Value controls: sliders/selects/number steppers call commands with values.
// Also renders the quick access toolbar into #qat and wires #app-menu-btn → app.dialogs.openAppMenu().
// ui/storyboard.js (E)
export class Storyboard { constructor(rootEl, app); refresh(); scrollToTime(t); }
// ui/preview.js (E)
export class Preview { constructor(rootEl, app); editText(id); }  // creates the <canvas> + transport, gives canvas via .canvas
// ui/dialogs.js (F)
export class Dialogs {
  constructor(app)
  open({ title, body: Node, buttons:[{label, value, primary}] , sheet?:boolean }) -> Promise<value>
  confirm(msg) / promptText(title, value) -> Promise
  toast(msg, { type:'info'|'error'|'success', timeout })
  progress(title) -> { set(p, text), close(), signal }   // cancelable
  openAppMenu(); openExport(presetId); openWebcam(); openNarration(); openTrim(itemId); openAbout(); openProjects()
}
// app.js (F) — creates: store, audio, player, exporter, dialogs, commands, ribbon, preview, storyboard;
// exposes window.app for debugging; restores last project from IndexedDB; enables autosave;
// registers sw.js (only on https/localhost); handles drag & drop + paste of files; keyboard shortcuts;
// shows an empty-state hint "Click here to browse for videos and photos" on the storyboard (E renders it,
// calls command addMedia).
```

Construction order in app.js:
```js
const app = {};
app.store = new Store(); app.persist = persist; app.media = media;
app.audio = new AudioEngine();
app.dialogs = new Dialogs(app);
app.preview = new Preview(document.getElementById('preview-pane'), app);   // creates canvas
app.player = new Player({ store: app.store, audio: app.audio, canvas: app.preview.canvas, mediaHost });
app.exporter = new Exporter({ store: app.store, player: app.player, audio: app.audio });
app.commands = createCommands(app);
app.preview.attach();   // preview subscribes to player events now that it exists
app.ribbon = new Ribbon(document.getElementById('ribbon'), app);
app.storyboard = new Storyboard(document.getElementById('storyboard-pane'), app);
```
So `Preview` must not touch `app.player` / `app.commands` in its constructor — only in `attach()`
and later event handlers. Every other UI module may use the full `app` in its constructor.

## Integration notes & end-to-end test

- **End-to-end test**: `NODE_PATH=/opt/node22/lib/node_modules node tests/e2e.mjs [--phone|--desktop|--landscape|--profile=a,b] [--no-export]`
  (starts its own `http-server` unless `BASE_URL` is set; screenshots and exported movies go to `$E2E_OUT`, default
  `<tmp>/moviemaker-e2e`). It boots the real `index.html` in Chromium as desktop (1366×768), iPhone portrait
  (390×844, touch, DPR 3) and iPhone landscape (844×390) and drives the UI with real clicks/taps: import through the
  file chooser, music/title/caption/credits, ribbon galleries, aspect, playback, scrubbing, split, trim tool, drag
  reorder (touch long-press on phones), undo/redo, AutoMovie, "Save movie › For email" verified with `ffprobe`/`ffmpeg`,
  and reload-from-IndexedDB. Any console error, page error or failed app request fails the run.
- **Keyboard (app.js)**: Space plays/pauses after a mouse click or tap anywhere (including storyboard items); only a
  control reached with **Tab** keeps its own Space behaviour.
- **Captions follow their clip** for every timeline edit, including the Trim tool's *Save trim* (dialogs.js uses
  `anchorTexts` / `reanchorTexts` from automovie.js).
- **Dialogs** toggle `html.mm-modal-open` while a modal or menu is open; on phones the stylesheet then shows toasts at
  the top so they never cover a bottom sheet's buttons.
- **Phone storyboard** grows the filmstrip into the pane's free height (up to 96px at medium thumbnail size) and keeps
  the fixed playhead aligned with it; on desktop, time after the last picture (e.g. end credits) is drawn as a black
  "Credits" slate in the item track.
- The service worker precaches every module listed in `sw.js` `SHELL`; bump `VERSION` there whenever shell files change.
