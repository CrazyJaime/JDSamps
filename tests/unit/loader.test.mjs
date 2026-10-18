// engine/loader.js against a fake tab (tests/unit/fixtures/loader-harness.mjs): which rungs of the
// ladder a page gets, every refusal, monotonic progress, the promotion and the release of the tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SITES, firstRung, parseHls } from '../../engine/loader.js';
import { defaults, MASTER_PARAMS, PERSISTED_MASTER_KEYS, validateUiMessage } from '../../shared/protocol.js';
import { load, rendition, file, code, DUR, SR, OPUS } from './fixtures/loader-harness.mjs';

const hi = () => rendition('opus-hi');
const called = (engine, fn) => engine.calls.filter((c) => c.fn === fn);
const near = (a, b, e) => Math.abs(a - b) <= e;
/** The commands the loader sent, in order, without the closing ones (drive stop, tap off). */
const asked = (tab) => tab.kinds().filter((k) => k !== 'drive stop' && k !== 'tap off');
const LIVE_ONLY = ['tap on'];

test('loading a tab tries for the whole track unless the persisted setting resident.auto says live', () => {
  assert.equal(defaults(MASTER_PARAMS)['resident.auto'], true);
  assert.ok(PERSISTED_MASTER_KEYS.includes('resident.auto'));
  assert.deepEqual(validateUiMessage({ t: 'set', deck: null, key: 'resident.auto', value: false }), { ok: true, value: false });
  assert.equal(validateUiMessage({ t: 'set', deck: null, key: 'resident.auto', value: 'no' }).ok, false);
});

// ---------------------------------------------------------------- the site table
test('the site table names the first rung by host suffix; any other host takes the generic order from the file rung', () => {
  assert.ok(Object.isFrozen(SITES));
  assert.equal(firstRung('https://artist.bandcamp.com/track/x'), 'file');
  assert.equal(firstRung('https://www.mixcloud.com/someone/mix/'), 'refetch');
  assert.equal(firstRung('https://soundcloud.com/a/b'), 'refetch');
  assert.equal(firstRung('https://www.youtube.com/watch?v=x'), 'drive');
  assert.equal(firstRung('https://music.youtube.com/watch?v=x'), 'drive');
  assert.equal(firstRung('https://notyoutube.com/x'), 'file', 'a suffix match ends at a dot');
  assert.equal(firstRung('https://example.com/a.mp3'), 'file');
  assert.equal(firstRung('not a url'), 'file');
});

test('an HLS playlist is read: a master names its variants, a media playlist its init and timed segments', () => {
  const master = parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=12000,CODECS="opus"\nlo.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=24000\nhi.m3u8\n', 'https://c.example/m/x.m3u8');
  assert.deepEqual(master.variants, [{ bw: 12000, url: 'https://c.example/m/lo.m3u8' }, { bw: 24000, url: 'https://c.example/m/hi.m3u8' }]);
  const media = parseHls('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\ns0.m4s\n#EXTINF:4.0,\ns1.m4s\n#EXTINF:0.5,\nhttps://o.example/s2.m4s\n#EXT-X-ENDLIST\n', 'https://c.example/m/hi.m3u8');
  assert.equal(media.init, 'https://c.example/m/init.mp4');
  assert.deepEqual(media.segs.map((s) => [s.url.split('/').pop(), s.t0, s.t1]), [['s0.m4s', 0, 4], ['s1.m4s', 4, 8], ['s2.m4s', 8, 8.5]]);
  assert.equal(parseHls('<MPD/>', 'https://c.example/x.mpd'), null);
  assert.equal(parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\ns0.ts\n', 'https://c.example/x.m3u8'), null, 'encrypted segments cannot be decoded');
});

// ---------------------------------------------------------------- the ladder
test('a Bandcamp-like page loads from its own track link: readTralbum, and nothing else', async () => {
  const link = 'https://site.example/stream/track.mp3';
  const { result, tab, engine, deck } = await load({ kind: 'progressive', src: link, tralbum: { url: link, duration: 120 }, files: { [link]: file('bandcamp', 120) } });
  assert.deepEqual(result, { ok: true, kind: 'resident', deckId: 1, slot: 1 });
  assert.deepEqual(asked(tab), ['tap on', 'readTralbum']);
  const [r] = called(engine, 'startResidentDeck');
  assert.equal(r.deckId, deck.id, 'the loading deck is promoted, not a new one made');
  assert.equal(r.frames, 120 * SR);
  assert.equal(r.code, code('bandcamp'));
  assert.equal(r.analysis, true, 'analysed before the promotion');
  assert.equal(deck.kind, 'resident');
});

test('a progressive page re-fetches its player\'s media link from the page, checked against the player\'s length', async () => {
  const link = 'https://site.example/media/track.webm';
  const { result, tab, engine } = await load({ kind: 'progressive', src: link, files: { [link]: file('ratefight', 120.0065) } });
  assert.equal(result.kind, 'resident');
  assert.deepEqual(asked(tab), ['tap on', 'readTralbum', 'fetch']);
  assert.deepEqual(tab.sent().find((m) => m.t === 'fetch').urls, [link]);
  assert.equal(called(engine, 'startResidentDeck')[0].code, code('ratefight'));
  assert.ok(!tab.kinds().includes('drive seekhop') && !tab.kinds().includes('drive accelerate'), 'never driven');
});

test('a media link the page cannot fetch (no CORS) is fetched by the engine itself', async () => {
  const link = 'https://cdn.example/track.mp3';
  const { result, engine } = await load({ kind: 'progressive', src: link, pageFetch: false, files: { [link]: file('cdn', 120) } });
  assert.equal(result.kind, 'resident');
  assert.equal(called(engine, 'startResidentDeck')[0].code, code('cdn'));
});

test('a media link whose length is not the player\'s is not taken: the deck goes live and says why', async () => {
  const link = 'https://site.example/jingle.mp3';
  const { result, engine, tab } = await load({ kind: 'progressive', src: link, files: { [link]: file('jingle', 30) } });
  assert.equal(result.kind, 'live');
  assert.deepEqual(called(engine, 'startResidentDeck'), []);
  const [f] = called(engine, 'failLoadingToLive');
  assert.match(f.reason, /30\.0 s/);
  assert.match(f.reason, /plays live from the tab/);
  assert.ok(!tab.kinds().some((k) => /drive (seekhop|accelerate)/.test(k)), 'a progressive player is not driven: it appends nothing');
});

test('an MSE page whose links can be fetched again: the playlist is read and only the missing pieces are fetched', async () => {
  const r = hi();
  const { result, tab, engine } = await load({ kind: 'mse', rendition: r, preTap: 6, playing: 3, list: true, segUrls: true });
  assert.equal(result.kind, 'resident', JSON.stringify(engine.calls));
  assert.deepEqual(asked(tab), ['tap on', 'readTralbum', 'fetch', 'fetch']);
  const [list, pieces] = tab.sent().filter((m) => m.t === 'fetch');
  assert.deepEqual(list.urls, [r.list]);
  const names = pieces.urls.map((u) => u.split('/').pop());
  assert.equal(names[0], 'init.mp4', 'the init first, so the pieces place on their own');
  for (const k of [6, 7, 8]) assert.ok(!names.includes(`seg-00${k}.m4s`), `seg ${k} was captured: not fetched again`);
  assert.equal(names.length, 1 + 31 - 3);
  const [s] = called(engine, 'startResidentDeck');
  assert.ok(near(s.frames / SR, 120, 0.02), `${s.frames / SR} s`);
  assert.ok(!tab.kinds().some((k) => /drive (seekhop|accelerate)/.test(k)));
});

test('an MSE page with nothing to fetch again is driven: seek-hop, then drive stop', async () => {
  const { result, tab, engine } = await load({ kind: 'mse', rendition: hi(), preTap: 0, playing: 2 });
  assert.equal(result.kind, 'resident', JSON.stringify(engine.calls));
  assert.deepEqual(tab.kinds(), ['tap on', 'readTralbum', 'drive seekhop', 'drive stop', 'tap off']);
  assert.ok(near(called(engine, 'startResidentDeck')[0].frames / SR, 120, 0.02));
});

test('a seek-hop that stalls goes on to accelerate, with the pitch unlocked through the drive', async () => {
  const { result, tab } = await load({ kind: 'mse', rendition: hi(), preTap: 0, playing: 2, seekhop: 'stall' });
  assert.equal(result.kind, 'resident');
  assert.deepEqual(asked(tab), ['tap on', 'readTralbum', 'drive seekhop', 'drive accelerate']);
  const acc = tab.sent().find((m) => m.t === 'drive' && m.mode === 'accelerate');
  assert.ok(acc.rate > 1 && acc.rate <= 16);
  assert.equal(tab.kinds().filter((k) => k === 'drive stop').length, 1);
});

test('a site-table host starts at its rung: a YouTube page is driven without asking for a track link or re-fetching', async () => {
  const { result, tab, loader } = await load({ url: 'https://www.youtube.com/watch?v=x', kind: 'mse', rendition: hi(), preTap: 0, playing: 1, list: true, segUrls: true });
  assert.equal(result.kind, 'resident');
  assert.deepEqual(asked(tab), ['tap on', 'drive seekhop']);
  assert.ok(loader.rep.steps.some((s) => s.name === 'file' && s.outcome === 'skipped'));
});

test('when the player had loaded the start before the tap and nothing can be fetched again, the track is never declared complete', async () => {
  const { result, engine, tab } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1 });
  assert.equal(result.kind, 'live');
  assert.deepEqual(called(engine, 'startResidentDeck'), []);
  assert.match(called(engine, 'failLoadingToLive')[0].reason, /0\.0–24\.0 s/);
  assert.ok(tab.kinds().includes('drive stop'), 'the drive is always stopped');
});

// ---------------------------------------------------------------- straight to live
for (const [reason, re] of [['drm', /protected/], ['worker', /worker/], ['preview', /SoundCloud only gives a 30-second preview of this track\./]]) {
  test(`${reason}: live at once, with its one message, and no slow rung tried`, async () => {
    const { result, engine, tab } = await load({ kind: 'mse', rendition: hi(), preTap: 6, list: true, segUrls: true, errors: [reason] });
    assert.equal(result.kind, 'live');
    assert.deepEqual(asked(tab), LIVE_ONLY);
    const f = called(engine, 'failLoadingToLive');
    assert.equal(f.length, 1);
    assert.match(f[0].reason, re);
    assert.match(f[0].reason, /live/);
    assert.equal(engine.events.filter((e) => /^Deck 1: /.test(e.text)).length, 1, 'said once');
  });
}

test('a stream with no end goes live without trying the slower rungs', async () => {
  const { result, engine, tab } = await load({ kind: 'mse', rendition: hi(), preTap: 6, list: true, segUrls: true, duration: Infinity, liveAfter: 60 });
  assert.equal(result.kind, 'live');
  assert.deepEqual(asked(tab), LIVE_ONLY);
  assert.match(called(engine, 'failLoadingToLive')[0].reason, /live stream/);
});

test('a player that never says how long its track is goes live, saying so, with no link fetched', async () => {
  const link = 'https://site.example/stream.mp3';
  const { result, engine, tab } = await load({ kind: 'progressive', src: link, duration: null, files: { [link]: file('x', 60) } });
  assert.equal(result.kind, 'live');
  assert.match(called(engine, 'failLoadingToLive')[0].reason, /does not say how long the track is/);
  assert.ok(!tab.kinds().includes('fetch'));
});

test('a page with no player the tap can see (Web Audio only) goes live: no agent ever connects', async () => {
  const t0 = performance.now();
  const { result, engine, tab } = await load({ kind: 'none' });
  assert.equal(result.kind, 'live');
  assert.deepEqual(tab.log, []);
  assert.match(called(engine, 'failLoadingToLive')[0].reason, /without a media player the deck can read/);
  assert.ok(performance.now() - t0 < 1000);
});

test('a page whose only element the deck could read is silent goes live like a Web-Audio page', async () => {
  const { result, engine } = await load({ kind: 'progressive' });
  assert.equal(result.kind, 'live');
  assert.match(called(engine, 'failLoadingToLive')[0].reason, /without a media player the deck can read/);
});

test('every rung failing ends live, naming the first failure', async () => {
  const link = 'https://site.example/missing.mp3';
  const { result, engine } = await load({ kind: 'progressive', src: link, pageFetch: false, extensionFetch: false });
  assert.equal(result.kind, 'live');
  assert.match(called(engine, 'failLoadingToLive')[0].reason, /could not be fetched/);
});

// ---------------------------------------------------------------- progress and release
test('progress only goes up, and says in plain words what the loader is doing', async () => {
  const { deck } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 2, list: true, segUrls: true });
  const ps = deck.loads.map((l) => l.progress);
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i] >= ps[i - 1], `progress went back: ${ps.join(' ')}`);
  const said = [...new Set(deck.loads.map((l) => l.strategy).filter(Boolean))];
  assert.ok(said.includes("fetching the track's pieces"), said.join(' | '));
  assert.ok(said.includes('finding the beat'), said.join(' | '));
  for (const s of said) assert.match(s, /^[a-z][a-z' ()×0-9]+$/, `not plain words: ${s}`);
  assert.equal(deck.load.progress, 1);
});

test('a resident load releases the tab: STOP_TAB, the capture stopped, the agents tapped off and let go, then the tab forgotten', async () => {
  const link = 'https://site.example/media/track.mp3';
  const { tab, engine, deck } = await load({ kind: 'progressive', src: link, files: { [link]: file('a', 120) } });
  const stop = engine.order.indexOf('STOP_TAB'), changed = engine.order.lastIndexOf('DECKS_CHANGED');
  assert.ok(stop >= 0 && changed > stop, engine.order.join());
  assert.equal(engine.hubLog[stop].tabId, 7, 'STOP_TAB for the source tab');
  assert.deepEqual(engine.hubLog[changed].decks, [], 'the hub forgets the tab');
  assert.equal(deck.tracks[0].stopped, true, 'the held capture is stopped');
  assert.equal(deck.stream, null);
  assert.equal(deck.tabId, null);
  assert.equal(deck.agents.size, 0);
  assert.equal(tab.frames[0].disconnected, true);
  assert.deepEqual(tab.sent().at(-1), { t: 'tap', on: false, forget: true });
});

test('a load that ends live keeps the tab and its agents for the live deck, with the tap off', async () => {
  const { tab, deck } = await load({ kind: 'mse', rendition: hi(), errors: ['drm'] });
  assert.equal(deck.tabId, 7);
  assert.equal(deck.agents.size, 1);
  assert.equal(deck.tracks[0].stopped, false);
  assert.deepEqual(tab.sent().slice(-2), [{ t: 'drive', mode: 'stop' }, { t: 'tap', on: false, forget: true }]);
});

test('MSE that carries no timestamps (MP3) is never seek-hopped: the player is run fast instead', async () => {
  const fs = await import('node:fs');
  const mp3 = fs.readFileSync(new URL('../fixtures/sites/track.mp3', import.meta.url));
  const appends = [];
  for (let k = 0; k < mp3.length; k += 65536) { const b = mp3.subarray(k, k + 65536); appends.push({ bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), mime: 'audio/mpeg' }); }
  const { result, tab } = await load({ kind: 'mse', mimes: ['audio/mpeg'], appends, preTap: 0, duration: 120 });
  assert.equal(result.kind, 'resident', JSON.stringify(result));
  assert.deepEqual(asked(tab), ['tap on', 'readTralbum', 'drive accelerate']);
});

test('the opus pieces this harness serves are what the model sites serve', () => {
  const r = hi();
  assert.equal(r.mime, OPUS);
  assert.equal(r.segs.length, 31);
  assert.ok(near(DUR, 120.0065, 1e-9));
});
