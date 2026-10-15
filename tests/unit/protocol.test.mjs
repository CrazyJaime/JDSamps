import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECK_PARAMS, MASTER_PARAMS, DECK_ACTIONS, MASTER_ACTIONS, defaults, validateValue,
  validateUiMessage, validateAgentMessage, isSafeIconUrl, sanitizeTitle, recordingFilename, timestamp,
} from '../../shared/protocol.js';

test('defaults match the spec', () => {
  const d = defaults(DECK_PARAMS);
  assert.equal(d.keyLock, true);
  assert.equal(d.range, 0.1);
  assert.equal(d.syncMode, 'BEAT');
  assert.equal(d.xf, 'THRU');
  assert.equal(d.fader, 1);
  assert.equal(d['eq.low'], 0.5);
  const m = defaults(MASTER_PARAMS);
  assert.equal(m['master.limiter'], true);
  assert.equal(m['rec.format'], 'wav');
  assert.equal(m['xfader.curve'], 'SMOOTH');
});

test('validateValue clamps numbers and rejects junk', () => {
  assert.deepEqual(validateValue(DECK_PARAMS.filter, 3), { ok: true, value: 1 });
  assert.deepEqual(validateValue(DECK_PARAMS.filter, -3), { ok: true, value: -1 });
  for (const bad of [NaN, Infinity, '0.5', null, undefined, {}]) {
    assert.equal(validateValue(DECK_PARAMS.filter, bad).ok, false, String(bad));
  }
  assert.equal(validateValue(DECK_PARAMS.keyLock, 1).ok, false);
  assert.equal(validateValue(DECK_PARAMS.xf, 'C').ok, false);
  assert.equal(validateValue(DECK_PARAMS.xf, 'A').ok, true);
  assert.equal(validateValue(undefined, 1).ok, false);
});

test('validateUiMessage routes deck vs master tables', () => {
  assert.equal(validateUiMessage({ t: 'set', deck: 1, key: 'eq.hi', value: 0.7 }).ok, true);
  assert.equal(validateUiMessage({ t: 'set', deck: null, key: 'eq.hi', value: 0.7 }).ok, false);
  assert.equal(validateUiMessage({ t: 'set', deck: null, key: 'xfader.pos', value: 0.2 }).ok, true);
  assert.equal(validateUiMessage({ t: 'set', deck: '1', key: 'eq.hi', value: 0.7 }).ok, false);
  assert.equal(validateUiMessage({ t: 'set', deck: 1, key: '__proto__', value: 1 }).ok, false);
  assert.equal(validateUiMessage({ t: 'act', deck: 2, a: 'play' }).ok, true);
  assert.equal(validateUiMessage({ t: 'act', deck: null, a: 'play' }).ok, false);
  assert.equal(validateUiMessage({ t: 'act', deck: null, a: 'mixRecStart' }).ok, true);
  assert.equal(validateUiMessage({ t: 'hello' }).ok, true);
  assert.equal(validateUiMessage({ t: 'nope' }).ok, false);
  assert.equal(validateUiMessage(null).ok, false);
});

test('action arguments are validated and normalised', () => {
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'nudge', arg: { dir: 1, fine: 1 } }).arg, { dir: 1, fine: true });
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'nudge', arg: { dir: 2 } }).ok, false);
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'mult', arg: { factor: 2 } }).arg, { factor: 2 });
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'mult', arg: { factor: 3 } }).ok, false);
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'gridShift', arg: { beats: 0.5 } }).arg, { beats: 0.5, ms: 0 });
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'gridShift', arg: { ms: -10 } }).arg, { beats: 0, ms: -10 });
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'gridShift', arg: { ms: 99 } }).ok, false);
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'rollStart', arg: { beats: 0.25 } }).arg, { beats: 0.25 });
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'rollStart', arg: { beats: 3 } }).ok, false);
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'sync', arg: { on: false } }).arg, { on: false });
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'sync' }).arg, { on: null });
  assert.deepEqual(validateUiMessage({ t: 'act', deck: 1, a: 'tap', arg: { wallMs: 123.5 } }).arg, { wallMs: 123.5 });
  assert.equal(validateUiMessage({ t: 'act', deck: 1, a: 'tap', arg: { wallMs: 'x' } }).ok, false);
  for (const a of DECK_ACTIONS) assert.equal(typeof a, 'string');
  for (const a of MASTER_ACTIONS) assert.equal(typeof a, 'string');
});

test('validateAgentMessage rejects hostile payloads', () => {
  assert.deepEqual(validateAgentMessage({ t: 'status', hasMedia: true, playing: false, rate: 1.03, preservesPitch: false, count: 2 }),
    { t: 'status', hasMedia: true, playing: false, rate: 1.03, preservesPitch: false, count: 2 });
  for (const bad of [
    null, 'x', {}, { t: 'status' }, { t: 'status', hasMedia: 'yes', playing: true, rate: 1 },
    { t: 'status', hasMedia: true, playing: true, rate: NaN }, { t: 'status', hasMedia: true, playing: true, rate: 1e9 },
    { t: 'external-rate', rate: -1 }, { t: 'evil', rate: 1 },
  ]) assert.equal(validateAgentMessage(bad), null, JSON.stringify(bad));
  assert.deepEqual(validateAgentMessage({ t: 'status', hasMedia: true, playing: true, rate: 1, count: 1e9 }).count, 0);
  assert.deepEqual(validateAgentMessage({ t: 'external-rate', rate: 1.25 }), { t: 'external-rate', rate: 1.25 });
});

test('isSafeIconUrl only allows http(s) and data:image', () => {
  assert.equal(isSafeIconUrl('https://www.youtube.com/favicon.ico'), true);
  assert.equal(isSafeIconUrl('http://x/y.png'), true);
  assert.equal(isSafeIconUrl('data:image/png;base64,AAAA'), true);
  for (const bad of ['javascript:alert(1)', 'data:text/html;base64,AA', '" onerror="x', '', null, 42, 'chrome://favicon/x', 'x'.repeat(5000)]) {
    assert.equal(isSafeIconUrl(bad), false, String(bad).slice(0, 40));
  }
});

test('filenames are sanitised', () => {
  assert.equal(sanitizeTitle('Daft Punk — One More Time (Official Video) | YouTube'), 'Daft Punk_One More Time_Official Video_YouTube');
  assert.equal(sanitizeTitle('../../etc/passwd'), 'etc_passwd');
  assert.equal(sanitizeTitle('<img src=x onerror=alert(1)>'), 'img src_x onerror_alert_1');
  assert.equal(sanitizeTitle(''), 'tab');
  assert.equal(sanitizeTitle('a'.repeat(200)).length, 60);
  const d = new Date(2026, 9, 15, 1, 2, 3);
  assert.equal(timestamp(d), '20261015-010203');
  assert.equal(recordingFilename('D2', 'My Track', 'wav', d), 'JDSamps-D2-My Track-20261015-010203.wav');
  assert.equal(recordingFilename('mix', 'Master', 'webm', d), 'JDSamps-mix-Master-20261015-010203.webm');
});
