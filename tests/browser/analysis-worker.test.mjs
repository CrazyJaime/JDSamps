// Whole-track analysis in a real Worker (engine/analysis.js analyseTrack), against the inline path.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// A 3-minute track: a 16-bar synth loop tiled (as tests/unit/analysis.test.mjs builds them).
const PAGE = `<!doctype html><meta charset="utf-8"><title>analysis</title>
<script type="module">
import { analyseTrack, analyseTrackSync } from '/engine/analysis.js';
import { synth, PATTERNS, FS } from '/tests/unit/fixtures/synth.mjs';
const one = synth({ ...PATTERNS.house, bpm: 124, bars: 16, tail: 0 });
const L = new Float32Array(180 * FS);
for (let at = 0; at < L.length; at += one.x.length) L.set(one.x.subarray(0, Math.min(one.x.length, L.length - at)), at);
const pcm = { L, R: L.slice(), sampleRate: FS };
// The longest the main thread went without running a 4 ms timer while fn ran.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function held(fn) {
  let last = performance.now(), gap = 0, on = true;
  const tick = () => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; if (on) setTimeout(tick, 4); };
  setTimeout(tick, 4);
  const r = await fn();
  await sleep(50);
  on = false;
  return { r, longest: gap };
}
window.worker = async () => {
  const t0 = performance.now();
  const { r: a, longest } = await held(async () => { const a = await analyseTrack(pcm, { lo: 70, hi: 180 }); window.ms = performance.now() - t0; return a; });
  return { ms: window.ms, longest, bpm: a.bpm, segments: a.segments.length, conf: a.conf, wave: a.wave.data.length,
    waveIsBytes: a.wave.data instanceof Uint8Array, pcmKept: pcm.L.length === 180 * FS && pcm.R.length === 180 * FS };
};
window.inline = async () => {
  const { r: a, longest } = await held(() => analyseTrackSync(pcm, { lo: 70, hi: 180 }));
  return { bpm: a.bpm, segments: a.segments.length, conf: a.conf, wave: a.wave.data.length, longest };
};
window.cancel = async () => {
  const c = new AbortController();
  const p = analyseTrack(pcm, { signal: c.signal });
  c.abort();
  try { await p; return 'resolved'; } catch (e) { return e.message; }
};
window.ready = true;
</script>`;

test('analyseTrack runs in a Worker: same result as the inline path, under 3 s for 3 minutes, PCM kept, no Worker left', async (t) => {
  const server = await startStaticServer(ROOT, { '/analysis.html': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); } });
  const browser = await launchPlain();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${server.origin}/analysis.html`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
    const w = await page.evaluate(() => window.worker());
    const s = await page.evaluate(() => window.inline());
    t.diagnostic(`worker ${w.ms.toFixed(0)} ms, longest main-thread task ${w.longest.toFixed(0)} ms (inline: ${s.longest.toFixed(0)} ms)`);
    assert.ok(Math.abs(w.bpm - 124) / 124 < 1e-4, `bpm ${w.bpm}`);
    assert.ok(Math.abs(w.bpm - s.bpm) < 1e-6, `worker ${w.bpm} vs inline ${s.bpm}`);
    assert.equal(w.segments, s.segments);
    assert.equal(w.conf, s.conf);
    assert.equal(w.wave, s.wave);
    assert.ok(w.waveIsBytes, 'waveform bytes');
    assert.ok(w.pcmKept, 'the PCM was handed away, not kept');
    assert.ok(w.ms < 3000, `${w.ms.toFixed(0)} ms`);
    assert.ok(s.longest > 200, `the main-thread probe saw ${s.longest.toFixed(0)} ms for the inline analysis`);
    assert.ok(w.longest < 200, `the main thread was held for ${w.longest.toFixed(0)} ms`);
    assert.equal(page.workers().length, 0, 'the Worker was not terminated');
    assert.match(await page.evaluate(() => window.cancel()), /cancelled/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(page.workers().length, 0, 'a cancelled analysis left its Worker running');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
