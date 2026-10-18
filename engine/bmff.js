// engine/bmff.js — just enough of the media containers to place captured bytes on a timeline (§6):
// ISO-BMFF boxes, tfdt and the mdhd timescale; WebM cluster timecodes; MP3 and ADTS frame walks.
// Pure functions over ArrayBuffer / typed-array views. Nothing here decodes audio.

const bytesOf = (buf) => (ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf));
const viewOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const u64 = (dv, p) => dv.getUint32(p) * 2 ** 32 + dv.getUint32(p + 4);   // exact below 2^53

// ---------------------------------------------------------------- ISO-BMFF

function readBox(b, dv, p, end) {
  if (p + 8 > end) return null;
  let size = dv.getUint32(p), hdr = 8;
  if (size === 1) { if (p + 16 > end) return null; size = u64(dv, p + 8); hdr = 16; }
  else if (size === 0) size = end - p;
  if (size < hdr || p + size > end) return null;
  return { type: fourcc(b, p + 4), start: p, end: p + size, size, hdr };
}

/** Complete boxes in [start, end), in order: {type, start, end, size, hdr}. Stops at a truncated box. */
export function* boxes(buf, start = 0, end) {
  const b = bytesOf(buf), dv = viewOf(b);
  end ??= b.length;
  for (let p = start, bx; (bx = readBox(b, dv, p, end)); p = bx.end) yield bx;
}

const kids = (b, bx, skip = 0) => [...boxes(b, bx.start + bx.hdr + skip, bx.end)];
const kid = (b, bx, type, skip) => (bx ? kids(b, bx, skip).find((k) => k.type === type) || null : null);
const dig = (b, bx, path) => path.reduce((at, type) => kid(b, at, type), bx);
const body = (bx) => bx.start + bx.hdr;

/** baseMediaDecodeTime of the first moof's first traf, in media ticks (64-bit safe below 2^53). */
export function tfdt(moofBuf) {
  const b = bytesOf(moofBuf), dv = viewOf(b);
  const moof = [...boxes(b)].find((x) => x.type === 'moof');
  const box = dig(b, moof, ['traf', 'tfdt']);
  if (!box) return null;
  const p = body(box);
  return b[p] === 1 ? u64(dv, p + 4) : dv.getUint32(p + 4);
}

/** The audio track's mdhd timescale (ticks per second), or null. */
export function timescale(initBuf) { return readInit(initBuf)?.timescale ?? null; }

/**
 * The audio track of an init segment (or a whole non-fragmented file):
 * {trackId, timescale, rate, channels, codec, key, delay, trexDuration, trexSize, fragmented, duration}.
 * `delay` (edit-list media time, else the Opus pre-skip) and `duration` are in media ticks. Two inits with the same
 * `key` can decode each other's fragments, so one can warm the decoder for the other.
 */
export function readInit(buf) {
  const b = bytesOf(buf), dv = viewOf(b);
  const moov = [...boxes(b)].find((x) => x.type === 'moov');
  if (!moov) return null;
  const traks = kids(b, moov).filter((x) => x.type === 'trak');
  const handler = (t) => { const h = dig(b, t, ['mdia', 'hdlr']); return h ? fourcc(b, body(h) + 8) : ''; };
  const trak = traks.find((t) => handler(t) === 'soun') || traks[0];
  if (!trak) return null;
  const tkhd = kid(b, trak, 'tkhd'), mdhd = dig(b, trak, ['mdia', 'mdhd']);
  if (!tkhd || !mdhd) return null;
  const trackId = dv.getUint32(body(tkhd) + (b[body(tkhd)] === 1 ? 20 : 12));
  const mv1 = b[body(mdhd)] === 1;
  const ts = dv.getUint32(body(mdhd) + (mv1 ? 20 : 12));
  const duration = mv1 ? u64(dv, body(mdhd) + 24) : dv.getUint32(body(mdhd) + 16);

  const stsd = dig(b, trak, ['mdia', 'minf', 'stbl', 'stsd']);
  const entry = stsd ? kids(b, stsd, 8)[0] : null;
  let codec = '', channels = 0, rate = 0, config = '', preSkip = null;
  if (entry) {
    const e = body(entry);
    codec = entry.type;
    channels = dv.getUint16(e + 16);
    rate = dv.getUint32(e + 24) >>> 16;
    for (const c of boxes(b, e + 28, entry.end)) {
      if (c.type === 'btrt') continue;                       // bitrate differs between renditions; the codec does not
      config += c.type + hex(b.subarray(c.start + c.hdr, c.end));
      if (c.type === 'dOps') preSkip = dv.getUint16(body(c) + 2);
    }
  }
  let delay = preSkip == null ? 0 : Math.round(preSkip * ts / 48000);
  const elst = dig(b, trak, ['edts', 'elst']);
  if (elst) {
    const p = body(elst), v1 = b[p] === 1, n = dv.getUint32(p + 4);
    for (let i = 0, q = p + 8; i < n; i++, q += v1 ? 20 : 12) {
      const mt = v1 ? dv.getInt32(q + 8) * 2 ** 32 + dv.getUint32(q + 12) : dv.getInt32(q + 4);
      if (mt >= 0) { delay = mt; break; }                      // -1 is an empty edit
    }
  }
  const mvex = kid(b, moov, 'mvex');
  const trex = mvex ? kids(b, mvex).find((x) => x.type === 'trex' && dv.getUint32(body(x) + 4) === trackId) : null;
  return {
    trackId, timescale: ts, rate: rate || ts, channels, codec, delay, duration,
    key: `${codec}/${channels}/${rate}/${trackId}/${config}`,
    trexDuration: trex ? dv.getUint32(body(trex) + 12) : 0,
    trexSize: trex ? dv.getUint32(body(trex) + 16) : 0,
    fragmented: !!mvex,
  };
}

/** One moof + mdat against its init: {t, d, frame} in ticks, or null when the samples do not fit the mdat. */
function fragment(b, dv, moof, mdat, info) {
  const trafs = kids(b, moof).filter((x) => x.type === 'traf');
  for (const traf of trafs) {
    const tfhd = kid(b, traf, 'tfhd');
    if (!tfhd || dv.getUint32(body(tfhd) + 4) !== info.trackId) continue;
    const fl = dv.getUint32(body(tfhd)) & 0xffffff;
    let q = body(tfhd) + 8, base = moof.start;
    if (fl & 0x01) { base = null; q += 8; }                    // an absolute base offset cannot be checked in a stream
    if (fl & 0x02) q += 4;
    const defDur = fl & 0x08 ? dv.getUint32((q += 4) - 4) : info.trexDuration;
    const defSize = fl & 0x10 ? dv.getUint32((q += 4) - 4) : info.trexSize;
    const td = kid(b, traf, 'tfdt');
    if (!td) return null;
    const t = b[body(td)] === 1 ? u64(dv, body(td) + 4) : dv.getUint32(body(td) + 4);
    let d = 0, frame = 0, next = base;
    for (const trun of kids(b, traf).filter((x) => x.type === 'trun')) {
      const p = body(trun), tf = dv.getUint32(p) & 0xffffff, n = dv.getUint32(p + 4);
      let r = p + 8, start = next;
      if (tf & 0x01) { start = base == null ? null : base + dv.getInt32(r); r += 4; }
      if (tf & 0x04) r += 4;
      let size = 0;
      for (let i = 0; i < n; i++) {
        const dur = tf & 0x100 ? dv.getUint32((r += 4) - 4) : defDur;
        size += tf & 0x200 ? dv.getUint32((r += 4) - 4) : defSize;
        if (tf & 0x400) r += 4;
        if (tf & 0x800) r += 4;
        d += dur; if (dur > frame) frame = dur;
      }
      if (start != null && (start < body(mdat) || start + size > mdat.end)) return null;
      next = start == null ? null : start + size;
    }
    return d > 0 ? { t, d, frame } : null;
  }
  return null;
}

const MP4_TOP = new Set(['ftyp', 'styp', 'moov', 'moof', 'mdat', 'sidx', 'ssix', 'emsg', 'prft', 'free', 'skip', 'uuid', 'mfra', 'meta', 'pdin', 'udta']);

/**
 * Walk a stream of fMP4 appends (one SourceBuffer's parts, concatenated) into
 * {kind:'init', start, end, info} and {kind:'media', start, end, t0, t1, frame} items (times in seconds).
 * Media before any init cannot be placed and is left out. After junk the walk resumes at the next `resync` offset.
 */
export function mp4Items(buf, { resync = [] } = {}) {
  const b = bytesOf(buf), dv = viewOf(b), items = [];
  let info = null, ftyp = null;
  for (let p = 0; p < b.length;) {
    const bx = readBox(b, dv, p, b.length);
    if (!bx || !MP4_TOP.has(bx.type)) {
      const r = resync.find((x) => x > p);
      if (r == null) break;
      p = r; ftyp = null; continue;
    }
    if (bx.type === 'ftyp') ftyp = bx;
    else if (bx.type === 'moov') {
      const start = ftyp && ftyp.end === bx.start ? ftyp.start : bx.start;
      info = readInit(b.subarray(start, bx.end));
      if (info) items.push({ kind: 'init', start, end: bx.end, info });
      ftyp = null;
    } else if (bx.type === 'moof') {
      const mdat = readBox(b, dv, bx.end, b.length);
      if (mdat?.type !== 'mdat') { p = bx.end; continue; }
      const f = info && fragment(b, dv, bx, mdat, info);
      if (f) items.push({ kind: 'media', start: bx.start, end: mdat.end, t0: f.t / info.timescale, t1: (f.t + f.d) / info.timescale, frame: f.frame / info.timescale });
      p = mdat.end; continue;
    }
    p = bx.end;
  }
  return items;
}

// ---------------------------------------------------------------- WebM (EBML)

const ID = { EBML: 0x1A45DFA3, SEGMENT: 0x18538067, INFO: 0x1549A966, TRACKS: 0x1654AE6B, CLUSTER: 0x1F43B675 };
const LEVEL1 = new Set([ID.EBML, ID.SEGMENT, ID.INFO, ID.TRACKS, ID.CLUSTER, 0x114D9B74, 0x1C53BB6B, 0x1254C367, 0x1043A770, 0x1941A469]);
const TOP = new Set([...LEVEL1, 0xEC]);                      // plus Void, which may sit between them

/** An EBML element header at p: {id, start, data, end} (end null for an unknown size), or null. */
function readEl(b, p, end) {
  if (p >= end) return null;
  const il = Math.clz32(b[p]) - 23;                          // leading zeros of the first byte, +1
  if (il < 1 || il > 4 || p + il > end) return null;
  let id = 0;
  for (let i = 0; i < il; i++) id = id * 256 + b[p + i];
  const q = p + il;
  if (q >= end) return null;
  const sl = Math.clz32(b[q]) - 23;
  if (sl < 1 || sl > 8 || q + sl > end) return null;
  let size = b[q] & (0xff >> sl), ones = size === (0xff >> sl);
  for (let i = 1; i < sl; i++) { size = size * 256 + b[q + i]; ones &&= b[q + i] === 0xff; }
  const data = q + sl;
  return { id, start: p, data, end: ones ? null : data + size };
}
const uintAt = (b, s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + b[i]; return v; };
const floatAt = (b, s, e) => { const dv = new DataView(b.buffer, b.byteOffset + s, e - s); return e - s === 4 ? dv.getFloat32(0) : dv.getFloat64(0); };
function* children(b, s, e) { for (let p = s, x; p < e && (x = readEl(b, p, e)) && x.end != null && x.end <= e; p = x.end) yield x; }

function webmTrack(b, tracks) {
  for (const te of children(b, tracks.data, tracks.end)) {
    if (te.id !== 0xAE) continue;
    const t = { trackId: 0, type: 0, codec: '', priv: '', delay: 0, defDur: 0, rate: 0, channels: 0 };
    for (const x of children(b, te.data, te.end)) {
      if (x.id === 0xD7) t.trackId = uintAt(b, x.data, x.end);
      else if (x.id === 0x83) t.type = uintAt(b, x.data, x.end);
      else if (x.id === 0x86) t.codec = String.fromCharCode(...b.subarray(x.data, x.end));
      else if (x.id === 0x63A2) t.priv = hex(b.subarray(x.data, x.end));
      else if (x.id === 0x56AA) t.delay = uintAt(b, x.data, x.end) / 1e9;
      else if (x.id === 0x23E383) t.defDur = uintAt(b, x.data, x.end) / 1e9;
      else if (x.id === 0xE1) for (const a of children(b, x.data, x.end)) {
        if (a.id === 0xB5) t.rate = floatAt(b, a.data, a.end);
        else if (a.id === 0x9F) t.channels = uintAt(b, a.data, a.end);
      }
    }
    if (t.type === 2 || t.type === 0) return t;
  }
  return null;
}

const OPUS_MS = [10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20];
const opusSec = (b, p) => { const c = b[p] & 3, n = c === 0 ? 1 : c === 3 ? b[p + 1] & 0x3f : 2; return OPUS_MS[b[p] >> 3] * n / 1000; };

/** A Block / SimpleBlock body: {track, rel, sec} (sec = the frame duration from an Opus TOC, else 0). */
function block(b, s, e, opus) {
  const l = Math.clz32(b[s]) - 23;
  const track = uintAt(b, s, s + l) - 2 ** (7 * l);           // strip the vint length marker
  const rel = (b[s + l] << 24 >> 16) | b[s + l + 1];
  const flags = b[s + l + 2], laced = (flags & 0x06) !== 0, p = s + l + 3 + (laced ? 1 : 0);
  const frames = laced ? b[s + l + 3] + 1 : 1;
  return { track, rel, sec: opus && p < e ? opusSec(b, p) * frames : 0 };
}

/**
 * Walk a stream of WebM appends into {kind:'init', start, end, info} and {kind:'media', start, end, t0, t1, frame}
 * items (seconds), one media item per Cluster. info: {trackId, codec, key, rate, channels, delay (s), scale, duration}.
 */
export function webmItems(buf, { resync = [] } = {}) {
  const b = bytesOf(buf), items = [];
  let info = null, head = null, scale = 1e6, fileDur = null;
  const skip = (p) => resync.find((x) => x > p);
  for (let p = 0; p < b.length;) {
    const x = readEl(b, p, b.length);
    if (!x || !TOP.has(x.id)) { const r = skip(p); if (r == null) break; p = r; continue; }
    if (x.id === ID.SEGMENT) { p = x.data; continue; }                        // step inside: its children are the stream
    if (x.id === ID.EBML) { head = x.start; scale = 1e6; fileDur = null; }
    if (x.id === ID.CLUSTER) {
      let end = x.end, tc = 0, first = null, last = null, frame = 0, prevAbs = null;
      if (end == null) {                                                        // unknown size: runs to the next level-1 element
        end = x.data;
        for (let q = x.data, c; q < b.length && (c = readEl(b, q, b.length)) && !LEVEL1.has(c.id) && c.end != null && c.end <= b.length; q = c.end) end = c.end;
      }
      if (end > b.length) break;                                                // cut short at the end of the capture
      for (const c of children(b, x.data, end)) {
        let blk = null, dur = null, discard = 0;
        if (c.id === 0xE7) tc = uintAt(b, c.data, c.end);
        else if (c.id === 0xA3) blk = block(b, c.data, c.end, info?.codec === 'A_OPUS');
        else if (c.id === 0xA0) for (const g of children(b, c.data, c.end)) {
          if (g.id === 0xA1) blk = block(b, g.data, g.end, info?.codec === 'A_OPUS');
          else if (g.id === 0x9B) dur = uintAt(b, g.data, g.end) * scale / 1e9;
          else if (g.id === 0x75A2) discard = uintAt(b, g.data, g.end) / 1e9;
        }
        if (!blk || !info || blk.track !== info.trackId) continue;
        let abs = (tc + blk.rel) * scale / 1e9;
        if (info.codec === 'A_OPUS' && scale >= 1e5) {                     // ms timecodes: back onto the 2.5 ms Opus frame grid
          const g = Math.round(abs / 0.0025) * 0.0025;
          if (Math.abs(g - abs) <= scale / 1e9 + 1e-9) abs = g;
        }
        const sec = dur ?? (blk.sec || info.defDur || (prevAbs != null ? abs - prevAbs : 0));
        if (first == null) first = abs;
        last = abs + sec - discard; prevAbs = abs;
        if (sec > frame) frame = sec;
      }
      if (info && first != null) items.push({ kind: 'media', start: x.start, end, t0: first, t1: last, frame });
      p = end; continue;
    }
    if (x.end == null || x.end > b.length) { const r = skip(p); if (r == null) break; p = r; continue; }
    if (x.id === ID.INFO) for (const c of children(b, x.data, x.end)) {
      if (c.id === 0x2AD7B1) scale = uintAt(b, c.data, c.end);
      else if (c.id === 0x4489) fileDur = floatAt(b, c.data, c.end);
    }
    if (x.id === ID.TRACKS) {
      const t = webmTrack(b, x);
      if (t) {
        info = { trackId: t.trackId, codec: t.codec, rate: t.rate, channels: t.channels, delay: t.delay, defDur: t.defDur, scale,
          duration: fileDur == null ? null : fileDur * scale / 1e9, key: `${t.codec}/${t.channels}/${t.rate}/${t.trackId}/${t.priv}` };
        items.push({ kind: 'init', start: head ?? x.start, end: x.end, info });
      }
      head = null;
    }
    p = x.end;
  }
  return items;
}

// ---------------------------------------------------------------- MP3 / ADTS frame walks

const MP3_BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SR = [44100, 48000, 32000];
function mp3Header(b, p) {                                   // MPEG-1/2/2.5 Layer III only
  if (b[p] !== 0xFF || (b[p + 1] & 0xE0) !== 0xE0) return null;
  const ver = (b[p + 1] >> 3) & 3, layer = (b[p + 1] >> 1) & 3, bi = b[p + 2] >> 4, si = (b[p + 2] >> 2) & 3;
  if (ver === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) return null;
  const v1 = ver === 3, sr = MP3_SR[si] / (v1 ? 1 : ver === 2 ? 2 : 4), br = (v1 ? MP3_BR1 : MP3_BR2)[bi] * 1000;
  return { len: Math.floor((v1 ? 144 : 72) * br / sr) + ((b[p + 2] >> 1) & 1), spf: v1 ? 1152 : 576, sr, v1, mono: (b[p + 3] >> 6) === 3 };
}
const ADTS_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function adtsHeader(b, p) {
  if (p + 7 > b.length || b[p] !== 0xFF || (b[p + 1] & 0xF6) !== 0xF0) return null;
  const si = (b[p + 2] >> 2) & 15, len = ((b[p + 3] & 3) << 11) | (b[p + 4] << 3) | (b[p + 5] >> 5);
  if (si > 12 || len < ((b[p + 1] & 1) ? 7 : 9)) return null;
  return { len, spf: 1024 * ((b[p + 6] & 3) + 1), sr: ADTS_SR[si] };
}

/** Xing/Info frame (VBR header, not audio) and the LAME encoder delay/padding it may carry. */
function xing(b, p, h) {
  const off = p + 4 + (h.v1 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17)), tag = fourcc(b, off);
  if (tag !== 'Xing' && tag !== 'Info') return null;
  const fl = (b[off + 4] << 24 | b[off + 5] << 16 | b[off + 6] << 8 | b[off + 7]) >>> 0;
  const lame = off + 8 + (fl & 1 ? 4 : 0) + (fl & 2 ? 4 : 0) + (fl & 4 ? 100 : 0) + (fl & 8 ? 4 : 0);
  if (lame + 24 > p + h.len) return { delay: 0, padding: 0 };
  return { delay: (b[lame + 21] << 4) | (b[lame + 22] >> 4), padding: ((b[lame + 22] & 15) << 8) | b[lame + 23] };
}

function walk(buf, header, lameTag) {
  const b = bytesOf(buf);
  let p = 0, frames = 0, samples = 0, junk = 0, sampleRate = 0, spf = 0, end = 0, synced = false, delay = 0, padding = 0;
  while (p + 4 <= b.length) {
    if (b[p] === 0x49 && b[p + 1] === 0x44 && b[p + 2] === 0x33 && p + 10 <= b.length) {            // ID3v2 tag
      p += 10 + ((b[p + 6] & 127) << 21 | (b[p + 7] & 127) << 14 | (b[p + 8] & 127) << 7 | (b[p + 9] & 127)) + (b[p + 5] & 0x10 ? 10 : 0);
      synced = false; continue;
    }
    const h = header(b, p);
    const fits = h && (!sampleRate || h.sr === sampleRate);
    const next = fits && p + h.len;
    if (fits && next > b.length) break;                                                             // a frame cut short at the end
    if (fits && (synced || next === b.length || header(b, next))) {
      const x = lameTag && frames === 0 && !end ? lameTag(b, p, h) : null;
      if (x) { delay = x.delay; padding = x.padding; }
      else { frames++; samples += h.spf; if (h.spf > spf) spf = h.spf; }
      sampleRate = h.sr; p = end = next; synced = true; continue;
    }
    junk++; p++; synced = false;
  }
  return { sampleRate, frames, samples: Math.max(0, samples - delay - padding), junk, end, spf, delay, padding };
}

/** MP3 (Layer III) frame walk: {sampleRate, frames, samples, junk, end, spf, delay, padding}. */
export const mp3Frames = (buf) => walk(buf, mp3Header, xing);
/** ADTS (AAC) header walk: {sampleRate, frames, samples, junk, end, spf}. */
export const adtsFrames = (buf) => walk(buf, adtsHeader, null);
