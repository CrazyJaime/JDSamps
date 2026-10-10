// Movie Maker (web) — Exporter: "Save movie". Renders the movie in real time into an
// off-screen canvas, records it together with the Web Audio mix through MediaRecorder,
// and patches the WebM header so the saved file has a duration and is seekable.

import { ASPECTS } from './model.js';
import { isIOS } from './audio.js';

export const EXPORT_PRESETS = [ // WLMM "Save movie" menu
  { id: 'recommended', name: 'Recommended for this project', height: 720 },
  { id: 'hd1080', name: 'High definition (1080p)', height: 1080 },
  { id: 'hd720', name: 'High definition (720p)', height: 720 },
  { id: 'wide480', name: 'Widescreen (480p)', height: 480 },
  { id: 'mobile', name: 'For mobile phone', height: 480 },
  { id: 'email', name: 'For email', height: 240 },
];

const MP4_LABEL = 'MPEG-4/H.264 video file (.mp4)';
const MP4_GENERIC_LABEL = 'MPEG-4 video file (.mp4)';
const WEBM_LABEL = 'WebM video file (.webm)';

// Probed in order. AAC-in-MP4 first (plays everywhere, incl. iPhone Photos), then WebM.
const MP4_AAC = [
  'video/mp4;codecs="avc1.640028,mp4a.40.2"',
  'video/mp4;codecs="avc1.4d0028,mp4a.40.2"',
  'video/mp4;codecs="avc1.42E01F,mp4a.40.2"',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4;codecs="avc1,mp4a.40.2"',
];
const WEBM = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="vp8,opus"',
  'video/webm',
];
const MP4_OTHER = [
  'video/mp4;codecs=avc1,opus',
  'video/mp4;codecs="avc1,opus"',
  'video/mp4;codecs=avc1',
  'video/mp4',
];

const AUDIO_BPS = 128000;
const TIMESLICE_MS = 1000;
const STALL_MS = 20000;
const SOUND_NOTICE_MS = 400;     // say "Preparing the sound…" when decoding takes longer than this
const SOUND_STALL_MS = 130000;   // give up waiting when no soundtrack finished decoding for this long

function isCoarsePointer() {
  try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch (_) { return false; }
}

function now() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

function makeEvent(type, detail) {
  if (typeof CustomEvent === 'function') return new CustomEvent(type, { detail });
  const e = new Event(type);
  e.detail = detail;
  return e;
}

/** Error whose message can be shown to the user as-is. */
function friendly(message, code = 'export-failed', cause) {
  const err = new Error(message);
  err.name = 'ExportError';
  err.code = code;
  err.friendly = true;
  if (cause !== undefined) err.cause = cause;
  return err;
}

function abortError() {
  const err = new Error('Saving the movie was canceled.');
  err.name = 'AbortError';
  err.code = 'aborted';
  err.friendly = true;
  return err;
}

function isTypeSupported(mime) {
  try {
    return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
      && MediaRecorder.isTypeSupported(mime);
  } catch (_) { return false; }
}

function baseMime(mime) { return String(mime || '').split(';')[0].trim().toLowerCase(); }

function extFor(mime) {
  const b = baseMime(mime);
  if (b === 'video/mp4' || b === 'video/quicktime') return 'mp4';
  if (b === 'video/x-matroska') return 'mkv';
  return 'webm';
}

/**
 * Formats this browser can record, best first: [{ mime, ext, label }].
 * Empty when MediaRecorder is missing.
 */
export function supportedFormats() {
  if (typeof MediaRecorder === 'undefined') return [];
  const out = [];
  const hasIsType = typeof MediaRecorder.isTypeSupported === 'function';
  if (!hasIsType) {
    // Very old implementations: let the browser pick its default container.
    return [{ mime: '', ext: 'webm', label: 'Video file' }];
  }
  const mp4 = MP4_AAC.find(isTypeSupported);
  const webm = WEBM.find(isTypeSupported);
  if (mp4) out.push({ mime: mp4, ext: 'mp4', label: MP4_LABEL });
  if (webm) out.push({ mime: webm, ext: 'webm', label: WEBM_LABEL });
  if (!mp4) {
    const other = MP4_OTHER.find(isTypeSupported);
    // Safari reports plain 'video/mp4' (H.264/AAC); Chrome's non-AAC MP4 goes after WebM.
    if (other) out.push({ mime: other, ext: 'mp4', label: out.length ? MP4_GENERIC_LABEL : MP4_LABEL });
  }
  return out;
}

function pickFormat(mime) {
  const list = supportedFormats();
  if (mime) {
    const want = String(mime).toLowerCase();
    const exact = list.find((f) => f.mime.toLowerCase() === want);
    if (exact) return exact;
    if (isTypeSupported(mime)) return { mime, ext: extFor(mime), label: '' };
    const sameBase = list.find((f) => baseMime(f.mime) === baseMime(want) || f.ext === want);
    if (sameBase) return sameBase;
  }
  return list[0] || null;
}

function even(v) { return Math.max(2, Math.round(v / 2) * 2); }

/** Height WLMM would recommend: the sources' resolution, between 480 and 1080. */
function recommendedHeight(project, mediaMap) {
  let best = 0;
  const items = project && Array.isArray(project.items) ? project.items : [];
  for (const it of items) {
    if (!it || it.kind !== 'video' || !it.mediaId) continue;
    const m = mediaMap && typeof mediaMap.get === 'function' ? mediaMap.get(it.mediaId) : null;
    if (!m || !(m.width > 0) || !(m.height > 0)) continue;
    const short = Math.min(m.width, m.height);
    if (short > best) best = short;
  }
  if (!best) return 720;
  if (best >= 1000) return 1080;
  if (best >= 700) return 720;
  return 480;
}

/**
 * Output size for a preset: the preset's number is the frame height for landscape and
 * square projects and the width (short side) for portrait ones, like phone editors.
 * On touch devices everything is capped at 720p unless 1080p was chosen explicitly.
 * Returns { width, height } (even numbers).
 */
export function exportSize(presetId, project, mediaMap, { coarse = isCoarsePointer() } = {}) {
  const preset = EXPORT_PRESETS.find((p) => p.id === presetId) || EXPORT_PRESETS[0];
  let short = preset.id === 'recommended' ? recommendedHeight(project, mediaMap) : preset.height;
  if (coarse && preset.id !== 'hd1080') short = Math.min(short, 720);
  const aspect = (project && ASPECTS[project.aspect]) || 16 / 9;
  if (aspect >= 1) return { width: even(short * aspect), height: even(short) };
  return { width: even(short), height: even(short / aspect) };
}

/** Video bitrate scaled to the frame size (≈0.12 bits per pixel). */
export function videoBitrate(width, height, fps) {
  return Math.round(Math.min(12e6, Math.max(400e3, width * height * fps * 0.12)));
}

/** A sensible file name for a project, e.g. "My Movie.mp4". */
export function movieFileName(project, ext) {
  const raw = project && typeof project.name === 'string' ? project.name : '';
  const name = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'My Movie';
  return name + '.' + (ext || 'webm');
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      try {
        const url = canvas.toDataURL(type, quality);
        const comma = url.indexOf(',');
        const bin = atob(url.slice(comma + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes], { type }));
      } catch (err) {
        reject(friendly("The picture couldn't be created. Try a smaller preview size.", 'snapshot-failed', err));
      }
    };
    if (typeof canvas.toBlob !== 'function') { fallback(); return; }
    try {
      canvas.toBlob((b) => { if (b && b.size) resolve(b); else fallback(); }, type, quality);
    } catch (_) { fallback(); }
  });
}

async function requestWakeLock() {
  try {
    if (typeof navigator !== 'undefined' && navigator.wakeLock && typeof navigator.wakeLock.request === 'function'
      && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
      return await navigator.wakeLock.request('screen');
    }
  } catch (_) { /* not allowed / not supported */ }
  return null;
}

function releaseWakeLock(lock) {
  if (!lock) return;
  try { const p = lock.release(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
}

function createRecorder(stream, mime, vbps) {
  const attempts = [];
  if (mime) {
    attempts.push({ mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: AUDIO_BPS });
    attempts.push({ mimeType: mime, videoBitsPerSecond: vbps });
    attempts.push({ mimeType: mime });
  }
  attempts.push({ videoBitsPerSecond: vbps });
  attempts.push(undefined);
  let last = null;
  for (const opts of attempts) {
    try { return opts ? new MediaRecorder(stream, opts) : new MediaRecorder(stream); } catch (err) { last = err; }
  }
  throw friendly("This browser couldn't start recording the movie. Try another format or a lower resolution.",
    'recorder-failed', last);
}

function supportsRequestFrame() {
  return typeof window !== 'undefined' && typeof window.CanvasCaptureMediaStreamTrack === 'function'
    && typeof window.CanvasCaptureMediaStreamTrack.prototype.requestFrame === 'function';
}

// ---------------------------------------------------------------------------

export class Exporter extends EventTarget {
  constructor({ store, player, audio } = {}) {
    super();
    if (!store || !player) throw new TypeError('Exporter needs a store and a player');
    this.store = store;
    this.player = player;
    this.audio = audio || null;
    this._busy = false;
  }

  get busy() { return this._busy; }

  /** Output size for a preset on this device (see exportSize). */
  sizeFor(presetId) {
    return exportSize(presetId, this.store.project, this.store.media);
  }

  /**
   * Record the whole movie in real time. Resolves with the movie Blob.
   * onProgress(p 0..1, t seconds, info { state, message }) — states: 'preparing', 'recording',
   * 'hidden' (paused while the tab is in the background), 'waiting' (needs a tap to restart sound,
   * iOS), 'resumed', 'warning', 'finalizing', 'done'. Show `message` when it is not empty.
   */
  async exportMovie({ presetId = 'recommended', mime, fps = 30, onProgress, signal } = {}) {
    // Sound must be unlocked inside the click that started the export (iOS): do it first.
    let unlockP = Promise.resolve(false);
    if (this.audio && typeof this.audio.unlock === 'function') {
      try { unlockP = Promise.resolve(this.audio.unlock()).catch(() => false); } catch (_) { /* ignore */ }
    }
    if (this._busy) throw friendly('A movie is already being saved. Please wait for it to finish.', 'busy');
    if (typeof MediaRecorder === 'undefined') {
      throw friendly("Saving movies isn't supported in this browser. Please use the latest Chrome, Edge, Firefox or Safari.",
        'no-mediarecorder');
    }
    if (typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined'
      || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
      throw friendly("This browser can't record video from the movie. Please use the latest Chrome, Edge, Firefox or Safari.",
        'no-capture');
    }
    if (signal && signal.aborted) throw abortError();
    const store = this.store, player = this.player;
    const duration = store.timeline.duration;
    if (!(duration > 0.05)) throw friendly('Add some videos or photos before saving a movie.', 'empty');
    const format = pickFormat(mime);
    if (!format) {
      throw friendly("This browser can't record video in any format Movie Maker supports.", 'no-format');
    }
    const { width, height } = exportSize(presetId, store.project, store.media);
    const rate = Math.round(Math.min(60, Math.max(10, Number.isFinite(+fps) ? +fps : 30)));

    this._busy = true;
    const progress = (p, t, state, message = '') => {
      const info = { state, message, width, height, mime: format.mime };
      if (typeof onProgress === 'function') {
        try { onProgress(Math.max(0, Math.min(1, p)), t, info); } catch (err) { console.warn(err); }
      }
      this.dispatchEvent(makeEvent('progress', { p, t, ...info }));
    };

    const saved = { time: player.currentTime, loop: player.loopRange };
    if (player.playing) player.pause();
    progress(0, 0, 'preparing');

    let canvas = null;
    let stream = null;
    let videoTrack = null;
    let dest = null;
    let recorder = null;
    let wake = null;
    let mutedSpeakers = false;
    const listeners = [];
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); };
    let watchdog = 0;

    try {
      // --- canvas & video track
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
      (player.mediaHost || document.body).appendChild(canvas);
      const ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
      if (!ctx) throw friendly("Movie Maker couldn't prepare the video picture. Try a lower resolution.", 'no-canvas');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);

      let manualFrames = false;
      if (supportsRequestFrame()) {
        try {
          stream = canvas.captureStream(0);
          videoTrack = stream.getVideoTracks()[0] || null;
          manualFrames = !!(videoTrack && typeof videoTrack.requestFrame === 'function');
        } catch (_) { stream = null; }
        if (!manualFrames && stream) { for (const tr of stream.getTracks()) tr.stop(); stream = null; }
      }
      if (!stream) {
        try { stream = canvas.captureStream(rate); } catch (err) {
          throw friendly("This browser can't record video from the movie.", 'no-capture', err);
        }
        videoTrack = stream.getVideoTracks()[0] || null;
      }
      if (!videoTrack) throw friendly("This browser can't record video from the movie.", 'no-capture');

      // --- audio track
      await Promise.race([unlockP, new Promise((r) => setTimeout(r, 1500))]);
      let audioWarning = '';
      if (this.audio && typeof this.audio.createStreamDestination === 'function') {
        try {
          const ctxA = this.audio.contextIfCreated || this.audio.context;
          if (ctxA && ctxA.state === 'running') {
            dest = this.audio.createStreamDestination();
            const at = dest.stream.getAudioTracks()[0];
            if (at) stream.addTrack(at);
          } else {
            // A suspended context feeds no samples, and some recorders then stall waiting for
            // sound: record picture only rather than risk an empty file.
            audioWarning = "Sound couldn't be started, so the saved movie will be silent. Close this and choose "
              + 'Save movie again to retry with sound.';
          }
        } catch (err) {
          dest = null;
          audioWarning = "This browser can't record the movie's sound, so the saved movie will be silent.";
        }
      } else {
        audioWarning = "This browser can't play sound through Web Audio, so the saved movie will be silent.";
      }

      // --- sound: every soundtrack must be decoded before recording starts, or the start of
      // it (or all of it: a big video on a phone decodes for a while) would be missing.
      if (dest) {
        const missing = await this._prepareSound(store, signal, progress);
        if (signal && signal.aborted) throw abortError();
        if (missing) audioWarning = missing;
      }

      // --- recorder
      recorder = createRecorder(stream, format.mime, videoBitrate(width, height, rate));
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      // --- player into export mode
      player.loopRange = null;
      player.setOutput(canvas);
      if (this.audio && 'outputMuted' in this.audio) { this.audio.outputMuted = true; mutedSpeakers = true; }
      await Promise.race([player.seek(0), new Promise((r) => setTimeout(r, 4000))]);
      if (signal && signal.aborted) throw abortError();
      wake = await requestWakeLock();
      if (audioWarning) progress(0, 0, 'warning', audioWarning);

      // --- record
      let recError = null;
      let rejectRun = null;
      const failRun = (err) => { recError = recError || err; if (rejectRun) rejectRun(recError); };
      recorder.onerror = (e) => {
        const inner = e && (e.error || e);
        failRun(friendly('The browser stopped recording the movie' + (inner && inner.name ? ` (${inner.name})` : '')
          + '. Try a lower resolution or another format.', 'recorder-error', inner));
      };
      // Frames are captured on display ticks. Take frame k on the first tick at or after
      // k/rate + phase, so the picture sampled is the one at the middle of the frame's interval
      // rather than right at its start, where a video frame boundary usually sits as well
      // (sampling there makes neighbouring source frames alternate: repeated/skipped frames).
      // Each output frame slot is captured once, even when the phase moves.
      let lastSlot = -Infinity;
      let tickDt = 1 / 60;
      let lastTickT = -1;
      let lastProgressAt = now();
      let lastReport = 0;
      let ended = false;
      let internalPause = false;
      let hiddenPause = false;
      let waitingTap = false;
      let resumeAfter = -1; // resume the recorder once playback moves past this time
      let pausedTotal = 0;
      let pausedAt = 0;

      const pauseRecorder = () => {
        if (recorder.state === 'recording' && typeof recorder.pause === 'function') {
          try { recorder.pause(); pausedAt = now(); } catch (_) { /* ignore */ }
        }
      };
      const resumeRecorder = () => {
        if (recorder.state === 'paused' && typeof recorder.resume === 'function') {
          try { recorder.resume(); } catch (_) { /* ignore */ }
          if (pausedAt) { pausedTotal += now() - pausedAt; pausedAt = 0; }
        }
      };

      try { recorder.start(TIMESLICE_MS); } catch (err) {
        throw friendly("This browser couldn't start recording the movie. Try another format or a lower resolution.",
          'recorder-failed', err);
      }
      const recordStart = now();
      // Timestamps run from start(): hold the recorder until the clock really moves so the
      // movie doesn't open with a frozen frame while videos and sound get going.
      if (manualFrames) { try { videoTrack.requestFrame(); } catch (_) { /* ignore */ } }
      else player.renderNow(); // repaint so captureStream(fps) picks up frame 0
      pauseRecorder();
      if (recorder.state === 'paused') resumeAfter = 0;
      progress(0, 0, 'recording');

      await new Promise((resolve, reject) => {
        rejectRun = reject;
        if (recError) { reject(recError); return; }
        if (signal && signal.aborted) { reject(abortError()); return; }
        on(player, 'timeupdate', (e) => {
          const t = e && e.detail ? e.detail.time : player.currentTime;
          if (!player.playing) return;
          lastProgressAt = now();
          if (resumeAfter >= 0) {
            if (!(t > resumeAfter + 1e-4)) return;
            resumeAfter = -1;
            resumeRecorder();
            lastSlot = -Infinity;
          }
          if (lastTickT >= 0 && t > lastTickT && t - lastTickT < 0.1) tickDt += (t - lastTickT - tickDt) * 0.1;
          lastTickT = t;
          const slot = Math.floor((t - Math.max(0, 0.5 / rate - tickDt / 2)) * rate + 1e-6);
          if (manualFrames && slot > lastSlot) {
            try { videoTrack.requestFrame(); } catch (_) { /* ignore */ }
            lastSlot = slot;
          }
          const pn = now();
          if (pn - lastReport >= 100) { lastReport = pn; progress(t / duration, t, 'recording'); }
        });
        on(player, 'ended', () => { ended = true; resolve(); });
        on(player, 'pause', () => {
          if (ended || internalPause) return;
          // 'pause' also precedes 'ended': decide once this event round is over.
          setTimeout(() => {
            if (ended || recError || (signal && signal.aborted) || hiddenPause || player.playing) return;
            // Someone paused playback (keyboard shortcut…): skip the gap and carry on recording.
            pauseRecorder();
            resumeAfter = player.currentTime;
            player.play().catch(failRun);
          }, 0);
        });
        if (signal) on(signal, 'abort', () => failRun(abortError()));
        on(document, 'visibilitychange', () => {
          if (document.hidden) {
            if (ended || hiddenPause) return;
            hiddenPause = true;
            internalPause = true;
            player.pause();
            internalPause = false;
            pauseRecorder();
            progress(player.currentTime / duration, player.currentTime, 'hidden',
              'Saving is paused while Movie Maker is in the background. Come back to this tab to continue.');
          } else if (hiddenPause) {
            hiddenPause = false;
            (async () => {
              if (this.audio && typeof this.audio.unlock === 'function') {
                try { await Promise.race([this.audio.unlock(), new Promise((r) => setTimeout(r, 1500))]); } catch (_) { /* ignore */ }
              }
              const ctxA = this.audio && this.audio.contextIfCreated;
              if (dest && ctxA && ctxA.state !== 'running' && typeof this.audio.addEventListener === 'function') {
                // iOS only restarts sound from a tap: ask for one (the audio engine resumes on any tap).
                waitingTap = true;
                progress(player.currentTime / duration, player.currentTime, 'waiting', 'Tap anywhere to continue saving your movie.');
                const audio = this.audio;
                await new Promise((res) => {
                  let timer = 0;
                  const finish = () => {
                    clearTimeout(timer);
                    audio.removeEventListener('statechange', onState);
                    if (signal) signal.removeEventListener('abort', finish);
                    res();
                  };
                  const onState = () => { if (ctxA.state === 'running') finish(); };
                  timer = setTimeout(finish, 120000);
                  audio.addEventListener('statechange', onState);
                  if (signal) signal.addEventListener('abort', finish);
                });
                waitingTap = false;
                lastProgressAt = now();
              }
              releaseWakeLock(wake);
              wake = await requestWakeLock();
              if (ended || recError || (signal && signal.aborted)) return;
              const t = player.currentTime;
              await Promise.race([player.seek(t), new Promise((r) => setTimeout(r, 2000))]);
              resumeAfter = t;
              progress(t / duration, t, 'resumed');
              lastProgressAt = now();
              await player.play();
            })().catch(failRun);
          }
        });
        watchdog = setInterval(() => {
          if (hiddenPause || waitingTap || ended || (typeof document !== 'undefined' && document.hidden)) {
            lastProgressAt = now();
            return;
          }
          if (now() - lastProgressAt > STALL_MS) {
            failRun(friendly('Saving the movie stopped responding. Close other apps or tabs and try again, '
              + 'or choose a lower resolution.', 'stalled'));
          }
        }, 1000);
        player.play().catch(failRun);
      });

      // --- finalize: let the last frame and the sound tail reach the recorder
      progress(1, duration, 'finalizing');
      if (manualFrames) { try { videoTrack.requestFrame(); } catch (_) { /* ignore */ } }
      await new Promise((r) => setTimeout(r, Math.max(40, 1000 / rate)));
      if (pausedAt) { pausedTotal += now() - pausedAt; pausedAt = 0; }
      const recorded = Math.max(0, (now() - recordStart - pausedTotal) / 1000);
      await new Promise((resolve) => {
        if (recorder.state === 'inactive') { resolve(); return; }
        const timer = setTimeout(resolve, 8000);
        recorder.addEventListener('stop', () => { clearTimeout(timer); resolve(); }, { once: true });
        try { recorder.stop(); } catch (_) { clearTimeout(timer); resolve(); }
      });
      if (recError) throw recError;
      const type = baseMime(recorder.mimeType || format.mime) || 'video/webm';
      let blob = new Blob(chunks, { type });
      chunks.length = 0;
      if (!blob.size) {
        throw friendly("The movie couldn't be saved: the browser produced an empty file. "
          + 'Try a lower resolution or another format.', 'empty-output');
      }
      if (type === 'video/webm' || type === 'video/x-matroska') {
        try {
          blob = await fixWebmDuration(blob, recorded > 0.1 ? recorded : duration);
        } catch (err) {
          console.warn('Movie Maker: could not add the duration to the WebM file.', err);
        }
      }
      progress(1, duration, 'done');
      return blob;
    } catch (err) {
      if (err && err.friendly) throw err;
      if (err && err.name === 'AbortError') throw abortError();
      throw friendly("The movie couldn't be saved" + (err && err.message ? ` (${err.message})` : '') + '.', 'export-failed', err);
    } finally {
      if (watchdog) clearInterval(watchdog);
      for (const [target, type, fn, opts] of listeners) {
        try { target.removeEventListener(type, fn, opts); } catch (_) { /* ignore */ }
      }
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.ondataavailable = null; recorder.stop(); } catch (_) { /* ignore */ }
      }
      try { player.pause(); } catch (_) { /* ignore */ }
      if (stream) { for (const tr of stream.getTracks()) { try { tr.stop(); } catch (_) { /* ignore */ } } }
      if (dest && this.audio && typeof this.audio.releaseStreamDestination === 'function') {
        try { this.audio.releaseStreamDestination(dest); } catch (_) { /* ignore */ }
      }
      if (mutedSpeakers) { try { this.audio.outputMuted = false; } catch (_) { /* ignore */ } }
      try { player.setOutput(null); } catch (_) { /* ignore */ }
      try { player.loopRange = saved.loop; } catch (_) { /* ignore */ }
      try { await Promise.race([player.seek(saved.time), new Promise((r) => setTimeout(r, 2000))]); } catch (_) { /* ignore */ }
      if (canvas) {
        try { canvas.remove(); } catch (_) { /* ignore */ }
        canvas.width = 0;
        canvas.height = 0;
      }
      releaseWakeLock(wake);
      this._busy = false;
    }
  }

  /**
   * Wait until the sound of everything the movie plays is decoded, reporting progress while it
   * takes a while. Resolves with a warning to show ('' when all the sound is there).
   */
  async _prepareSound(store, signal, progress) {
    const audio = this.audio;
    const project = store.project;
    if (!audio) return '';
    if (typeof audio.whenReady !== 'function') {
      if (typeof audio.prepare !== 'function') return '';
      let timer = 0;
      await Promise.race([
        Promise.resolve(audio.prepare(project, store)).catch(() => {}),
        new Promise((r) => { timer = setTimeout(r, SOUND_STALL_MS); }),
      ]);
      clearTimeout(timer);
      return '';
    }
    let shown = false;
    let last = [0, 0];
    const show = () => {
      shown = true;
      const [done, total] = last;
      progress(0, 0, 'preparing', total > 1 ? `Preparing the sound (${Math.min(done + 1, total)} of ${total})…` : 'Preparing the sound…');
    };
    const timer = setTimeout(show, SOUND_NOTICE_MS);
    let res = null;
    try {
      res = await audio.whenReady(project, store, {
        stallMs: SOUND_STALL_MS,
        signal,
        onProgress: (done, total) => { last = [done, total]; if (shown && done < total) show(); },
      });
    } catch (_) {
      res = null;
    } finally {
      clearTimeout(timer);
    }
    if (shown) progress(0, 0, 'preparing', ' '); // clear the note (a blank message replaces it)
    if (!res || (signal && signal.aborted)) return '';
    const names = (list) => {
      const shownNames = list.slice(0, 3).map((m) => `"${m && m.name ? m.name : 'sound'}"`).join(', ');
      return list.length > 3 ? `${shownNames} and ${list.length - 3} more` : shownNames;
    };
    const parts = [];
    if (res.pending.length) parts.push(`The sound of ${names(res.pending)} took too long to prepare`);
    if (res.failed.length) parts.push(`The sound of ${names(res.failed)} couldn't be read`);
    if (!parts.length) return '';
    const n = res.pending.length + res.failed.length;
    return parts.join('. ') + `, so ${n > 1 ? 'they' : 'it'} will be missing from the saved movie.`;
  }

  /** PNG of the frame at time t (default: the playhead) at export resolution (WLMM "Snapshot"). */
  async snapshot(t) {
    if (this._busy) throw friendly('Please wait until the movie has finished saving.', 'busy');
    if (typeof document === 'undefined') throw friendly("Snapshots aren't available here.", 'no-canvas');
    const player = this.player, store = this.store;
    const duration = store.timeline.duration;
    if (!(duration > 0)) throw friendly('Add some videos or photos before taking a snapshot.', 'empty');
    if (player.playing) player.pause();
    const time = Number.isFinite(+t) && t !== null ? Math.max(0, Math.min(duration, +t)) : player.currentTime;
    const { width, height } = exportSize('recommended', store.project, store.media, { coarse: false });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    if (!ctx) throw friendly("The picture couldn't be created.", 'snapshot-failed');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    this._busy = true;
    try {
      player.setOutput(canvas);
      await Promise.race([player.seek(time), new Promise((r) => setTimeout(r, 4000))]);
    } finally {
      try { player.setOutput(null); } catch (_) { /* ignore */ }
      this._busy = false;
    }
    try {
      return await canvasToBlob(canvas, 'image/png');
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Saving files

// When the app is framed by a host page that offers a save capability (a claude.ai artifact
// viewer exposes window.claude.use('downloads')), sandboxed frames can't download directly,
// so files go through the host's save prompt. Resolved early so a click doesn't wait on it.
let hostDownloads = null;
try {
  if (typeof window !== 'undefined' && window.top !== window.self
    && window.claude && typeof window.claude.use === 'function') {
    hostDownloads = Promise.resolve(window.claude.use('downloads')).catch(() => null);
  }
} catch (_) { hostDownloads = null; }

// The host only accepts common extensions; project files are JSON, so they travel as .json.
const HOST_EXT_RENAMES = [[/\.wlmmweb$/i, '.wlmmweb.json']];

async function saveViaHost(blob, name) {
  const dl = hostDownloads ? await hostDownloads : null;
  if (!dl || typeof dl.save !== 'function') return null;
  let filename = name;
  for (const [re, ext] of HOST_EXT_RENAMES) filename = filename.replace(re, ext);
  try {
    await dl.save({ filename, data: blob });
    return 'downloaded';
  } catch (err) {
    const code = err && err.code;
    if (code === 'declined') return 'canceled';
    if (code === 'rate_limited') throw friendly('A save is already waiting for your answer.', 'busy');
    if (code === 'too_large') throw friendly('This file is too large to save here. Try a smaller movie size.', 'too-large');
    return null; // unavailable here: fall back to the browser's own ways of saving
  }
}

/**
 * Save a blob as a file. Resolves 'downloaded' | 'shared' | 'opened' | 'canceled'.
 * On iOS (and wherever <a download> is unsupported) the share sheet is offered when it can
 * take files — call this from a click handler, share needs a user gesture.
 */
export async function downloadBlob(blob, filename) {
  if (!blob) throw friendly('There is nothing to save.', 'no-data');
  const name = filename || 'movie';
  if (hostDownloads) {
    const res = await saveViaHost(blob, name);
    if (res) return res;
  }
  const a = document.createElement('a');
  const canDownloadAttr = 'download' in a;
  if ((isIOS() || !canDownloadAttr) && typeof navigator !== 'undefined' && typeof navigator.share === 'function'
    && typeof navigator.canShare === 'function' && typeof File === 'function') {
    let file = null;
    try { file = new File([blob], name, { type: blob.type || 'application/octet-stream' }); } catch (_) { file = null; }
    let ok = false;
    try { ok = !!file && navigator.canShare({ files: [file] }); } catch (_) { ok = false; }
    if (ok) {
      try {
        await navigator.share({ files: [file], title: name });
        return 'shared';
      } catch (err) {
        if (err && err.name === 'AbortError') return 'canceled';
        // NotAllowedError (no user gesture) etc.: fall back to a download link below.
      }
    }
  }
  const url = URL.createObjectURL(blob);
  if (canDownloadAttr) {
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); }, 0);
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ } }, 60000);
    return 'downloaded';
  }
  const win = window.open(url, '_blank');
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ } }, 300000);
  if (!win) {
    try { location.href = url; } catch (_) { /* ignore */ }
  }
  return 'opened';
}

// ---------------------------------------------------------------------------
// WebM duration patch.
// MediaRecorder writes WebM without a Duration in the Segment Info, which makes players
// show no length and refuse to seek. This adds (or overwrites) the Duration element in
// the header, fixing up any sizes and SeekHead/Cues positions it shifts. Only the head of
// the file is read into memory; the rest is sliced from the original Blob.

const EBML_ID = 0x1A45DFA3;
const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549A966;
const DURATION_ID = 0x4489;
const TIMECODESCALE_ID = 0x2AD7B1;
const SEEKHEAD_ID = 0x114D9B74;
const SEEK_ID = 0x4DBB;
const SEEKPOSITION_ID = 0x53AC;
const SEEKID_ID = 0x53AB;
const CLUSTER_ID = 0x1F43B675;
const CUES_ID = 0x1C53BB6B;
const CUEPOINT_ID = 0xBB;
const CUETRACKPOSITIONS_ID = 0xB7;
const CUECLUSTERPOSITION_ID = 0xF1;
const HEAD_BYTES = 1 << 20;

function readId(b, p) {
  if (p >= b.length) return null;
  const first = b[p];
  let len;
  if (first & 0x80) len = 1;
  else if (first & 0x40) len = 2;
  else if (first & 0x20) len = 3;
  else if (first & 0x10) len = 4;
  else return null;
  if (p + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[p + i];
  return { id, len };
}

function readSize(b, p) {
  if (p >= b.length) return null;
  const first = b[p];
  if (!first) return null;
  let len = 1, mask = 0x80;
  while (!(first & mask)) { mask >>= 1; len++; }
  if (p + len > b.length) return null;
  let value = first & (mask - 1);
  let ones = value === mask - 1;
  for (let i = 1; i < len; i++) {
    const x = b[p + i];
    value = value * 256 + x;
    if (x !== 0xff) ones = false;
  }
  return { value, len, unknown: ones };
}

/** Element header at p: { id, start, idLen, sizeLen, size, unknown, dataStart, end }. */
function readElement(b, p) {
  const id = readId(b, p);
  if (!id) return null;
  const sz = readSize(b, p + id.len);
  if (!sz) return null;
  const dataStart = p + id.len + sz.len;
  return {
    id: id.id, start: p, idLen: id.len, sizeLen: sz.len, size: sz.value, unknown: sz.unknown,
    dataStart, end: sz.unknown ? Infinity : dataStart + sz.value,
  };
}

function encodeSize(value, len) {
  if (len < 1 || len > 8) return null;
  const max = Math.pow(2, 7 * len) - 2;
  if (!(value >= 0) || value > max) return null;
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function minSizeLen(value) {
  for (let l = 1; l <= 8; l++) if (value <= Math.pow(2, 7 * l) - 2) return l;
  return 0;
}

function readUint(b, p, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
  return v;
}

function writeUint(b, p, len, value) {
  if (value >= Math.pow(256, len)) return false;
  let v = value;
  for (let i = len - 1; i >= 0; i--) { b[p + i] = v % 256; v = Math.floor(v / 256); }
  return true;
}

function children(b, el, fn) {
  const end = Math.min(el.end, b.length);
  let p = el.dataStart;
  while (p < end) {
    const c = readElement(b, p);
    if (!c || c.unknown || c.end > end) return false;
    if (fn(c) === false) return false;
    p = c.end;
  }
  return true;
}

/**
 * Patch the head bytes. Returns an array of Uint8Array parts replacing head, or null when
 * the file can't (or needn't) be patched safely.
 */
export function patchWebmHead(head, seconds) {
  const b = head;
  const ebml = readElement(b, 0);
  if (!ebml || ebml.id !== EBML_ID || ebml.unknown || ebml.end > b.length) return null;
  const seg = readElement(b, ebml.end);
  if (!seg || seg.id !== SEGMENT_ID) return null;
  const segEnd = seg.unknown ? b.length : Math.min(b.length, seg.end);
  let info = null;
  let cues = null;
  const seekHeads = [];
  for (let p = seg.dataStart; p < segEnd;) {
    const c = readElement(b, p);
    if (!c) break;
    // Clusters of unknown size (MediaRecorder) end the scan; known-size ones are skipped so
    // Cues written after them (small files from other muxers) can still be fixed up.
    if (c.unknown) { if (c.id === CLUSTER_ID) break; return null; }
    if (c.id === INFO_ID) info = c;
    else if (c.id === SEEKHEAD_ID) seekHeads.push(c);
    else if (c.id === CUES_ID) cues = c;
    if (c.end > b.length) break;
    p = c.end;
  }
  if (!info || info.end > b.length) return null;

  let scale = 1e6;
  let durEl = null;
  children(b, info, (c) => {
    if (c.id === TIMECODESCALE_ID && c.size >= 1 && c.size <= 8) scale = readUint(b, c.dataStart, c.size) || 1e6;
    else if (c.id === DURATION_ID) durEl = c;
  });
  const ticks = (seconds * 1e9) / scale;
  const out = b.slice(0);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  if (durEl) {
    if (durEl.size === 8) dv.setFloat64(durEl.dataStart, ticks, false);
    else if (durEl.size === 4) dv.setFloat32(durEl.dataStart, ticks, false);
    else return null;
    return [out];
  }

  // Insert Duration (float64) at the end of Info.
  const dur = new Uint8Array(11);
  dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88;
  new DataView(dur.buffer).setFloat64(3, ticks, false);
  const newInfoSize = info.size + dur.length;
  const sizeBytes = encodeSize(newInfoSize, info.sizeLen) || encodeSize(newInfoSize, minSizeLen(newInfoSize));
  if (!sizeBytes) return null;
  const delta = dur.length + (sizeBytes.length - info.sizeLen);
  const infoRel = info.start - seg.dataStart;

  if (!seg.unknown) {
    const segSize = encodeSize(seg.size + delta, seg.sizeLen);
    if (!segSize) return null;
    out.set(segSize, seg.start + seg.idLen);
  }

  // SeekHead entries point at positions relative to the segment data.
  let refersToCues = false;
  for (const sh of seekHeads) {
    const ok = children(b, sh, (seek) => {
      if (seek.id !== SEEK_ID) return true;
      let posEl = null;
      let target = 0;
      children(b, seek, (c) => {
        if (c.id === SEEKPOSITION_ID) posEl = c;
        else if (c.id === SEEKID_ID) target = readUint(b, c.dataStart, Math.min(4, c.size));
      });
      if (!posEl || posEl.size < 1 || posEl.size > 8) return true;
      const pos = readUint(b, posEl.dataStart, posEl.size);
      if (target === CUES_ID) refersToCues = true;
      if (pos > infoRel && !writeUint(out, posEl.dataStart, posEl.size, pos + delta)) return false;
      return true;
    });
    if (!ok) return null;
  }
  // Cue points also hold segment-relative cluster positions.
  if (refersToCues && !cues) return null; // cues live beyond the head: can't fix them up safely
  if (cues) {
    if (cues.end > b.length) return null;
    const ok = children(b, cues, (cp) => {
      if (cp.id !== CUEPOINT_ID) return true;
      return children(b, cp, (ctp) => {
        if (ctp.id !== CUETRACKPOSITIONS_ID) return true;
        return children(b, ctp, (c) => {
          if (c.id !== CUECLUSTERPOSITION_ID) return true;
          const pos = readUint(b, c.dataStart, c.size);
          return pos > infoRel ? writeUint(out, c.dataStart, c.size, pos + delta) : true;
        });
      });
    });
    if (!ok) return null;
  }

  return [
    out.subarray(0, info.start + info.idLen),
    sizeBytes,
    out.subarray(info.dataStart, info.end),
    dur,
    out.subarray(info.end),
  ];
}

async function blobBytes(blob) {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Uint8Array(await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  }));
}

/** Return a copy of a WebM Blob whose header carries `seconds` as its Duration. */
export async function fixWebmDuration(blob, seconds) {
  if (!blob || !(blob.size > 0) || !(seconds > 0)) return blob;
  const headLen = Math.min(blob.size, HEAD_BYTES);
  const head = await blobBytes(blob.slice(0, headLen));
  const parts = patchWebmHead(head, seconds);
  if (!parts) return blob;
  return new Blob(headLen < blob.size ? [...parts, blob.slice(headLen)] : parts, { type: blob.type });
}
