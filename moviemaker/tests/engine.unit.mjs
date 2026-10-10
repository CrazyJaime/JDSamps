// Node unit tests for the pure parts of js/exporter.js and js/audio.js.
// Usage: node tests/engine.unit.mjs   (needs ffmpeg/ffprobe on PATH for the WebM checks)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  EXPORT_PRESETS, exportSize, movieFileName, videoBitrate, supportedFormats, patchWebmHead, fixWebmDuration,
} from '../js/exporter.js';
import { mixGains } from '../js/audio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
let count = 0;
function check(name, cond, info = '') {
  count++;
  if (!cond) failures++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  — ' + info : ''));
}

// ---------------------------------------------------------------------------
// sizes, names, bitrates, formats
const media = new Map([
  ['v1080', { id: 'v1080', type: 'video', width: 1920, height: 1080 }],
  ['v360', { id: 'v360', type: 'video', width: 640, height: 360 }],
  ['vPortrait', { id: 'vPortrait', type: 'video', width: 720, height: 1280 }],
]);
const proj = (aspect, ids) => ({ aspect, items: ids.map((id) => ({ kind: 'video', mediaId: id })) });
const desk = { coarse: false }, phone = { coarse: true };
let s = exportSize('recommended', proj('16:9', ['v1080', 'v360']), media, desk);
check('size: recommended follows the best source (1080p)', s.width === 1920 && s.height === 1080, JSON.stringify(s));
s = exportSize('recommended', proj('16:9', ['v1080']), media, phone);
check('size: recommended capped to 720p on phones', s.width === 1280 && s.height === 720, JSON.stringify(s));
s = exportSize('hd1080', proj('16:9', []), media, phone);
check('size: explicit 1080p allowed on phones', s.height === 1080, JSON.stringify(s));
s = exportSize('recommended', proj('16:9', ['v360']), media, desk);
check('size: recommended for small sources is 480p', s.width === 854 && s.height === 480, JSON.stringify(s));
s = exportSize('recommended', proj('4:3', []), media, desk);
check('size: photos only → 720p, 4:3 even width', s.width === 960 && s.height === 720, JSON.stringify(s));
s = exportSize('email', proj('16:9', []), media, desk);
check('size: email 426x240', s.width === 426 && s.height === 240, JSON.stringify(s));
s = exportSize('wide480', proj('9:16', ['vPortrait']), media, desk);
check('size: portrait uses the preset as the short side', s.width === 480 && s.height === 854, JSON.stringify(s));
s = exportSize('mobile', proj('1:1', []), media, desk);
check('size: square', s.width === 480 && s.height === 480, JSON.stringify(s));
s = exportSize('nonsense', { aspect: 'weird' }, null, desk);
check('size: unknown preset/aspect fall back sanely', s.width % 2 === 0 && s.height % 2 === 0 && s.height === 720, JSON.stringify(s));
check('presets: WLMM menu', EXPORT_PRESETS.map((p) => p.id).join() === 'recommended,hd1080,hd720,wide480,mobile,email');
check('filename: sanitized', movieFileName({ name: ' My: "Trip" / 2024 ' }, 'mp4') === 'My Trip 2024.mp4', movieFileName({ name: ' My: "Trip" / 2024 ' }, 'mp4'));
check('filename: default', movieFileName({ name: '' }, 'webm') === 'My Movie.webm');
check('bitrate: scales and clamps', videoBitrate(1280, 720, 30) === Math.round(1280 * 720 * 30 * 0.12)
  && videoBitrate(100, 100, 10) === 400000 && videoBitrate(3840, 2160, 60) === 12e6);
check('formats: none without MediaRecorder', Array.isArray(supportedFormats()) && supportedFormats().length === 0);
const g0 = mixGains(0), g1 = mixGains(1), gm = mixGains(-0.6);
check('mix: gains', g0.video === 1 && g0.music === 1 && g1.video === 0 && g1.music === 1 && gm.video === 1 && Math.abs(gm.music - 0.4) < 1e-9,
  JSON.stringify([g0, g1, gm]));

// ---------------------------------------------------------------------------
// EBML helpers for building / reading test files
function vint(value, len) {
  const out = [];
  let v = value;
  for (let i = 0; i < len; i++) { out.unshift(v % 256); v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}
function idBytes(id) { const b = []; let v = id; while (v > 0) { b.unshift(v & 0xff); v = Math.floor(v / 256); } return b; }
function el(id, data, sizeLen = 0) {
  const d = Array.isArray(data) ? data : [...data];
  const len = sizeLen || (d.length < 127 ? 1 : d.length < 16383 ? 2 : 4);
  return [...idBytes(id), ...vint(d.length, len), ...d];
}
function uint(v, len) { const out = []; for (let i = 0; i < len; i++) { out.unshift(v % 256); v = Math.floor(v / 256); } return out; }
// Minimal reader: returns { id, start, dataStart, size, end, children? }
function readVar(b, p, keepMarker) {
  const first = b[p];
  let len = 1, mask = 0x80;
  while (!(first & mask)) { mask >>= 1; len++; }
  let v = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < len; i++) v = v * 256 + b[p + i];
  return { v, len };
}
function parse(b, p, end) {
  const list = [];
  while (p < end) {
    const id = readVar(b, p, true);
    const sz = readVar(b, p + id.len, false);
    const dataStart = p + id.len + sz.len;
    const unknown = sz.v === Math.pow(2, 7 * sz.len) - 1;
    const e = { id: id.v, start: p, dataStart, size: sz.v, end: unknown ? end : dataStart + sz.v };
    list.push(e);
    p = e.end;
  }
  return list;
}
const readU = (b, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };

// ---------------------------------------------------------------------------
// Synthetic file: SeekHead → (Info, Tracks, Cues), Info without Duration, Cues before the
// cluster, known Segment size. After the patch every position must still point at its element.
{
  const ebmlHeader = el(0x1A45DFA3, el(0x4282, [...Buffer.from('webm')]));
  const info = el(0x1549A966, [...el(0x2AD7B1, uint(1000000, 3)), ...el(0x4D80, [...Buffer.from('test')])]);
  const tracks = el(0x1654AE6B, el(0xAE, el(0xD7, [1])));
  const cluster = el(0x1F43B675, [...el(0xE7, [0]), ...el(0xA3, [0x81, 0, 0, 0x80, 1, 2, 3])]);
  // Layout: SeekHead (fixed 8-byte positions) | Info | Tracks | Cues | Cluster
  const seek = (id, pos) => el(0x4DBB, [...el(0x53AB, idBytes(id)), ...el(0x53AC, uint(pos, 8))]);
  const seekHeadLen = el(0x114D9B74, [...seek(0x1549A966, 0), ...seek(0x1654AE6B, 0), ...seek(0x1C53BB6B, 0)]).length;
  const cuesFor = (clusterPos) => el(0x1C53BB6B, el(0xBB, [...el(0xB3, [0]), ...el(0xB7, [...el(0xF7, [1]), ...el(0xF1, uint(clusterPos, 8))])]));
  const cuesLen = cuesFor(0).length;
  const infoPos = seekHeadLen, tracksPos = infoPos + info.length, cuesPos = tracksPos + tracks.length;
  const clusterPos = cuesPos + cuesLen;
  const seekHead = el(0x114D9B74, [...seek(0x1549A966, infoPos), ...seek(0x1654AE6B, tracksPos), ...seek(0x1C53BB6B, cuesPos)]);
  const segData = [...seekHead, ...info, ...tracks, ...cuesFor(clusterPos), ...cluster];
  const file = Uint8Array.from([...ebmlHeader, ...el(0x18538067, segData, 8)]);

  const parts = patchWebmHead(file, 12.5);
  check('ebml: synthetic file patched', !!parts);
  if (parts) {
    const out = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const top = parse(out, 0, out.length);
    const seg = top[1];
    check('ebml: segment size grew by the inserted bytes', seg.size === segData.length + 11 && seg.end === out.length, `${seg.size} vs ${segData.length}`);
    const kids = parse(out, seg.dataStart, seg.end);
    const byId = (id) => kids.find((k) => k.id === id);
    const infoEl = byId(0x1549A966);
    const infoKids = parse(out, infoEl.dataStart, infoEl.end);
    const durEl = infoKids.find((k) => k.id === 0x4489);
    const durVal = durEl && Buffer.from(out.subarray(durEl.dataStart, durEl.end)).readDoubleBE(0);
    check('ebml: Duration inserted in ms ticks', durEl && durEl.size === 8 && durVal === 12500, durVal);
    check('ebml: other Info children intact', infoKids.some((k) => k.id === 0x2AD7B1) && infoKids.some((k) => k.id === 0x4D80));
    const sh = byId(0x114D9B74);
    const seeks = parse(out, sh.dataStart, sh.end).map((sk) => {
      const c = parse(out, sk.dataStart, sk.end);
      const sid = c.find((x) => x.id === 0x53AB), pos = c.find((x) => x.id === 0x53AC);
      return { target: readU(out, sid.dataStart, sid.size), pos: readU(out, pos.dataStart, pos.size) };
    });
    const allPointRight = seeks.every((sk) => { const k = kids.find((x) => x.start - seg.dataStart === sk.pos); return k && k.id === sk.target; });
    check('ebml: SeekHead positions still point at their elements', allPointRight, JSON.stringify(seeks));
    const cues = byId(0x1C53BB6B);
    const cp = parse(out, cues.dataStart, cues.end)[0];
    const ctp = parse(out, cp.dataStart, cp.end).find((x) => x.id === 0xB7);
    const ccp = parse(out, ctp.dataStart, ctp.end).find((x) => x.id === 0xF1);
    const cpos = readU(out, ccp.dataStart, ccp.size);
    const target = kids.find((x) => x.start - seg.dataStart === cpos);
    check('ebml: CueClusterPosition still points at the cluster', target && target.id === 0x1F43B675, cpos);
    // Second patch overwrites in place (Duration now present).
    const again = patchWebmHead(new Uint8Array(out), 3);
    const out2 = Buffer.concat(again.map((p) => Buffer.from(p)));
    check('ebml: existing Duration overwritten in place', out2.length === out.length && out2.readDoubleBE(durEl.dataStart) === 3000);
  }
  check('ebml: non-webm input left alone', patchWebmHead(Uint8Array.from([1, 2, 3, 4, 5]), 3) === null);
  const unknownCuesBeyond = (() => {
    // SeekHead names Cues but they are not in the head → refuse rather than corrupt.
    const sh2 = el(0x114D9B74, [...seek(0x1C53BB6B, 5000)]);
    const f = Uint8Array.from([...ebmlHeader, ...el(0x18538067, [...sh2, ...info, ...cluster], 8)]);
    return patchWebmHead(f, 2);
  })();
  check('ebml: refuses when Cues lie outside the head', unknownCuesBeyond === null);
}

// ---------------------------------------------------------------------------
// Real file: an ffmpeg WebM with SeekHead + Cues; strip its Duration (turn it into a Void
// element), then let fixWebmDuration put one back and make sure ffmpeg still reads it all.
function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return parseFloat(r.stdout);
}
{
  const src = fs.readFileSync(path.join(here, 'fixtures', 'clip1.webm'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-unit-'));
  const b = Uint8Array.from(src);
  // Find the Duration element (0x44 0x89 0x88) inside Info and void it.
  let at = -1;
  for (let i = 0; i < Math.min(b.length, 4096) - 11; i++) if (b[i] === 0x44 && b[i + 1] === 0x89 && b[i + 2] === 0x88) { at = i; break; }
  check('real: fixture has a Duration to strip', at > 0);
  if (at > 0) {
    b[at] = 0xEC; b[at + 1] = 0x89; // Void, 9 bytes
    for (let i = 2; i < 11; i++) b[at + i] = 0;
    // Info now has no Duration, so fixWebmDuration has to insert one and shift everything after it.
    const parsed = parse(b, 0, b.length);
    const seg = parsed[1];
    const infoEl = parse(b, seg.dataStart, Math.min(seg.end, b.length)).find((k) => k.id === 0x1549A966);
    const voided = path.join(tmp, 'voided.webm');
    fs.writeFileSync(voided, b);
    const before = probeDuration(voided);
    const fixed = await fixWebmDuration(new Blob([b], { type: 'video/webm' }), 4.025);
    const fixedFile = path.join(tmp, 'fixed.webm');
    fs.writeFileSync(fixedFile, Buffer.from(await fixed.arrayBuffer()));
    const after = probeDuration(fixedFile);
    check('real: Duration restored', Math.abs(after - 4.025) < 0.01, `before ${before}, after ${after}, info@${infoEl && infoEl.start}`);
    const full = spawnSync('ffmpeg', ['-v', 'error', '-i', fixedFile, '-f', 'null', '-'], { encoding: 'utf8' });
    check('real: patched file decodes without errors', full.status === 0 && !full.stderr.trim(), full.stderr.trim().slice(0, 200));
    const seekRun = spawnSync('ffmpeg', ['-v', 'error', '-ss', '3', '-i', fixedFile, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
    check('real: patched file seeks', seekRun.status === 0 && !seekRun.stderr.trim(), seekRun.stderr.trim().slice(0, 200));
    const big = await fixWebmDuration(new Blob([src], { type: 'video/webm' }), 9);
    const bigFile = path.join(tmp, 'overwrite.webm');
    fs.writeFileSync(bigFile, Buffer.from(await big.arrayBuffer()));
    check('real: existing Duration overwritten', Math.abs(probeDuration(bigFile) - 9) < 0.01 && big.size === src.length, probeDuration(bigFile));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`${count - failures}/${count} passed`);
console.log(failures ? `FAIL (${failures})` : 'PASS');
process.exit(failures ? 1 : 0);
