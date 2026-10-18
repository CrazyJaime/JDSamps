// Resident decks, engine side: the memory limit on a decoded track, and the UI actions and settings
// that load whole tracks (the parts that run without a browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { limitPcm } from '../../engine/decode.js';
import { validateUiMessage, defaults, MASTER_PARAMS, PERSISTED_MASTER_KEYS, DECK_ACTIONS, MASTER_ACTIONS } from '../../shared/protocol.js';

test('a source longer than the resident limit is cut to the limit and says so', () => {
  const sr = 1000, n = 20 * 60 * sr, L = new Float32Array(n), R = new Float32Array(n);
  L[n - 1] = 1;
  const r = limitPcm({ L, R, sampleRate: sr }, 15);
  assert.equal(r.pcm.L.length, 15 * 60 * sr);
  assert.equal(r.pcm.R.length, 15 * 60 * sr);
  assert.equal(r.pcm.sampleRate, sr);
  assert.equal(r.pcm.L.buffer.byteLength, 15 * 60 * sr * 4, 'the cut track still holds the whole source in memory');
  assert.match(r.notice, /20 minutes/);
  assert.match(r.notice, /first 15 minutes/);
  assert.match(limitPcm({ L, R, sampleRate: sr }, 1).notice, /first 1 minute\b/);
});

test('a source within the resident limit is kept whole, with no notice', () => {
  const pcm = { L: new Float32Array(1000), R: new Float32Array(1000), sampleRate: 1000 };
  const r = limitPcm(pcm, 15);
  assert.equal(r.pcm, pcm);
  assert.equal(r.notice, null);
});

test('loadFile / loadUrl / loadCancel / recordWhole are valid UI actions; junk is not', () => {
  assert.ok(MASTER_ACTIONS.includes('loadFile') && MASTER_ACTIONS.includes('loadUrl'));
  assert.ok(DECK_ACTIONS.includes('loadCancel') && DECK_ACTIONS.includes('recordWhole'));
  const ok = (m) => { const v = validateUiMessage(m); assert.equal(v.ok, true, `${JSON.stringify(m)}: ${v.error}`); return v; };
  const bad = (m) => assert.equal(validateUiMessage(m).ok, false, JSON.stringify(m));
  assert.deepEqual(ok({ t: 'act', deck: null, a: 'loadFile', arg: { name: 'a.mp3', blobUrl: 'blob:chrome-extension://x/y' } }).arg, { name: 'a.mp3', blobUrl: 'blob:chrome-extension://x/y' });
  assert.deepEqual(ok({ t: 'act', deck: null, a: 'loadUrl', arg: { url: 'https://example.com/a.mp3' } }).arg, { url: 'https://example.com/a.mp3' });
  ok({ t: 'act', deck: null, a: 'loadUrl', arg: { url: 'http://127.0.0.1:8080/x?y=1' } });
  ok({ t: 'act', deck: 3, a: 'loadCancel', arg: {} });
  ok({ t: 'act', deck: 3, a: 'recordWhole' });
  bad({ t: 'act', deck: null, a: 'loadUrl', arg: { url: 'javascript:alert(1)' } });
  bad({ t: 'act', deck: null, a: 'loadUrl', arg: { url: 'file:///etc/passwd' } });
  bad({ t: 'act', deck: null, a: 'loadUrl', arg: { url: 'not a url' } });
  bad({ t: 'act', deck: null, a: 'loadUrl', arg: { url: 42 } });
  bad({ t: 'act', deck: null, a: 'loadUrl', arg: { url: `https://example.com/${'a'.repeat(9000)}` } });
  bad({ t: 'act', deck: null, a: 'loadFile', arg: { name: 'a.mp3', blobUrl: 'https://example.com/a.mp3' } });
  bad({ t: 'act', deck: null, a: 'loadFile', arg: { name: 'a.mp3' } });
  bad({ t: 'act', deck: null, a: 'loadFile', arg: { name: 7, blobUrl: 'blob:chrome-extension://x/y' } });
  bad({ t: 'act', deck: 3, a: 'loadFile', arg: { name: 'a.mp3', blobUrl: 'blob:chrome-extension://x/y' } }); // a master action
  bad({ t: 'act', deck: null, a: 'loadCancel', arg: {} }); // a deck action
});

test('the resident track limit (1..60 min, default 15) and whole-track recording (default off) are persisted settings', () => {
  const d = defaults(MASTER_PARAMS);
  assert.equal(d['resident.limitMin'], 15);
  assert.equal(d['resident.recordWhole'], false);
  assert.ok(PERSISTED_MASTER_KEYS.includes('resident.limitMin') && PERSISTED_MASTER_KEYS.includes('resident.recordWhole'));
  assert.deepEqual(validateUiMessage({ t: 'set', deck: null, key: 'resident.limitMin', value: 90 }), { ok: true, value: 60 });
  assert.deepEqual(validateUiMessage({ t: 'set', deck: null, key: 'resident.limitMin', value: 0 }), { ok: true, value: 1 });
  assert.equal(validateUiMessage({ t: 'set', deck: null, key: 'resident.recordWhole', value: 'yes' }).ok, false);
});
