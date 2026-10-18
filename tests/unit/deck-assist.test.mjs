// Player assist in the real Deck: what the engine commits to its source model, and when.
// The Deck runs on a fake clock with a fake stretch node; agents are fake ports that act like
// agent-main.js behind agent-relay.js (they answer commands with a status a little later).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Deck } from '../../engine/deck.js';
import { Timeshift } from '../../engine/timeshift.js';
import { MasterClock } from '../../engine/sync.js';

globalThis.chrome = globalThis.chrome || { runtime: {} };
const DT = 1536 / 48000;
// How long agent-main.js holds a rate without a command before it lets go of the page by itself.
const LET_GO = Number(/const LET_GO = (\d+);/.exec(fs.readFileSync(new URL('../../agent/agent-main.js', import.meta.url), 'utf8'))[1]) / 1000;

class FakeNode {
  constructor(clock) { this.clock = clock; this.map = [{ active: false, input: 0, output: 0, rate: 1, loopStart: 0, loopEnd: 0 }]; }
  addBuffers() { return 0; }
  schedule(obj) {
    const wNow = this.clock.t + 0.003;
    while (this.map.length && this.map[this.map.length - 1].output >= wNow) this.map.pop();
    this.map.push({ ...(this.map[this.map.length - 1] || {}), ...obj });
    return Promise.resolve();
  }
  dropBuffers(t) { return Promise.resolve({ start: t, end: 0 }); }
}

function fakeTempo(bpm) {
  return {
    bpm, grid: { t0: 0, T: 60 / bpm, bar1: null },
    get() { return { state: 'LOCKED', inBpm: this.bpm, conf: 0.9, mult: 1, tapped: false, grid: this.grid, canBeat: true }; },
    sourceRateChanged(ratio) { this.bpm *= ratio; this.grid = { ...this.grid, T: this.grid.T / ratio }; },
    pushBatch() {}, tap() {}, multiply() {}, shiftGrid() {}, setBar1() {},
  };
}

/** A playing deck at +6 % with ~4 s of reserve: assist wants to engage. */
async function setup({ pitch = 0.06 } = {}) {
  const clock = { t: 1 };
  const engine = {
    ctx: { get currentTime() { return clock.t; }, sampleRate: 48000 },
    params: { 'buffer.capSec': 240, 'assist.on': true, 'bpm.range': 'AUTO', 'rec.format': 'wav' },
    clock: new MasterClock(), decks: new Map(), events: [],
    master: { setAssign() {}, removeDeck() {} },
    event(level, text) { this.events.push({ level, text }); },
    broadcast() {}, updateClock() {}, wallNow: () => clock.t * 1000, ctxTimeAtWall: (w) => w / 1000, heardTime: () => clock.t,
  };
  const d = new Deck(engine, {
    id: 1, slot: 1, tabId: 10, stream: { getTracks: () => [], getAudioTracks: () => [] }, meta: { title: 't' },
    params: { pitch, range: 0.1, keyLock: true, syncMode: 'BEAT', fader: 1, xf: 'THRU', 'fx.type': 'ECHO', 'fx.beats': 0.5, 'fx.level': 0.5, 'fx.on': false },
  });
  d.ts = new Timeshift(new FakeNode(clock), { sampleRate: 48000, latency: 0.12, outLatency: 0.06, capSec: 240 });
  d.ts.liveEdge = 30;
  d.tempo = fakeTempo(124);
  d.grids.update(d.tempo.get().grid);
  d.analyser = { getFloatTimeDomainData() {} };
  d.meterBuf = new Float32Array(16);
  d.rack = { setClock() {}, tick() {}, setFx() {}, setFilter() {} };
  d.xfGain = { gain: { value: 1 } };
  d.recorder = { state: 'idle' };
  engine.decks.set(1, d);
  d.startAt(d.ts.soon(clock.t), d.ts.liveEdge - d.ts.lat - 4);
  return { clock, engine, d, agents: [] };
}

/**
 * A frame's agent. `page` is the media element the page plays: `obey` = it takes the rates the
 * agent sets; `audible` = whether the tab's captured sound comes from it. Like agent-main.js it
 * lets go of the page LET_GO after the last rate command, says so (selfReleased, with the wall
 * time), and then takes the page back only on a command with a new seq.
 */
function agent(env, frameId, { audible = true, obey = true, rate = 1, delay = 0.05 } = {}) {
  const page = { rate, base: rate, seq: 0, obey, enforcing: false, cmdAt: 0, letGo: 0 };
  const q = [];
  const port = {
    sent: [], listeners: [], dropListeners: [],
    onMessage: { addListener: (f) => port.listeners.push(f) },
    onDisconnect: { addListener: (f) => port.dropListeners.push(f) },
    postMessage(m) {
      port.sent.push({ at: env.clock.t, ...m });
      if (!(m.t === 'rate' && page.letGo && m.seq === page.seq)) {
        if (m.t === 'rate' || m.t === 'release') page.letGo = 0;
        if (Number.isSafeInteger(m.seq)) page.seq = m.seq;
        if (m.t === 'rate') { page.enforcing = true; page.cmdAt = env.clock.t; }
        if (m.t === 'rate' && page.obey) page.rate = m.rate;
        if (m.t === 'release') { page.rate = page.base; page.enforcing = false; }
      }
      port.reply(delay);
    },
    disconnect() {},
    status: () => ({
      t: 'status', hasMedia: true, playing: true, rate: page.rate, preservesPitch: page.rate === page.base,
      muted: !audible, volume: 1, audible: audible ? 1 : 0, count: 1, seq: page.seq,
      ...(page.letGo ? { selfReleased: true, releasedAt: page.letGo } : {}),
    }),
    /** The agent's own clock (its tab is not stalled with the engine): the watchdog. */
    watch(t) {
      if (!page.enforcing || t - page.cmdAt < LET_GO) return;
      const at = page.cmdAt + LET_GO;
      page.enforcing = false; page.rate = page.base; page.letGo = page.letGoAt = at * 1000; // the engine's wallNow() is clock.t * 1000
      q.push({ at: at + delay, m: null });
    },
    reply(after = delay, m = null) { q.push({ at: env.clock.t + after, m }); },
    pump(t) { while (q.length && q[0].at <= t) { const { m } = q.shift(); port.deliver(m || port.status()); } },
    deliver(m) { for (const f of port.listeners) f(m); },
    drop() { for (const f of port.dropListeners) f(); },
    page,
  };
  env.d.attachAgent(port, frameId);
  port.reply(0.01);
  env.agents.push(port);
  return port;
}

/** Advance in render-quantum batches. `src` = the playback rate the captured audio really has. */
function run(env, seconds, { src = () => 1, onTick } = {}) {
  const end = env.clock.t + seconds;
  while (env.clock.t < end - 1e-9) {
    env.clock.t += DT;
    env.d.ts.liveEdge += DT * src();
    for (const a of env.agents) { a.watch(env.clock.t); a.pump(env.clock.t); }
    if (onTick) onTick(env.clock.t);
    env.d.tick(env.clock.t);
  }
}
const rates = (port) => port.sent.filter((m) => m.t === 'rate');

test('assist does not engage on a muted or unrelated media element', async () => {
  const env = await setup();
  const decor = agent(env, 0, { audible: false }); // <audio muted loop autoplay>; the music is Web Audio
  run(env, 12); // the captured audio never speeds up
  assert.deepEqual(rates(decor), [], 'no rate commands');
  assert.equal(env.d.assist.sourceRate, 1);
  assert.equal(env.d.src.rateAt(Infinity), 1);
  assert.equal(env.d.tempo.bpm, 124, 'tempo model untouched');
  assert.equal(env.d.state(env.clock.t).assist.available, false);
});

test('assist does not engage when the page already plays at its own speed', async () => {
  const env = await setup();
  const yt = agent(env, 0, { rate: 1.25 }); // the site remembered 1.25x
  run(env, 6, { src: () => yt.page.rate });
  assert.deepEqual(rates(yt), []);
  assert.equal(env.d.assist.sourceRate, 1);
  assert.equal(env.d.state(env.clock.t).assist.available, false);
});

test('a source-rate step is committed only when the page confirms it, at the confirmation time', async () => {
  const env = await setup();
  const a = agent(env, 0, { delay: 0.3 });
  let sentAt = null, edgeAtSend = null, confirmedAt = null, edgeAtConfirm = null;
  run(env, 3, {
    src: () => a.page.rate,
    onTick: (t) => {
      if (sentAt == null && rates(a).length) { sentAt = t; edgeAtSend = env.d.ts.liveEdge; }
      if (sentAt != null && confirmedAt == null) {
        if (env.d.assist.sourceRate !== 1) { confirmedAt = t; edgeAtConfirm = env.d.ts.liveEdge; }
      }
    },
  });
  assert.ok(sentAt != null, 'assist engaged');
  assert.ok(confirmedAt != null, 'the step was committed');
  assert.ok(confirmedAt - sentAt >= 0.25, `committed ${(confirmedAt - sentAt).toFixed(3)} s after sending, before the page confirmed`);
  const step = env.d.src.steps.find((s) => s.inPos > 0);
  assert.ok(Math.abs(step.inPos - edgeAtConfirm) < 0.05, `step at ${step.inPos.toFixed(3)}; live edge at send ${edgeAtSend.toFixed(3)}, at confirm ${edgeAtConfirm.toFixed(3)}`);
});

test('a page that ignores the rate gets no source-model change, a release, and ASSIST n/a', async () => {
  const env = await setup();
  const a = agent(env, 0, { obey: false }); // e.g. the rate lands on an element that is not the one heard
  run(env, 8, { src: () => a.page.rate });
  assert.ok(rates(a).length > 0, 'assist tried');
  assert.equal(env.d.assist.sourceRate, 1, 'nothing committed');
  assert.equal(env.d.src.rateAt(Infinity), 1);
  assert.equal(env.d.tempo.bpm, 124);
  assert.equal(a.sent.at(-1).t, 'release');
  assert.equal(env.d.state(env.clock.t).assist.available, false);
  const n = rates(a).length;
  run(env, 10, { src: () => a.page.rate });
  assert.equal(rates(a).length, n, 'assist stays off for a while');
});

test('external-rate from the page rolls assist back at the live edge and keeps it off for a while', async () => {
  const env = await setup();
  const a = agent(env, 0);
  run(env, 8, { src: () => a.page.rate });
  const engaged = env.d.assist.sourceRate;
  assert.ok(engaged > 1.01, `engaged at ${engaged}`);
  // The player insists on 1x: agent-main gives up and says so.
  a.page.obey = false; a.page.rate = 1;
  a.deliver({ t: 'external-rate', rate: 1 });
  const edge = env.d.ts.liveEdge;
  assert.equal(a.sent.at(-1).t, 'release');
  assert.equal(env.d.assist.sourceRate, 1);
  assert.equal(env.d.src.rateAt(edge + 0.01), 1);
  assert.ok(env.d.src.rateAt(edge - 0.5) > 1, 'audio already buffered keeps its rate');
  assert.ok(Math.abs(env.d.tempo.bpm - 124) < 1e-6, `tempo ${env.d.tempo.bpm}`);
  assert.equal(env.d.state(env.clock.t).assist.available, false);
  const n = rates(a).length;
  run(env, 20, { src: () => a.page.rate });
  assert.equal(rates(a).length, n, 'no new rate commands');
});

test('while engaged the engine re-sends the rate at least every second', async () => {
  const env = await setup();
  const a = agent(env, 0);
  run(env, 16, { src: () => a.page.rate });
  const on = a.sent.filter((m) => m.t === 'rate');
  assert.ok(on.length > 10);
  let gap = 0;
  for (let i = 1; i < on.length; i++) gap = Math.max(gap, on[i].at - on[i - 1].at);
  gap = Math.max(gap, env.clock.t - on.at(-1).at);
  assert.ok(env.d.assist.sourceRate > 1, 'still engaged');
  assert.ok(gap <= 1.3, `longest silence ${gap.toFixed(2)} s`);
});

test("an old port's disconnect does not drop the frame's new agent", async () => {
  const env = await setup();
  const old = agent(env, 0);
  const fresh = agent(env, 0); // same frame reconnected (navigation or bfcache)
  old.drop();
  assert.equal(env.d.agents.get(0)?.port, fresh);
});

test('assist ramps back down through confirmed steps and ends with a confirmed release', async () => {
  const env = await setup();
  const a = agent(env, 0);
  run(env, 4, { src: () => a.page.rate });
  assert.ok(env.d.assist.sourceRate > 1.005);
  env.d.setParam('pitch', 0);
  run(env, 8, { src: () => a.page.rate });
  assert.equal(a.sent.at(-1).t, 'release');
  assert.equal(a.page.rate, 1);
  assert.equal(env.d.assist.sourceRate, 1);
  assert.equal(env.d.assist.active, false);
  assert.ok(Math.abs(env.d.tempo.bpm - 124) < 1e-6);
  assert.equal(env.d.state(env.clock.t).assist.available, true, 'nothing was refused');
});

test('if the heard element stops, assist lets go at once and comes back when it plays again', async () => {
  const env = await setup();
  const a = agent(env, 0);
  run(env, 4, { src: () => a.page.rate });
  assert.ok(env.d.assist.sourceRate > 1.005);
  const silent = a.status;
  a.status = () => ({ ...silent(), playing: false, audible: 0 }); // e.g. the player changes track
  a.reply(0);
  run(env, 0.5, { src: () => 1 });
  assert.equal(a.sent.at(-1).t, 'release');
  assert.equal(env.d.assist.sourceRate, 1);
  a.status = silent;
  a.reply(0);
  run(env, 2, { src: () => a.page.rate });
  assert.ok(env.d.assist.sourceRate > 1, 're-engaged without a penalty');
});

test("rates go to the heard element's frame only; other frames cannot switch assist off", async () => {
  const env = await setup();
  const ad = agent(env, 7, { audible: false }); // muted ad video in an iframe
  const a = agent(env, 0);
  run(env, 3, { src: () => a.page.rate });
  assert.ok(env.d.assist.sourceRate > 1);
  assert.deepEqual(rates(ad), []);
  ad.deliver({ t: 'external-rate', rate: 1 });
  assert.ok(env.d.assist.sourceRate > 1, 'still engaged');
  assert.equal(env.d.state(env.clock.t).assist.available, true);
});

test('if the heard element moves to another frame, assist starts again from 1x there', async () => {
  const env = await setup();
  const a = agent(env, 0);
  run(env, 3, { src: () => a.page.rate });
  assert.ok(env.d.assist.sourceRate > 1);
  const quiet = a.status;
  a.status = () => ({ ...quiet(), playing: false, audible: 0 });
  a.reply(0);
  const b = agent(env, 3); // the player now lives in an iframe
  run(env, 0.3, { src: () => 1 });
  assert.equal(env.d.assist.sourceRate, 1);
  assert.equal(a.sent.at(-1).t, 'release');
  run(env, 2, { src: () => b.page.rate });
  assert.ok(rates(b).length > 0 && env.d.assist.sourceRate > 1, 're-engaged on the new frame');
});

// A source tab Chrome throttles in the background may answer late. A late answer that confirms the
// command is taken; only a contradiction (or external-rate) refuses at once, silence after ~5 s.
test('a throttled page that confirms 3 s late is taken, not refused', async () => {
  const env = await setup();
  const a = agent(env, 0, { delay: 3 });
  run(env, 14, { src: () => a.page.rate });
  assert.ok(env.d.assist.sourceRate > 1.005, `engaged at ${env.d.assist.sourceRate}`);
  assert.ok(!a.sent.some((m) => m.t === 'release'), 'never released');
  assert.equal(env.d.state(env.clock.t).assist.available, true, 'not refused');
});

test('a page that never confirms is refused after about 5 s, and the ramp holds while it is overdue', async () => {
  const env = await setup();
  const a = agent(env, 0);
  run(env, 0.1);
  a.reply = () => {}; // answers nothing from now on
  let firstAt = null, refusedAt = null;
  run(env, 10, {
    src: () => a.page.rate,
    onTick: (t) => {
      if (firstAt == null && rates(a).length) firstAt = t;
      if (refusedAt == null && firstAt != null && a.sent.some((m) => m.t === 'release')) refusedAt = t;
    },
  });
  assert.ok(refusedAt != null, 'refused in the end');
  assert.ok(refusedAt - firstAt > 4.5 && refusedAt - firstAt < 5.6, `refused ${(refusedAt - firstAt).toFixed(2)} s after the first command`);
  const before = rates(a).filter((m) => m.at < refusedAt);
  const steps = new Set(before.map((m) => m.seq)).size;
  assert.ok(steps <= 9, `${steps} rate steps sent to a page that confirmed none`);
  let gap = 0;
  for (let i = 1; i < before.length; i++) gap = Math.max(gap, before[i].at - before[i - 1].at);
  assert.ok(gap <= 1.3, `kept alive meanwhile (longest silence ${gap.toFixed(2)} s)`);
  assert.equal(env.d.assist.sourceRate, 1);
  assert.equal(env.d.state(env.clock.t).assist.available, false);
});

/**
 * The engine's main thread is blocked for `seconds`: no ticks, no messages. The captured audio
 * queues up (appended in one go afterwards, `chunksFirst`, or after the agents' statuses), and the
 * agents' tabs run on. The input timeline runs on the audio clock: src defaults to 1 s per s.
 */
function stall(env, seconds, { src = () => 1, chunksFirst = true } = {}) {
  let backlog = 0;
  const end = env.clock.t + seconds;
  while (env.clock.t < end - 1e-9) {
    env.clock.t += DT;
    backlog += DT * src();
    for (const a of env.agents) a.watch(env.clock.t);
  }
  if (chunksFirst) env.d.ts.liveEdge += backlog;
  for (const a of env.agents) a.pump(env.clock.t);
  if (!chunksFirst) env.d.ts.liveEdge += backlog;
}

test("an engine stall shorter than the agent's timeout keeps assist engaged: no release, no refusal, no empty reserve", async () => {
  const env = await setup();
  const a = agent(env, 0);
  run(env, 8);
  const engaged = env.d.assist.sourceRate;
  assert.ok(engaged > 1.01, `engaged at ${engaged}`);
  const n = a.sent.length;
  stall(env, 5);
  const off = [];
  run(env, 20, { onTick: (t) => { if (!env.d.assist.active) off.push(t); } });
  assert.deepEqual(off, [], 'assist stayed engaged');
  assert.ok(!a.sent.slice(n).some((m) => m.t === 'release'), 'never released');
  assert.equal(a.page.letGoAt, undefined, 'the page never let go');
  assert.ok(env.d.assist.sourceRate > 1.01);
  assert.equal(env.d.state(env.clock.t).assist.available, true);
  assert.deepEqual(env.engine.events.filter((e) => /reserve empty/.test(e.text)), []);
});

for (const chunksFirst of [true, false]) {
  test(`an agent that let go by itself is not a refusal: the model steps back to 1x where the page did, and assist ramps again (${chunksFirst ? 'audio' : 'status'} first after the stall)`, async () => {
    const env = await setup();
    const a = agent(env, 0);
    run(env, 8);
    const engaged = env.d.assist.sourceRate;
    assert.ok(engaged > 1.01, `engaged at ${engaged}`);
    // The engine stalls past the agent's timeout: the page goes back to 1x mid-stall.
    const edge0 = env.d.ts.liveEdge, t0 = env.clock.t;
    stall(env, LET_GO + 3, { chunksFirst });
    assert.ok(a.page.letGoAt > 0, 'the agent let go');
    const edgeAtLetGo = edge0 + (a.page.letGoAt / 1000 - t0);
    const seqs = new Set(a.sent.map((m) => m.seq));
    run(env, DT); // the first tick after the stall
    assert.equal(env.d.state(env.clock.t).assist.available, true, 'not refused');
    assert.equal(env.d.assist.sourceRate, 1);
    const step = env.d.src.steps.at(-1);
    assert.equal(step.rate, 1);
    assert.ok(Math.abs(step.inPos - edgeAtLetGo) < 0.1, `step back to 1x at ${step.inPos.toFixed(2)}; the page let go at ${edgeAtLetGo.toFixed(2)}, the engine heard of it at ${env.d.ts.liveEdge.toFixed(2)}`);
    assert.ok(env.d.src.rateAt(step.inPos - 0.5) > 1.01, 'audio from before the page let go keeps its rate');
    assert.ok(Math.abs(env.d.tempo.bpm - 124) < 1e-6, `tempo back to the page's own ${env.d.tempo.bpm}`);
    run(env, 4);
    const fresh = rates(a).filter((m) => !seqs.has(m.seq));
    assert.ok(fresh.length > 0, 'new rate commands');
    assert.ok(env.d.assist.sourceRate > 1, `re-engaged at ${env.d.assist.sourceRate}`);
    assert.equal(a.page.rate, env.d.assist.sourceRate, 'the page plays what the engine believes');
  });
}

test('malformed or hostile agent messages change nothing in the engine (Review Focus 5)', async () => {
  const env = await setup();
  const a = agent(env, 0);
  run(env, 3, { src: () => a.page.rate });
  const snap = () => JSON.stringify([env.d.assist.sourceRate, env.d.assist.sent, env.d.assist.active, env.d.src.steps, env.d.tempo.bpm, env.d.ts.segs.length]);
  const before = snap(), sent = a.sent.length;
  assert.ok(env.d.assist.sourceRate > 1, 'engaged');
  const ok = a.status();
  for (const m of [
    'garbage', null, 42, [], { t: 'status' }, { ...ok, rate: NaN }, { ...ok, rate: Infinity }, { ...ok, rate: -1 },
    { ...ok, rate: 1e9 }, { ...ok, rate: '1.5' }, { ...ok, hasMedia: 'yes' }, { ...ok, playing: 1 },
    { t: 'external-rate', rate: NaN }, { t: 'external-rate', rate: 0 }, { t: 'external-rate', rate: '2' }, { t: 'external-rate', rate: 1e9 },
    { t: 'rate', rate: 1.2 }, { t: 'release' }, JSON.parse('{"__proto__":{"t":"status","hasMedia":true,"playing":true,"rate":2}}'),
  ]) a.deliver(m);
  assert.equal(snap(), before);
  assert.equal(a.sent.length, sent, 'no reply to the page');
  assert.deepEqual(env.engine.events, []);
  run(env, 1, { src: () => a.page.rate });
  const st = env.d.state(env.clock.t);
  assert.ok(st.assist.active && st.assist.sourceRate > 1 && Number.isFinite(st.engineRate) && Number.isFinite(st.reserve), JSON.stringify(st.assist));
});

test('a deck guards the pauses of every frame it captures, and reports a site that keeps pausing once', async () => {
  const env = await setup();
  const a = agent(env, 0), b = agent(env, 1, { audible: false });
  // Every frame's agent is told the tab is on a deck, right after the first query.
  for (const port of [a, b]) {
    assert.deepEqual(port.sent.slice(0, 2), [{ at: 1, t: 'query' }, { at: 1, t: 'isolate', on: true }], JSON.stringify(port.sent.slice(0, 2)));
  }
  // The guard gave up on a site that keeps pausing: the user is told, once, whichever frame says so.
  a.deliver({ t: 'external-pause' });
  a.deliver({ t: 'external-pause' });
  b.deliver({ t: 'external-pause' });
  assert.deepEqual(env.engine.events, [{ level: 'warn', text: 'Deck 1: the site keeps pausing this tab — it may only allow one track at a time.' }]);
  assert.equal(env.d.assist.sourceRate, 1, 'and assist is left alone');
  // Ejecting gives the tab back to its site.
  env.engine.events.length = 0;
  for (const port of [a, b]) port.deliver(port.status());
  env.d.recorder = { state: 'idle', teardown() {} };
  await env.d.dispose();
  assert.deepEqual(a.sent.filter((m) => m.t === 'isolate').map((m) => m.on), [true, false]);
});
