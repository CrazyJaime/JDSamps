import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let server, browser, page;

before(async () => {
  server = await startStaticServer(ROOT, {
    '/__controls.html': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><link rel="stylesheet" href="/deck.css"><body style="padding:40px">
        <div id="k" class="knob"></div><div id="f" class="vfader" style="height:200px"></div><button id="p" class="pad">P</button>
        <div id="s" class="seg"><button data-v="A">A</button><button data-v="THRU">THRU</button><button data-v="0.5">x</button></div>
        <script type="module">
          import { Knob, Fader, bindPad, bindSeg } from '/ui/controls.js';
          window.log = [];
          window.knob = new Knob(document.getElementById('k'), { label: 'HI', def: 0.5, value: 0.5, onChange: (v) => log.push(['k', v]) });
          window.fader = new Fader(document.getElementById('f'), { label: 'FADER', def: 1, value: 1, onChange: (v) => log.push(['f', v]) });
          window.pad = bindPad(document.getElementById('p'), { latch: true, onDown: () => log.push(['down']), onUp: () => log.push(['up']) });
          window.seg = bindSeg(document.getElementById('s'), { onSelect: (v) => log.push(['seg', v]) });
          // Fresh control per test in #x; window.c is the current one.
          window.mk = (kind, o) => {
            const el = document.createElement('div');
            el.className = kind === 'knob' ? 'knob' : 'vfader';
            if (kind === 'fader') el.style.height = '200px';
            document.getElementById('x').replaceChildren(el);
            window.c = new (kind === 'knob' ? Knob : Fader)(el, { label: 'X', onChange: (v) => log.push(['c', v]), ...o });
            return true;
          };
          window.wheel = (init, n = 1) => {
            const el = window.c.el.querySelector('svg') || window.c.el;
            let prevented = 0;
            for (let i = 0; i < n; i++) {
              const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
              el.dispatchEvent(e);
              if (e.defaultPrevented) prevented++;
            }
            return { value: window.c.value, prevented };
          };
          window.ready = true;
        </script><div id="x" style="margin-top:20px"></div>`);
    },
  });
  browser = await launchPlain();
  page = await browser.newPage();
  await page.goto(`${server.origin}/__controls.html`);
  await page.waitForFunction(() => window.ready);
});
after(async () => { await browser?.close(); await server?.close(); });

const log = () => page.evaluate(() => window.log.splice(0));

test('knob drags up, double-click resets, keys step, aria reflects value', async () => {
  const box = await page.locator('#k svg').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 90, { steps: 6 });
  await page.mouse.up();
  const v = await page.evaluate(() => window.knob.value);
  assert.ok(Math.abs(v - 1) < 0.02, `dragged to ${v}`);
  await page.locator('#k svg').dblclick();
  assert.equal(await page.evaluate(() => window.knob.value), 0.5);
  await page.locator('#k').focus();
  await page.keyboard.press('ArrowUp');
  assert.ok(Math.abs((await page.evaluate(() => window.knob.value)) - 0.51) < 1e-9);
  assert.equal(await page.getAttribute('#k', 'role'), 'slider');
  assert.equal(await page.getAttribute('#k', 'aria-valuenow'), '0.510');
  const l = await log();
  assert.ok(l.length >= 3 && l.every((x) => x[0] === 'k'));
});

test('external set is ignored while dragging', async () => {
  const box = await page.locator('#f').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 80, { steps: 4 });
  await page.evaluate(() => window.fader.set(1));
  const during = await page.evaluate(() => window.fader.value);
  await page.mouse.up();
  assert.ok(during < 0.9, `value during drag ${during}`);
  await page.evaluate(() => window.fader.set(1)); // a stale echo just after the drag is still ignored
  assert.equal(await page.evaluate(() => window.fader.value), during);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.fader.set(0.25));
  assert.equal(await page.evaluate(() => window.fader.value), 0.25);
});

test('pad: tap latches, second tap releases, hold is momentary', async () => {
  await log();
  await page.locator('#p').click();
  assert.deepEqual(await log(), [['down']]);
  assert.equal(await page.getAttribute('#p', 'aria-pressed'), 'true');
  await page.locator('#p').click();
  assert.deepEqual(await log(), [['up']]);
  const box = await page.locator('#p').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(320);
  await page.mouse.up();
  assert.deepEqual(await log(), [['down'], ['up']]);
  assert.equal(await page.getAttribute('#p', 'aria-pressed'), 'false');
});

test('segmented control parses values and reflects selection', async () => {
  await log();
  await page.locator('#s button[data-v="0.5"]').click();
  assert.deepEqual(await log(), [['seg', 0.5]]);
  await page.evaluate(() => window.seg.set('THRU'));
  assert.equal(await page.getAttribute('#s button[data-v="THRU"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('#s button[data-v="A"]', 'aria-pressed'), 'false');
});

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const mk = (kind, o = {}) => page.evaluate(([k, x]) => window.mk(k, x), [kind, o]);
const wheel = (init, n = 1) => page.evaluate(([i, k]) => window.wheel(i, k), [init, n]);
const cval = () => page.evaluate(() => window.c.value);
const cbox = () => page.locator('#x > *').boundingBox();

test('wheel: a sideways swipe never moves a control and is left to scroll the page', async () => {
  await mk('knob', { def: 0.5, value: 0.5 });
  let r = await wheel({ deltaX: 40, deltaY: 0 }, 30);
  assert.equal(r.value, 0.5);
  assert.equal(r.prevented, 0);
  r = await wheel({ deltaX: -60, deltaY: 20 }, 10);
  assert.equal(r.value, 0.5);
  // The same gesture from real input, over a fader.
  await mk('fader', { def: 1, value: 1 });
  const b = await cbox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(40, 0);
  await page.waitForTimeout(50);
  assert.equal(await cval(), 1);
});

test('wheel: small trackpad deltas accumulate into whole steps', async () => {
  await mk('knob', { def: 0.5, value: 0.5 });
  let r = await wheel({ deltaY: -2 }, 20); // 40 px: not a step yet
  assert.equal(r.value, 0.5);
  r = await wheel({ deltaY: -2 }, 30); // 100 px in all: two steps
  assert.ok(near(r.value, 0.52), `value ${r.value}`);
});

test('wheel: one mouse notch is one step, whatever the deltaMode', async () => {
  await mk('knob', { def: 0.5, value: 0.5 });
  assert.ok(near((await wheel({ deltaY: -100 })).value, 0.51));
  assert.ok(near((await wheel({ deltaY: -120 })).value, 0.52));
  assert.ok(near((await wheel({ deltaY: -3, deltaMode: 1 })).value, 0.53)); // 3 lines
  assert.ok(near((await wheel({ deltaY: 1, deltaMode: 2 })).value, 0.52)); // 1 page
});

test('wheel: Shift is fine, and Shift+wheel delivered as deltaX keeps its direction', async () => {
  await mk('knob', { def: 0.5, value: 0.5 });
  assert.ok(near((await wheel({ deltaX: -100, deltaY: 0, shiftKey: true })).value, 0.502));
  assert.ok(near((await wheel({ deltaX: -100, deltaY: 0, shiftKey: true })).value, 0.504));
  assert.ok(near((await wheel({ deltaX: 100, deltaY: 0, shiftKey: true })).value, 0.502));
  assert.ok(near((await wheel({ deltaY: -100, shiftKey: true })).value, 0.504));
});

test('wheel: a control built with wheel:false ignores the wheel', async () => {
  await mk('fader', { def: 1, value: 0.5, wheel: false });
  const r = await wheel({ deltaY: -100 }, 3);
  assert.equal(r.value, 0.5);
  assert.equal(r.prevented, 0);
});

test('double-click after a tap-then-drag re-grab does not reset', async () => {
  await mk('fader', { def: 1, value: 0.1 });
  const b = await cbox();
  const x = b.x + b.width / 2, y = b.y + b.height - 30;
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
  await page.waitForTimeout(80);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(x, y + 15, { steps: 3 });
  await page.mouse.up({ clickCount: 2 });
  await page.waitForTimeout(50);
  const v = await cval();
  assert.ok(v < 0.1, `fader jumped to ${v}`);
});

test('double-click after a drag-then-tap does not reset', async () => {
  await mk('knob', { def: 0.5, value: 0.8 });
  const b = await page.locator('#x svg').boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.move(x, y + 20, { steps: 3 });
  await page.mouse.up({ clickCount: 1 });
  const dragged = await cval();
  assert.ok(dragged < 0.8);
  await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
  await page.waitForTimeout(50);
  assert.equal(await cval(), dragged);
});

test('a still double-click resets, unless the control is built with reset:false', async () => {
  await mk('fader', { def: 1, value: 0.3 });
  await page.locator('#x > *').dblclick();
  assert.equal(await cval(), 1);
  await mk('fader', { def: 1, value: 0.3, reset: false });
  await page.locator('#x > *').dblclick();
  assert.equal(await cval(), 0.3);
});

test('stale engine echoes do not overwrite a fresh local commit', async () => {
  await mk('knob', { def: 0.5, value: 0.5 });
  await page.locator('#x > *').focus();
  await page.keyboard.press('ArrowUp'); // local commit 0.51
  await page.evaluate(() => window.c.set(0.5)); // snapshot taken before the engine applied it
  assert.ok(near(await cval(), 0.51));
  await page.evaluate(() => window.c.set(0.51)); // the echo of what was sent
  await page.evaluate(() => window.c.set(0.7)); // a real engine-side change now applies at once
  assert.equal(await cval(), 0.7);
  await page.keyboard.press('ArrowUp'); // 0.71
  await page.evaluate(() => window.c.set(0.7));
  assert.ok(near(await cval(), 0.71));
  await page.waitForTimeout(300); // the hold expires even if no matching echo came back
  await page.evaluate(() => window.c.set(0.3));
  assert.equal(await cval(), 0.3);
});

// Switching away mid-press: the release (pointerup / keyup) goes to another window or tab, so the
// control lets go when the window loses focus or the page is hidden.
const hide = () => page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
const unhide = () => page.evaluate(() => { delete document.hidden; });

test('a held pad lets go when the window loses focus or the page is hidden', async () => {
  await log();
  const box = await page.locator('#p').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(300); // held: momentary
  assert.deepEqual(await log(), [['down']]);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.deepEqual(await log(), [['up']]);
  await page.mouse.up();
  assert.deepEqual(await log(), [], 'let go once');
  await page.mouse.down();
  await page.waitForTimeout(300);
  assert.deepEqual(await log(), [['down']]);
  await hide();
  assert.deepEqual(await log(), [['up']]);
  await unhide();
  await page.mouse.up();
  assert.deepEqual(await log(), []);
  assert.equal(await page.getAttribute('#p', 'aria-pressed'), 'false');
});

test('a drag ends when the window loses focus, so engine values apply again', async () => {
  const box = await page.locator('#f').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 60, { steps: 3 });
  assert.equal(await page.evaluate(() => window.fader.dragging), true);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await page.evaluate(() => window.fader.dragging), false);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.fader.set(0.75));
  assert.equal(await page.evaluate(() => window.fader.value), 0.75);
  await page.mouse.up();
});
