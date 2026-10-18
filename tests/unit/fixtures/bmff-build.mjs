// Hand-built ISO-BMFF, EBML and MPEG audio frames for the reader and assembly tests.

const bytes = (parts) => {
  const flat = parts.flat(Infinity).map((p) => (p instanceof Uint8Array ? p : Uint8Array.from([p])));
  const out = new Uint8Array(flat.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of flat) { out.set(p, k); k += p.length; }
  return out;
};
export const u16 = (n) => [(n >>> 8) & 255, n & 255];
export const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
export const u64 = (n) => [...u32(Math.floor(n / 2 ** 32)), ...u32(n % 2 ** 32)];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
export const cat = (...parts) => bytes(parts);

export function box(type, ...parts) {
  const body = bytes(parts);
  return bytes([u32(8 + body.length), ascii(type), body]);
}
export const full = (type, version, flags, ...parts) => box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);

/** An Opus-in-MP4 init segment: ftyp + moov (mdhd timescale, edit list with the pre-skip, dOps) + mvex/trex. */
export function initSeg({ timescale = 48000, trackId = 1, rate = 48000, channels = 2, preSkip = 312, edit = preSkip, mdhdVersion = 0, trexDuration = 960 } = {}) {
  const mdhd = mdhdVersion === 1
    ? full('mdhd', 1, 0, u64(0), u64(0), u32(timescale), u64(0), u32(0))
    : full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u32(0));
  const dOps = box('dOps', 0, channels, u16(preSkip), u32(rate), u16(0), 0);
  const opus = box('Opus', new Uint8Array(6), u16(1), new Uint8Array(8), u16(channels), u16(16), u16(0), u16(0), u32(rate * 65536), dOps);
  const stbl = box('stbl', full('stsd', 0, 0, u32(1), opus), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
  const trak = box('trak',
    full('tkhd', 0, 3, u32(0), u32(0), u32(trackId), new Uint8Array(68)),
    box('edts', full('elst', 0, 0, u32(1), u32(0), u32(edit), u16(1), u16(0))),
    box('mdia', mdhd, full('hdlr', 0, 0, u32(0), ascii('soun'), new Uint8Array(13)), box('minf', full('smhd', 0, 0, u32(0)), stbl)));
  return cat(box('ftyp', ascii('iso5'), u32(512), ascii('iso5iso6mp41')),
    box('moov', full('mvhd', 0, 0, new Uint8Array(96)), trak, box('mvex', full('trex', 0, 0, u32(trackId), u32(1), u32(trexDuration), u32(0), u32(0)))));
}

/**
 * One fragment (moof + mdat). `durs` lists the sample durations (all equal -> tfhd default only).
 * Sample sizes default to `size` bytes each; the trun data offset points at the mdat payload.
 */
export function fragSeg({ t, durs, trackId = 1, version = 1, size = 4, fill = 0, styp = false }) {
  const n = durs.length, same = durs.every((d) => d === durs[0]);
  const tfdtBox = version === 1 ? full('tfdt', 1, 0, u64(t)) : full('tfdt', 0, 0, u32(t));
  const build = (offset) => {
    const tfhd = full('tfhd', 0, 0x020000 | 0x10 | (same ? 0x08 : 0), u32(trackId), same ? u32(durs[0]) : [], u32(size));
    const trun = full('trun', 0, 0x01 | (same ? 0 : 0x100), u32(n), u32(offset), same ? [] : durs.map(u32));
    return box('moof', full('mfhd', 0, 0, u32(1)), box('traf', tfhd, tfdtBox, trun));
  };
  const moofLen = build(0).length;
  const moof = build(moofLen + 8);
  const mdat = box('mdat', new Uint8Array(n * size).fill(fill));
  return styp ? cat(box('styp', ascii('msdh'), u32(0), ascii('msdh')), moof, mdat) : cat(moof, mdat);
}

// ---- EBML (WebM) ----
const vsize = (n) => { // 8-byte size vint
  const out = [0x01]; for (let i = 6; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 255); return out;
};
const idBytes = (id) => { const out = []; let v = id; while (v > 0) { out.unshift(v & 255); v = Math.floor(v / 256); } return out; };
export const el = (id, ...parts) => { const body = bytes(parts); return bytes([idBytes(id), vsize(body.length), body]); };
export const elUnknown = (id, ...parts) => bytes([idBytes(id), [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], bytes(parts)]);
export const uint = (n, w = 4) => { const out = []; for (let i = w - 1; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 255); return out; };
export const f64 = (x) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x); return b; };

/** A WebM/Opus init: EBML header + Segment (unknown size) + Info + Tracks. */
export function webmInit({ scale = 1000000, codecDelay = 6500000, track = 1, rate = 48000, channels = 2 } = {}) {
  return cat(
    el(0x1A45DFA3, el(0x4282, ascii('webm'))),
    [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    el(0x1549A966, el(0x2AD7B1, uint(scale))),
    el(0x1654AE6B, el(0xAE, el(0xD7, uint(track, 1)), el(0x86, ascii('A_OPUS')), el(0x56AA, uint(codecDelay)),
      el(0xE1, el(0xB5, f64(rate)), el(0x9F, uint(channels, 1))))));
}
/** One Cluster at `tc` (in timecode-scale units) with Opus SimpleBlocks at relative times `rel`; TOC 0xFC = 20 ms stereo frame. */
export function webmCluster({ tc, rel, track = 1, unknown = false }) {
  const blocks = rel.map((r) => el(0xA3, 0x80 | track, u16(r & 0xffff), 0x80, 0xFC, 0, 0, 0));
  return (unknown ? elUnknown : el)(0x1F43B675, el(0xE7, uint(tc)), ...blocks);
}

// ---- MPEG audio ----
/** An MPEG-1 Layer III frame header (+ zero payload) at 48 kHz: bitrate index 9 = 128 kbps -> 384 bytes. */
export function mp3Frame({ brIndex = 9, srIndex = 1, pad = 0, payload = null } = {}) {
  const br = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][brIndex] * 1000;
  const sr = [44100, 48000, 32000][srIndex];
  const len = Math.floor(144 * br / sr) + pad;
  const f = new Uint8Array(len);
  f.set([0xFF, 0xFB, (brIndex << 4) | (srIndex << 2) | (pad << 1), 0x00]);
  if (payload) f.set(payload, 4);
  return f;
}
/** An ADTS header + zero payload: AAC LC, sample rate index `sf`, `blocks` raw data blocks (1..4). */
export function adtsFrame({ sf = 4, len = 200, blocks = 1, ch = 2 } = {}) {
  const f = new Uint8Array(len);
  f[0] = 0xFF; f[1] = 0xF1;                                   // sync, MPEG-4, layer 0, no CRC
  f[2] = (1 << 6) | (sf << 2) | (ch >> 2);                    // profile LC (1), sf index, channel config high bit
  f[3] = ((ch & 3) << 6) | ((len >> 11) & 3);
  f[4] = (len >> 3) & 255;
  f[5] = ((len & 7) << 5) | 0x1F;
  f[6] = 0xFC | ((blocks - 1) & 3);
  return f;
}
