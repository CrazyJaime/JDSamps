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
          window.ready = true;
        </script>`);
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
