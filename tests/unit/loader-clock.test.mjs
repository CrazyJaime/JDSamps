// The loader on an injected clock, and the virtual clock the loader harness runs it on: time moves only when a
// virtual timer fires, and one fires only once everything already due (microtasks, immediates) has run. So a load's
// outcome never depends on how busy the machine is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from './fixtures/virtual-clock.mjs';
import { load, settle } from './fixtures/loader-harness.mjs';
import { TIMES } from '../../engine/loader.js';

test('a virtual timer fires only once the immediates and microtasks before it have run, one timer per macrotask', async () => {
  const clock = new VirtualClock(), seen = [];
  clock.setTimeout(() => seen.push(`t0 at ${clock.now()}`), 0);
  clock.setTimeout(() => { seen.push(`t5 at ${clock.now()}`); Promise.resolve().then(() => seen.push('t5 microtask')); setImmediate(() => seen.push('t5 immediate')); }, 5);
  clock.setTimeout(() => seen.push(`t5b at ${clock.now()}`), 5);
  // A chain of 30 immediates, each with a microtask, all due before any virtual time passes.
  let n = 0;
  const chain = () => { Promise.resolve().then(() => { if (++n < 30) setImmediate(chain); else seen.push('chain done'); }); };
  setImmediate(chain);
  await clock.sleep(10);
  assert.deepEqual(seen, ['chain done', 't0 at 0', 't5 at 5', 't5 microtask', 't5 immediate', 't5b at 5']);
  assert.equal(clock.now(), 10);
});

test('virtual intervals repeat, cleared timers never fire, and only unref\'d timers left stop the clock', async () => {
  const clock = new VirtualClock(), at = [];
  const iv = clock.setInterval(() => { at.push(clock.now()); if (at.length === 3) clock.clearInterval(iv); }, 20);
  const never = clock.setTimeout(() => at.push('never'), 30);
  clock.clearTimeout(never);
  await clock.sleep(100);
  assert.deepEqual(at, [20, 40, 60]);
  const idle = clock.setInterval(() => at.push('idle'), 5);
  idle.unref();
  await settle(10);
  assert.equal(clock.now(), 100, 'an unref\'d timer alone does not move the clock');
  clock.clearInterval(idle);
});

test('a load runs on the clock it is given: its waits are virtual, so the slow default waits take no real time', async () => {
  // A Web-Audio page: no agent ever connects, so the load waits out the whole 2 s grace before it goes live.
  const t0 = performance.now();
  const { result, engine, loader } = await load({ kind: 'none' }, { times: TIMES });
  const real = performance.now() - t0;
  assert.equal(result.kind, 'live');
  assert.ok(engine.clock.now() >= TIMES.grace, `the virtual clock moved ${engine.clock.now()} ms`);
  const connect = loader.rep.steps.find((s) => s.name === 'connect');
  assert.ok(Math.abs(connect.ms - TIMES.grace) < 1, `the connect step took ${connect.ms} ms of the loader's own time`);
  assert.ok(real < 1000, `the load took ${real.toFixed(0)} ms of real time`);
});
