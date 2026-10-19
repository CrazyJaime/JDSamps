// engine/decode.js — a whole track as decoded PCM, {L, R, sampleRate}, for a resident deck: fetched
// (a blob: URL from the deck page, or an audio link), decoded, cut to the resident track limit and,
// when its rate is not the engine's, resampled.

export const minutes = (m) => `${+m.toFixed(1)} minute${m === 1 ? '' : 's'}`;

export const FETCH_STALL = 15000;       // ms: a fetch is given up when no byte has come for this long
export const FETCH_CAP = 600 * 2 ** 20; // bytes: the most one fetch reads (a tab's loader gives what is left of its own budget)

/** A fetch refused for what the link is. kind: 'stall', 'stream' (it has no end), 'big' (past the cap), 'page' (a web page). */
export class FetchRefused extends Error {
  constructor(kind, message) { super(message); this.name = 'FetchRefused'; this.kind = kind; }
}
const PAGE_TYPE = /^(text\/html|application\/xhtml\+xml)$/i;
const STREAM_TYPE = /^audio\/(x-scpls|x-mpegurl|mpegurl)$/i; // a radio station's playlist (.pls, .m3u)
const mb = (n) => `${+(n / 2 ** 20).toFixed(1)} MB`;

/**
 * The bytes at a URL. Throws with a plain reason when the fetch fails or the server refuses, and refuses (FetchRefused)
 * a link that sends nothing for `stall` ms, one whose body passes `cap` bytes (or what is left of `budget.left`, shared
 * by several fetches and taken from as bytes come), a stream with no end (no length and past the cap, an Icecast
 * station, a radio playlist) and a web page.
 */
export async function fetchArrayBuffer(url, { signal, stall = FETCH_STALL, cap = FETCH_CAP, budget = null } = {}) {
  const ac = new AbortController(), abort = () => ac.abort();
  let why = null, timer = 0, took = 0;
  const refuse = (kind, message) => { why = why || new FetchRefused(kind, message); ac.abort(); return why; };
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => refuse('stall', `nothing came from the link for ${+(stall / 1000).toFixed(1)} s`), stall); };
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', abort, { once: true }); }
  try {
    arm();
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    if (!res.ok) { ac.abort(); throw new Error(`it answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`); }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim(), told = res.headers.get('content-length');
    const size = told != null && /^\d+$/.test(told) ? Number(told) : null, limit = Math.min(cap, budget ? budget.left : Infinity);
    if (PAGE_TYPE.test(type)) throw refuse('page', 'That link is a web page, not an audio file: open it in a tab and add the tab to a deck.');
    if (STREAM_TYPE.test(type) || [...res.headers.keys()].some((k) => k.toLowerCase().startsWith('icy-'))) throw refuse('stream', 'this link is a stream with no end, so there is no whole track to load');
    if (size != null && size > limit) throw refuse('big', `it holds ${(size / 2 ** 20).toFixed(1)} MB, more than the ${mb(limit)} a deck takes`);
    // Read as it comes, into one buffer when its length is known: a body that passes the cap is refused as it does.
    const reader = res.body.getReader(), parts = [];
    let out = size != null ? new Uint8Array(size) : null, n = 0;
    for (;;) {
      arm();
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.byteLength > limit) {
        throw size == null ? refuse('stream', 'this link is a stream with no end, so there is no whole track to load')
          : refuse('big', `it holds more than the ${mb(limit)} a deck takes`);
      }
      if (out && n + value.byteLength > out.length) { parts.push(out.subarray(0, n)); out = null; } // longer than it said (a coded body)
      if (out) out.set(value, n); else parts.push(value);
      n += value.byteLength;
      took += value.byteLength;
      if (budget) budget.left -= value.byteLength;
    }
    if (out) return n === out.length ? out.buffer : out.buffer.slice(0, n);
    const all = new Uint8Array(n);
    let k = 0;
    for (const p of parts) { all.set(p, k); k += p.byteLength; }
    return all.buffer;
  } catch (err) {
    if (budget) budget.left += took; // nothing of a fetch that failed is kept
    throw why || err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
  }
}

/** Decode with the engine's context (decodeAudioData resamples to its rate). A mono file plays on both channels. */
export async function decodeTo(ctx, buf) {
  const ab = await ctx.decodeAudioData(buf);
  const L = ab.getChannelData(0);
  return { L, R: ab.numberOfChannels > 1 ? ab.getChannelData(1) : L.slice(), sampleRate: ab.sampleRate };
}

/**
 * A WAV file's length (samples at sampleRate), from its header, and (cut) the file cut to its first `until` s with
 * its sizes set to match, when it is longer; null for any other file.
 */
export function wavFrames(bytes, until) {
  const v = new DataView(bytes), n = bytes.byteLength, id = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (n < 12 || id(0) !== 'RIFF' || id(8) !== 'WAVE') return null;
  let fmt = null;
  for (let o = 12; o + 8 <= n;) {
    const size = v.getUint32(o + 4, true), body = o + 8;
    if (id(o) === 'fmt ' && size >= 16 && body + 16 <= n) fmt = { sampleRate: v.getUint32(body + 4, true), block: v.getUint16(body + 12, true) };
    else if (id(o) === 'data') {
      if (!fmt || !fmt.sampleRate || !fmt.block) return null;
      const len = size && size !== 0xffffffff ? Math.min(size, n - body) : n - body; // a streamed WAV may not say
      const samples = Math.floor(len / fmt.block), keep = Math.ceil(until * fmt.sampleRate);
      if (samples <= keep) return { samples, sampleRate: fmt.sampleRate, cut: null };
      const end = body + keep * fmt.block, out = bytes.slice(0, end), w = new DataView(out);
      w.setUint32(4, end - 8, true);
      w.setUint32(o + 4, keep * fmt.block, true);
      return { samples, sampleRate: fmt.sampleRate, cut: { end, samples: keep, bytes: out } };
    }
    o = body + size + (size & 1);
  }
  return null;
}

/**
 * A media file's length (s), read from its header by the browser's own player, or null when it cannot say (a file
 * it cannot play, or one that does not give its length).
 */
export function mediaDuration(bytes, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes])), a = new Audio();
    let timer = null, done = false;
    const end = (d) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.removeAttribute('src'); a.load();
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) && d > 0 ? d : null);
    };
    timer = setTimeout(() => end(null), timeout);
    a.muted = true;
    a.preload = 'metadata';
    a.onloadedmetadata = () => end(a.duration);
    a.onerror = () => end(null);
    a.src = url;
  });
}

/** PCM at another sample rate, through an OfflineAudioContext. */
export async function resample({ L, R, sampleRate }, rate) {
  const off = new OfflineAudioContext(2, Math.max(1, Math.round((L.length * rate) / sampleRate)), rate);
  const buf = off.createBuffer(2, L.length, sampleRate);
  buf.copyToChannel(L, 0);
  buf.copyToChannel(R, 1);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return { L: out.getChannelData(0), R: out.getChannelData(1), sampleRate: rate };
}

/**
 * A track longer than the resident track limit (minutes) keeps its first part, with a notice to show
 * once. The cut is a copy, so the rest of the source can be freed. length (s): the whole source's, when
 * only its first part was decoded.
 */
export function limitPcm(pcm, limitMin, length = pcm.L.length / pcm.sampleRate) {
  const max = Math.round(limitMin * 60 * pcm.sampleRate);
  if (!(pcm.L.length > max)) return { pcm, notice: null };
  return {
    pcm: { L: pcm.L.slice(0, max), R: pcm.R.slice(0, max), sampleRate: pcm.sampleRate },
    notice: `this track is ${minutes(length / 60)} long: the deck holds its first ${minutes(limitMin)} (the resident track limit).`,
  };
}
