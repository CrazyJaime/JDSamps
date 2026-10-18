// The page tap's messages (agent -> engine) are untrusted page-adjacent data: validateAgentMessage
// passes on only what the I3 contract allows, with every number, string and list bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentMessage, TAP_ERRORS } from '../../shared/protocol.js';

const BLOB = 'blob:https://example.com/0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
const part = (o = {}) => ({ blobUrl: BLOB, mime: 'audio/mp4; codecs="opus"', kind: 'media', sb: 0, seq: 3, ...o });

test('tap-progress: bytes, buffered ranges, duration and mimes, bounded', () => {
  const m = { t: 'tap-progress', bytes: 123456, buffered: [[0, 20.5], [40, 44]], duration: 180.02, mimes: ['audio/mp4; codecs="opus"'] };
  assert.deepEqual(validateAgentMessage(m), m);
  assert.deepEqual(validateAgentMessage({ ...m, duration: null, evil: 1 }), { ...m, duration: null });
  // A duration that is not a sane finite length reads as unknown, never as a number.
  for (const duration of [Infinity, -1, 0, NaN, '180', undefined]) assert.equal(validateAgentMessage({ ...m, duration }).duration, null, String(duration));
  for (const bad of [
    { ...m, bytes: -1 }, { ...m, bytes: NaN }, { ...m, bytes: '9' },
    { ...m, buffered: 'x' }, { ...m, buffered: [[5, 1]] }, { ...m, buffered: [[0, NaN]] }, { ...m, buffered: [[0]] },
    { ...m, buffered: Array.from({ length: 1000 }, (_, i) => [i, i + 0.5]) },
    { ...m, mimes: 'audio/mp4' }, { ...m, mimes: [5] }, { ...m, mimes: ['x'.repeat(300)] }, { ...m, mimes: Array(100).fill('audio/mp4') },
  ]) assert.equal(validateAgentMessage(bad), null, JSON.stringify(bad).slice(0, 120));
});

test('tap-urls: media requests with method, Range and size; only http(s) links', () => {
  const r = { url: 'https://cdn.example.com/a/seg-00004.m4s?sig=abc', method: 'GET', range: 'bytes=0-999', size: 1000, media: true };
  assert.deepEqual(validateAgentMessage({ t: 'tap-urls', reqs: [r] }), { t: 'tap-urls', reqs: [r] });
  // A request the page made before the tap was on (from its resource history) says so.
  assert.deepEqual(validateAgentMessage({ t: 'tap-urls', reqs: [{ ...r, range: null, size: null, past: true }] }).reqs, [{ ...r, range: null, size: null, past: true }]);
  assert.deepEqual(validateAgentMessage({ t: 'tap-urls', reqs: [{ ...r, past: 'yes' }] }).reqs, [r]);
  for (const bad of [
    { t: 'tap-urls' }, { t: 'tap-urls', reqs: [] }, { t: 'tap-urls', reqs: 'x' },
    { t: 'tap-urls', reqs: [{ ...r, url: 'javascript:alert(1)' }] }, { t: 'tap-urls', reqs: [{ ...r, url: 'file:///etc/passwd' }] },
    { t: 'tap-urls', reqs: [{ ...r, url: `https://x.com/${'a'.repeat(9000)}` }] },
    { t: 'tap-urls', reqs: [{ ...r, method: 'get it' }] }, { t: 'tap-urls', reqs: [{ ...r, media: 1 }] },
    { t: 'tap-urls', reqs: [{ ...r, size: -5 }] }, { t: 'tap-urls', reqs: [{ ...r, range: 7 }] },
    { t: 'tap-urls', reqs: Array(100).fill(r) },
  ]) assert.equal(validateAgentMessage(bad), null, JSON.stringify(bad).slice(0, 120));
});

test('tap-ready: blob-URL parts only, with kind, SourceBuffer and sequence', () => {
  const m = { t: 'tap-ready', parts: [part({ kind: 'init', seq: 0 }), part({ seq: 1 }), part({ kind: 'file', sb: -1, seq: 0, mime: '' })], duration: 30 };
  assert.deepEqual(validateAgentMessage(m), m);
  assert.deepEqual(validateAgentMessage({ ...m, duration: Infinity }).duration, null);
  for (const bad of [
    { ...m, parts: [] }, { ...m, parts: 'x' },
    { ...m, parts: [part({ blobUrl: 'https://example.com/a.mp3' })] }, { ...m, parts: [part({ blobUrl: 'blob:evil' })] },
    { ...m, parts: [part({ kind: 'video' })] }, { ...m, parts: [part({ sb: -2 })] }, { ...m, parts: [part({ sb: 1.5 })] },
    { ...m, parts: [part({ seq: -1 })] }, { ...m, parts: [part({ mime: 7 })] }, { ...m, parts: [part({ mime: 'x'.repeat(300) })] },
    { ...m, parts: Array(300).fill(part()) },
  ]) assert.equal(validateAgentMessage(bad), null, JSON.stringify(bad).slice(0, 120));
});

test('tap-error: a known reason and a short plain detail', () => {
  assert.deepEqual([...TAP_ERRORS], ['drm', 'worker', 'preview', 'live', 'none', 'fetch']);
  for (const reason of TAP_ERRORS) assert.deepEqual(validateAgentMessage({ t: 'tap-error', reason, detail: 'x' }), { t: 'tap-error', reason, detail: 'x' });
  assert.equal(validateAgentMessage({ t: 'tap-error', reason: 'none', detail: 'y'.repeat(2000) }).detail.length, 300);
  assert.deepEqual(validateAgentMessage({ t: 'tap-error', reason: 'drm' }), { t: 'tap-error', reason: 'drm', detail: '' });
  for (const bad of [{ t: 'tap-error' }, { t: 'tap-error', reason: 'evil', detail: '' }, { t: 'tap-error', reason: 'DRM', detail: '' }]) {
    assert.equal(validateAgentMessage(bad), null, JSON.stringify(bad));
  }
});
