// Generates the assembly fixtures in tests/fixtures/fmp4/ with /usr/bin/ffmpeg. Deterministic: the
// signal is an expression (no randomness), every output is bitexact and carries no metadata.
//   node tests/fixtures/make-fmp4.mjs [outDir]
// Signal: 30 s stereo, an exponential chirp 100 Hz -> 6 kHz (L sine, R cosine) plus a 1 ms click every
// 1.37 s from 0.5 s, so a doubled or missing span shows up as a cross-correlation peak away from lag 0.
// Outputs:
//   lo/, hi/      Opus in fragmented MP4 at 48k and 128k: init.mp4 + seg-0000N.m4s, 4 s segments,
//                 the same packet timing in both, so segment boundaries line up
//   whole-lo.mp4  the lo packets in one unfragmented MP4 (the sample-exact reference)
//   track.webm    10 s of WebM/Opus in 2 s clusters
//   track.mp3     10 s of MP3 (32k CBR)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FFMPEG = '/usr/bin/ffmpeg';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || path.join(HERE, 'fmp4'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'make-fmp4-'));
const SEC = 30, SEG = 4;
const BIT = ['-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1'];

const ff = (...args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

const K = Math.log(6000 / 100) / SEC;
const phase = `2*PI*100/${K}*(exp(${K}*t)-1)`;
const click = '0.6*lt(mod(t-0.5,1.37),0.001)*gte(t,0.5)';
const src = path.join(TMP, 'src.wav');
ff('-f', 'lavfi', '-i', `aevalsrc=exprs='0.3*sin(${phase})+${click}|0.3*cos(${phase})+${click}':s=48000:d=${SEC}`,
  '-c:a', 'pcm_s16le', ...BIT, src);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [rep, rate] of [['lo', '48k'], ['hi', '128k']]) {
  // an MP4 intermediate keeps sample-exact timestamps (Matroska would round them to 1 ms)
  const enc = rep === 'lo' ? path.join(OUT, 'whole-lo.mp4') : path.join(TMP, `${rep}.mp4`);
  ff('-i', src, '-c:a', 'libopus', '-b:a', rate, '-vbr', 'off', '-frame_duration', '20', ...BIT, '-movflags', '+faststart', enc);
  const dir = path.join(OUT, rep);
  fs.mkdirSync(dir);
  ff('-i', enc, '-c', 'copy', ...BIT, '-f', 'dash', '-dash_segment_type', 'mp4', '-seg_duration', String(SEG), '-use_template', '1', '-use_timeline', '0',
    '-init_seg_name', 'init.mp4', '-media_seg_name', 'seg-$Number%05d$.m4s', path.join(dir, 'manifest.mpd'));
  fs.rmSync(path.join(dir, 'manifest.mpd'));
}
ff('-i', src, '-t', '10', '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'off', ...BIT, '-cluster_time_limit', '2000', '-f', 'webm', path.join(OUT, 'track.webm'));
ff('-i', src, '-t', '10', '-c:a', 'libmp3lame', '-b:a', '32k', ...BIT, '-id3v2_version', '0', path.join(OUT, 'track.mp3'));
fs.rmSync(TMP, { recursive: true, force: true });

let total = 0;
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else total += fs.statSync(p).size; } };
walk(OUT);
console.log(`wrote ${OUT} (${(total / 1024).toFixed(0)} KiB)`);
