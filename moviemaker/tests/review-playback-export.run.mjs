// Reviewer repro harness — playback / render / export correctness (not part of the regular suite).
//
//   NODE_PATH=/opt/node22/lib/node_modules node tests/review-playback-export.run.mjs [case ...|all]
//
// Cases (each prints MEASURED vs EXPECTED and exits non-zero when the defect reproduces):
//   silent-start     Save movie right after adding a long video: the first ~0.75 s of its sound is missing
//   slow-decode      soundtrack decode slower than the movie: the saved movie is silent, no warning
//   step-frame       "next frame" (Player.stepFrame) repeats a frame on 1 of 3 presses (30 fps WebM)
//   in-point         a clip trimmed at an exact frame time starts with the frame BEFORE its in-point (export)
//   cut-hitch        a clip split into contiguous 1 s pieces stutters at every split (export)
//   short-clips      0.2 s clips: share of their source frames that ever reach the exported file
//   judder           steady-state export of one 30 fps clip: repeated/skipped frame pairs, multi-frame holds
//   cut-click        hard audio cut between two non-contiguous parts of a tone → sample discontinuity (click)
//   rate-thrash      export: playbackRate rewritten every frame while the <video> stays ~50 ms behind
//   media-retention  removed clips keep their Media (blob URL) and decoded audio for the whole session
//
// Starts http-server on $PORT (default 8123) unless BASE_URL is set. Fixtures are generated with
// ffmpeg into a temp folder: "bar" clips encode the frame number as 12 vertical bars (top half) and
// carry a 1 kHz beep at every whole second, so each exported frame can be mapped back to its source frame.

import { createRequire } from 'node:module';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PORT || 8123);
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-review-'));

// ---------------------------------------------------------------------------- fixtures
function ff(args) { execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]); }
function makeFixtures() {
  const bar = (name, base, freq) => ff(['-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=12', '-f', 'lavfi', '-i', `sine=f=${freq}:sample_rate=48000:d=12`,
    '-filter_complex', `[0:v]format=gray,geq=lum='if(lt(Y,H/2), if(mod(floor((N+${base})/pow(2,floor(X*12/W))),2),235,16), if(lt(mod(N,30),3)*gte(N,30),235,16))',format=yuv420p[v];`
      + "[1:a]volume=volume=0.5,volume=volume=0:enable='not(gte(t,1)*lt(mod(t,1),0.1))'[a]",
    '-map', '[v]', '-map', '[a]', '-c:v', 'libvpx', '-b:v', '1500k', '-g', '15', '-c:a', 'libopus', '-b:a', '96k', path.join(FX, name)]);
  bar('barA.webm', 0, 1000);
  bar('barB.webm', 2000, 500);
  ff(['-f', 'lavfi', '-i', 'color=c=0x404040:s=640x360:r=30:d=10', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=10',
    '-af', 'volume=volume=0.25', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', '-b:a', '96k', path.join(FX, 'tone440.webm')]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x303030:s=320x180:r=30:d=240', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=240',
    '-c:v', 'libvpx', '-b:v', '50k', '-c:a', 'libopus', '-b:a', '64k', path.join(FX, 'long240.webm')]);
}

// ---------------------------------------------------------------------------- analysis
function framesOf(file, W = 96, H = 54) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-vf', `scale=${W}:${H}:flags=area,format=gray,showinfo`, '-fps_mode', 'passthrough', '-an', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const pts = [...r.stderr.toString().matchAll(/pts_time:\s*([-\d.]+)/g)].map((m) => parseFloat(m[1]));
  const out = [];
  for (let i = 0; i < Math.floor(r.stdout.length / (W * H)); i++) {
    const g = r.stdout.subarray(i * W * H, (i + 1) * W * H);
    let code = 0, valid = true, sum = 0;
    for (let k = 0; k < 12; k++) {
      const v = g[Math.floor(H / 4) * W + Math.floor(((k + 0.5) * W) / 12)];
      if (v > 100 && v < 150) valid = false;
      if (v >= 128) code |= 1 << k;
    }
    for (const v of g) sum += v;
    out.push({ t: pts[i], code, valid, mean: sum / g.length });
  }
  return out;
}
function pcm(file) { // timestamp-correct (pads the stream's start offset)
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-af', 'aresample=async=1:first_pts=0', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
}
function tone(x, f, win) {
  const N = Math.round(win * 48000), k = 2 * Math.cos((2 * Math.PI * f) / 48000), out = [];
  for (let i = 0; i + N <= x.length; i += N) {
    let s1 = 0, s2 = 0;
    for (let j = 0; j < N; j++) { const s = x[i + j] + k * s1 - s2; s2 = s1; s1 = s; }
    out.push((Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) * 2) / N);
  }
  return out;
}

// ---------------------------------------------------------------------------- browser
let server = null;
async function base() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/?$/, '/');
  const url = `http://127.0.0.1:${PORT}/`;
  try { if ((await fetch(url + 'js/app.js')).ok) return url; } catch (_) { /* start one */ }
  const bin = fs.existsSync('/opt/node22/bin/http-server') ? '/opt/node22/bin/http-server' : 'http-server';
  server = spawn(bin, [ROOT, '-p', String(PORT), '-a', '127.0.0.1', '-c-1', '-s'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + 'js/app.js')).ok) return url; } catch (_) { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('http-server did not start');
}

async function openApp(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.route('**/__fx/**', (route) => route.fulfill({ body: fs.readFileSync(path.join(FX, decodeURIComponent(route.request().url().split('/__fx/')[1]))) }));
  await page.goto(url + 'index.html');
  await page.waitForFunction(() => window.app && window.app.player && window.app.commands, null, { timeout: 20000 });
  await page.mouse.click(5, 5); // a real gesture so the AudioContext may run
  await page.evaluate(async () => {
    await app.audio.unlock();
    window.__build = async (spec, { decode = true } = {}) => {
      const model = await import('/js/model.js');
      const byName = new Map([...app.store.media.values()].map((m) => [m.name, m]));
      for (const it of spec.items) {
        if (!it.file || byName.has(it.file)) continue;
        const b = await (await fetch('/__fx/' + it.file)).blob();
        const m = await app.media.importFile(new File([b], it.file, { type: 'video/webm' }));
        app.store.addMedia(m); byName.set(it.file, m);
      }
      app.store.update((p) => {
        p.items = spec.items.map(({ file, kind, ...rest }) => model.createVisualItem(kind || 'video',
          { transition: { type: 'none', duration: 0 }, ...rest, mediaId: file ? byName.get(file).id : null }));
        p.texts = []; p.music = [];
      });
      if (decode) await app.audio.prepare(app.store.project, app.store);
      return app.store.timeline.segments.map((s) => [s.start, s.end]);
    };
    window.__export = async (presetId = 'wide480') => {
      const blob = await app.exporter.exportMovie({ presetId, fps: 30 });
      const fr = new FileReader();
      return new Promise((res) => { fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
    };
  });
  return { context, page };
}
async function exportFile(page, name, preset) {
  const b64 = await page.evaluate((p) => window.__export(p), preset);
  const file = path.join(FX, name + '.webm');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

// ---------------------------------------------------------------------------- cases
const CASES = {
  async 'silent-start'(page) {
    await page.evaluate(() => window.__build({ items: [{ file: 'long240.webm', trimEnd: 6 }] }, { decode: false }));
    const x = pcm(await exportFile(page, 'silent-start', 'email'));
    const lv = tone(x, 440, 0.25);
    const first = lv.findIndex((v) => v > 0.01) * 0.25;
    console.log(`  440 Hz level per 0.25 s: ${lv.slice(0, 8).map((v) => v.toFixed(3)).join(' ')} …`);
    return { bad: first > 0.1, msg: `sound starts at ${first.toFixed(2)} s (expected 0.00 s)` };
  },
  async 'slow-decode'(page) {
    await page.evaluate(() => {
      const A = app.audio, orig = A._decode.bind(A);
      A._decode = async (m) => { await new Promise((r) => setTimeout(r, 8000)); return orig(m); }; // a big phone video
    });
    await page.evaluate(() => window.__build({ items: [{ file: 'tone440.webm', trimEnd: 5 }] }, { decode: false }));
    const x = pcm(await exportFile(page, 'slow-decode', 'email'));
    const peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    return { bad: peak < 0.001, msg: `peak sample ${peak.toFixed(4)} over the whole movie (tone expected throughout); no warning state is emitted` };
  },
  async 'step-frame'(page) {
    await page.evaluate(() => window.__build({ items: [{ file: 'barA.webm', trimEnd: 4 }] }));
    const r = await page.evaluate(async () => {
      const P = app.player;
      const read = () => {
        const L = P._lay, g = P.canvas.getContext('2d'), fw = L.fw * L.s;
        const row = g.getImageData(Math.floor(L.ox), Math.floor(L.oy + (L.fh * L.s) / 4), Math.floor(fw), 1).data;
        let c = 0; for (let q = 0; q < 12; q++) if (row[Math.floor(((q + 0.5) * fw) / 12) * 4] >= 128) c |= 1 << q; return c;
      };
      await P.seek(1); const seq = [read()];
      for (let i = 0; i < 30; i++) { await P.stepFrame(1); seq.push(read()); }
      return seq;
    });
    const repeats = r.filter((c, i) => i && c === r[i - 1]).length;
    console.log(`  frames shown: ${r.join(' ')}`);
    return { bad: repeats > 0, msg: `${repeats}/30 next-frame presses left the picture unchanged (expected 0)` };
  },
  async 'in-point'(page) {
    const ins = [59 / 30, 62 / 30, 2.0];
    const items = [{ kind: 'title', duration: 1, background: '#000000', text: '' }];
    for (const s of ins) items.push({ file: 'barB.webm', trimStart: s, trimEnd: s + 1 }, { kind: 'title', duration: 0.5, background: '#000000', text: '' });
    const segs = await page.evaluate((sp) => window.__build(sp), { items });
    const d = framesOf(await exportFile(page, 'in-point'));
    let bad = 0; const lines = [];
    items.forEach((it, i) => {
      if (!it.file) return;
      const f = d.find((x) => x.t >= segs[i][0] - 0.001 && x.valid);
      const want = 2000 + Math.round(it.trimStart * 30);
      if (f.code < want) bad++;
      lines.push(`in-point ${it.trimStart.toFixed(5)}: first exported frame ${f.code} (in-point frame ${want})`);
    });
    console.log('  ' + lines.join('\n  '));
    return { bad: bad > 0, msg: `${bad}/${ins.length} clips start with a frame from before their in-point` };
  },
  async 'cut-hitch'(page) {
    const items = []; for (let i = 0; i < 10; i++) items.push({ file: 'barA.webm', trimStart: 1 + i, trimEnd: 2 + i });
    await page.evaluate((sp) => window.__build(sp), { items });
    const rows = framesOf(await exportFile(page, 'cut-hitch')).filter((f) => f.valid);
    let holds = 0, skips = 0;
    for (let i = 1; i < rows.length; i++) {
      const k = rows[i].code - rows[i - 1].code;
      if (Math.abs(rows[i].t - Math.round(rows[i].t)) < 0.12 && rows[i].t > 0.5 && rows[i].t < 9.9) { if (k === 0) holds++; if (k > 1) skips += k - 1; }
    }
    console.log('  around the 3 s split:', rows.filter((r) => Math.abs(r.t - 3) < 0.17).map((r) => `${r.t.toFixed(3)}:${r.code}`).join(' '), '(continuous: 30 + 30·t)');
    return { bad: holds + skips > 4, msg: `within ±120 ms of the 9 splits: ${holds} repeated frames, ${skips} skipped source frames (a continuous clip has ~0)` };
  },
  async judder(page) {
    await page.evaluate((sp) => window.__build(sp), { items: [{ file: 'barA.webm' }, { file: 'barA.webm' }, { file: 'barA.webm' }] });
    const rows = framesOf(await exportFile(page, 'judder')).filter((f) => f.valid);
    let dup = 0, skip = 0, maxSkip = 0, holds3 = 0, run = 1;
    for (let i = 1; i < rows.length; i++) {
      const k = rows[i].code - rows[i - 1].code;
      if (k < 0) { run = 1; continue; } // clip boundary (same file again)
      if (k === 0) { dup++; run++; if (run === 3) holds3++; } else run = 1;
      if (k > 1) { skip += k - 1; maxSkip = Math.max(maxSkip, k - 1); }
    }
    return { bad: dup + skip > rows.length * 0.04, msg: `${rows.length} frames of a 36 s single-source export: ${dup} repeated frames, ${skip} skipped source frames (largest jump ${maxSkip}), ${holds3} holds of ≥3 frames (a 30 fps source recorded at 30 fps should have ~0)` };
  },
  async 'short-clips'(page) {
    const items = []; for (let i = 0; i < 10; i++) items.push({ file: i % 2 ? 'barB.webm' : 'barA.webm', trimStart: 1 + i * 0.5, trimEnd: 1.2 + i * 0.5 });
    await page.evaluate((sp) => window.__build(sp), { items });
    const rows = framesOf(await exportFile(page, 'short-clips')).filter((f) => f.valid);
    const shown = new Set(rows.map((r) => r.code));
    let wanted = 0, got = 0;
    items.forEach((it, i) => { for (let k = 0; k < 6; k++) { wanted++; if (shown.has((i % 2 ? 2000 : 0) + Math.round(it.trimStart * 30) + k)) got++; } });
    return { bad: got / wanted < 0.9, msg: `${got}/${wanted} source frames of ten 0.2 s clips appear in the movie (${Math.round((100 * got) / wanted)} %)` };
  },
  async 'cut-click'(page) {
    await page.evaluate((sp) => window.__build(sp), { items: [{ file: 'tone440.webm', trimStart: 0, trimEnd: 1.513 }, { file: 'tone440.webm', trimStart: 4.207, trimEnd: 5.71 }] });
    const x = pcm(await exportFile(page, 'cut-click', 'email'));
    let steady = 0; for (let i = 24000; i < 67000; i++) steady = Math.max(steady, Math.abs(x[i] - x[i - 1]));
    let jump = 0, at = 0; for (let i = Math.floor(1.45 * 48000); i < 1.65 * 48000; i++) { const d = Math.abs(x[i] - x[i - 1]); if (d > jump) { jump = d; at = i / 48000; } }
    return { bad: jump > 3 * steady, msg: `largest sample step near the cut ${jump.toFixed(4)} at ${at.toFixed(3)} s vs ${steady.toFixed(4)} max elsewhere (${(jump / steady).toFixed(1)}×)` };
  },
  async 'rate-thrash'(page) {
    await page.evaluate((sp) => window.__build(sp), { items: [{ file: 'barA.webm', trimEnd: 8 }] });
    const r = await page.evaluate(async () => {
      let writes = 0; const lag = [];
      const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
      Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', { configurable: true, get() { return desc.get.call(this); }, set(v) { writes++; desc.set.call(this, v); } });
      const P = app.player;
      const on = (e) => { const v = [...P._videos.values()][0]; if (P.output !== P.canvas && v && e.detail.time > 2) lag.push(v.el.currentTime - e.detail.time); };
      P.addEventListener('timeupdate', on);
      await app.exporter.exportMovie({ presetId: 'wide480', fps: 30 });
      P.removeEventListener('timeupdate', on);
      lag.sort((a, b) => a - b);
      return { writes, lag: lag[lag.length >> 1] };
    });
    return { bad: r.writes > 60, msg: `${r.writes} playbackRate writes during an 8 s export; <video> median offset from the clock after 2 s: ${(r.lag * 1000).toFixed(0)} ms (repeat the case: ~2 runs in 3 show the thrash)` };
  },
  async 'media-retention'(page) {
    const r = await page.evaluate(async () => {
      const snap = () => { let b = 0; for (const e of app.audio._cache.values()) b += e.bytes || 0; return { media: app.store.media.size, items: app.store.project.items.length, audioMB: +(b / 1e6).toFixed(1) }; };
      const out = [];
      for (let c = 0; c < 3; c++) {
        const files = [];
        for (const n of ['barA.webm', 'barB.webm', 'tone440.webm']) files.push(new File([await (await fetch('/__fx/' + n)).blob()], n, { type: 'video/webm' }));
        await app.commands.run('addMedia', files);
        await app.audio.prepare(app.store.project, app.store);
        app.commands.run('selectAll'); app.commands.run('remove');
        await new Promise((res) => setTimeout(res, 300));
        out.push(snap());
      }
      return out;
    });
    console.log('  after each add→remove cycle:', JSON.stringify(r));
    const last = r[r.length - 1];
    return { bad: last.items === 0 && last.media > 0, msg: `0 items left, but ${last.media} Media records and ${last.audioMB} MB of decoded audio are still held` };
  },
};

// ---------------------------------------------------------------------------- main
const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = !want.length || want.includes('all') ? Object.keys(CASES) : want;
makeFixtures();
const url = await base();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let reproduced = 0;
try {
  for (const name of list) {
    if (!CASES[name]) { console.log(`unknown case ${name}`); continue; }
    const { context, page } = await openApp(browser, url);
    try {
      const r = await CASES[name](page);
      console.log(`${r.bad ? 'REPRODUCED' : 'not reproduced'} [${name}] ${r.msg}`);
      if (r.bad) reproduced++;
    } catch (err) {
      console.log(`ERROR [${name}] ${err.message.split('\n')[0]}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  if (server) server.kill();
  fs.rmSync(FX, { recursive: true, force: true });
}
process.exit(reproduced ? 1 : 0);
