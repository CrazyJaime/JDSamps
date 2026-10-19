// engine/decode.js fetchArrayBuffer against a local server: a fetch of a link (pasted, or the loader's own fallback)
// has a stall deadline and a byte cap, refuses a stream with no end and a web page, and returns a whole file whole.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchArrayBuffer, FetchRefused, FETCH_CAP, FETCH_STALL } from '../../engine/decode.js';

let server, origin, served = 0;
const KB = 1024, chunk = Buffer.alloc(64 * KB, 7);
const routes = {
  // A file with its length.
  '/file.mp3': (req, res) => { const b = Buffer.alloc(300 * KB, 3); res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': b.length }); res.end(b); },
  // A file sent without a length (chunked), well within the cap.
  '/chunked.mp3': (req, res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.write(chunk); res.end(chunk); },
  // Headers, then nothing ever again.
  '/stall': (req, res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.flushHeaders(); },
  // Never even answers.
  '/silent': () => {},
  // A body that keeps coming slowly: never stalls for long, ends after a second.
  '/trickle': (req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    let n = 0;
    const t = setInterval(() => { res.write(Buffer.alloc(KB, 1)); if (++n === 50) { clearInterval(t); res.end(); } }, 20);
    req.on('close', () => clearInterval(t));
  },
  // An internet radio station: no length, bytes forever.
  '/radio': (req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    let open = true;
    req.on('close', () => { open = false; });
    const pump = () => { while (open && res.write(chunk)) served += chunk.length; if (open) res.once('drain', pump); };
    pump();
  },
  // The same station as Icecast announces it.
  '/icy': (req, res) => { res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-name': 'Radio', 'icy-metaint': '16000' }); res.write(chunk); },
  // A radio playlist (.pls).
  '/radio.pls': (req, res) => { res.writeHead(200, { 'content-type': 'audio/x-scpls' }); res.end('[playlist]\nFile1=http://radio.example/stream\n'); },
  // A file that says it is larger than the cap.
  '/huge.wav': (req, res) => { res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(4 * 2 ** 30) }); res.write(chunk); },
  // A web page (a track's page on a site, pasted instead of its audio).
  '/track-page': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>A track</title>'); },
  '/missing.mp3': (req, res) => { res.writeHead(404); res.end(); },
};

before(async () => {
  server = http.createServer((req, res) => (routes[new URL(req.url, 'http://x').pathname] || routes['/missing.mp3'])(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

const refused = async (p, kind, re) => {
  try { await p; } catch (err) {
    assert.ok(err instanceof FetchRefused, `${err && err.name}: ${err && err.message}`);
    assert.equal(err.kind, kind, err.message);
    assert.match(err.message, re);
    return err;
  }
  assert.fail('the fetch was not refused');
};

test('the defaults: a stall of 15 s, a cap of 600 MB', () => {
  assert.equal(FETCH_STALL, 15000);
  assert.equal(FETCH_CAP, 600 * 2 ** 20);
});

test('a whole file comes back whole, with or without its length', async () => {
  assert.equal((await fetchArrayBuffer(`${origin}/file.mp3`)).byteLength, 300 * KB);
  const b = new Uint8Array(await fetchArrayBuffer(`${origin}/chunked.mp3`));
  assert.equal(b.length, 128 * KB);
  assert.ok(b.every((x) => x === 7));
  await assert.rejects(fetchArrayBuffer(`${origin}/missing.mp3`), /it answered 404/);
});

test('a link that stops sending (or never answers) is given up after the stall, saying so', async () => {
  for (const path of ['/stall', '/silent']) {
    const t0 = performance.now();
    await refused(fetchArrayBuffer(`${origin}${path}`, { stall: 300 }), 'stall', /^nothing came from the link for 0\.3 s$/);
    assert.ok(performance.now() - t0 < 3000, path);
  }
  // A slow body that keeps coming is not a stall.
  assert.equal((await fetchArrayBuffer(`${origin}/trickle`, { stall: 2000 })).byteLength, 50 * KB);
});

test('a body with no length that passes the cap is a stream with no end: refused, and no more of it is read', async () => {
  served = 0;
  await refused(fetchArrayBuffer(`${origin}/radio`, { cap: 2 * 2 ** 20 }), 'stream', /^this link is a stream with no end, so there is no whole track to load$/);
  const at = served;
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(served - at <= 4 * 2 ** 20, `the server went on sending: ${served - at} bytes after the refusal`);
});

test('an Icecast station or a radio playlist is a stream with no end, said before its body is read', async () => {
  await refused(fetchArrayBuffer(`${origin}/icy`), 'stream', /stream with no end/);
  await refused(fetchArrayBuffer(`${origin}/radio.pls`), 'stream', /stream with no end/);
});

test('a link larger than the cap is refused from its length, before its body is read', async () => {
  await refused(fetchArrayBuffer(`${origin}/huge.wav`), 'big', /^it holds 4096\.0 MB, more than the 600 MB a deck takes$/);
  await refused(fetchArrayBuffer(`${origin}/file.mp3`, { cap: 100 * KB }), 'big', /more than the 0\.1 MB a deck takes/);
});

test('a budget shared by several fetches is a cap on them all', async () => {
  const budget = { left: 400 * KB };
  assert.equal((await fetchArrayBuffer(`${origin}/file.mp3`, { budget })).byteLength, 300 * KB);
  assert.equal(budget.left, 100 * KB);
  await refused(fetchArrayBuffer(`${origin}/file.mp3`, { budget }), 'big', /more than the 0\.1 MB a deck takes/);
  // Two at once, sharing it: what they keep together never passes it.
  const shared = { left: 400 * KB }, rs = await Promise.allSettled([1, 2].map(() => fetchArrayBuffer(`${origin}/file.mp3`, { budget: shared })));
  const kept = rs.filter((r) => r.status === 'fulfilled');
  assert.equal(kept.length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.ok(rs.find((r) => r.status === 'rejected').reason instanceof FetchRefused);
  assert.equal(shared.left, 100 * KB);
});

test('a web page is refused as one: open it in a tab', async () => {
  await refused(fetchArrayBuffer(`${origin}/track-page`), 'page', /^That link is a web page, not an audio file: open it in a tab and add the tab to a deck\.$/);
});
