// Seeded, deterministic fuzz test for the editing core: js/commands.js + js/store.js + js/model.js +
// js/automovie.js (real modules, fake player/dialogs/media like tests/commands.test.mjs).
//
// It runs many random command sequences (add media/music/titles/captions/credits, split, trim
// (set start/end point), move, cut/copy/paste, remove, transitions, speed, durations, text format,
// music tools, AutoMovie, aspect, audio mix, selection changes, seeks, undo/redo bursts, reloads)
// and after EVERY step checks the data-integrity invariants:
//
//   timeline     computeTimeline: finite, non-negative durations; segments contiguous & monotonic;
//                transition overlaps within the WLMM clamp; store.timeline cache == fresh compute
//   source       every video segment's sourceIn/sourceOut inside [0, media.duration]; no zero-length
//                video; stored trims valid (trimEnd null or > trimStart)
//   ids          no duplicate ids across items/texts/music; no dangling media references
//   selection    selection type/ids consistent and referring to existing objects of that type
//   texts/music  start >= 0, sane durations; music length > 0
//   normalize    normalizeProject(JSON round trip) is the identity on the project
//   history      every mutation is one undo step (or coalesced into the last one) and no undo step is
//                empty; undo restores the previous JSON (updatedAt aside), undo→redo is the identity
//                (selection included); undo all → the initial project; redo all → the final project;
//                a save/load (normalize) round trip and a project switch keep everything consistent
//
// plus WLMM editing semantics:
//   anchor       captions stay on the clip they are on, end credits stay after the pictures,
//                whenever the clip itself was not changed (any command)
//   split        halves add up; the second half has no transition; no transition changes except the
//                two next to the halves, and those only by computeTimeline's clamp (a half shorter than
//                twice the transition) — so the movie length changes by exactly that; video halves
//                meet at the frame under the playhead (speed-aware)
//   setPoint     Set start/end point puts the frame under the playhead at the clip's in/out (speed-aware)
//   paste        pasted pictures land right after the selected item
//   music        Split music / Set start / end point keep the song playing at the same movie time
//   automovie    the movie starts with a title and new credits follow the pictures; applying the
//                same theme twice changes nothing the second time (no duplicate titles / credits)
//
// Usage:
//   node tests/fuzz.test.mjs [--runs=2000] [--seed=1] [--steps=60] [--only=<failure-key>] [--no-shrink] [-v]
//        [--allow=key1,key2]     known failure kinds (or prefixes before ':') are counted, not fatal,
//                                so the run keeps looking for other bugs
//        [--replay=ops.json]     run one op list exactly as printed in a "repro ops" line
//   FUZZ_DUMP=1 with --replay prints the timeline / texts / selection after every op.
// Exit code 0 when no invariant failed. Every failure kind is reported once with a shrunk,
// replayable op list (ops refer to objects by index, so they replay on any run).
// ~25 s for the default 2000 sequences (node 22).

import * as M from '../js/model.js';
import { Store } from '../js/store.js';
import * as catalog from '../js/catalog.js';
import { createCommands } from '../js/commands.js';
import { applyAutoMovie } from '../js/automovie.js';

// ------------------------------------------------------------------ options
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return def;
  const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
  return typeof def === 'number' ? Number(v) : v;
};
const RUNS = opt('runs', 2000);
const SEED = opt('seed', 1);
const MAX_STEPS = Math.min(90, opt('steps', 60)); // < UNDO_LIMIT so "undo all" is meaningful
const ONLY = opt('only', '');
const SHRINK = !argv.includes('--no-shrink');
const VERBOSE = argv.includes('-v') || argv.includes('--verbose');

// ------------------------------------------------------------------ deterministic environment
let fakeClock = 1e6;
Object.defineProperty(globalThis, 'performance', { value: { now: () => fakeClock }, configurable: true, writable: true });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.warn = () => {}; // commands warn about the bogus ids the fuzzer feeds them on purpose

function mulberry32(a) {
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ids = (list) => list.map((x) => x.id);
const EPS = 1e-6;
const TRANSITIONS = catalog.TRANSITIONS.map((t) => t.id);
const PANZOOM = catalog.PANZOOM.map((t) => t.id);
const EFFECTS = catalog.EFFECTS.map((t) => t.id);
const TEXT_EFFECTS = catalog.TEXT_EFFECTS.map((t) => t.id);
const THEMES = catalog.AUTOMOVIE_THEMES.map((t) => t.id);
const FADES = ['none', 'slow', 'medium', 'fast'];
const ASPECTS = Object.keys(M.ASPECTS);
const STYLE_VALUES = {
  font: ['Arial', 'Georgia, serif', '', 'Segoe UI, Arial, sans-serif'],
  size: [1, 6, 12.5, 50, 80, -3, '14', 'abc'],
  bold: [true, false, 'yes'],
  italic: [true, false],
  color: ['#ff0000', '#00FF00', '', 'red'],
  outline: ['none', 'thin', 'thick', 'huge'],
  outlineColor: ['#000000', '#123456'],
  align: ['left', 'center', 'right', 'middle'],
  valign: ['top', 'middle', 'bottom'],
  opacity: [0, 0.4, 1, 3, '0.5'],
  background: [null, 'none', '#202020', ''],
};

// ------------------------------------------------------------------ fake app
let mediaSeq = 0;
function fakeMedia(type, duration) {
  mediaSeq++;
  return {
    id: `media-${mediaSeq}`, type, name: `${type}-${mediaSeq}`,
    mime: type === 'image' ? 'image/png' : type === 'audio' ? 'audio/ogg' : 'video/webm',
    blob: new Blob([new Uint8Array(4)]), url: `blob:fake-${mediaSeq}`,
    duration: type === 'image' ? 0 : duration, width: 640, height: 360,
    hasAudio: type !== 'image', thumb: '', filmstrip: [], peaks: [0.5],
  };
}
const fakeFile = (spec) => ({ size: 1, slice() { return this; }, name: `${spec.type}.bin`, spec });

function makeApp() {
  const store = new Store();
  const toasts = [];
  const errors = [];
  const player = {
    currentTime: 0, playing: false,
    seek(t) { this.currentTime = t; return Promise.resolve(); },
    play() { return Promise.resolve(); }, pause() {}, toggle() { return Promise.resolve(); }, stepFrame() {},
  };
  const dialogs = {
    trimActive: false,
    toast(msg, o = {}) { toasts.push({ msg, type: o.type || 'info' }); },
    progress() { return { set() {}, close() {}, signal: undefined }; },
    openWebcam() { return Promise.resolve(fakeFile({ type: 'video', duration: 5.5 })); },
    openNarration() { return Promise.resolve(fakeFile({ type: 'audio', duration: 4.25 })); },
  };
  const media = {
    async importFiles(files) { return files.map((f) => fakeMedia(f.spec.type, f.spec.duration)); },
    computePeaks() { return Promise.resolve(null); },
    revokeMedia() {},
  };
  const app = { store, player, dialogs, media, options: {}, exporting: false, audio: { prepare: () => Promise.resolve() } };
  app.commands = createCommands(app);
  return { app, store, player, toasts, errors, cmd: app.commands };
}

// ------------------------------------------------------------------ op generation (data only, replayable)
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
const chance = (rnd, p) => rnd() < p;

function genMediaSpec(rnd, kinds) {
  const type = pick(rnd, kinds);
  if (type === 'image') return { type, duration: 0 };
  if (type === 'video') return { type, duration: pick(rnd, [0.3, 1, 3.7, 4, 10, 30.25, 61]) };
  return { type, duration: pick(rnd, [0.5, 5, 12.3, 30, 200]) };
}

/** A random op for the current state. Indices are fractions so ops replay on any state. */
function genOp(rnd) {
  const r = rnd();
  const f = () => Math.round(rnd() * 1000) / 1000; // replayable fraction
  const dt = chance(rnd, 0.25) ? 100 : 1000;      // 100ms apart → slider coalescing may kick in
  const any = (...xs) => pick(rnd, xs);
  let op;
  if (r < 0.10) op = { op: 'addMedia', files: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => genMediaSpec(rnd, ['video', 'video', 'image', 'image', 'audio'])) };
  else if (r < 0.13) op = { op: any('addMusic', 'addMusicAtPlayhead'), files: Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => genMediaSpec(rnd, ['audio', 'audio', 'video'])) };
  else if (r < 0.25) op = { op: 'select', type: any('item', 'item', 'item', 'text', 'music', null), fracs: Array.from({ length: chance(rnd, 0.8) ? 1 : 1 + Math.floor(rnd() * 3) }, f) };
  else if (r < 0.33) op = { op: 'seek', mode: any('in-selected', 'in-selected', 'anywhere', 'boundary'), frac: f() };
  else if (r < 0.40) {
    // select a target, put the playhead inside it and run an at-playhead command (one op, so it shrinks well)
    const name = any('split', 'split', 'setStartPoint', 'setEndPoint', 'musicSplit', 'musicSetStartPoint', 'musicSetEndPoint');
    op = { op: 'pointCmd', name, pick: f(), local: any(f(), f(), 0, 1, 0.01, 0.99), noSelect: chance(rnd, 0.15) };
  }
  else if (r < 0.46) op = { op: 'cmd', name: any('cut', 'copy', 'paste', 'paste', 'remove', 'selectAll') };
  else if (r < 0.50) op = { op: 'moveItem', frac: f(), to: f() };
  else if (r < 0.53) op = { op: any('moveText', 'moveMusic'), frac: f(), start: Math.round(rnd() * 400) / 10 };
  else if (r < 0.58) op = { op: 'cmd', name: 'setTransition', arg: pick(rnd, TRANSITIONS.concat(['none', 'none', 'bogus'])) };
  else if (r < 0.60) op = { op: 'cmd', name: 'setTransitionDuration', arg: any(0, -1, 0.05, 0.75, 1.5, 2.25, 5, 100, '2,5', 'abc') };
  else if (r < 0.62) op = { op: 'cmd', name: any('applyTransitionAll', 'applyPanZoomAll', 'applyEffectAll', 'rotateLeft', 'rotateRight') };
  else if (r < 0.64) op = { op: 'cmd', name: 'setPanZoom', arg: pick(rnd, PANZOOM) };
  else if (r < 0.66) op = { op: 'cmd', name: 'setEffect', arg: pick(rnd, EFFECTS) };
  else if (r < 0.68) op = { op: 'cmd', name: 'setBrightness', arg: any(-150, -40, 0, 33.3, 100, 'x') };
  else if (r < 0.71) op = { op: 'cmd', name: 'setSpeed', arg: pick(rnd, M.SPEEDS.concat([0, -2, 100, '1.5', 0.3])) };
  else if (r < 0.74) op = { op: 'cmd', name: 'setDuration', arg: any(0, 0.05, 0.1, 0.25, 1, 3.5, 7, 12.345, 5000, 'x', '00:04.50') };
  else if (r < 0.76) op = { op: 'cmd', name: any('setVolume', 'musicVolume'), arg: any(0, 0.5, 1, 50, 150, -1) };
  else if (r < 0.78) op = { op: 'cmd', name: any('setFadeIn', 'setFadeOut', 'musicFadeIn', 'musicFadeOut'), arg: pick(rnd, FADES.concat(['bogus'])) };
  else if (r < 0.80) op = { op: 'cmd', name: any('addTitle', 'addCaption', 'addCaption', 'addCredits', 'webcam', 'narration') };
  else if (r < 0.82) op = { op: 'cmd', name: 'textSet', arg: (() => { const key = pick(rnd, Object.keys(STYLE_VALUES)); return { key, value: pick(rnd, STYLE_VALUES[key]) }; })() };
  else if (r < 0.84) op = { op: 'cmd', name: any('textEdit', 'textDuration', 'textStartTime', 'textEffect', 'musicStartTime'),
    arg: undefined, argPick: f(), selectFirst: chance(rnd, 0.7) ? f() : undefined };
  else if (r < 0.86) op = { op: 'cmd', name: 'autoMovie', arg: pick(rnd, THEMES.concat(['nope'])) };
  else if (r < 0.88) op = { op: 'cmd', name: any('setAspect', 'setAudioMix', 'emphasize', 'fitToMusic', 'setBackground'), argPick: f() };
  else if (r < 0.97) op = { op: 'history', undo: Math.floor(rnd() * 5), redo: Math.floor(rnd() * 5) };
  else if (r < 0.985) op = { op: 'reload' };
  else op = { op: 'switchProject' };
  op.dt = dt;
  if (op.argPick !== undefined) {
    const k = op.argPick;
    const byName = {
      textEdit: ['Hello', '', 'Line 1\nLine 2', 'Ünïcødé ✓'],
      textDuration: [0, 0.05, 1, 3.5, 9.99, 'x'],
      textStartTime: [undefined, 0, 2.5, 30, -4, '00:01.50'],
      textEffect: TEXT_EFFECTS.concat(['bogus']),
      musicStartTime: [undefined, 0, 3.25, 50, -1],
      setAspect: ASPECTS.concat(['2:1']),
      setAudioMix: [-1, -0.25, 0, 0.6, 1, 4],
      emphasize: ['video', 'music', 'narration', 'narration', 'bogus'],
      fitToMusic: [undefined],
      setBackground: ['#ff0000', '#000000', '', '#123abc'],
    }[op.name];
    op.arg = byName[Math.floor(k * byName.length) % byName.length];
    delete op.argPick;
  }
  return op;
}

// ------------------------------------------------------------------ applying ops
const byFrac = (list, frac) => (list.length ? list[Math.min(list.length - 1, Math.floor(frac * list.length))] : undefined);

async function applyOp(env, op, ctx) {
  const { store, cmd, player } = env;
  fakeClock += op.dt || 1000;
  const p = store.project;
  switch (op.op) {
    case 'addMedia':
    case 'addMusic':
    case 'addMusicAtPlayhead':
      return cmd.run(op.op, op.files.map(fakeFile));
    case 'select': {
      if (!op.type) { store.select(null, []); return; }
      const coll = op.type === 'item' ? p.items : op.type === 'text' ? p.texts : p.music;
      store.select(op.type, op.fracs.map((fr) => byFrac(coll, fr)).filter(Boolean).map((o) => o.id));
      return;
    }
    case 'seek': {
      const tl = store.timeline;
      let t = op.frac * tl.duration;
      if (op.mode === 'in-selected') {
        const s = store.selection;
        const pool = s.type === 'item' ? tl.segments.filter((x) => s.ids.includes(x.item.id)).map((x) => [x.start, x.end])
          : s.type === 'music' ? tl.music.filter((x) => s.ids.includes(x.item.id)).map((x) => [x.start, x.end])
            : s.type === 'text' ? tl.texts.filter((x) => s.ids.includes(x.item.id)).map((x) => [x.start, x.end]) : [];
        if (pool.length) { const [a, b] = pool[0]; t = a + op.frac * (b - a); }
      } else if (op.mode === 'boundary') {
        const edges = tl.segments.flatMap((x) => [x.start, x.end]);
        if (edges.length) t = byFrac(edges, op.frac);
      }
      player.currentTime = Math.max(0, Math.round(t * 1000) / 1000);
      return;
    }
    case 'moveItem': {
      const it = byFrac(p.items, op.frac);
      if (!it) return;
      return cmd.run('moveItem', { id: it.id, toIndex: Math.floor(op.to * p.items.length) });
    }
    case 'moveText':
    case 'moveMusic': {
      const o = byFrac(op.op === 'moveText' ? p.texts : p.music, op.frac);
      if (!o) return;
      return cmd.run(op.op, { id: o.id, start: op.start });
    }
    case 'cmd':
      if (op.selectFirst !== undefined) {
        // text tools work on a caption / credits / title; music tools on music
        if (op.name === 'musicStartTime') { const m = byFrac(p.music, op.selectFirst); if (m) store.select('music', m.id); }
        else {
          const pool = [...p.texts.map((t) => ['text', t]), ...p.items.filter((i) => i.kind === 'title').map((i) => ['item', i])];
          const e = byFrac(pool, op.selectFirst);
          if (e) store.select(e[0], e[1].id);
        }
      }
      return cmd.run(op.name, op.arg);
    case 'pointCmd': {
      const music = op.name.startsWith('music');
      const tl = store.timeline;
      const pool = music ? tl.music : tl.segments.filter((x) => op.name === 'split' || x.item.kind === 'video');
      const e = byFrac(pool, op.pick);
      if (e) {
        if (op.noSelect && !music) store.select(null, []);
        else store.select(music ? 'music' : 'item', e.item.id);
        player.currentTime = Math.round((e.start + op.local * (e.end - e.start)) * 1000) / 1000;
        ctx.time = player.currentTime;
        ctx.selection = structuredClone(store.selection); // what the command sees
      }
      return cmd.run(op.name);
    }
    case 'history':
      for (let i = 0; i < op.undo; i++) cmd.run('undo');
      for (let i = 0; i < op.redo; i++) cmd.run('redo');
      return;
    case 'reload': {
      // What persist does on save → load: structuredClone + normalizeProject (store.replaceProject).
      const json = JSON.stringify(p);
      store.replaceProject(JSON.parse(json), store.media);
      ctx.reloaded = json;
      return;
    }
    case 'switchProject':
      // File › New project / Open project: a different project and media map; the clipboard stays.
      store.replaceProject(M.createProject('Other'), new Map());
      ctx.reloaded = JSON.stringify(store.project);
      return;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

// ------------------------------------------------------------------ invariants
class Failure extends Error {
  constructor(key, detail) { super(`${key}: ${detail}`); this.key = key; this.detail = detail; }
}
// --allow=key1,key2: known failures are counted but do not stop the sequence (to find other bugs)
const ALLOW = new Set(String(opt('allow', '')).split(',').filter(Boolean));
const allowed = new Map();
const fail = (key, detail) => {
  if (ALLOW.has(key) || ALLOW.has(key.split(':')[0])) { allowed.set(key, (allowed.get(key) || 0) + 1); return; }
  throw new Failure(key, detail);
};
const noStamp = (p) => JSON.stringify({ ...p, updatedAt: 0 });
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

function checkStructure(store) {
  const p = store.project;
  const media = store.media;
  const tl = M.computeTimeline(p, media);
  // store cache coherent with a fresh computation
  const cached = store.timeline;
  const sig = (t) => JSON.stringify([t.duration, t.segments.map((s) => [s.item.id, s.start, s.end]), t.texts.map((x) => [x.item.id, x.start, x.end]), t.music.map((x) => [x.item.id, x.start, x.end])]);
  if (sig(cached) !== sig(tl)) fail('timeline-cache', 'store.timeline differs from computeTimeline(project, media)');

  if (!Number.isFinite(tl.duration) || tl.duration < 0) fail('timeline-finite', `timeline duration ${tl.duration}`);
  let prev = null;
  for (const s of tl.segments) {
    for (const k of ['start', 'end', 'duration', 'sourceIn', 'sourceOut']) {
      if (!Number.isFinite(s[k]) || s[k] < -EPS) fail('timeline-finite', `segment ${s.index} ${k}=${s[k]}`);
    }
    if (!near(s.end, s.start + s.duration)) fail('timeline-finite', `segment ${s.index} end != start + duration`);
    if (s.end > tl.duration + EPS) fail('timeline-finite', `segment ${s.index} ends after the timeline`);
    if (prev) {
      if (s.start < prev.start - EPS) fail('timeline-monotonic', `segment ${s.index} starts before segment ${prev.index}`);
      if (s.start > prev.end + EPS) fail('timeline-monotonic', `gap before segment ${s.index}`);
      if (s.transitionIn) {
        const lim = Math.min(prev.duration / 2, s.duration / 2);
        if (s.transitionIn.duration > lim + EPS) fail('timeline-transition', `segment ${s.index} transition ${s.transitionIn.duration} > clamp ${lim}`);
        if (!near(prev.end - s.start, s.transitionIn.duration)) fail('timeline-transition', `segment ${s.index} overlap != transition`);
      } else if (!near(s.start, prev.end)) fail('timeline-transition', `segment ${s.index} overlaps without a transition`);
    } else if (s.start !== 0) fail('timeline-monotonic', 'first segment does not start at 0');
    const it = s.item;
    if (it.kind === 'video') {
      const m = media.get(it.mediaId);
      if (m) {
        if (s.sourceIn < -EPS || s.sourceOut > m.duration + EPS || s.sourceIn > s.sourceOut + EPS) {
          fail('source-range', `segment ${s.index} source ${s.sourceIn}..${s.sourceOut} outside 0..${m.duration}`);
        }
        if (s.duration < 1e-3) fail('source-zero-video', `video item ${s.index} has zero length (trim ${it.trimStart}..${it.trimEnd}, media ${m.duration})`);
        if (!(it.trimStart >= 0) || it.trimStart >= m.duration) fail('source-range', `video item ${s.index} trimStart ${it.trimStart} outside media ${m.duration}`);
        if (it.trimEnd !== null && (!(it.trimEnd > it.trimStart) || it.trimEnd > m.duration + 1e-3)) fail('source-range', `video item ${s.index} trimEnd ${it.trimEnd} (trimStart ${it.trimStart}, media ${m.duration})`);
      }
      if (!(it.speed > 0 && it.speed <= 64)) fail('item-fields', `speed ${it.speed}`);
    } else if (!(it.duration >= 0.01) || !Number.isFinite(it.duration)) fail('item-fields', `${it.kind} duration ${it.duration}`);
    if (!(it.volume >= 0 && it.volume <= 1)) fail('item-fields', `volume ${it.volume}`);
    if (![0, 90, 180, 270].includes(it.rotation)) fail('item-fields', `rotation ${it.rotation}`);
    if (!(it.brightness >= -100 && it.brightness <= 100)) fail('item-fields', `brightness ${it.brightness}`);
    if (!it.transition || !(it.transition.duration >= 0 && it.transition.duration <= 60)) fail('item-fields', `transition ${JSON.stringify(it.transition)}`);
    if (it.kind !== 'title' && !media.has(it.mediaId)) fail('dangling-media', `${it.kind} item ${s.index} → missing media ${it.mediaId}`);
    prev = s;
  }
  const lastEnd = prev ? prev.end : 0;
  if (tl.duration < lastEnd - EPS) fail('timeline-finite', 'duration < end of the pictures');

  for (const x of tl.texts) {
    const t = x.item;
    if (!Number.isFinite(t.start) || t.start < 0) fail('text-start', `text ${t.id} start ${t.start}`);
    if (!Number.isFinite(t.duration) || t.duration < 0.1 - EPS) fail('text-fields', `text duration ${t.duration}`);
    if (!['caption', 'credits'].includes(t.kind)) fail('text-fields', `text kind ${t.kind}`);
  }
  for (const x of tl.music) {
    const m = x.item;
    if (!Number.isFinite(m.start) || m.start < 0) fail('music-start', `music ${m.id} start ${m.start}`);
    if (!(m.trimStart >= 0) || (m.trimEnd !== null && !(m.trimEnd > m.trimStart))) fail('music-fields', `music trim ${m.trimStart}..${m.trimEnd}`);
    const md = media.get(m.mediaId);
    if (!md) fail('dangling-media', `music → missing media ${m.mediaId}`);
    if (!(x.end - x.start > 1e-3)) fail('music-zero', `music ${m.id} has zero length (trim ${m.trimStart}..${m.trimEnd}, media ${md.duration})`);
    if (m.trimStart >= md.duration) fail('music-fields', `music trimStart ${m.trimStart} >= media ${md.duration}`);
  }

  // unique ids
  const all = [...p.items, ...p.texts, ...p.music].map((o) => o.id);
  if (new Set(all).size !== all.length) fail('duplicate-ids', 'an id is used twice');

  // selection
  const sel = store.selection;
  if (!sel.type && sel.ids.length) fail('selection', 'ids without a type');
  if (sel.type && !sel.ids.length) fail('selection', 'type without ids');
  if (sel.type) {
    const coll = sel.type === 'item' ? p.items : sel.type === 'text' ? p.texts : sel.type === 'music' ? p.music : null;
    if (!coll) fail('selection', `bad type ${sel.type}`);
    for (const id of sel.ids) if (!coll.some((o) => o.id === id)) fail('selection', `selected ${sel.type} ${id} does not exist`);
    if (new Set(sel.ids).size !== sel.ids.length) fail('selection', 'duplicate selected id');
  }

  // normalizeProject(JSON) is the identity on a valid project
  const json = JSON.stringify(p);
  const norm = JSON.stringify(M.normalizeProject(JSON.parse(json)));
  if (norm !== json) fail('normalize-identity', firstDiff(json, norm));
  return tl;
}

function deepNear(a, b, eps) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => deepNear(a[k], b[k], eps));
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `differs at ${i}: …${a.slice(Math.max(0, i - 60), i + 60)}… vs …${b.slice(Math.max(0, i - 60), i + 60)}…`;
}

/** Where every text sits (same rule as automovie.anchorTexts, computed independently). */
function anchorsOf(tl) {
  const visEnd = tl.segments.length ? tl.segments[tl.segments.length - 1].end : 0;
  const out = new Map();
  for (const x of tl.texts) {
    if (!tl.segments.length || x.start >= visEnd - 0.05) { out.set(x.item.id, { end: true, offset: Math.max(0, x.start - visEnd), start: x.start, visEnd }); continue; }
    const i = M.segmentIndexAt(tl, x.start);
    if (i < 0) continue;
    const s = tl.segments[i];
    out.set(x.item.id, { itemId: s.item.id, offset: x.start - s.start, duration: s.duration, sourceIn: s.sourceIn, speed: s.item.speed, start: x.start });
  }
  return out;
}

// ops that legitimately move texts by themselves
const TEXT_MOVERS = new Set(['moveText', 'textStartTime', 'history', 'reload']);

const stats = new Map(); // check → times it ran (printed with -v)
const ran = (k) => stats.set(k, (stats.get(k) || 0) + 1);

function checkSemantics(env, op, before, after, extra) {
  const { store } = env;
  const name = op.op === 'cmd' || op.op === 'pointCmd' ? op.name : op.op;
  if (extra.result !== undefined && extra.result !== false) ran(`ok:${name}`);
  const changed = noStamp(before.project) !== noStamp(store.project);

  // --- captions stay on their clip / credits after the pictures
  if (changed && !TEXT_MOVERS.has(name) && !(name === 'cmd' && op.name === 'textStartTime')) {
    const segAfter = new Map(after.tl.segments.map((s) => [s.item.id, s]));
    const visEnd = after.tl.segments.length ? after.tl.segments[after.tl.segments.length - 1].end : 0;
    for (const [tid, a] of before.anchors) {
      const t = store.project.texts.find((x) => x.id === tid);
      if (!t) continue;
      let want;
      if (a.end) {
        if (name === 'fitToMusic' || name === 'autoMovie') continue; // fit moves end credits with the pictures explicitly
        // pictures end where they did → the text must not move; otherwise it follows the end
        // (a text up to 50 ms before the end counts as end credits and may snap onto the end)
        want = near(a.visEnd, visEnd) ? (a.start < visEnd && near(t.start, visEnd, 1e-3) ? t.start : a.start) : visEnd + a.offset;
      } else {
        const s = segAfter.get(a.itemId);
        if (!s || !near(s.duration, a.duration) || !near(s.sourceIn, a.sourceIn) || s.item.speed !== a.speed) continue;
        want = s.start + a.offset;
      }
      ran('anchor');
      if (!near(t.start, want, 1e-3)) {
        fail(`anchor:${name}`, `${a.end ? 'end credits' : 'caption'} ${tid} was ${a.end ? `${a.offset.toFixed(3)}s after the pictures` : `${a.offset.toFixed(3)}s into its (unchanged) clip`}; expected start ${want.toFixed(3)}, got ${t.start}`);
      }
    }
  }

  // --- split
  if (name === 'split' && typeof extra.result === 'string') {
    const bSeg = before.tl;
    const aEnd = (tl) => (tl.segments.length ? tl.segments[tl.segments.length - 1].end : 0);
    const overlap = (s) => (s && s.transitionIn ? s.transitionIn.duration : 0);
    const idx = after.tl.segments.findIndex((s) => s.item.id === extra.result);
    const first = after.tl.segments[idx - 1];
    const second = after.tl.segments[idx];
    const orig = before.tl.segments.find((s) => s.item.id === first.item.id);
    // The movie keeps its length unless a half is shorter than twice a neighbouring transition:
    // computeTimeline then clamps that overlap (min(tr, prev/2, cur/2)) and the pictures get longer
    // by exactly the lost overlap. Nothing else may move.
    if (second.transitionIn) fail('split-length', 'the second half starts with a transition');
    const wasOverlap = new Map(bSeg.segments.map((s) => [s.item.id, overlap(s)]));
    const nextAfter = after.tl.segments[idx + 1];
    let lost = 0;
    for (const s of after.tl.segments) {
      if (s === second) continue;
      const was = wasOverlap.get(s.item.id) || 0;
      const now = overlap(s);
      if (s === first || s === nextAfter) {
        const prev = after.tl.segments[s.index - 1];
        const clamp = Math.min(Number.isFinite(s.item.transition.duration) ? s.item.transition.duration : M.DEFAULT_TRANSITION_DURATION,
          prev ? prev.duration / 2 : 0, s.duration / 2);
        if (now > was + 1e-9 || (now < was - 1e-9 && !near(now, Math.max(0, clamp), 1e-9))) {
          fail('split-length', `split changed the transition into ${s.item.kind} ${s.index} from ${was} to ${now} (clamp ${clamp})`);
        }
        lost += was - now;
      } else if (!near(now, was, 1e-9)) {
        fail('split-length', `split changed an unrelated transition (${s.item.kind} ${s.index}) from ${was} to ${now}`);
      }
    }
    if (!near(aEnd(after.tl), aEnd(bSeg) + lost, 1e-3)) {
      fail('split-length', `split changed the length of the pictures from ${aEnd(bSeg).toFixed(3)} to ${aEnd(after.tl).toFixed(3)} (clamped overlaps account for ${lost.toFixed(3)})`);
    }
    if (!near(first.duration + second.duration, orig.duration, 1e-3)) fail('split-halves', `halves ${first.duration}+${second.duration} != ${orig.duration}`);
    if (first.item.kind === 'video') {
      const t = extra.time;
      const want = orig.sourceIn + (t - orig.start) * (orig.item.speed || 1);
      if (!near(first.sourceOut, want, 1e-3) || !near(second.sourceIn, want, 1e-3)) {
        fail('split-frame', `split at ${t}: halves meet at ${first.sourceOut}/${second.sourceIn}, frame under playhead was ${want}`);
      }
    }
  }

  // --- set start / end point
  if ((name === 'setStartPoint' || name === 'setEndPoint') && extra.result === true) {
    const t = extra.time;
    // the segment the command works on: the last selected video under the playhead, or (no
    // selection) the segment under the playhead
    let orig;
    if (before.selection.type === 'item') {
      orig = before.tl.segments.filter((s) => s.item.kind === 'video' && before.selection.ids.includes(s.item.id)
        && t >= s.start - 1e-6 && t <= s.end + 1e-6).pop();
    } else {
      orig = before.tl.segments[M.segmentIndexAt(before.tl, t)];
    }
    if (orig) {
      const want = orig.sourceIn + (t - orig.start) * (orig.item.speed || 1);
      const now = after.tl.segments.find((s) => s.item.id === orig.item.id);
      const got = name === 'setStartPoint' ? now.sourceIn : now.sourceOut;
      if (!near(got, want, 1e-3)) fail(`setpoint-frame:${name}`, `${name} at ${t} (speed ${orig.item.speed}): ${got} != frame ${want}`);
    }
  }

  // --- music split / set start / end point (the song keeps playing at the same movie time)
  if (['musicSplit', 'musicSetStartPoint', 'musicSetEndPoint'].includes(name) && extra.result) {
    const t = extra.time;
    const sel = before.selection.ids;
    const orig = before.tl.music.filter((m) => sel.includes(m.item.id) && t >= m.start - 1e-6 && t <= m.end + 1e-6).pop();
    if (orig) {
      const local = t - orig.start;
      const now = after.tl.music.find((m) => m.item.id === orig.item.id);
      if (name === 'musicSplit') {
        const second = after.tl.music.find((m) => m.item.id === extra.result);
        if (!near(now.end, second.start, 1e-3) || !near(now.end, t, 1e-3) || !near(second.end, orig.end, 1e-3)) {
          fail('music-split', `halves ${now.start}..${now.end} + ${second.start}..${second.end}, original ${orig.start}..${orig.end}, playhead ${t}`);
        }
        if (!near(second.item.trimStart, now.item.trimEnd, 1e-6)) fail('music-split', 'halves do not meet in the song');
      } else if (name === 'musicSetStartPoint') {
        if (!near(now.start, orig.start, 1e-6) || !near(now.item.trimStart, orig.item.trimStart + local, 1e-3) || !near(now.end, orig.end - local, 1e-3)) {
          fail('music-setpoint', `start point: ${JSON.stringify([now.start, now.end, now.item.trimStart])} from ${JSON.stringify([orig.start, orig.end, orig.item.trimStart])} at ${t}`);
        }
      } else if (!near(now.start, orig.start, 1e-6) || !near(now.end, t, 1e-3)) {
        fail('music-setpoint', `end point: music now ${now.start}..${now.end}, playhead ${t}`);
      }
    }
  }

  // --- AutoMovie result shape: opening title first, credits after the pictures
  if (name === 'autoMovie' && extra.result && extra.result.ok) {
    const p = store.project;
    if (!p.items.length || p.items[0].kind !== 'title') fail('automovie-shape', 'the movie does not start with a title');
    const visEnd = after.tl.segments.length ? after.tl.segments[after.tl.segments.length - 1].end : 0;
    if (extra.result.creditsAdded) {
      const c = p.texts.find((x) => x.id === extra.result.creditsId);
      if (!c || c.start < visEnd - 1e-3) fail('automovie-shape', `new credits at ${c && c.start} start before the end of the pictures ${visEnd}`);
    }
  }

  // --- paste position (pictures)
  if (name === 'paste' && Array.isArray(extra.result) && before.clipType === 'item' && before.selection.type === 'item') {
    const last = Math.max(...before.selection.ids.map((id) => before.project.items.findIndex((i) => i.id === id)));
    const at = store.project.items.findIndex((i) => i.id === extra.result[0]);
    if (at !== last + 1) fail('paste-position', `pasted at index ${at}, expected right after the selection (${last + 1})`);
  }

  // --- AutoMovie twice = no change, no duplicate titles/credits
  if (name === 'autoMovie' && extra.result && extra.result.ok) {
    const s2 = new Store();
    s2.media = store.media;
    s2.replaceProject(structuredClone(store.project));
    const p1 = noStamp(s2.project);
    const titles1 = s2.project.items.filter((i) => i.kind === 'title').length;
    const credits1 = s2.project.texts.filter((i) => i.kind === 'credits').length;
    const r2 = applyAutoMovie(s2, op.arg);
    const titles2 = s2.project.items.filter((i) => i.kind === 'title').length;
    const credits2 = s2.project.texts.filter((i) => i.kind === 'credits').length;
    if (r2.titleAdded || r2.creditsAdded || titles2 !== titles1 || credits2 !== credits1) {
      fail('automovie-duplicates', `second AutoMovie added ${titles2 - titles1} title(s) and ${credits2 - credits1} credits`);
    }
    // ignore sub-millisecond re-rounding of times
    if (!deepNear(JSON.parse(noStamp(s2.project)), JSON.parse(p1), 1e-3)) fail('automovie-idempotent', `second AutoMovie "${op.arg}" changed the project: ${firstDiff(p1, noStamp(s2.project))}`);
  }
}

// ------------------------------------------------------------------ one sequence
async function runSequence(ops, { stopAt = Infinity } = {}) {
  const env = makeApp();
  const { store, toasts } = env;
  const origErr = console.error;
  const errs = [];
  console.error = (...a) => { errs.push(a.map((x) => (x && x.stack) || String(x)).join(' ')); };
  try {
    // history model: snaps[k] = project JSON when the undo stack had k entries
    // (updatedAt is ignored: an undo may legitimately stamp a new modification time)
    let snaps = [noStamp(store.project)];
    let initial = snaps[0];
    let tl = checkStructure(store);
    for (let i = 0; i < ops.length && i < stopAt; i++) {
      const op = ops[i];
      const before = {
        project: structuredClone(store.project),
        tl: M.computeTimeline(structuredClone(store.project), store.media),
        anchors: anchorsOf(tl),
        selection: structuredClone(store.selection),
        clipType: store.clipboard && store.clipboard.type,
        undoLen: store._undo.length,
      };
      const time = env.player.currentTime;
      const ctx = {};
      let result;
      try {
        result = await applyOp(env, op, ctx);
      } catch (err) {
        fail('throws', `${op.op}${op.name ? `:${op.name}` : ''} threw ${err && err.stack}`);
      }
      const name = op.op === 'cmd' || op.op === 'pointCmd' ? op.name : op.op;
      if (errs.length) fail(`console-error:${name}`, errs.join(' | ').slice(0, 400));
      const generic = toasts.find((t) => /Something went wrong/.test(t.msg));
      if (generic) fail(`generic-error:${name}`, generic.msg);
      toasts.length = 0;

      if (process.env.FUZZ_DUMP) {
        const t2 = M.computeTimeline(store.project, store.media);
        origErr.call(console, `#${i} ${JSON.stringify(op)} → result ${JSON.stringify(result)?.slice(0, 80)}\n   segs ${t2.segments.map((g) => `${g.item.kind[0]}${g.transitionIn ? `~${+g.transitionIn.duration.toFixed(3)}` : ''}[${+g.start.toFixed(3)}..${+g.end.toFixed(3)}]`).join(' ')}\n   texts ${t2.texts.map((x) => `${x.item.kind}@${x.start}`).join(' ')}  sel ${store.selection.type}:${store.selection.ids.length}  t=${env.player.currentTime}`);
      }
      tl = checkStructure(store);
      const L = store._undo.length;
      const cur = noStamp(store.project);
      if (op.op === 'reload' || op.op === 'switchProject') {
        if (JSON.stringify(store.project) !== ctx.reloaded) fail('reload-identity', firstDiff(ctx.reloaded, JSON.stringify(store.project)));
        snaps = [cur];
        initial = cur;
      } else if (op.op === 'history') {
        if (snaps[L] === undefined) fail('history', `no snapshot for undo depth ${L}`);
        if (snaps[L] !== cur) fail('history-undo-redo', `after ${op.undo} undo / ${op.redo} redo the project is not the one recorded at depth ${L}: ${firstDiff(snaps[L], cur)}`);
      } else if (L === before.undoLen + 1) {
        if (snaps[L - 1] !== noStamp(store._undo[L - 1].project)) fail('history-snapshot', 'undo entry is not the state before the command');
        if (noStamp(before.project) === noStamp(store.project)) fail(`noop-undo-step:${name}`, `${name}(${JSON.stringify(op.arg)}) added an undo step without changing the project`);
        snaps.length = L;
        snaps[L] = cur;
      } else if (L === before.undoLen) {
        const changedNow = noStamp(before.project) !== noStamp(store.project);
        if (changedNow) {
          if (!store._lastCoalesce) fail(`mutation-without-undo:${name}`, `${name} changed the project without an undo step`);
          snaps[L] = cur; // coalesced into the previous step
        }
      } else {
        fail('history', `undo depth jumped from ${before.undoLen} to ${L} on ${name}`);
      }
      const after = { tl };
      if (ctx.selection) before.selection = ctx.selection;
      checkSemantics(env, op, before, after, { result, time: ctx.time !== undefined ? ctx.time : time });

      // occasional undo→redo identity probe (outside the generated ops)
      if (op.op !== 'history' && store.canUndo && (i % 4 === 1)) {
        const selBefore = JSON.stringify(store.selection);
        store.undo();
        const undone = noStamp(store.project);
        if (undone !== snaps[store._undo.length]) fail('history-undo', `undo after ${name} did not restore the previous project: ${firstDiff(snaps[store._undo.length], undone)}`);
        checkStructure(store);
        store.redo();
        if (noStamp(store.project) !== cur) fail('history-redo', `undo→redo after ${name} is not the identity`);
        if (JSON.stringify(store.selection) !== selBefore) {
          // selection after redo should be the selection the edit left behind
          fail('history-redo-selection', `undo→redo after ${name} changed the selection ${selBefore} → ${JSON.stringify(store.selection)}`);
        }
        checkStructure(store);
      }
    }
    // undo everything → initial; redo everything → final
    // redo all goes to the deepest recorded state (pending redo steps included)
    const final = snaps[snaps.length - 1];
    let guard = 0;
    while (store.canUndo && guard++ < 1000) { store.undo(); checkStructure(store); }
    if (noStamp(store.project) !== initial) fail('history-undo-all', `undo all did not return to the initial project: ${firstDiff(initial, noStamp(store.project))}`);
    guard = 0;
    while (store.canRedo && guard++ < 1000) { store.redo(); checkStructure(store); }
    if (noStamp(store.project) !== final) fail('history-redo-all', 'redo all did not return to the final project');
    return null;
  } catch (err) {
    if (err instanceof Failure) return err;
    return new Failure('harness', err && err.stack);
  } finally {
    console.error = origErr;
  }
}

// ------------------------------------------------------------------ shrinking
async function reproduces(ops, key) {
  const f = await runSequence(ops);
  return !!f && f.key === key;
}

async function shrink(ops, key) {
  let cur = ops.slice();
  // cut the tail after the failing step first
  for (let n = 1; n <= cur.length; n++) {
    const f = await runSequence(cur, { stopAt: n });
    if (f && f.key === key) { cur = cur.slice(0, n); break; }
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (let chunk = Math.max(1, Math.floor(cur.length / 2)); chunk >= 1; chunk = Math.floor(chunk / 2)) {
      for (let i = 0; i + chunk <= cur.length;) {
        const trial = cur.slice(0, i).concat(cur.slice(i + chunk));
        if (await reproduces(trial, key)) { cur = trial; progress = true; } else i += chunk;
      }
      if (chunk === 1) break;
    }
  }
  // simplify: every dt → 1000 when it still reproduces
  for (const op of cur) {
    if (op.dt !== 1000) {
      const old = op.dt;
      op.dt = 1000;
      if (!(await reproduces(cur, key))) op.dt = old;
    }
  }
  return cur;
}

// ------------------------------------------------------------------ main
// --replay=<file.json>: run one op list (as printed in a failure's "repro ops") and report.
const REPLAY = opt('replay', '');
if (REPLAY) {
  const { readFileSync } = await import('node:fs');
  const ops = JSON.parse(readFileSync(REPLAY, 'utf8'));
  const f = await runSequence(ops);
  console.log(f ? `FAIL - ${f.key}\n       ${f.detail}` : 'ok   - replay held every invariant');
  process.exit(f ? 1 : 0);
}
const failures = new Map(); // key → { count, first: { seed, ops, detail } }
let steps = 0;
const t0 = Date.now();
for (let run = 0; run < RUNS; run++) {
  const seed = SEED * 100003 + run;
  const rnd = mulberry32(seed);
  const n = 10 + Math.floor(rnd() * (MAX_STEPS - 10));
  const ops = [];
  // most sequences start with some pictures so the editing commands have something to work on
  if (rnd() < 0.9) ops.push({ op: 'addMedia', dt: 1000, files: Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => genMediaSpec(rnd, ['video', 'video', 'image', 'image'])) });
  if (rnd() < 0.5) ops.push({ op: 'addMusic', dt: 1000, files: [genMediaSpec(rnd, ['audio'])] });
  while (ops.length < n) ops.push(genOp(rnd));
  steps += ops.length;
  const f = await runSequence(ops);
  if (!f) continue;
  if (ONLY && f.key !== ONLY) continue;
  const e = failures.get(f.key);
  if (e) { e.count++; continue; }
  failures.set(f.key, { count: 1, first: { seed, ops, detail: f.detail } });
  if (VERBOSE) console.log(`run ${run} seed ${seed}: ${f.key} — ${String(f.detail).slice(0, 300)}`);
}

console.log(`fuzz: ${RUNS} sequences, ${steps} ops, seed ${SEED}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (VERBOSE) console.log(`checks: ${JSON.stringify(Object.fromEntries([...stats].sort()))}`);
if (allowed.size) console.log(`allowed (known) failures: ${JSON.stringify(Object.fromEntries(allowed))}`);
if (!failures.size) {
  console.log('ok   - all invariants held');
  process.exit(0);
}
for (const [key, e] of [...failures].sort((a, b) => b[1].count - a[1].count)) {
  let ops = e.first.ops;
  let detail = e.first.detail;
  if (SHRINK) {
    ops = await shrink(ops, key);
    const f = await runSequence(ops);
    if (f) detail = f.detail;
  }
  console.log(`\nFAIL - ${key}  (${e.count} sequence${e.count === 1 ? '' : 's'}; first seed ${e.first.seed})`);
  console.log(`       ${String(detail).split('\n').slice(0, 4).join('\n       ')}`);
  console.log(`       repro ops (${ops.length}): ${JSON.stringify(ops)}`);
}
console.log(`\n${failures.size} invariant failure kind(s)`);
process.exit(1);
