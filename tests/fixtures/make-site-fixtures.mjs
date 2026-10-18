// Generates tests/fixtures/sites/: the media behind the model streaming sites (/m/* on the track
// server in tests/browser/ext-harness.mjs), plus index.json describing every file. Deterministic:
// with the same ffmpeg, a re-run writes identical bytes. Run: node tests/fixtures/make-site-fixtures.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sites');
const FFMPEG = process.env.FFMPEG || '/usr/bin/ffmpeg';
const SIGNAL = {
  sampleRate: 48000, channels: 2, seconds: 120, bpm: 124, firstBeat: 0, beatsPerBar: 4,
  kick: 'pitched kick (45-115 Hz, 0.2 s) on every beat, 0.7 on the first beat of a bar, 0.5 otherwise',
  chirp: { f0: 200, f1: 4000, shape: 'exponential over the whole track', amplitude: 0.15 },
};
const PREVIEW_SECONDS = 30;
// A ClearKey test key, not a secret: it only makes the encrypted copy a real CENC stream.
const DRM = { keySystem: 'org.w3.clearkey', kid: '6a647361-6d70-7300-0000-000000000001'.replace(/-/g, ''), key: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' };
const CLEARKEY_SYSTEM = '1077efecc0b24d02ace33c1e52e2fb4b';
const OPUS_MP4 = 'audio/mp4; codecs="opus"';

/** 16-bit PCM WAV, both channels equal: the kick track over a chirp that sweeps once across the track. */
function signalWav() {
  const { sampleRate: sr, seconds, bpm, chirp } = SIGNAL, n = sr * seconds, beat = 60 / bpm, k = Math.log(chirp.f1 / chirp.f0);
  const buf = Buffer.alloc(44 + n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / sr, b = Math.floor(t / beat), tb = t - b * beat;
    let v = chirp.amplitude * Math.sin((2 * Math.PI * chirp.f0 * seconds / k) * (Math.exp((k * t) / seconds) - 1));
    if (tb < 0.2) v += (b % 4 === 0 ? 0.7 : 0.5) * Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-tb * 35)) * tb) * Math.exp(-tb * 18);
    const s = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 46 + i * 4);
  }
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  return buf;
}

// ---------------------------------------------------------------- ISO-BMFF
function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  for (let o = start; o + 8 <= end;) {
    const size = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    if (size < 8 || o + size > end) throw new Error(`bad ${type} box at ${o}`);
    out.push({ type, start: o, end: o + size });
    o += size;
  }
  return out;
}
const PREFIX = { stsd: 8, Opus: 28 }; // bytes between a box header and its children
const child = (buf, b, type) => boxes(buf, b.start + 8 + (PREFIX[b.type] || 0), b.end).find((c) => c.type === type);
const find = (buf, route) => route.reduce((b, t) => b && child(buf, b, t), { type: '', start: -8, end: buf.length });
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
function box(type, ...parts) {
  const body = Buffer.concat(parts), head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length); head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
/** Rebuild the boxes in buf[start, end), replacing the one at `route` with leaf(box). */
function rewrite(buf, start, end, route, leaf) {
  return Buffer.concat(boxes(buf, start, end).map((b) => {
    if (b.type !== route[0]) return buf.subarray(b.start, b.end);
    if (route.length === 1) return leaf(b);
    const body = b.start + 8 + (PREFIX[b.type] || 0);
    return box(b.type, buf.subarray(b.start + 8, body), rewrite(buf, body, b.end, route.slice(1), leaf));
  }));
}

function timescale(init) {
  const mdhd = find(init, ['moov', 'trak', 'mdia', 'mdhd']);
  return init.readUInt32BE(mdhd.start + (init[mdhd.start + 8] === 1 ? 28 : 20));
}
/** A fragment's samples: [{dur, size}] from its tfhd defaults and trun. */
function samples(seg) {
  const traf = find(seg, ['moof', 'traf']), tfhd = child(seg, traf, 'tfhd'), trun = child(seg, traf, 'trun');
  const tf = seg.readUInt32BE(tfhd.start + 8) & 0xffffff;
  let o = tfhd.start + 16 + (tf & 0x1 ? 8 : 0) + (tf & 0x2 ? 4 : 0);
  const defDur = tf & 0x8 ? seg.readUInt32BE(o) : null; if (tf & 0x8) o += 4;
  const defSize = tf & 0x10 ? seg.readUInt32BE(o) : null;
  const fl = seg.readUInt32BE(trun.start + 8) & 0xffffff, count = seg.readUInt32BE(trun.start + 12), out = [];
  let q = trun.start + 16 + (fl & 0x1 ? 4 : 0) + (fl & 0x4 ? 4 : 0);
  for (let i = 0; i < count; i++) {
    const dur = fl & 0x100 ? seg.readUInt32BE(q) : defDur; if (fl & 0x100) q += 4;
    const size = fl & 0x200 ? seg.readUInt32BE(q) : defSize; if (fl & 0x200) q += 4;
    q += (fl & 0x400 ? 4 : 0) + (fl & 0x800 ? 4 : 0);
    if (dur == null || size == null) throw new Error('sample duration or size only in trex: not handled');
    out.push({ dur, size });
  }
  return out;
}
function tfdt(seg) {
  const b = child(seg, find(seg, ['moof', 'traf']), 'tfdt');
  return seg[b.start + 8] === 1 ? Number(seg.readBigUInt64BE(b.start + 12)) : seg.readUInt32BE(b.start + 12);
}

/** A fragmented MP4 split as a DASH/HLS packager would: init (ftyp + moov), then one moof + mdat per segment. */
function split(mp4) {
  const top = boxes(mp4), at = (t) => top.filter((b) => b.type === t);
  const [moov] = at('moov'), init = mp4.subarray(0, moov.end), segs = [];
  for (const moof of at('moof')) {
    const mdat = top[top.indexOf(moof) + 1];
    if (mdat?.type !== 'mdat') throw new Error('moof without mdat');
    segs.push(mp4.subarray(moof.start, mdat.end));
  }
  return { init, segs };
}

// ---------------------------------------------------------------- CENC (ClearKey)
/** Opus sample entry -> 'enca' with a cenc 'sinf'; a ClearKey 'pssh' (v1, naming the KID) in moov. */
function encryptInit(init, kid) {
  const tenc = box('tenc', u32(0), Buffer.from([0, 0, 1, 8]), kid);
  const sinf = box('sinf', box('frma', Buffer.from('Opus')), box('schm', u32(0), Buffer.from('cenc'), u32(0x10000)), box('schi', tenc));
  const pssh = box('pssh', u32(0x01000000), Buffer.from(CLEARKEY_SYSTEM, 'hex'), u32(1), kid, u32(0));
  return rewrite(init, 0, init.length, ['moov'], (moov) => box('moov',
    rewrite(init, moov.start + 8, moov.end, ['trak', 'mdia', 'minf', 'stbl', 'stsd', 'Opus'], (e) => box('enca', init.subarray(e.start + 8, e.end), sinf)),
    pssh));
}
/** Whole-sample AES-128-CTR with an 8-byte IV per sample (ivBase + i); IVs in 'senc', located by 'saiz'/'saio'. */
function encryptSeg(seg, key, ivBase) {
  const [moof] = boxes(seg), [mfhd, traf] = boxes(seg, moof.start + 8, moof.end), ss = samples(seg);
  const trunBox = child(seg, traf, 'trun');
  if (!(seg.readUInt32BE(trunBox.start + 8) & 0x1)) throw new Error('trun without data offset');
  let p = moof.start + seg.readInt32BE(trunBox.start + 16);
  const ivs = [], data = [];
  ss.forEach(({ size }, i) => {
    const iv = Buffer.alloc(8); iv.writeBigUInt64BE(BigInt(ivBase + i));
    const c = crypto.createCipheriv('aes-128-ctr', key, Buffer.concat([iv, Buffer.alloc(8)]));
    data.push(c.update(seg.subarray(p, p + size)), c.final()); ivs.push(iv); p += size;
  });
  const kept = boxes(seg, traf.start + 8, traf.end).map((b) => seg.subarray(b.start, b.end));
  const saiz = box('saiz', u32(0), Buffer.from([8]), u32(ss.length)), senc = box('senc', u32(0), u32(ss.length), ...ivs);
  const moofSize = 8 + (mfhd.end - mfhd.start) + 8 + kept.reduce((a, b) => a + b.length, 0) + saiz.length + 20 + senc.length;
  const trun = Buffer.from(seg.subarray(trunBox.start, trunBox.end));
  trun.writeInt32BE(moofSize + 8, 16);
  const trafKids = kept.map((b) => (b.toString('latin1', 4, 8) === 'trun' ? trun : b));
  const saio = box('saio', u32(0), u32(1), u32(moofSize - 8 * ss.length));
  const out = Buffer.concat([box('moof', seg.subarray(mfhd.start, mfhd.end), box('traf', ...trafKids, saiz, saio, senc)), box('mdat', ...data)]);
  if (boxes(out)[0].end !== moofSize) throw new Error('moof size mismatch');
  return out;
}

// ---------------------------------------------------------------- main
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jds-sites-'));
try {
  const wav = path.join(tmp, 'signal.wav');
  fs.writeFileSync(wav, signalWav());
  const enc = (out, ...args) => {
    const file = path.join(tmp, out);
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav,
      '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', ...args, file], { stdio: 'inherit' });
    return fs.readFileSync(file);
  };
  const fmp4 = (kbps) => ['-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'constrained', '-f', 'mp4',
    '-movflags', '+empty_moov+default_base_moof', '-frag_duration', '4000000'];

  fs.rmSync(OUT, { recursive: true, force: true });
  const index = { about: 'Generated by tests/fixtures/make-site-fixtures.mjs; do not edit by hand.', signal: SIGNAL, files: {}, reps: {} };
  const write = (p, buf, extra = {}) => {
    fs.mkdirSync(path.dirname(path.join(OUT, p)), { recursive: true });
    fs.writeFileSync(path.join(OUT, p), buf);
    return { path: p, ...extra, bytes: buf.length, sha256: sha(buf) };
  };
  const mp3 = ['-c:a', 'libmp3lame', '-b:a', '32k', '-ar', '48000'];
  index.files['track.mp3'] = write('track.mp3', enc('track.mp3', ...mp3), { mime: 'audio/mpeg', seconds: SIGNAL.seconds });
  index.files['preview/track.mp3'] = write('preview/track.mp3', enc('preview.mp3', '-t', String(PREVIEW_SECONDS), ...mp3), { mime: 'audio/mpeg', seconds: PREVIEW_SECONDS });
  index.files['track.webm'] = write('track.webm', enc('track.webm', '-c:a', 'libopus', '-b:a', '16k', '-vbr', 'constrained', '-f', 'webm'), { mime: 'audio/webm; codecs="opus"', seconds: SIGNAL.seconds });

  const rep = (name, { init, segs }, extra = {}) => {
    const ts = timescale(init);
    index.reps[name] = {
      mime: OPUS_MP4, ...extra, timescale: ts,
      init: write(`${name}/init.mp4`, init),
      segs: segs.map((s, i) => {
        const t0 = tfdt(s), d = samples(s).reduce((a, x) => a + x.dur, 0);
        return write(`${name}/seg-${String(i).padStart(3, '0')}.m4s`, s, { t0: t0 / ts, t1: (t0 + d) / ts });
      }),
    };
  };
  const lo = split(enc('lo.mp4', ...fmp4(12))), hi = split(enc('hi.mp4', ...fmp4(24)));
  rep('opus-lo', lo, { bitrate: 12000 });
  rep('opus-hi', hi, { bitrate: 24000 });
  const key = Buffer.from(DRM.key, 'hex'), kid = Buffer.from(DRM.kid, 'hex');
  let ivBase = 1;
  rep('opus-cenc', {
    init: encryptInit(lo.init, kid),
    segs: lo.segs.map((s) => { const out = encryptSeg(s, key, ivBase); ivBase += samples(s).length; return out; }),
  }, { bitrate: 12000, drm: DRM });

  fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  const total = fs.readdirSync(OUT, { recursive: true }).map((p) => fs.statSync(path.join(OUT, p))).filter((s) => s.isFile()).reduce((a, s) => a + s.size, 0);
  console.log(`wrote ${OUT}: ${total} bytes`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
