// engine/loader.js against a fake tab (tests/unit/fixtures/loader-harness.mjs): which rungs of the
// ladder a page gets, every refusal, monotonic progress, the promotion and the release of the tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SITES, firstRung, parseHls, findStart } from '../../engine/loader.js';
import { defaults, MASTER_PARAMS, PERSISTED_MASTER_KEYS, validateUiMessage } from '../../shared/protocol.js';
import { load, rendition, file, mp3, code, DUR, SR, OPUS, makeTab, makeEngine, loaderFor, fetcher, settle, turn, decoders, FAST } from './fixtures/loader-harness.mjs';

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

test('an HLS playlist of MPEG-TS pieces is told apart: no init, and .ts pieces or an mp2t hint', () => {
  const at = 'https://c.example/m/a.m3u8', list = (lines) => parseHls(['#EXTM3U', ...lines, '#EXT-X-ENDLIST', ''].join('\n'), at);
  assert.equal(list(['#EXTINF:4,', 's0.ts', '#EXTINF:4,', 's1.ts?tok=1']).ts, true);
  assert.equal(list(['#EXTINF:4,', 'seg?n=0&mime=video%2Fmp2t']).ts, true);
  assert.equal(list(['#EXTINF:4,', 'seg?n=0', '#EXT-X-MEDIA-TYPE:video/mp2t']).ts, true);
  assert.equal(list(['#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4,', 's0.m4s']).ts, undefined, 'fMP4 pieces with their init');
  assert.equal(list(['#EXTINF:4,', 's0.aac', '#EXTINF:4,', 's1.aac']).ts, undefined, 'packed audio (ADTS) decodes as it is');
  assert.equal(list(['#EXTINF:4,', 's0.mp3']).ts, undefined);
});

test('an MSE page whose playlist is MPEG-TS skips fetching its pieces again (they cannot be decoded), says so, and drives the player', async () => {
  const r = hi();
  const { result, tab, deck, engine } = await load({ kind: 'mse', rendition: r, preTap: 0, playing: 1, list: true, ts: true });
  assert.equal(result.kind, 'resident', JSON.stringify(called(engine, 'failLoadingToLive')));
  assert.deepEqual(asked(tab), ['tap on', 'readTralbum', 'fetch', 'drive seekhop']);
  assert.deepEqual(tab.sent().find((m) => m.t === 'fetch').urls, [r.list], 'the playlist only: no piece is fetched');
  assert.match(deck.load.report, /refetch \(fetching the track's pieces\): skipped in \d+\.\d s — the playlist's pieces are MPEG-TS, which cannot be decoded directly/);
  assert.equal(deck.load.report.match(/^ +refetch/gm).length, 1, 'not tried again after the drive');
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

test('a progressive page re-fetches its heard player\'s own source first, ahead of media the page fetched before it', async () => {
  const link = 'https://site.example/media/track.mp3', ads = [1, 2, 3].map((k) => `https://ads.example/jingle-${k}.mp3`);
  const files = { [link]: file('track', 120), ...Object.fromEntries(ads.map((u) => [u, file('jingle', 30)])) };
  const { result, tab, engine } = await load({ kind: 'progressive', src: link, fetched: ads, files });
  assert.equal(result.kind, 'resident', JSON.stringify(called(engine, 'failLoadingToLive')));
  assert.deepEqual(tab.sent().filter((m) => m.t === 'fetch').map((m) => m.urls), [[link]], 'its own source, first and only');
  assert.equal(called(engine, 'startResidentDeck')[0].code, code('track'));
  // When the tap does not say which source the player plays, the links go in the order the page asked for them.
  const blind = await load({ kind: 'progressive', src: link, fetched: ads.slice(0, 1), files, elSrc: false });
  assert.deepEqual(blind.tab.sent().filter((m) => m.t === 'fetch').map((m) => m.urls), [[ads[0]], [link]]);
  assert.equal(blind.result.kind, 'resident');
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

test('a player that has let go of the start it buffered before the tap is run once more from that gap, and the track loads', async () => {
  const { result, engine, tab, deck } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1, evicts: true });
  assert.equal(result.kind, 'resident', JSON.stringify(called(engine, 'failLoadingToLive')));
  assert.ok(near(called(engine, 'startResidentDeck')[0].frames / SR, 120, 0.02));
  assert.deepEqual(tab.sent().filter((m) => m.t === 'drive' && m.mode !== 'stop').map((m) => [m.mode, m.from]), [['seekhop', undefined], ['accelerate', 0]]);
  assert.equal(tab.kinds().filter((k) => k === 'drive stop').length, 1);
  assert.match(deck.load.report, /drive \(seek-hop, then accelerate 8× from 0\.0 s\): ok/);
});

test('a player that stops saying how long its track is while it is driven ends live with a plain reason', async () => {
  const lost = { t: 'tap-progress', bytes: 0, buffered: [], duration: null, mimes: [OPUS], sbs: [0], drive: { mode: 'seekhop', state: 'done', at: 120 } };
  const { result, engine } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1, seekhop: 'stall' }, {
    before: ({ tab }) => { tab.hooks.push((m) => { if (m.t === 'drive' && m.mode === 'seekhop') setImmediate(() => { tab.frames[0].duration = null; tab.frames[0].emit(lost); }); }); },
  });
  assert.equal(result.kind, 'live');
  assert.doesNotMatch(called(engine, 'failLoadingToLive')[0].reason, /undefined|Cannot read|TypeError/);
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

/** load() options: the page reports `reason` as the loader does `when` (a command it sends, or 'beat': the analysis). */
const lateError = (reason, when) => ({
  before: ({ tab, engine }) => {
    let fired = false;
    const fire = () => { if (!fired) { fired = true; setImmediate(() => tab.frames[0].emit({ t: 'tap-error', reason, detail: `late ${reason}` })); } };
    if (when !== 'beat') { tab.hooks.push((m) => { if (when(m)) fire(); }); return; }
    const f = engine.analyse.bind(engine);
    engine.analyse = async (pcm, s) => { fire(); await settle(10); return f(pcm, s); };
  },
});
for (const [reason, re] of [['drm', /protected/], ['worker', /worker/], ['preview', /30-second preview/], ['live', /live stream/]]) {
  for (const [stage, page, when, before] of [
    ['while the pieces are fetched', { kind: 'mse', rendition: hi(), preTap: 6, playing: 2, list: true, segUrls: true }, (m) => m.t === 'fetch', ['tap on', 'readTralbum', 'fetch']],
    ['while the player is driven', { kind: 'mse', rendition: hi(), preTap: 0, playing: 1 }, (m) => m.t === 'drive' && m.mode === 'seekhop', ['tap on', 'readTralbum', 'drive seekhop']],
    ['while the beat is found', { kind: 'progressive', src: 'https://site.example/t.mp3', files: { 'https://site.example/t.mp3': file('t', 120.0065) } }, 'beat', ['tap on', 'readTralbum', 'fetch']],
  ]) {
    test(`${reason} said after the first look, ${stage}: live at once with its one message, nothing more asked of the page, nothing promoted`, async () => {
      const { result, engine, tab } = await load(page, lateError(reason, when));
      assert.equal(result.kind, 'live', JSON.stringify(result));
      assert.deepEqual(called(engine, 'startResidentDeck'), []);
      const f = called(engine, 'failLoadingToLive');
      assert.equal(f.length, 1);
      assert.match(f[0].reason, re);
      assert.equal(engine.events.filter((e) => /^Deck 1: /.test(e.text)).length, 1, 'said once');
      assert.deepEqual(asked(tab), before, 'nothing fetched again, driven or run faster after it');
      if (stage.includes('driven')) assert.ok(tab.kinds().includes('drive stop'));
    });
  }
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

test('a resident load releases the tab in order: STOP_TAB answered, then the capture stopped, the agents tapped off and let go, then the tab forgotten', async () => {
  const link = 'https://site.example/media/track.mp3';
  const { tab, engine, deck } = await load({ kind: 'progressive', src: link, files: { [link]: file('a', 120) } }, {
    before: ({ engine: e, deck: d, tab: t }) => {
      const tr = d.tracks[0], stop = tr.stop;
      tr.stop = function () { e.order.push('capture stopped'); return stop.call(this); };
      const disc = t.frames[0].port.disconnect;
      t.frames[0].port.disconnect = () => { e.order.push('agent let go'); disc(); };
    },
  });
  // The tab is silenced (its STOP_TAB answered) before its capture goes, so the track never comes out of the speakers.
  assert.deepEqual(engine.order.filter((x) => x !== 'AGENT_CONNECT'), ['STOP_TAB', 'STOP_TAB done', 'capture stopped', 'agent let go', 'DECKS_CHANGED']);
  const stop = engine.hubLog.find((m) => m.type === 'STOP_TAB'), changed = engine.hubLog.findLast((m) => m.type === 'DECKS_CHANGED');
  assert.equal(stop.tabId, 7, 'STOP_TAB for the source tab');
  assert.equal(stop.release, true, 'a release: the tab is paused, never left muted');
  assert.deepEqual(changed.decks, [], 'the hub forgets the tab');
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

/**
 * An HLS playlist of MP3 pieces (packed audio: no EXT-X-MAP, .mp3 pieces) as a SoundCloud-style MSE player reads it,
 * appending 'audio/mpeg': 30 pieces of 4.032 s (56 frames of 72 ms), their times only in the playlist's EXTINF.
 */
function mp3Hls(origin = 'https://cdn.example') {
  const SEG = 56 * 0.072, base = `${origin}/media`;
  const r = { rep: 'mp3', mime: 'audio/mpeg', list: `${base}/mp3.m3u8`, init: { url: `${base}/unused-init`, bytes: new ArrayBuffer(0) },
    segs: Array.from({ length: 30 }, (_, k) => ({ url: `${base}/seg-${k}.mp3`, t0: k * SEG, t1: (k + 1) * SEG, bytes: mp3(4) })) };
  const text = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-PLAYLIST-TYPE:VOD',
    ...r.segs.flatMap((s, k) => [`#EXTINF:${SEG.toFixed(3)},`, `seg-${k}.mp3`]), '#EXT-X-ENDLIST', ''].join('\n');
  return { r, D: 30 * SEG, before: ({ tab }) => { tab.net.set(r.list, new TextEncoder().encode(text).buffer); } };
}

for (const [when, preTap] of [['already playing when it is loaded', 2], ['started after the tap', 0]]) {
  test(`an HLS playlist of MP3 pieces (no timestamps of their own), its player ${when}: every piece from the first is fetched and placed alone, resident`, async () => {
    const { r, D, before } = mp3Hls();
    const { result, tab, engine, deck } = await load({ kind: 'mse', rendition: r, preTap, playing: 2, list: true, segUrls: true, mimes: ['audio/mpeg'], duration: D }, { before });
    assert.equal(result.kind, 'resident', deck.load.report);
    const [list, pieces] = tab.sent().filter((m) => m.t === 'fetch');
    assert.deepEqual(list.urls, [r.list]);
    assert.deepEqual(pieces.urls, r.segs.map((s) => s.url), 'every piece, in order from the first: where the capture starts cannot be known');
    const [s] = called(engine, 'startResidentDeck');
    assert.ok(near(s.frames / SR, D, 0.01), `${s.frames / SR} s of ${D} s`);
    assert.match(deck.load.report, /refetch \(fetching the track's pieces\): ok in \d+\.\d s — 30 pieces fetched/);
    assert.ok(!tab.kinds().some((k) => /drive (seekhop|accelerate)/.test(k)), 'not driven');
  });
}

test('an HLS playlist of MP3 pieces longer than the resident limit fetches only the pieces up to it, from the first', async () => {
  const { r, D, before } = mp3Hls();
  const { result, tab, engine } = await load({ kind: 'mse', rendition: r, preTap: 2, playing: 2, list: true, segUrls: true, mimes: ['audio/mpeg'], duration: D }, { before, limitMin: 1 });
  assert.equal(result.kind, 'resident');
  assert.deepEqual(tab.sent().filter((m) => m.t === 'fetch')[1].urls, r.segs.slice(0, 16).map((s) => s.url), 'pieces 0–15: up to a second past the limit');
  assert.equal(called(engine, 'startResidentDeck')[0].frames, 60 * SR);
  assert.match(engine.notes[0].text, /the deck holds its first 1 minute/);
});

test('MP3 pieces from a playlist that cannot all be fetched are never placed beside the player\'s capture: the drive gives the whole track', async () => {
  const { r, D, before } = mp3Hls(), lost = r.segs[10];
  const { result, tab, engine, deck } = await load({ kind: 'mse', rendition: r, preTap: 0, playing: 2, list: true, segUrls: true, mimes: ['audio/mpeg'], duration: D },
    { before: (o) => { before(o); o.tab.net.delete(lost.url); } });
  assert.equal(result.kind, 'resident', deck.load.report);
  assert.match(deck.load.report, /refetch \(fetching the track's pieces\): failed in \d+\.\d s — 29 pieces fetched, 1 failed, still missing 40\.3–44\.4 s/);
  assert.match(deck.load.report, /drive \(accelerate 8×\): ok/);
  assert.deepEqual(tab.sent().filter((m) => m.t === 'drive' && m.mode !== 'stop').map((m) => m.mode), ['accelerate']);
  assert.ok(near(called(engine, 'startResidentDeck')[0].frames / SR, D, 0.01));
});

// ---------------------------------------------------------------- the load report (R4.2)
test('a resident load leaves a plain-text report: host, every rung and how it ended, mimes, counts, bytes, timings, no failure', async () => {
  const { deck } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 3, list: true, segUrls: true });
  const r = deck.load.report;
  assert.equal(typeof r, 'string');
  assert.match(r, /^JD Samps load report\n/);
  assert.match(r, /Page: site\.example \(generic site: file, refetch, drive, then live\)/);
  assert.match(r, /Result: resident, 119\.99\d s/, 'the Opus delay at the end of the last piece is trimmed');
  assert.match(r, /Track length: 120\.007 s/);
  assert.match(r, /file \(reading the page's track link\): skipped in \d+\.\d s — the page has no track link of its own/);
  assert.match(r, /refetch \(fetching the track's pieces\): ok in \d+\.\d s — 29 pieces fetched/);
  assert.doesNotMatch(r, /^ +drive/m, 'a rung never reached is not listed');
  assert.match(r, /Media types: audio\/mp4; codecs="opus"/);
  assert.match(r, /Runs: 1, segments: 30, gaps: none/);
  assert.match(r, /Requests seen: 7 media, 1 playlist/);
  assert.match(r, /Bytes: \d+ kB captured from the player, \d+ kB fetched again/);
  assert.match(r, /First failure: none/);
  assert.match(r, /Total: \d+\.\d s/);
  assert.doesNotMatch(r, /undefined|NaN|\[object/);
});

test('a load that ends live leaves a report naming the rung that failed first, and why', async () => {
  const { deck } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1 });
  const r = deck.load.report;
  assert.match(r, /Result: live: the whole track could not be read/);
  assert.match(r, /refetch \(fetching the track's pieces\): skipped in \d+\.\d s — the player fetched nothing that can be fetched again/);
  assert.match(r, /drive \(seek-hop, then accelerate 8× from 0\.0 s\): failed in \d+\.\d s — the player buffered the whole track, but 0\.0–24\.0 s came before the deck could read it/);
  assert.match(r, /gaps: 0\.0–24\.0 s/);
  assert.match(r, /First failure: drive: the player buffered the whole track/);
});

test('a track with no steady beat still loads, and its report says so', async () => {
  const link = 'https://site.example/ambient.mp3';
  const { result, deck } = await load({ kind: 'progressive', src: link, files: { [link]: file('ambient', 120.0065) } }, {
    before: ({ engine }) => { engine.analyse = async () => ({ bpm: 0, conf: 0, octConf: 0, segments: [], bar1: null, residuals: { median: 0, max: 0 }, wave: null }); },
  });
  assert.equal(result.kind, 'resident');
  assert.match(deck.load.report, /beat: ok in \d+\.\d s — no steady beat/);
});

test('a refusal leaves a report too, its reason as the first failure', async () => {
  const { deck } = await load({ kind: 'mse', rendition: hi(), errors: ['drm'] });
  assert.match(deck.load.report, /Result: live: this page's audio is protected/);
  assert.match(deck.load.report, /look: drm in \d+\.\d s/);
  assert.match(deck.load.report, /First failure: this page's audio is protected/);
  const web = await load({ kind: 'none' });
  assert.match(web.deck.load.report, /connect: none in \d+\.\d s — 0 frames with a player/);
});

test('a track longer than the resident limit loads its first part: only those pieces are fetched, it is said once and reported', async () => {
  const { result, tab, engine, deck } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1, list: true, segUrls: true }, { limitMin: 1 });
  assert.equal(result.kind, 'resident');
  const names = tab.sent().filter((m) => m.t === 'fetch')[1].urls.map((u) => u.split('/').pop());
  assert.ok(!names.includes('seg-016.m4s') && names.includes('seg-014.m4s'), names.join(' '));
  assert.equal(called(engine, 'startResidentDeck')[0].frames, 60 * SR);
  assert.equal(engine.notes.length, 1);
  assert.match(engine.notes[0].text, /^Deck 1: this track is 2 minutes long: the deck holds its first 1 minute \(the resident track limit\)\.$/);
  assert.match(deck.load.report, /Limit: this track is 2 minutes long/);
});

/** load() with the stand-in decoder's input sizes recorded. */
const loadSeen = (page, opts = {}) => {
  const sizes = [];
  return load(page, { ...opts, deps: { decodeFile: (ctx, buf) => { sizes.push(buf.byteLength); return decoders.decodeFile(ctx, buf); } } }).then((r) => ({ ...r, sizes }));
};

for (const [name, page] of [
  ['behind a progressive player', (link, S) => ({ kind: 'progressive', src: link, duration: S, files: { [link]: mp3(S) } })],
  ['on a Bandcamp-like page', (link, S) => ({ kind: 'progressive', src: link, duration: S, tralbum: { url: link, duration: S }, files: { [link]: mp3(S) } })],
]) {
  test(`an MP3 mix ${name} longer than twice the resident limit loads its first part: only that part is decoded, said once and reported`, async () => {
    for (const minutes of [40, 74]) {
      const link = 'https://site.example/media/mix.mp3', S = minutes * 60;
      const { result, engine, deck, sizes } = await loadSeen(page(link, S));
      assert.equal(result.kind, 'resident', `${minutes} min: ${called(engine, 'failLoadingToLive').map((c) => c.reason)}`);
      assert.equal(called(engine, 'startResidentDeck')[0].frames, 15 * 60 * SR);
      assert.equal(engine.notes.length, 1);
      assert.match(engine.notes[0].text, new RegExp(`^Deck 1: this track is ${minutes} minutes long: the deck holds its first 15 minutes \\(the resident track limit\\)\\.$`));
      assert.match(deck.load.report, new RegExp(`Limit: this track is ${minutes} minutes long`));
      // Cut a frame past the limit and a second: the decoder never sees the rest.
      assert.equal(sizes.length, 1);
      assert.ok(sizes[0] <= Math.ceil((15 * 60 + 1) / 0.072 + 1) * 72 && sizes[0] >= (15 * 60 + 1) / 0.072 * 72, `${minutes} min: decoded ${sizes[0]} bytes of ${mp3(S).byteLength}`);
    }
  });
}

test('a long MP3 whose own frames do not give the player\'s length is not cut and taken: live, saying why', async () => {
  const link = 'https://site.example/media/mix.mp3';
  const { result, engine } = await load({ kind: 'progressive', src: link, duration: 74 * 60, files: { [link]: mp3(30 * 60) } });
  assert.equal(result.kind, 'live');
  assert.match(called(engine, 'failLoadingToLive')[0].reason, /holds 1800\.0 s, but the page's player says 4440\.0 s/);
});

test('a file longer than twice the limit in a format that cannot be cut at a frame is not decoded whole: live, saying why', async () => {
  const link = 'https://site.example/media/mix.m4a', S = 74 * 60;
  const { result, engine, sizes } = await loadSeen({ kind: 'progressive', src: link, duration: S, files: { [link]: file('mix', S) } });
  assert.equal(result.kind, 'live');
  assert.deepEqual(sizes, []);
  assert.match(called(engine, 'failLoadingToLive')[0].reason, /74 minutes long, too long to decode whole/);
});

test('a recording from the page starts at the first sound after the page was held silent', () => {
  const L = new Float32Array(4000), R = new Float32Array(4000);
  for (let i = 0; i < 900; i++) L[i] = 0.5 * Math.sin(i / 3);      // the page playing before it was held
  for (let i = 2500; i < 4000; i++) R[i] = 0.2 * Math.sin((i - 2500) / 5); // the track from its start (right channel only)
  assert.equal(findStart(L, R, 1000, 4000), 2500 + 1);              // sin(0) is silent: the first audible sample
  assert.equal(findStart(L, R, 1000, 2400), -1, 'nothing yet');
  assert.equal(findStart(L, R, 0, 4000), 1, 'from where it is asked');
});

// ---------------------------------------------------------------- races, cancellation, the page going away (R4.3)
test('two loads racing on two tabs: each deck gets its own track, and no tab hears the other load', async () => {
  const pageA = { tabId: 11, url: 'https://a.example/x', kind: 'mse', rendition: rendition('opus-hi', 'https://a.example'), preTap: 6, playing: 2, list: true, segUrls: true };
  const pageB = { tabId: 12, url: 'https://b.example/y', kind: 'mse', rendition: rendition('opus-lo', 'https://b.example'), preTap: 0, playing: 1 };
  const a = makeTab(pageA), b = makeTab(pageB), engine = makeEngine({ tabs: [a, b] }), fetchBytes = fetcher([a, b]);
  const la = loaderFor(a, engine, { deckId: 1, slot: 1, fetchBytes }), lb = loaderFor(b, engine, { deckId: 2, slot: 2, fetchBytes });
  const [ra, rb] = await Promise.all([la.loader.run(), lb.loader.run()]);
  await settle();
  assert.equal(ra.kind, 'resident'); assert.equal(rb.kind, 'resident');
  const by = Object.fromEntries(called(engine, 'startResidentDeck').map((c) => [c.deckId, c.code]));
  assert.equal(by[1], code(pageA.rendition.segs[0].bytes.byteLength), "deck 1 holds tab A's audio");
  assert.equal(by[2], code(pageB.rendition.segs[0].bytes.byteLength), "deck 2 holds tab B's audio");
  assert.notEqual(by[1], by[2]);
  assert.ok(a.kinds().includes('fetch') && !b.kinds().includes('fetch'), 'A was re-fetched, B driven: each its own ladder');
  assert.ok(b.kinds().includes('drive seekhop') && !a.kinds().includes('drive seekhop'));
  for (const t of [a, b]) for (const m of t.sent()) if (m.t === 'fetch') for (const u of m.urls) assert.ok(u.startsWith(new URL(t.url).origin), `${u} asked of the wrong tab`);
});

/** Run a load, ejecting its deck at the k-th thing it does (a command, a hub or engine call, a read); null when it did fewer. */
async function ejectAt(k, page) {
  const tab = makeTab(page), engine = makeEngine({ tabs: [tab] });
  let n = 0, at = null;
  const { deck, loader, ac } = loaderFor(tab, engine, { fetchBytes: (u, o) => { tick(`read ${u.slice(0, 12)}`); return fetcher([tab])(u, o); } });
  const order = [];
  function tick(what) {
    order.push(what);
    if (n++ === k && at == null) {
      at = { what, sent: tab.log.length };
      // Another deck starting holds serial() for a moment, so the eject's turn (and its deck's going) comes later.
      engine.serial(() => new Promise((r) => setTimeout(r, 25)));
      engine.eject(deck.id);
    }
  }
  tab.hooks.push((m) => tick(`send ${m.t}${m.mode ? ` ${m.mode}` : ''}`));
  for (const fn of ['hub', 'stopTab', 'analyse', 'startResidentDeck', 'failLoadingToLive']) {
    const f = engine[fn].bind(engine);
    engine[fn] = (...a) => { tick(fn); return f(...a); };
  }
  const result = await loader.run();
  await engine.serial(() => {}); // the eject has had its turn
  await settle(30);
  return { result, at, tab, engine, deck, order, signal: ac.signal };
}

for (const [name, page] of [
  ['re-fetched', { kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true }],
  ['driven', { kind: 'mse', rendition: rendition(), preTap: 0, playing: 1 }],
  ['read from its own link', { kind: 'progressive', src: 'https://site.example/t.mp3', tralbum: { url: 'https://site.example/t.mp3' }, files: { 'https://site.example/t.mp3': file('t', 120.0065) } }],
]) {
  test(`ejected at every step of a load ${name}: cancelled, nothing promoted or sent live, the page given back, then silence`, async () => {
    let k = 0;
    for (;; k++) {
      const { result, at, tab, engine, deck, order, signal } = await ejectAt(k, page);
      if (!at) { assert.ok(k > 5, `only ${k} steps`); break; }
      const where = `ejected at step ${k} (${at.what}) of ${order.join(', ')}`;
      // The eject stops the load at once (its deck goes later, in its turn), as the real one does.
      assert.equal(signal.aborted, true, `${where}: the load's abort signal fired`);
      assert.equal(engine.decks.has(deck.id), false, `${where}: the deck is gone`);
      if (order.slice(0, k).includes('startResidentDeck')) {
        // Ejected while the tab was being released: the load had finished, and the eject takes the resident deck.
        assert.equal(result.kind, 'resident', where);
        assert.equal(engine.calls.filter((c) => c.fn === 'startResidentDeck').length, 1, where);
        continue;
      }
      assert.deepEqual(result, { ok: false, error: 'Loading was cancelled.' }, where);
      const after = engine.calls.slice(engine.calls.findIndex((c) => c.fn === 'eject') + 1);
      // A promotion already on its way finds the deck on its way out; none is started after the eject.
      assert.notEqual(deck.kind, 'resident', where);
      assert.deepEqual(engine.events.filter((e) => /^Loaded /.test(e.text)), [], `${where}: said to be loaded`);
      assert.ok(after.filter((c) => c.fn === 'startResidentDeck').length <= (at.what === 'startResidentDeck' ? 1 : 0), where);
      assert.ok(after.filter((c) => c.fn === 'failLoadingToLive').length <= (at.what === 'failLoadingToLive' ? 1 : 0), where);
      // No release of an ejected deck: the eject's own STOP_TAB and DECKS_CHANGED only, and the deck keeps its tab.
      assert.deepEqual(engine.hubLog.filter((m) => (m.type === 'STOP_TAB' && m.release) || (m.type === 'DECKS_CHANGED' && !m.eject)), [], `${where}: released`);
      assert.equal(deck.tabId, tab.tabId, `${where}: released`);
      const late = tab.log.slice(at.sent).map((x) => x.m).filter((m) => !(m.t === 'drive' && m.mode === 'stop') && !(m.t === 'tap' && m.on === false));
      // The command that was being sent when the eject came is the only other one.
      assert.ok(late.length <= (at.what.startsWith('send') ? 1 : 0), `${where}: sent after the eject: ${JSON.stringify(late)}`);
      if (tab.log.some((x) => x.m.t === 'tap' && x.m.on)) assert.deepEqual(tab.sent().at(-1), { t: 'tap', on: false, forget: true }, `${where}: the tap is left off`);
      if (tab.kinds().some((x) => /drive (seekhop|accelerate)/.test(x))) assert.ok(tab.kinds().lastIndexOf('drive stop') > tab.kinds().findLastIndex((x) => /drive (seekhop|accelerate)/.test(x)), `${where}: the drive was stopped`);
    }
  });
}

test('the analysis is told to stop when the deck is ejected while the beat is being found', async () => {
  const link = 'https://site.example/t.mp3';
  let signal = null;
  const { result } = await load({ kind: 'progressive', src: link, files: { [link]: file('t', 120.0065) } }, {
    before: ({ engine, deck }) => { const f = engine.analyse.bind(engine); engine.analyse = (pcm, s) => { signal = s; engine.eject(deck.id); return f(pcm, s); }; },
  });
  assert.deepEqual(result, { ok: false, error: 'Loading was cancelled.' });
  assert.equal(signal && signal.aborted, true, 'the Worker\'s signal is aborted (analyseTrack terminates it)');
});

/** load() options: at the n-th fetch the loader sends, fn({tab, engine, deck}) runs. */
const atFetch = (n, fn) => ({ before: (x) => { let k = 0; x.tab.hooks.push((m) => { if (m.t === 'fetch' && ++k === n) setImmediate(() => fn(x)); }); } });
const MOVED = 'Deck 1: the page moved on to something else before the track was in. Add the tab again.';
const OTHER = 'https://site.example/another-track';

test('the page reloading mid-load (the same page again) goes live with one message: no half-built deck, nothing unhandled', async () => {
  const unhandled = [];
  const on = (e) => unhandled.push(e);
  process.on('unhandledRejection', on);
  try {
    const { result, engine, tab, deck } = await load({ kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true }, atFetch(2, ({ tab: t }) => t.navigate()));
    await settle(30);
    assert.equal(result.kind, 'live');
    assert.deepEqual(called(engine, 'startResidentDeck'), []);
    const f = called(engine, 'failLoadingToLive');
    assert.equal(f.length, 1);
    assert.match(f[0].reason, /the page changed while the track was loading/);
    assert.equal(engine.events.filter((e) => /^Deck 1: /.test(e.text)).length, 1);
    assert.ok(tab.frames[0].left);
    assert.match(deck.load.report, /page: reload in \d+\.\d s — the same page again/);
  } finally { process.off('unhandledRejection', on); }
  assert.deepEqual(unhandled, []);
});

test('the page moving on to another page mid-load ejects the deck with one error: never a live deck on that page\'s audio', async () => {
  // The hub's word of the new page (META) comes a little after the page's agents have gone, as it does in Chrome.
  const { result, engine } = await load({ kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true },
    atFetch(2, ({ tab: t }) => t.navigate({ to: OTHER, metaAfter: 30 })));
  await settle(30);
  assert.deepEqual(result, { ok: false, error: MOVED });
  assert.deepEqual(called(engine, 'failLoadingToLive'), []);
  assert.deepEqual(called(engine, 'startResidentDeck'), []);
  assert.equal(called(engine, 'eject').length, 1);
  assert.equal(engine.decks.size, 0);
  assert.deepEqual(engine.events.filter((e) => /^Deck 1: /.test(e.text)), [{ level: 'error', text: MOVED }]);
});

test('a page that moves on while a link it gave decodes badly is ejected, never played live', async () => {
  const link = 'https://site.example/t.mp3';
  const { result, engine } = await load({ kind: 'progressive', src: link, files: { [link]: file('t', 120.0065) } }, {
    before: ({ tab, loader }) => { loader.d.decodeFile = async () => { tab.navigate({ to: OTHER }); await settle(5); throw new Error('Unable to decode audio data'); }; },
  });
  assert.deepEqual(result, { ok: false, error: MOVED });
  assert.deepEqual(called(engine, 'failLoadingToLive'), []);
  assert.deepEqual(engine.events.filter((e) => /^Deck 1: /.test(e.text)), [{ level: 'error', text: MOVED }]);
});

// A single-page site (YouTube, SoundCloud, Mixcloud) moves on to another track in place: the address changes, the page
// and its agents stay, and the same player plays the other track.
test('a single-page site moving on to another track while a link it gave decodes badly is ejected, never played live', async () => {
  const link = 'https://site.example/t.mp3';
  const { result, engine } = await load({ kind: 'progressive', src: link, files: { [link]: file('t', 120.0065) } }, {
    before: ({ tab, loader }) => { loader.d.decodeFile = async () => { tab.moveInPlace({ to: OTHER }); await new Promise((r) => setTimeout(r, 5)); throw new Error('Unable to decode audio data'); }; },
  });
  assert.deepEqual(result, { ok: false, error: MOVED }, JSON.stringify(engine.events));
  assert.deepEqual(called(engine, 'failLoadingToLive'), []);
  assert.deepEqual(called(engine, 'startResidentDeck'), []);
  assert.deepEqual(engine.events.filter((e) => /^Deck 1: /.test(e.text)), [{ level: 'error', text: MOVED }]);
});

test('a single-page site moving on to another track while its player is driven is ejected: the other track never becomes the deck', async () => {
  // The other track (80 s, the low rendition's pieces) is appended whole a moment after the address changed.
  const { result, engine, tab } = await load({ kind: 'mse', rendition: hi(), preTap: 0, playing: 1 }, {
    before: ({ tab: t }) => { t.hooks.push((m) => { if (m.t === 'drive' && m.mode === 'seekhop') t.moveInPlace({ to: OTHER, rendition: rendition('opus-lo'), duration: 80 }); }); },
  });
  await settle(30);
  assert.deepEqual(result, { ok: false, error: MOVED }, JSON.stringify([engine.calls, engine.events]));
  assert.deepEqual(called(engine, 'startResidentDeck'), []);
  assert.deepEqual(called(engine, 'failLoadingToLive'), []);
  assert.equal(called(engine, 'eject').length, 1);
  assert.deepEqual(engine.events.filter((e) => /^Deck 1: /.test(e.text)), [{ level: 'error', text: MOVED }]);
  assert.ok(tab.kinds().includes('drive stop'), 'the page has its player back');
});

test('a single-page site moving on to another track while its pieces are fetched again is ejected, never played live or resident', async () => {
  const { result, engine } = await load({ kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true },
    atFetch(2, ({ tab: t }) => t.moveInPlace({ to: OTHER, rendition: rendition('opus-lo'), duration: 80 })));
  await settle(30);
  assert.deepEqual(result, { ok: false, error: MOVED }, JSON.stringify([engine.calls, engine.events]));
  assert.deepEqual(called(engine, 'startResidentDeck'), []);
  assert.deepEqual(called(engine, 'failLoadingToLive'), []);
  assert.deepEqual(engine.events.filter((e) => /^Deck 1: /.test(e.text)), [{ level: 'error', text: MOVED }]);
});
for (const [what, page, opts] of [
  ['its pieces fetched, while the beat is found', { kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true },
    { before: ({ tab, engine }) => { const f = engine.analyse.bind(engine); engine.analyse = async (p, s) => { tab.navigate({ to: OTHER }); await settle(5); return f(p, s); }; } }],
  ['its link read, while it is decoded', { kind: 'progressive', src: 'https://site.example/t.mp3', files: { 'https://site.example/t.mp3': file('t', 120.0065) } },
    { before: ({ tab, loader }) => { loader.d.decodeFile = async (ctx, buf) => { tab.navigate({ to: OTHER }); await settle(5); return decoders.decodeFile(ctx, buf); }; } }],
  // Checked only when the drive says it is done, so the page goes before the loader has looked at what it holds.
  ['all its pieces captured from the player, before the loader looked', { kind: 'mse', rendition: hi(), preTap: 0, playing: 1 },
    { times: { ...FAST, check: 1000 }, before: ({ tab }) => { tab.hooks.push((m) => { if (m.t === 'drive' && m.mode === 'seekhop') setTimeout(() => tab.navigate({ to: OTHER }), 2); }); } }],
  // The hub's word of the new page (META) can come before the old page's agents have gone.
  ['all its pieces captured from the player, before the loader looked, word of the new page coming before its agents go', { kind: 'mse', rendition: hi(), preTap: 0, playing: 1 },
    { times: { ...FAST, check: 1000 }, before: ({ tab }) => { tab.hooks.push((m) => { if (m.t === 'drive' && m.mode === 'seekhop') setTimeout(() => { tab.deck.meta.url = OTHER; setTimeout(() => tab.navigate(), 20); }, 2); }); } }],
  // A single-page site moving on in place: its agents stay, and its player goes on to another track.
  ['its pieces fetched, while the beat is found, on a single-page site that moves on in place', { kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true },
    { before: ({ tab, engine }) => { const f = engine.analyse.bind(engine); engine.analyse = async (p, s) => { tab.moveInPlace({ to: OTHER }); await new Promise((r) => setTimeout(r, 5)); return f(p, s); }; } }],
  ['its link read, while it is decoded, on a single-page site that moves on in place', { kind: 'progressive', src: 'https://site.example/t.mp3', files: { 'https://site.example/t.mp3': file('t', 120.0065) } },
    { before: ({ tab, loader }) => { loader.d.decodeFile = async (ctx, buf) => { tab.moveInPlace({ to: OTHER }); await new Promise((r) => setTimeout(r, 5)); return decoders.decodeFile(ctx, buf); }; } }],
]) {
  test(`a page that moves on once every byte of its track is in, ${what}: the deck goes resident and lets go of the tab`, async () => {
    const { result, engine, deck } = await load(page, opts);
    assert.equal(result.kind, 'resident', JSON.stringify([result, engine.events]));
    assert.ok(near(called(engine, 'startResidentDeck')[0].frames / SR, 120, 0.02));
    assert.deepEqual(called(engine, 'failLoadingToLive'), []);
    assert.deepEqual(called(engine, 'eject'), []);
    assert.equal(deck.tabId, null, 'released');
    assert.deepEqual(engine.events.filter((e) => e.level === 'error'), []);
  });
}

test('the tab closed mid-load ejects the deck with one error: no live deck on its dying capture', async () => {
  // The page's agents go first; the capture ends 10 ms later and the hub's EJECT for the closed tab comes after that.
  const { result, engine } = await load({ kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true },
    atFetch(2, ({ tab: t, engine: e }) => t.close(e, { endAfter: 10, ejectAfter: 30 })));
  await settle(30);
  assert.equal(result.ok, false);
  assert.deepEqual(called(engine, 'failLoadingToLive'), []);
  assert.deepEqual(called(engine, 'startResidentDeck'), []);
  assert.equal(engine.decks.size, 0);
  assert.deepEqual(engine.events.filter((e) => /^Deck 1: /.test(e.text)), [{ level: 'error', text: 'Deck 1: the tab was closed before the track was in.' }]);
});

test('the page going away with the tab\'s audio gone too ejects the deck with one error, never a silent live deck', async () => {
  const { result, engine } = await load({ kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true }, {
    before: ({ tab: t, deck }) => { t.hooks.push((m) => { if (m.t === 'fetch') setImmediate(() => { for (const x of deck.tracks) x.stop(); t.navigate(); }); }); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /audio/);
  assert.deepEqual(called(engine, 'failLoadingToLive'), []);
  assert.equal(called(engine, 'eject').length, 1);
  assert.equal(engine.events.filter((e) => e.level === 'error' && /^Deck 1: .*audio/.test(e.text)).length, 1);
});

test('a length not known at first is waited for; then the track loads', async () => {
  const { result, engine } = await load({ kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true, duration: null }, {
    before: ({ tab: t }) => { setTimeout(() => { t.frames[0].duration = DUR; t.frames[0].progress(); }, 60); },
  });
  assert.equal(result.kind, 'resident');
  assert.ok(near(called(engine, 'startResidentDeck')[0].frames / SR, 120, 0.02));
});

test('a length that grows mid-load is never taken at its first value: the rest is fetched and the whole track loads', async () => {
  const { result, engine, tab } = await load({ kind: 'mse', rendition: rendition(), preTap: 6, playing: 2, list: true, segUrls: true, duration: 60 }, {
    before: ({ tab: t }) => { let n = 0; t.hooks.push((m) => { if (m.t === 'fetch' && ++n === 2) setImmediate(() => { t.frames[0].duration = DUR; t.frames[0].progress(); }); }); },
  });
  assert.equal(result.kind, 'resident');
  const [s] = called(engine, 'startResidentDeck');
  assert.ok(near(s.frames / SR, 120, 0.02), `resident at ${s.frames / SR} s`);
  assert.ok(tab.sent().filter((m) => m.t === 'fetch').length >= 3, 'the pieces past 60 s were fetched too');
});

// ---------------------------------------------------------------- several players in one tab
test('the track length is the heard player\'s, not that of a player in a frame whose agent came first', async () => {
  const track = { kind: 'mse', rendition: hi(), preTap: 6, playing: 2, list: true, segUrls: true };
  const other = { kind: 'mse', rendition: rendition('opus-lo', 'https://ads.example'), duration: 30, preTap: 1 };
  for (const [what, status] of [['muted and playing', { audible: 0, muted: true }], ['heard too (the shorter is not the track)', {}]]) {
    const { result, engine, deck } = await load({ frames: 2, framePages: [{ ...other, status }, track] });
    assert.equal(result.kind, 'resident', `${what}: ${JSON.stringify(called(engine, 'failLoadingToLive'))}`);
    assert.ok(near(called(engine, 'startResidentDeck')[0].frames / SR, 120, 0.02), what);
    assert.match(deck.load.report, /look: ok in \d+\.\d s — the player says 120\.007 s/, what);
  }
});

test('another player\'s appends never become the track: one beside it in its frame, or in another frame', async () => {
  const r = hi(), lo = rendition('opus-lo', 'https://ads.example');
  const track = { kind: 'mse', rendition: r, preTap: 6, playing: 2, list: true, segUrls: true };
  for (const [where, page] of [
    ['beside it, on its own SourceBuffer', { ...track, other: { rendition: lo, sb: 1, n: 5 } }],
    ['in another frame, muted', { frames: 2, framePages: [track, { kind: 'mse', rendition: lo, preTap: 0, playing: 5, status: { audible: 0, muted: true } }] }],
  ]) {
    const { result, loader, engine } = await load(page);
    assert.equal(result.kind, 'resident', `${where}: ${JSON.stringify(called(engine, 'failLoadingToLive'))}`);
    assert.ok(near(called(engine, 'startResidentDeck')[0].frames / SR, 120, 0.02), where);
    // Every piece the deck was decoded from is the track's own piece for that time.
    for (const run of loader.rep.placed.runs) {
      for (const s of run.segs) {
        const own = r.segs.find((x) => Math.abs(x.t0 - s.t0) < 1e-6);
        assert.ok(own && own.bytes.byteLength === s.bytes.byteLength, `${where}: the audio at ${s.t0.toFixed(1)} s is another player's`);
      }
    }
  }
});

test('the opus pieces this harness serves are what the model sites serve', () => {
  const r = hi();
  assert.equal(r.mime, OPUS);
  assert.equal(r.segs.length, 31);
  assert.ok(near(DUR, 120.0065, 1e-9));
});

// ---------------------------------------------------------------- a player already playing when it is loaded (flush)
const drives = (tab) => tab.sent().filter((m) => m.t === 'drive' && m.mode !== 'stop');

test('the start a player held from before the tap, which no link can fetch again, has the first drive flush the player', async () => {
  const { tab } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1 });
  assert.deepEqual(drives(tab).map((m) => [m.mode, m.flush]), [['seekhop', true], ['accelerate', undefined]]);
});

test('no flush when the tap holds the start (the player started after it), nor for appends placed in order only', async () => {
  const { tab } = await load({ kind: 'mse', rendition: hi(), preTap: 0, playing: 2 });
  assert.ok(drives(tab).length && drives(tab).every((m) => m.flush === undefined), JSON.stringify(drives(tab)));
  const r = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1, mimes: ['audio/mpeg'], appends: [{ bytes: mp3(120.0065), mime: 'audio/mpeg' }] });
  assert.ok(drives(r.tab).length && drives(r.tab).every((m) => m.flush === undefined), JSON.stringify(drives(r.tab)));
});

test('flushed, a player that fetches again what left its buffer gives the whole track in one seek-hop: resident', async () => {
  const { result, tab, engine, deck } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1, flush: 'refetch' });
  assert.equal(result.kind, 'resident', JSON.stringify(called(engine, 'failLoadingToLive')));
  assert.ok(near(called(engine, 'startResidentDeck')[0].frames / SR, 120, 0.02));
  assert.deepEqual(drives(tab).map((m) => m.mode), ['seekhop']);
  assert.match(deck.load.report, /drive \(seek-hop after a flush\): ok in \d+\.\d s/);
});

test('a player that did not fetch again what the flush took from behind its place ends live at once, the report naming the start it would not fetch again', async () => {
  const { result, engine, deck, tab } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1, flush: 'sticky' });
  assert.equal(result.kind, 'live');
  assert.deepEqual(called(engine, 'startResidentDeck'), []);
  const why = /the player would not fetch the start again after a flush: 0\.0–24\.0 s came before the deck could read it/;
  assert.match(called(engine, 'failLoadingToLive')[0].reason, why);
  assert.match(deck.load.report, new RegExp(`drive \\(seek-hop\\): failed in \\d+\\.\\d s — ${why.source}`));
  assert.doesNotMatch(deck.load.report, /not flushed/);
  assert.deepEqual(drives(tab).map((m) => m.mode), ['seekhop'], 'no accelerate: nothing more is to be had');
  assert.ok(tab.kinds().lastIndexOf('drive stop') > tab.kinds().lastIndexOf('drive seekhop'), 'the drive is stopped');
});

test('flushed, a player that then fetches nothing more ends live, the report naming the start it would not fetch again', async () => {
  const { result, engine, deck, tab } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1, flush: 'dry' });
  assert.equal(result.kind, 'live');
  assert.deepEqual(called(engine, 'startResidentDeck'), []);
  const why = /the player would not fetch the start again after a flush: 0\.0–24\.0 s came before the deck could read it/;
  assert.match(called(engine, 'failLoadingToLive')[0].reason, why);
  assert.match(deck.load.report, new RegExp(`drive \\(seek-hop after a flush, then accelerate 8×\\): failed in \\d+\\.\\d s — ${why.source}`));
  assert.match(deck.load.report, new RegExp(`First failure: drive: ${why.source}`));
  assert.ok(tab.kinds().lastIndexOf('drive stop') > tab.kinds().lastIndexOf('drive accelerate'), 'the drive is stopped');
});

test('a player at the very start of the track is not flushed (nothing behind its place to try it on): noted, and the drive goes on as before', async () => {
  const { result, deck } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1, flush: 'start' });
  assert.equal(result.kind, 'live');
  assert.match(deck.load.report, /note: the player was not flushed: it had only just started, with nothing behind its place to try a flush on/);
});

test('a flush the player refuses (it has ended its stream) is noted in the report, the drive goes on as it did before, and the DJ is told to reload the tab', async () => {
  const { result, engine, deck } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1, flush: 'ended' });
  assert.equal(result.kind, 'live');
  assert.match(deck.load.report, /note: the player was not flushed: it had loaded the whole track and ended its stream/);
  const why = /the player buffered the whole track, but 0\.0–24\.0 s came before the deck could read it: reload the tab, then load it again/;
  assert.match(deck.load.report, new RegExp(`drive \\(seek-hop, then accelerate 8× from 0\\.0 s\\): failed in \\d+\\.\\d s — ${why.source}\\n`));
  assert.match(called(engine, 'failLoadingToLive')[0].reason, why);
});

test('a seek-hop the player says has stalled goes to accelerate after a stall, even while bytes keep coming from elsewhere (shaka going on from its last segment)', async () => {
  const { result, tab } = await load({ kind: 'mse', rendition: hi(), preTap: 6, playing: 1, seekhop: 'trickle', evicts: true });
  assert.equal(result.kind, 'resident', JSON.stringify(tab.sent().filter((m) => m.t === 'drive')));
  assert.deepEqual(drives(tab).map((m) => [m.mode, m.from]), [['seekhop', undefined], ['accelerate', undefined], ['accelerate', 0]]);
});
