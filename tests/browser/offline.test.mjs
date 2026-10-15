import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';
import { PATCHES } from '../../vendor/signalsmith-stretch/patch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let server, browser, page; const errors = [];

// The vendored stretcher without its process-cost patch (every other patch kept), for the equivalence check.
const STRETCH = path.join(ROOT, 'vendor/signalsmith-stretch/SignalsmithStretch.js');
const withoutCostPatch = () => PATCHES.filter((p) => p.id === 'process-cost')
  .reduceRight((s, p) => s.replace(p.new, () => p.old), fs.readFileSync(STRETCH, 'utf8'));

before(async () => {
  server = await startStaticServer(ROOT, {
    '/stretch-without-cost-patch.js': (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(withoutCostPatch()); },
  });
  browser = await launchPlain();
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${server.origin}/tests/browser/pages/offline.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
});
after(async () => { await browser?.close(); await server?.close(); });

const run = (name, arg) => page.evaluate(([n, a]) => window.tests[n](a), [name, arg ?? null]);

test('isolator bands sum flat at unity', async () => {
  const r = await run('eqFlat');
  assert.ok(Math.abs(r.db) < 0.2, JSON.stringify(r));
});

for (const [band, freq] of [['low', 60], ['mid', 1000], ['hi', 8000]]) {
  test(`${band} kill removes ${freq} Hz by at least 30 dB`, async () => {
    const r = await run('eqKill', { band, freq });
    assert.ok(r.db <= -30, JSON.stringify(r));
  });
}

test('mid knob fully right boosts 1 kHz by about 6 dB', async () => {
  const r = await run('eqBoost');
  assert.ok(Math.abs(r.db - 6) < 0.6, JSON.stringify(r));
});

test('trim knob law', async () => {
  assert.ok(Math.abs((await run('trim', { k: 1 })).db - 12) < 0.2);
  assert.ok(Math.abs((await run('trim', { k: 0.5 })).db) < 0.05);
});

test('DJ filter: centre transparent, extremes cut', async () => {
  assert.ok(Math.abs((await run('filter', { x: 0, freq: 1000 })).db) < 0.1);
  assert.ok((await run('filter', { x: -1, freq: 2000 })).db <= -30);
  assert.ok((await run('filter', { x: 1, freq: 200 })).db <= -30);
});

test('echo repeats one beat-fraction later', async () => {
  const r = await run('echo');
  assert.ok(Math.abs(r.at - 0.35) < 0.003, JSON.stringify(r));
  assert.ok(r.best > 0.05);
});

test('gate opens and closes on the beat grid, following its 16-step pattern', async () => {
  const r = await run('gate');
  assert.ok(r.open > 0.3 && r.open2 > 0.3, JSON.stringify(r));
  assert.ok(r.closed < 0.01, JSON.stringify(r));
  assert.ok(r.rest < 0.01, JSON.stringify(r));
});

test('crush reduces bit depth', async () => {
  const r = await run('crush');
  assert.ok(r.distinct < 64, JSON.stringify(r));
});

test('flanger colours the signal', async () => {
  const r = await run('flanger');
  assert.ok(r.corr < 0.95, JSON.stringify(r));
});

test('flanger sweep spans its period in beats and starts on a beat of the deck clock', async () => {
  const anchor = 0.13, beat = 0.5, beats = 0.25, sweep = 2 * beat; // FX length 1/4 → a 2-beat sweep
  const r = await run('flangerSweep', { anchor, beats });
  const info = JSON.stringify(r);
  assert.ok(r.minMs > 0.5 && r.minMs < 1.5 && r.maxMs > 4.5 && r.maxMs < 5.5, info);
  assert.ok(r.bottoms.length >= 2, info);
  for (let j = 1; j < r.bottoms.length; j++) assert.ok(Math.abs(r.bottoms[j] - r.bottoms[j - 1] - sweep) < 0.003, `period: ${info}`);
  for (const b of r.bottoms) {
    const off = (b - anchor) / beat;
    assert.ok(Math.abs(off - Math.round(off)) * beat < 0.003, `sweep start ${b.toFixed(4)} s is not on a beat: ${info}`);
  }
});

test('reverb leaves a tail', async () => {
  const r = await run('reverb');
  assert.ok(r.tail > 1e-4, JSON.stringify(r));
});

test('rack with FX off is sample-transparent', async () => {
  const r = await run('fxOffIsTransparent');
  assert.ok(r.maxDiff < 1e-6, JSON.stringify(r));
});

test('limiter holds -1 dBFS on a +6 dB signal and reports gain reduction', async () => {
  const r = await run('limiter', { amp: 2, on: true });
  assert.ok(r.peak <= 10 ** (-1 / 20) + 1e-4, JSON.stringify({ peak: r.peak }));
  assert.ok(r.minGr < -5, JSON.stringify({ gr: r.minGr }));
  assert.ok(r.ticks > 20, `ticks ${r.ticks}`);
});

test('limiter is transparent below the ceiling', async () => {
  const r = await run('limiter', { amp: 0.5, on: true });
  assert.ok(Math.abs(20 * Math.log10(r.outRms / r.inRms)) < 0.05, JSON.stringify(r));
});

test('crossfader at B silences an A-assigned deck', async () => {
  const r = await run('xfader');
  assert.ok(r.rms < 1e-4, JSON.stringify(r));
});

test('stretcher: the process-cost patch renders bit-identical audio (trimmed start, jump, loop, a trim while playing)', async () => {
  const r = await run('stretchEquivalence', { files: ['/stretch-without-cost-patch.js', '/vendor/signalsmith-stretch/SignalsmithStretch.js'] });
  assert.ok(r.energy > 1000, JSON.stringify(r));
  assert.equal(r.differing, 0, JSON.stringify(r));
});

test('no page errors', () => { assert.deepEqual(errors, []); });
