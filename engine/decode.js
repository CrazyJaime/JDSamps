// engine/decode.js — a whole track as decoded PCM, {L, R, sampleRate}, for a resident deck: fetched
// (a blob: URL from the deck page, or an audio link), decoded, cut to the resident track limit and,
// when its rate is not the engine's, resampled.

export const minutes = (m) => `${+m.toFixed(1)} minute${m === 1 ? '' : 's'}`;

/** The bytes at a URL. Throws with a plain reason when the fetch fails or the server refuses. */
export async function fetchArrayBuffer(url, { signal } = {}) {
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`it answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  return res.arrayBuffer();
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
