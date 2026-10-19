// engine/decode.js — a whole track as decoded PCM, {L, R, sampleRate}, for a resident deck: fetched
// (a blob: URL from the deck page, or an audio link), decoded, cut to the resident track limit and,
// when its rate is not the engine's, resampled.

const minutes = (m) => `${+m.toFixed(1)} minute${m === 1 ? '' : 's'}`;

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
