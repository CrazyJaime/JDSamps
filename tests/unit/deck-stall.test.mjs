// A stalled main thread (the engine shares it with the deck page and the service worker) leaves a
// backlog of input chunk messages and engine ticks. The stretcher keeps getting its audio straight from
// the input worklet, but the backlogged ticks run at the current time with a live edge that is still
// catching up: the reserve looks empty when it is not. The deck must not act on such a stale edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck } from './fixtures/deck-harness.mjs';

const SR = 48000, CH = 2048, DT = 1536 / SR;

/** A deck playing +3 % (faster than its source) with `reserve` s buffered, fed chunk by chunk in real time. */
async function playing(reserve) {
  const clock = { t: 10 };
  const engine = makeEngine(clock);
  const d = makeDeck(engine, clock, { pitch: 0.03, liveEdge: 0 });
  const feed = { frames: 0, start: 0, queue: [] };
  // What the input worklet posts: a chunk every 2048 frames, stamped with the audio frame it was made at.
  feed.produce = () => {
    feed.frames += DT * SR;
    while (feed.frames >= CH) {
      feed.frames -= CH;
      feed.queue.push({ t: 'chunk', start: feed.start, L: new Float32Array(CH), R: new Float32Array(CH), at: Math.round(clock.t * SR), peak: 0, firstAbove: -1 });
      feed.start += CH;
    }
  };
  feed.deliver = () => { for (const m of feed.queue.splice(0)) d.onInput(m); };
  while (d.ts.liveEdge < reserve + d.ts.lat + 0.02) { clock.t += DT; feed.produce(); feed.deliver(); }
  await d.act('play');
  for (let i = 0; i < 40; i++) { clock.t += DT; feed.produce(); feed.deliver(); d.tick(clock.t); }
  return { clock, d, feed };
}

test('after a 2 s main-thread stall, backlogged ticks do not jump or starve a deck whose live edge is catching up', async () => {
  const { clock, d, feed } = await playing(1.0);
  const before = d.node.log.length;
  assert.ok(d.ts.reserveAt(clock.t) > 0.8, `reserve ${d.ts.reserveAt(clock.t)}`);
  // The stall: the audio thread keeps making chunks (and the stretcher keeps getting them directly);
  // the main thread runs nothing. Then the backlog: each queued tick runs at the current time.
  const backlog = [];
  for (let i = 0; i < Math.round(2 / DT); i++) { clock.t += DT; feed.produce(); backlog.push(feed.queue.splice(0)); }
  let starved = false;
  for (const chunks of backlog) {
    for (const m of chunks) d.onInput(m);
    d.tick(clock.t);
    starved = starved || d.starved;
  }
  assert.deepEqual(d.node.log.slice(before), [], 'no schedule() from a stale reserve (emergency jump or 1x clamp)');
  assert.equal(starved, false);
  // Caught up: the reserve is right again and the deck carries on.
  assert.ok(d.ts.reserveAt(clock.t) > 0.8, `reserve ${d.ts.reserveAt(clock.t)}`);
});

test('a fresh live edge still starves a deck that is really out of reserve, and a stale tick does not clear it', async () => {
  const { clock, d, feed } = await playing(0.3);
  assert.equal(d.starved, true, `reserve ${d.ts.reserveAt(clock.t)}: the deck plays at its source speed`);
  clock.t += 1; // a stall: no chunk for a second
  d.tick(clock.t);
  assert.equal(d.starved, true, 'kept while the live edge is stale');
  feed.produce(); feed.deliver();
  d.tick(clock.t);
  assert.equal(d.starved, true, 'and re-evaluated once it is fresh');
});
