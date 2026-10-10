// Node unit tests for the pure parts of the shell (owner: D): icons markup + dom.js helpers.
//   node moviemaker/tests/shell-unit.test.mjs
import assert from 'node:assert/strict';
import { iconSVG, ICON_NAMES, hasIcon } from '../js/ui/icons.js';
import { clamp, debounce, formatSeconds, rafThrottle } from '../js/ui/dom.js';

let n = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log(`  ok   ${name}`); }, (e) => { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; });

await t('icon set has at least 70 icons', () => assert.ok(ICON_NAMES.length >= 70, `only ${ICON_NAMES.length}`));

await t('every icon renders well-formed markup without NaN/undefined', () => {
  for (const name of ICON_NAMES) {
    const s = iconSVG(name, 16);
    assert.ok(s.startsWith('<svg') && s.endsWith('</svg>'), name);
    assert.ok(!/NaN|undefined|null/.test(s), `${name} contains NaN/undefined`);
    // tags balance (self-closing or paired)
    const open = (s.match(/<(?!\/)[a-zA-Z]+[^>]*[^/]>/g) || []).length;
    const close = (s.match(/<\/[a-zA-Z]+>/g) || []).length;
    assert.equal(open, close, `${name}: ${open} open vs ${close} close tags`);
  }
});

await t('required icon names from the brief exist (or alias)', () => {
  const required = ['film', 'photos', 'add-videos', 'webcam', 'narration-mic', 'snapshot-camera', 'music-note', 'title', 'caption', 'credits',
    'automovie', 'cut', 'copy', 'paste', 'rotate-left', 'rotate-right', 'remove', 'select-all', 'save-movie', 'save', 'undo', 'redo',
    'play', 'pause', 'prev-frame', 'next-frame', 'split', 'trim', 'set-start', 'set-end', 'volume', 'fade-in', 'fade-out', 'speed',
    'duration', 'background-color', 'font', 'bold', 'italic', 'align-left', 'align-center', 'align-right', 'text-color', 'outline',
    'transparency', 'start-time', 'zoom-in', 'zoom-out', 'aspect-wide', 'aspect-standard', 'aspect-portrait', 'aspect-square',
    'audio-mix', 'emphasize', 'fit-to-music', 'waveform', 'thumb-small', 'thumb-medium', 'thumb-large', 'preview-size', 'fullscreen',
    'menu', 'help', 'info', 'folder-open', 'new', 'share', 'close', 'check', 'chevron-down', 'chevron-up', 'chevron-left', 'chevron-right'];
  const missing = required.filter((r) => !hasIcon(r));
  assert.deepEqual(missing, []);
});

await t('unknown icon falls back to a placeholder', () => {
  const orig = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    const s = iconSVG('no-such-icon');
    assert.ok(s.includes('ic-placeholder'));
    iconSVG('no-such-icon');
    assert.equal(warned, 1, 'warns once per unknown name');
  } finally { console.warn = orig; }
});

await t('clamp', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp('2', 0, 3), 2);
  assert.equal(clamp(NaN, 1, 3), 1);
});

await t('formatSeconds', () => {
  assert.equal(formatSeconds(7), '7.00');
  assert.equal(formatSeconds(65.4), '1:05.40');
  assert.equal(formatSeconds(-3), '0.00');
});

await t('debounce runs once with the last args; cancel and flush work', async () => {
  const calls = [];
  const d = debounce((x) => calls.push(x), 20);
  d(1); d(2); d(3);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, [3]);
  d(4); d.cancel();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls, [3]);
  d(5); d.flush();
  assert.deepEqual(calls, [3, 5]);
});

await t('rafThrottle coalesces to one call (setTimeout fallback in node)', async () => {
  const calls = [];
  const f = rafThrottle((x) => calls.push(x));
  f(1); f(2); f(3);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls, [3]);
});

console.log(`\n${n} passed${process.exitCode ? ', some FAILED' : ''}`);
