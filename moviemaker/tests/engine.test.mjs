// Headless Chromium run of tests/engine.html (C-engine: audio.js, player.js, exporter.js).
// Usage: NODE_PATH=/opt/node22/lib/node_modules node tests/engine.test.mjs [outDir]
//        ENGINE_PROFILE=desktop|phone|fallbacks runs a single profile.
// Waits (up to 20 min) for the modules the engine depends on, serves the project on
// port 8103, runs both test phases (phase 2 from a real click so audio unlocks the way it
// does for users), then checks the exported movies with ffprobe/ffmpeg.
import { createRequire } from 'node:module';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'movie-maker-engine-test'));
fs.mkdirSync(outDir, { recursive: true });
const PORT = 8103;
const base = `http://127.0.0.1:${PORT}`;

// 1) Wait for the modules written by the other engineers.
const needed = ['js/model.js', 'js/store.js', 'js/renderer.js', 'js/transitions.js', 'js/effects.js', 'js/text.js'];
const deadline = Date.now() + 20 * 60 * 1000;
for (;;) {
  const missing = needed.filter((f) => !fs.existsSync(path.join(root, f)));
  if (!missing.length) break;
  if (Date.now() > deadline) { console.log('Still missing after 20 min, testing anyway:', missing.join(', ')); break; }
  console.log('Waiting for', missing.join(', '));
  await new Promise((r) => setTimeout(r, 15000));
}

// A/V sync fixture: white flashes and 1 kHz beeps at exactly 1.0 s and 2.5 s.
const syncFixture = path.join(root, 'tests', 'engine-sync.webm');
if (!fs.existsSync(syncFixture)) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=4',
    '-f', 'lavfi', '-i', 'sine=f=1000:sample_rate=48000:d=4', '-filter_complex',
    "[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,1,1.1)+between(t,2.5,2.6)'[v];"
    + "[1:a]volume=volume=0:enable='not(between(t,1,1.1)+between(t,2.5,2.6))'[a]",
    '-map', '[v]', '-map', '[a]', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', '-b:a', '64k', syncFixture]);
}

/** Times of flashes (video) and beeps (audio) in a file, using the streams' own timestamps. */
function syncEvents(file) {
  const v = spawnSync('ffprobe', ['-v', 'error', '-f', 'lavfi', '-i', `movie=${file},signalstats`, '-show_entries',
    'frame=pts_time:frame_tags=lavfi.signalstats.YAVG', '-of', 'csv=p=0'], { encoding: 'utf8' });
  const flashes = [];
  let prevBright = false;
  for (const line of v.stdout.trim().split('\n')) {
    const [t, y] = line.split(',').map(parseFloat);
    const bright = y > 100;
    if (bright && !prevBright) flashes.push(t);
    prevBright = bright;
  }
  const a = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'silencedetect=n=-30dB:d=0.2', '-f', 'null', '-'], { encoding: 'utf8' });
  const beeps = [...(a.stderr || '').matchAll(/silence_end: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
  return { flashes, beeps };
}

// 2) Serve.
const server = spawn('npx', ['http-server', root, '-p', String(PORT), '-c-1', '--silent'], { stdio: 'ignore' });
const stopServer = () => { try { server.kill('SIGTERM'); } catch (_) { /* ignore */ } };
process.on('exit', stopServer);
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(base + '/tests/engine.html'); if (r.ok) break; } catch (_) { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

let failures = 0;
const { devices } = require('playwright');
// Desktop, then a phone profile (touch, coarse pointer, high DPR) unless ENGINE_PROFILE picks one.
const profiles = [
  { name: 'desktop', page: 'engine.html', ctx: { viewport: { width: 900, height: 900 } }, tap: false },
  { name: 'phone', page: 'engine.html', ctx: { ...devices['Pixel 7'] }, tap: true },
  { name: 'fallbacks', page: 'engine-fallbacks.html', ctx: { viewport: { width: 900, height: 900 } }, tap: false },
].filter((p) => !process.env.ENGINE_PROFILE || process.env.ENGINE_PROFILE === p.name);
const browser = await chromium.launch();
try {
  for (const profile of profiles) {
    console.log(`\n=== ${profile.name} ===`);
    const context = await browser.newContext(profile.ctx);
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => {
      const text = m.text();
      if (m.type() === 'warning' && /willReadFrequently/.test(text)) return; // the harness reads pixels back
      if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.type() + ': ' + text);
    });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    await page.goto(base + '/tests/' + profile.page);
    await page.waitForFunction(() => window.__phase1Done === true, null, { timeout: 120000 });
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches + ' dpr=' + devicePixelRatio);
    console.log('pointer:coarse=' + coarse);
    if (profile.tap) await page.tap('#go'); else await page.click('#go');
    await page.waitForFunction(() => window.__done === true, null, { timeout: 180000 });
    const results = await page.evaluate(() => window.__results);
    for (const r of results) {
      console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.info ? '  — ' + r.info : ''));
      if (!r.ok) failures++;
    }
    await page.screenshot({ path: path.join(outDir, `engine-${profile.name}.png`), fullPage: true });

    // Inspect exported files.
    const exportsList = await page.evaluate(() => window.__exports.map((e) => ({
      name: e.name, b64: e.b64, expect: e.expect, audio: e.audio !== false, sync: !!e.sync, size: e.size || [426, 240],
    })));
    for (const ex of exportsList) {
      const file = path.join(outDir, profile.name + '-' + ex.name);
      fs.writeFileSync(file, Buffer.from(ex.b64, 'base64'));
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
        'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', file]).toString());
      const streams = probe.streams || [];
      const v = streams.find((st) => st.codec_type === 'video');
      const a = streams.find((st) => st.codec_type === 'audio');
      const dur = parseFloat(probe.format && probe.format.duration);
      const report = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + '  — ' + info); if (!ok) failures++; };
      report(`ffprobe ${ex.name}: ${ex.audio ? 'video + audio streams' : 'video only'}`, !!v && (ex.audio ? !!a : !a),
        streams.map((st) => st.codec_type + ':' + st.codec_name + (st.width ? ` ${st.width}x${st.height}` : '')).join(', '));
      report(`ffprobe ${ex.name}: header duration`, Number.isFinite(dur) && Math.abs(dur - ex.expect) < 0.6, `${dur} (movie ${ex.expect.toFixed(2)})`);
      report(`ffprobe ${ex.name}: preset size`, v && v.width === ex.size[0] && v.height === ex.size[1], v ? `${v.width}x${v.height}` : 'none');
      // Decoded length and loudness.
      const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      const txt = r.stderr || '';
      const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(txt);
      const timeM = [...txt.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
      const decoded = timeM ? (+timeM[1]) * 3600 + (+timeM[2]) * 60 + parseFloat(timeM[3]) : NaN;
      report(`ffmpeg ${ex.name}: decodes to full length`, Math.abs(decoded - ex.expect) < 0.6, decoded);
      if (ex.sync) {
        const ref = syncEvents(syncFixture);
        const out = syncEvents(file);
        const refOff = ref.beeps[0] - ref.flashes[0]; // codec delay already in the source
        const offs = out.flashes.slice(0, 2).map((f, i) => (out.beeps[i] - f) - refOff);
        const ok = out.flashes.length >= 2 && out.beeps.length >= 2 && offs.every((o) => Math.abs(o) < 0.067);
        report(`sync ${ex.name}: picture and sound line up`, ok,
          `flashes ${out.flashes.map((x) => x.toFixed(3))} beeps ${out.beeps.slice(0, 2).map((x) => x.toFixed(3))} → offset ${offs.map((o) => (o * 1000).toFixed(0) + 'ms').join(', ')}`);
        const gap = out.flashes[1] - out.flashes[0];
        report(`sync ${ex.name}: real-time pacing`, Math.abs(gap - 1.5) < 0.05, `flash gap ${gap.toFixed(3)}s (want 1.5)`);
      }
      if (ex.audio) report(`ffmpeg ${ex.name}: has audible sound`, mean && parseFloat(mean[1]) > -50, mean ? mean[1] + ' dB mean' : 'n/a');
      const frames = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames',
        '-of', 'csv=p=0', file], { encoding: 'utf8' });
      const nFrames = parseInt(frames.stdout, 10);
      report(`ffprobe ${ex.name}: frame count ~ fps × duration`, nFrames > ex.expect * 20 && nFrames < ex.expect * 31 + 5, `${nFrames} frames`);
    }
    const ignorable = (str) => /Movie Maker player: (video|image) missing/.test(str);
    const realConsole = consoleErrors.filter((str) => !ignorable(str));
    if (realConsole.length) console.log('Console warnings/errors:\n  ' + realConsole.join('\n  '));
    await context.close();
  }
  console.log(`Screenshots/exports in ${outDir}`);
} finally {
  await browser.close();
  stopServer();
}
console.log(failures ? `FAIL (${failures})` : 'PASS');
process.exit(failures ? 1 : 0);
