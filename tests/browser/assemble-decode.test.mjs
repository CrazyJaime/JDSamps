// decodePlaced in real Chromium: captured parts are placed, decoded run by run and stitched. The fixtures come
// from tests/fixtures/make-fmp4.mjs: a 30 s chirp with clicks, Opus fMP4 at 48k (lo) and 128k (hi) in 4 s
// segments whose boundaries line up, the lo packets as one unfragmented file, and short WebM and MP3 files.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let server, browser, page; const errors = [];

// Page side: fetch fixture parts, place and decode them, and compare against reference decodes.
const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { placeParts, decodePlaced, AssemblyError } from '/engine/assemble.js';
import { webmItems } from '/engine/bmff.js';
const F = '/tests/fixtures/fmp4/', MP4 = 'audio/mp4; codecs="opus"', W = 'audio/webm; codecs="opus"';
const get = async (f) => (await fetch(F + f)).arrayBuffer();
const pad = (k) => String(k).padStart(5, '0');
const cat = (list) => { const o = new Uint8Array(list.reduce((n, b) => n + b.byteLength, 0)); let k = 0; for (const b of list) { o.set(new Uint8Array(b), k); k += b.byteLength; } return o.buffer; };
const shuffle = (a, seed = 11) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { seed = (seed * 1103515245 + 12345) % 2 ** 31; const j = seed % (i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const ctxAt = (sr) => new OfflineAudioContext(2, 1, sr);
const decode = async (buf, sr = 48000) => { const b = await ctxAt(sr).decodeAudioData(buf); return [b.getChannelData(0), b.getChannelData(1)]; };
async function parts(rep, ks, { sb = 0, seq = 0 } = {}) {
  const out = [{ bytes: await get(rep + '/init.mp4'), mime: MP4, kind: 'init', sb, seq: seq++ }];
  for (const k of ks) out.push({ bytes: await get(rep + '/seg-' + pad(k) + '.m4s'), mime: MP4, kind: 'media', sb, seq: seq++ });
  return out;
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
function diff(x, y, n = Math.min(x.length, y.length)) { let m = 0, at = -1; for (let i = 0; i < n; i++) { const d = Math.abs(x[i] - y[i]); if (d > m) { m = d; at = i; } } return { max: m, at }; }

// Normalised cross-correlation of out[t0, t0 + win) against ref over lags +-maxLag (s), by FFT.
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) for (let j = 0, cr = 1, ci = 0; j < len / 2; j++) {
      const p = i + j, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
      re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
      const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
    }
  }
}
function xcorr(out, ref, t0, win, maxLag, sr = 48000) {
  const w0 = Math.round(t0 * sr), wn = Math.round(win * sr), L = Math.round(maxLag * sr);
  const r0 = Math.max(0, w0 - L), r1 = Math.min(ref.length, w0 + wn + L), rn = r1 - r0;
  let n = 1; while (n < rn + wn) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  for (let i = 0; i < rn; i++) ar[i] = ref[r0 + i];
  for (let i = 0; i < wn; i++) br[i] = out[w0 + i];
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] + ai[i] * bi[i], im = ai[i] * br[i] - ar[i] * bi[i]; ar[i] = r; ai[i] = im; }
  fft(ar, ai, true);
  const pre = new Float64Array(rn + 1); for (let i = 0; i < rn; i++) pre[i + 1] = pre[i] + ref[r0 + i] ** 2;
  let ew = 0; for (let i = 0; i < wn; i++) ew += out[w0 + i] ** 2;
  const at = (lag) => { const s = w0 + lag - r0; if (s < 0 || s + wn > rn) return 0; return ar[s] / n / Math.sqrt(ew * (pre[s + wn] - pre[s]) + 1e-20); };
  let zero = at(0), far = 0, farLag = 0;
  for (let lag = -L; lag <= L; lag++) { if (Math.abs(lag) < 0.025 * sr) continue; const v = at(lag); if (v > far) { far = v; farLag = lag / sr; } }
  return { zero, far, farLag };
}

window.tests = {
  async shuffled() {
    const p = await parts('lo', shuffle(range(1, 8)));
    const placed = placeParts(shuffle(p, 5));
    const out = await decodePlaced(ctxAt(48000), placed, { duration: 30 });
    const [rL, rR] = await decode(await get('whole-lo.mp4'));
    return { runs: placed.runs.length, len: out.L.length, sr: out.sampleRate, refLen: rL.length, dL: diff(out.L, rL).max, dR: diff(out.R, rR).max };
  },
  async abr(down) {
    const [a, b] = down ? ['hi', 'lo'] : ['lo', 'hi'];
    const p = [...await parts(a, range(1, 4)), ...await parts(b, range(4, 8), { seq: 5 })];
    const placed = placeParts(shuffle(p, 9));
    const out = await decodePlaced(ctxAt(48000), placed, { duration: 30 });
    const ia = await get(a + '/init.mp4'), sa = [], sb = [];
    for (const k of range(1, down ? 4 : 3)) sa.push(await get(a + '/seg-' + pad(k) + '.m4s'));
    for (const k of range(down ? 5 : 4, 8)) sb.push(await get(b + '/seg-' + pad(k) + '.m4s'));
    const [X] = await decode(cat([ia, ...sa, ...sb]));                     // one decoder fed what a player would have been fed
    const [ref] = await decode(await get('whole-lo.mp4'));
    const sw = down ? 16 : 12;
    return { runs: placed.runs.map((r) => [r.segs[0].t0, r.segs.length]), len: out.L.length, vsPlayer: diff(out.L, X, 1440000),
      xc: [sw - 1, sw - 0.25, sw - 0.05].map((t) => xcorr(out.L, ref, t, 1.5, 4.5)) };
  },
  async near() {                                                            // the hi rendition stamped 5 samples late
    const late = (buf) => { const u = new Uint8Array(buf.slice(0)), dv = new DataView(u.buffer);
      for (let i = 0; i + 8 < u.length; i++) if (String.fromCharCode(...u.subarray(i, i + 4)) === 'tfdt') { dv.setUint32(i + 12, dv.getUint32(i + 12) + 5); break; }
      return u.buffer; };
    const hi = (await parts('hi', range(3, 8), { seq: 5 })).map((p) => p.kind === 'media' ? { ...p, bytes: late(p.bytes) } : p);
    const placed = placeParts([...await parts('lo', range(1, 4)), ...hi]);
    const out = await decodePlaced(ctxAt(48000), placed, { duration: 30 });
    const [ref] = await decode(await get('whole-lo.mp4'));
    return { runs: placed.runs.map((r) => [r.segs[0].t0, r.segs.length, r.preroll ? r.preroll.segs.length : 0]), len: out.L.length,
      xc: [11, 11.75].map((t) => xcorr(out.L, ref, t, 1.5, 4.5)) };
  },
  async gapped() {
    const placed = placeParts(await parts('lo', [1, 2, 3, 5, 6, 7, 8]));
    try { await decodePlaced(ctxAt(48000), placed, { duration: 30 }); return { threw: false }; }
    catch (e) { return { threw: true, isAE: e instanceof AssemblyError, name: e.name, gaps: e.gaps, message: e.message }; }
  },
  async webm() {
    const file = await get('track.webm'), u = new Uint8Array(file), items = webmItems(file);
    const init = items.find((i) => i.kind === 'init'), cl = items.filter((i) => i.kind === 'media');
    const p = [{ bytes: u.slice(init.start, init.end).buffer, mime: W, kind: 'init', sb: 0, seq: 0 },
      ...shuffle(cl).map((c, i) => ({ bytes: u.slice(c.start, c.end).buffer, mime: W, kind: 'media', sb: 0, seq: 1 + i }))];
    const out = await decodePlaced(ctxAt(48000), placeParts(p), { duration: 10 });
    const [rL] = await decode(file);
    return { len: out.L.length, refLen: rL.length, d: diff(out.L, rL).max };
  },
  async mp3() {
    const file = new Uint8Array(await get('track.mp3')), cuts = [0, 777, 15000, 15001, 30000, file.length];
    const p = cuts.slice(1).map((e, i) => ({ bytes: file.slice(cuts[i], e).buffer, mime: 'audio/mpeg', kind: 'media', sb: 0, seq: i }));
    const out = await decodePlaced(ctxAt(48000), placeParts(p), { duration: 10 });
    const [rL] = await decode(file.buffer);
    return { len: out.L.length, refLen: rL.length, d: diff(out.L, rL).max };
  },
  async resampled() {
    const p = [...await parts('lo', range(1, 4)), ...await parts('hi', range(4, 8), { seq: 5 })];
    const out = await decodePlaced(ctxAt(44100), placeParts(p), { duration: 30 });
    const [ref] = await decode(await get('whole-lo.mp4'), 44100);
    return { sr: out.sampleRate, len: out.L.length, xc: xcorr(out.L, ref, 11.5, 1, 0.5, 44100) };
  },
};
window.ready = true;
</script>`;

before(async () => {
  server = await startStaticServer(ROOT, { '/assemble.html': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); } });
  browser = await launchPlain();
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${server.origin}/assemble.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
});
after(async () => { await browser?.close(); await server?.close(); });

const run = (name, arg) => page.evaluate(([n, a]) => window.tests[n](a), [name, arg ?? null]);

test('every segment shuffled: the stitched track is sample-exact against the unfragmented file', async () => {
  const r = await run('shuffled');
  assert.equal(r.runs, 1);
  assert.equal(r.sr, 48000);
  assert.equal(r.len, 30 * 48000, 'cut to the duration (the codec pads its last frame)');
  assert.ok(r.refLen >= r.len, JSON.stringify(r));
  assert.equal(r.dL, 0, JSON.stringify(r));
  assert.equal(r.dR, 0, JSON.stringify(r));
});

for (const down of [false, true]) {
  test(`an ABR switch ${down ? 'down' : 'up'}: duration within one frame, no doubled or missing audio, and exactly what a player decodes`, async () => {
    const r = await run('abr', down);
    assert.deepEqual(r.runs, down ? [[0, 4], [16, 4]] : [[0, 3], [12, 5]]);
    assert.ok(Math.abs(r.len - 30 * 48000) <= 960, `length ${r.len}`);
    assert.equal(r.vsPlayer.max, 0, `stitched audio differs from one continuous decode at sample ${r.vsPlayer.at}`);
    for (const x of r.xc) {
      assert.ok(x.zero > 0.99, `correlation at lag 0: ${x.zero}`);
      assert.ok(x.far < 0.3, `a second peak at ${x.farLag} s: ${x.far}`);
    }
  });
}

test('renditions stamped a few samples apart still join, warmed on the new rendition\'s own segment', async () => {
  const r = await run('near');
  assert.deepEqual(r.runs, [[0, 3, 0], [12 + 5 / 48000, 5, 1]]);
  assert.ok(Math.abs(r.len - 30 * 48000) <= 960, `length ${r.len}`);
  for (const x of r.xc) assert.ok(x.zero > 0.9 && x.far < 0.3, JSON.stringify(x));
});

test('a gapped set throws AssemblyError naming the gap', async () => {
  const r = await run('gapped');
  assert.equal(r.threw, true);
  assert.equal(r.isAE, true);
  assert.equal(r.name, 'AssemblyError');
  assert.deepEqual(r.gaps, [[12, 16]]);
  assert.match(r.message, /12\.0.*16\.0/);
});

test('WebM clusters in any order decode sample-exact against the whole file', async () => {
  const r = await run('webm');
  assert.equal(r.len, 10 * 48000);
  assert.equal(r.d, 0, JSON.stringify(r));
});

test('MP3 appends split anywhere decode the same as the whole file', async () => {
  const r = await run('mp3');
  assert.ok(Math.abs(r.len - 10 * 48000) <= 1152, JSON.stringify(r));
  assert.equal(r.d, 0, JSON.stringify(r));
});

test('a context at 44.1 kHz gets the stitched track resampled once, still aligned', async () => {
  const r = await run('resampled');
  assert.equal(r.sr, 44100);
  assert.ok(Math.abs(r.len - 30 * 44100) <= 882, `length ${r.len}`);
  assert.ok(r.xc.zero > 0.99 && r.xc.far < 0.3, JSON.stringify(r.xc));
});

test('no page errors', () => { assert.deepEqual(errors, []); });
