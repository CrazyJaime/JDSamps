// Node unit tests for js/text.js placement: align/valign, and free placement by style.x / style.y
// (block centre as a fraction of the frame) and style.w (wrap width as a fraction of the frame).
// Run: node /home/user/JDSamps/moviemaker/tests/text.unit.mjs
import assert from 'node:assert/strict';
import { measureTextBox } from '../js/text.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   - ${name}`); } catch (err) {
    failed++;
    console.log(`FAIL - ${name}\n       ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : err}`);
  }
}

/** A 2D context stand-in: every character is half the font size wide. */
function fakeCtx() {
  return {
    font: '10px sans-serif',
    save() {}, restore() {},
    measureText(s) {
      const px = parseFloat(String(this.font).replace(/^(italic )?(bold )?/, '')) || 10;
      return { width: Array.from(String(s)).length * px * 0.5 };
    },
  };
}
const ST = { font: 'Arial, sans-serif', size: 8, bold: false, italic: false, color: '#ffffff', outline: 'none', outlineColor: '#000000', align: 'center', valign: 'bottom', opacity: 1, background: null };
const W = 1000, H = 500;
const centre = (b) => [b.x + b.width / 2, b.y + b.height / 2];
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);

test('align / valign placement without x/y (unchanged behaviour)', () => {
  const b = measureTextBox(fakeCtx(), { text: 'Mm', style: ST, w: W, h: H });
  const [cx] = centre(b);
  near(cx, 500, 0.01, 'centred');
  assert.ok(b.y + b.height > H * 0.85, 'bottom');
});

test('x / y place the block centre (preview drag support detection)', () => {
  const b = measureTextBox(fakeCtx(), { text: 'Mm', style: { ...ST, x: 0.25, y: 0.3 }, w: W, h: H });
  const [cx, cy] = centre(b);
  near(cx, 250, 3, 'x');
  near(cy, 150, 3, 'y');
});

test('x / y are clamped so the block stays inside the frame', () => {
  const b = measureTextBox(fakeCtx(), { text: 'Hello world', style: { ...ST, x: 0, y: 1 }, w: W, h: H });
  const pad = 8 / 100 * H * 0.35; // padX = 0.35 × font px
  assert.ok(b.x + pad >= -0.01, `left edge inside (${b.x})`);
  assert.ok(b.y + b.height <= H + 0.01 + pad, `bottom edge inside (${b.y + b.height})`);
});

test('only one of x / y → align / valign placement', () => {
  const a = measureTextBox(fakeCtx(), { text: 'Mm', style: { ...ST, x: 0.1 }, w: W, h: H });
  const b = measureTextBox(fakeCtx(), { text: 'Mm', style: ST, w: W, h: H });
  assert.deepEqual(a, b);
});

test('w sets the wrap width', () => {
  const text = 'Mm Mm Mm Mm Mm Mm Mm Mm';
  const narrow = measureTextBox(fakeCtx(), { text, style: { ...ST, x: 0.5, y: 0.5, w: 0.08 }, w: W, h: H });
  const wide = measureTextBox(fakeCtx(), { text, style: { ...ST, x: 0.5, y: 0.5 }, w: W, h: H });
  assert.ok(narrow.height > wide.height * 2, `wraps to more lines (${narrow.height} vs ${wide.height})`);
  assert.ok(narrow.width < wide.width, 'narrower block');
});

test('invalid x / y / w are ignored', () => {
  const a = measureTextBox(fakeCtx(), { text: 'Mm Mm', style: { ...ST, x: 'left', y: NaN, w: 7 }, w: W, h: H });
  const b = measureTextBox(fakeCtx(), { text: 'Mm Mm', style: ST, w: W, h: H });
  assert.deepEqual(a, b);
});

test('empty text with x / y: the tap target sits at the dragged place', () => {
  const b = measureTextBox(fakeCtx(), { text: '', style: { ...ST, x: 0.7, y: 0.2 }, w: W, h: H });
  const [cx, cy] = centre(b);
  near(cx, 700, 3, 'x');
  near(cy, 100, 3, 'y');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
