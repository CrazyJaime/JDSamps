// engine/assemble.js — strict assembly of captured media (§6). The decoder fails silently on bad input (it
// closes holes and drops duplicates), so nothing reaches it unchecked: captured parts are grouped into runs (an
// init and the media appended after it), placed on the media timeline from the bytes themselves, one segment
// is chosen per span (the higher bitrate, switching only at a boundary both renditions share), and the result
// must cover [0, duration] within one codec frame. decodePlaced decodes each run as [init + segments] and
// stitches the PCM at the placed offsets.
//
// Splices, as measured in Chromium: every decode drops the codec delay (Opus pre-skip) at its start, so a run's
// decoded sample 0 is its first segment's media time, and its own audio ends one codec delay before the next
// run's first segment. A decoder started cold is wrong for its first ~0.5 s, so the run after a switch is decoded
// with the segments just before the switch fed first (the previous run's own packets when the codec setup matches,
// which is exactly what a player decodes; else the new rendition's own earlier segments), and the PCM is cut where
// the previous run's audio ends. The join is then sample-continuous.

import { mp4Items, webmItems, mp3Frames, adtsFrames } from './bmff.js';

const FRAME = 0.02;   // s: one Opus frame, the tolerance when nothing better is known
const PREROLL = 1;    // s of decoder warm-up fed ahead of a switch
const EXACT = 1e-6;   // s: segments that must abut exactly (a warm-up chain)

export class AssemblyError extends Error {
  /** reason: 'gaps' (audio missing), 'duration' (length unknown or not matching), 'splice', 'decode'. */
  constructor(message, { gaps = [], reason = 'gaps' } = {}) {
    super(message);
    this.name = 'AssemblyError';
    this.gaps = gaps;
    this.reason = reason;
  }
}

const bytesOf = (b) => (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b));
const span = ([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} s`;
const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 4096) s += String.fromCharCode(...u8.subarray(i, i + 4096)); return s; };

function join(list) {
  const out = new Uint8Array(list.reduce((n, b) => n + b.byteLength, 0)), cuts = [];
  let k = 0;
  for (const b of list) { cuts.push(k); out.set(bytesOf(b), k); k += b.byteLength; }
  return { buf: out, cuts };
}

function sniff(mime, b) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a')) return 'mp4';
  if (m.includes('webm') || m.includes('matroska')) return 'webm';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('aac') || m.includes('adts')) return 'adts';
  const tag = String.fromCharCode(...b.subarray(4, 8));
  if (['ftyp', 'styp', 'moov', 'moof', 'sidx'].includes(tag)) return 'mp4';
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'webm';
  if (mp3Frames(b.subarray(0, 8192)).frames) return 'mp3';
  if (adtsFrames(b.subarray(0, 8192)).frames) return 'adts';
  return null;
}

/**
 * Place captured parts on the media timeline.
 * parts: [{bytes: ArrayBuffer, mime, kind: 'init'|'media'|'file', sb, seq}] — one SourceBuffer's parts in `seq` order
 * form one byte stream (an append may split a box); a 'file' part stands alone.
 * -> { runs: [{mime, init, segs: [{t0, t1, bytes}], delay, rate, key, preroll: {segs}|null, cold}],
 *      coverage: [[t0, t1]], gaps: [[t0, t1]], tol, tolSamples, skipped }
 * Times are media seconds. `gaps` holds the holes inside the coverage (the end is checked against a duration by
 * gapsFor / decodePlaced). `skipped` counts parts nothing could be placed from.
 */
export function placeParts(parts) {
  const streams = new Map();
  parts.forEach((p, i) => {
    const key = p.kind === 'file' ? `file:${i}` : `sb:${p.sb ?? 0}`;
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push(p);
  });
  const reps = new Map();
  let skipped = 0;
  const rep = (id, props) => { if (!reps.has(id)) reps.set(id, { id, segs: [], bytes: 0, secs: 0, ...props }); return reps.get(id); };
  const add = (r, seg) => {
    if (r.segs.some((s) => Math.abs(s.t0 - seg.t0) < EXACT)) return;                    // a duplicate append
    r.segs.push(seg); r.bytes += seg.bytes.byteLength; r.secs += seg.t1 - seg.t0;
  };

  for (const [key, list] of streams) {
    list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const { buf, cuts } = join(list.map((p) => p.bytes));
    const mime = list[0].mime, fmt = buf.length ? sniff(mime, buf) : null;
    const used = new Array(list.length).fill(false);
    const mark = (s, e) => cuts.forEach((c, i) => { const ce = cuts[i + 1] ?? buf.length; if (s < ce && e > c) used[i] = true; });
    if (fmt === 'mp4' || fmt === 'webm') {
      let r = null;
      for (const it of (fmt === 'mp4' ? mp4Items : webmItems)(buf, { resync: cuts })) {
        if (it.kind === 'init') {
          const info = it.info;
          if (fmt === 'mp4' && !info.fragmented) {                                       // a whole progressive file
            r = null;
            if (!info.duration || !info.timescale) continue;
            const all = buf.slice().buffer;
            add(rep(`${key}:whole`, { fmt, mime, key: info.key, init: null, rate: info.rate, delay: info.delay / info.timescale }),
              { t0: 0, t1: info.duration / info.timescale, frame: FRAME, bytes: all });
            mark(0, buf.length);
            continue;
          }
          const init = buf.slice(it.start, it.end);
          r = rep(`${fmt}:${latin1(init)}`, { fmt, mime, key: info.key, init: init.buffer, rate: info.rate || 48000,
            delay: fmt === 'mp4' ? info.delay / info.timescale : info.delay });
          mark(it.start, it.end);
        } else if (r) {
          add(r, { t0: it.t0, t1: it.t1, frame: it.frame, bytes: buf.slice(it.start, it.end).buffer });
          mark(it.start, it.end);
        }
      }
    } else if (fmt === 'mp3' || fmt === 'adts') {
      const w = fmt === 'mp3' ? mp3Frames(buf) : adtsFrames(buf);
      if (w.frames && !w.midJunk) {                                                       // lost sync: bytes may be missing, so place nothing
        add(rep(`${key}:${fmt}`, { fmt, mime, key: `${fmt}/${w.sampleRate}`, init: null, rate: w.sampleRate, delay: 0 }),
          { t0: 0, t1: w.samples / w.sampleRate, frame: w.spf / w.sampleRate, bytes: buf.slice(0, w.end).buffer });
        used.fill(true);
      }
    }
    skipped += used.filter((u) => !u).length;
  }
  return choose([...reps.values()], skipped);
}

const MAX_TAIL = 16 * 2 ** 20; // bytes a stream may hold unread (nothing in them placed) before the index gives up on it

/**
 * placeParts kept up to date as parts come in, for a drive that looks for gaps every few hundred ms: each new part is
 * read once (an item cut across appends waits for the rest), what it places goes into an index, and the coverage comes
 * from the same choose(). The last item read in a stream is read again with what follows it (a WebM cluster of unknown
 * size may still grow). Its segments carry no bytes: the placement a decode needs is placeParts', made once this finds
 * no gap. update(parts) takes the list placeParts would take, and returns null when a stream defeats it (bytes it cannot
 * get past): placeParts has the say then.
 */
export class PlaceIndex {
  constructor() { this.reset(); }
  reset() { this.seen = new Set(); this.streams = new Map(); this.reps = new Map(); this.files = 0; this.lost = false; }

  update(parts) {
    let kept = 0;
    for (const p of parts) if (this.seen.has(p)) kept++;
    if (kept < this.seen.size) this.reset(); // a part left the list (another player feeds the track now): from the start
    const touched = new Set();
    for (const p of parts) {
      if (this.seen.has(p)) continue;
      this.seen.add(p);
      const key = p.kind === 'file' ? `file:${this.files++}` : `sb:${p.sb ?? 0}`;
      let s = this.streams.get(key);
      if (!s) this.streams.set(key, (s = { key, mime: p.mime, fmt: null, fresh: [], tail: [], size: 0, last: -Infinity, init: null, rep: null, prov: [], mp3: null }));
      s.fresh.push(p);
      touched.add(s);
    }
    for (const s of touched) {
      s.fresh.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      // A part that comes after a later one of its stream was read: everything is read again, in order.
      if ((s.fresh[0].seq ?? 0) < s.last) { const all = parts; this.reset(); return this.update(all); }
    }
    for (const s of touched) this.read(s);
    return this.lost ? null : this.placement();
  }

  rep(id, props) { if (!this.reps.has(id)) this.reps.set(id, { id, segs: [], bytes: 0, secs: 0, ...props }); return this.reps.get(id); }
  add(r, seg) {
    if (r.segs.some((s) => Math.abs(s.t0 - seg.t0) < EXACT)) return;
    r.segs.push(seg); r.bytes += seg.size; r.secs += seg.t1 - seg.t0;
  }

  read(s) {
    for (const p of s.fresh) { s.tail.push(bytesOf(p.bytes)); s.size += p.bytes.byteLength; s.last = Math.max(s.last, p.seq ?? 0); }
    s.fresh = [];
    if (!s.fmt) { const { buf } = join(s.tail); s.fmt = buf.length ? sniff(s.mime, buf) : null; }
    if (s.fmt === 'mp4' || s.fmt === 'webm') this.readItems(s);
    else if (s.fmt === 'mp3' || s.fmt === 'adts') this.readFrames(s);
    if (s.tail.reduce((n, b) => n + b.byteLength, 0) > MAX_TAIL) this.lost = true;
  }

  /** fMP4 or WebM: the unread bytes behind the init they follow, walked as placeParts walks them. */
  readItems(s) {
    const pre = s.init ? [s.init] : [], { buf, cuts } = join([...pre, ...s.tail]), base = pre.length ? s.init.byteLength : 0;
    const items = (s.fmt === 'mp4' ? mp4Items : webmItems)(buf, { resync: cuts }).filter((it) => it.start >= base);
    let done = base, cur = s.rep;
    s.prov = [];
    items.forEach((it, i) => {
      const last = i === items.length - 1;
      if (it.kind === 'init') {
        const info = it.info;
        if (s.fmt === 'mp4' && !info.fragmented) {                                       // a whole progressive file
          cur = null;
          if (info.duration && info.timescale) {
            const r = this.rep(`${s.key}:whole`, { fmt: s.fmt, mime: s.mime, key: info.key, init: null, rate: info.rate, delay: info.delay / info.timescale });
            const seg = { t0: 0, t1: info.duration / info.timescale, frame: FRAME, size: s.size, bytes: null };
            if (last) s.prov.push({ r, seg }); else this.add(r, seg);
          }
          if (!last) { s.init = null; s.rep = null; }
        } else {
          const init = buf.slice(it.start, it.end);
          cur = this.rep(`${s.fmt}:${latin1(init)}`, { fmt: s.fmt, mime: s.mime, key: info.key, init: init.buffer, rate: info.rate || 48000,
            delay: s.fmt === 'mp4' ? info.delay / info.timescale : info.delay });
          if (!last) { s.init = init; s.rep = cur; }
        }
      } else if (cur) {
        const seg = { t0: it.t0, t1: it.t1, frame: it.frame, size: it.end - it.start, bytes: null };
        if (last) s.prov.push({ r: cur, seg }); else this.add(cur, seg);
      }
      if (!last) done = it.end;
    });
    // What is left unread: from the end of the last item read for good, still cut where the appends were.
    const tail = [];
    cuts.forEach((c, i) => { const e = cuts[i + 1] ?? buf.length; if (e > done && e > base) tail.push(buf.subarray(Math.max(c, done, base), e)); });
    s.tail = tail;
  }

  /** MP3 or ADTS: the frame walk goes on from the last whole frame; the stream is one segment from 0, as placeParts has it. */
  readFrames(s) {
    const m = s.mp3 || (s.mp3 = { frames: 0, samples: 0, sampleRate: 0, spf: 0, at: 0, midJunk: false });
    const { buf } = join(s.tail), walk = s.fmt === 'mp3' ? mp3Frames : adtsFrames;
    const w = walk(buf, m.frames ? { resume: { frames: m.frames, sampleRate: m.sampleRate } } : {});
    if (w.frames) {
      m.frames += w.frames; m.samples += w.samples; m.sampleRate = w.sampleRate; m.spf = Math.max(m.spf, w.spf); m.at += w.end;
      m.midJunk = m.midJunk || w.midJunk;
      s.tail = w.end < buf.length ? [buf.subarray(w.end)] : [];
    }
    s.prov = [];
    if (!m.frames || m.midJunk) { this.reps.delete(`${s.key}:${s.fmt}`); return; }         // lost sync: bytes may be missing, so place nothing
    const r = this.rep(`${s.key}:${s.fmt}`, { fmt: s.fmt, mime: s.mime, key: `${s.fmt}/${m.sampleRate}`, init: null, rate: m.sampleRate, delay: 0 });
    r.segs = [{ t0: 0, t1: m.samples / m.sampleRate, frame: m.spf / m.sampleRate, size: m.at, bytes: null }];
    r.bytes = m.at; r.secs = r.segs[0].t1;
  }

  /** The placement as placeParts gives it for the parts read so far (with each stream's last item as read now). */
  placement() {
    const prov = new Map();
    for (const s of this.streams.values()) for (const { r, seg } of s.prov) { if (!prov.has(r)) prov.set(r, []); prov.get(r).push(seg); }
    const reps = [...this.reps.values()].map((r) => {
      const more = (prov.get(r) || []).filter((seg) => !r.segs.some((x) => Math.abs(x.t0 - seg.t0) < EXACT));
      return more.length ? { ...r, segs: [...r.segs, ...more], bytes: r.bytes + more.reduce((n, x) => n + x.size, 0), secs: r.secs + more.reduce((n, x) => n + x.t1 - x.t0, 0) } : r;
    });
    for (const [r, segs] of prov) if (!this.reps.has(r.id)) reps.push({ ...r, segs }); // a rep only a last item has made so far
    return choose(reps, 0);
  }
}

/** One segment per span: the highest bitrate starting at each boundary, a switch only where a warm-up exists. */
function choose(reps, skipped) {
  const all = reps.flatMap((r) => r.segs.map((s) => ({ ...s, rep: r }))).sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  const rate = (r) => (r.secs ? r.bytes / r.secs : 0);
  const tol = Math.min(0.12, Math.max(0, ...all.map((s) => s.frame || 0))) || FRAME;
  const chosen = [], gaps = [];
  let t = all.length ? all[0].t0 : 0, cur = null;
  if (all.length && t > tol) gaps.push([0, t]);
  while (all.length) {
    const cands = all.filter((s) => Math.abs(s.t0 - t) <= tol && s.t1 > t + tol);
    if (!cands.length) {
      const after = all.find((s) => s.t0 > t + tol);
      const over = all.filter((s) => s.t0 < t - tol && s.t1 > t + tol);                 // material whose boundaries do not line up
      if (!after) { if (over.length) gaps.push([t, Math.max(...over.map((s) => s.t1))]); break; }
      gaps.push([t, after.t0]); t = after.t0; cur = null; continue;
    }
    const ok = (c) => !cur || c.rep === cur || !!warmup(chosen, c.rep, c.t0, tol);
    const pick = cands.sort((a, b) => ok(b) - ok(a) || rate(b.rep) - rate(a.rep) || (b.rep === cur) - (a.rep === cur))[0];
    chosen.push(pick); t = pick.t1; cur = pick.rep;
  }

  const runs = [], coverage = [];
  for (const s of chosen) {
    const last = runs.at(-1), prev = last?.segs.at(-1);
    const joined = prev && Math.abs(s.t0 - prev.t1) <= tol;
    if (joined) coverage.at(-1)[1] = s.t1; else coverage.push([s.t0, s.t1]);
    if (joined && last.rep === s.rep) last.segs.push(s);
    else runs.push({ rep: s.rep, segs: [s] });
  }
  const out = runs.map((run, i) => {
    const M = run.segs[0].t0;
    const pre = i > 0 && M > tol ? warmup(chosen, run.rep, M, tol) : null;
    const r = run.rep, strip = ({ t0, t1, bytes }) => ({ t0, t1, bytes });
    return { mime: r.mime, init: r.init, segs: run.segs.map(strip), delay: r.delay, rate: r.rate, key: r.key,
      preroll: pre && { segs: pre.map(strip) }, cold: i > 0 && M > tol && !pre };
  });
  return { runs: out, coverage, gaps, tol, tolSamples: Math.round(tol * (out[0]?.rate || 48000)), skipped };
}

/** What to feed ahead of a switch to `rep` at M: the packets a player decoded just before it, else the rendition's own. */
const warmup = (chosen, rep, M, tol) => chainBefore(chosen, M, rep.key, tol) || chainBefore(rep.segs.map((s) => ({ ...s, rep })), M, rep.key, tol);

/** Segments (each with .rep) abutting exactly and ending at M, sharing codec `key`: at least PREROLL long, or reaching 0. */
function chainBefore(segs, M, key, tol) {
  const chain = [];
  let t = M, acc = 0;
  for (;;) {
    const s = segs.find((x) => Math.abs(x.t1 - t) < EXACT && x.rep.key === key && x.t0 < t);
    if (!s) break;
    chain.unshift(s); acc += s.t1 - s.t0; t = s.t0;
    if (acc >= PREROLL || t <= tol) return chain;
  }
  return null;
}

/** Spans of [0, duration] the placement does not cover (re-checked against the duration given now). */
export function gapsFor(placed, duration) {
  const { coverage, tol } = placed, gaps = [];
  let t = 0;
  for (const [a, b] of coverage) {
    if (a - t > tol) gaps.push([t, Math.min(a, duration)]);
    t = Math.max(t, b);
    if (t >= duration) break;
  }
  if (duration - t > tol) gaps.push([t, duration]);
  return gaps.filter(([a, b]) => b > a);
}

/**
 * Decode a placement into one track: {L, R, sampleRate} at ctx.sampleRate, `duration` long.
 * Throws AssemblyError when the duration is unknown, when [0, duration] is not covered within one codec frame,
 * when the capture runs past it, or when a run cannot be joined or decodes to an unexpected length.
 */
export async function decodePlaced(ctx, placed, { duration } = {}) {
  if (!(duration > 0) || !Number.isFinite(duration)) {
    throw new AssemblyError('The track length is not known yet, so it cannot be checked for completeness.', { reason: 'duration' });
  }
  const gaps = gapsFor(placed, duration);
  if (gaps.length) throw new AssemblyError(`Audio is missing at ${gaps.map(span).join(', ')}.`, { gaps });
  const { runs, tol } = placed, lastRun = runs.at(-1), end = placed.coverage.at(-1)[1] - (lastRun?.delay || 0);
  if (end - duration > tol) {
    throw new AssemblyError(`The captured audio runs to ${end.toFixed(1)} s, past the track length of ${duration.toFixed(1)} s.`, { reason: 'duration' });
  }
  const cold = runs.find((r) => r.cold);
  if (cold) {
    const t = cold.segs[0].t0;
    throw new AssemblyError(`Two qualities of the track cannot be joined cleanly at ${t.toFixed(1)} s.`, { reason: 'splice', gaps: [[t, t]] });
  }

  // One run: decode straight at the context rate. Several: decode at the media rate, so every cut is exact, then resample once.
  const rate = runs.length > 1 ? Math.max(...runs.map((r) => r.rate || ctx.sampleRate)) : ctx.sampleRate;
  const dctx = rate === ctx.sampleRate ? ctx : new OfflineAudioContext(1, 1, rate);
  const total = Math.round(duration * rate);
  let L = new Float32Array(total), R = new Float32Array(total), filled = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i], fed = [...(run.preroll?.segs || []), ...run.segs];
    const bytes = join([...(run.init ? [run.init] : []), ...fed.map((s) => s.bytes)]).buf;
    let audio;
    try { audio = await dctx.decodeAudioData(bytes.buffer); } catch (e) {
      throw new AssemblyError(`Audio from ${fed[0].t0.toFixed(1)} s would not decode (${e?.message || e}).`, { reason: 'decode', gaps: [[run.segs[0].t0, run.segs.at(-1).t1]] });
    }
    const base = Math.round(fed[0].t0 * rate);                                          // decoded sample 0 sits here
    const expect = (fed.at(-1).t1 - fed[0].t0 - run.delay) * rate, slack = tol * rate + 2;
    if (Math.abs(audio.length - expect) > slack) {
      throw new AssemblyError(`Audio from ${fed[0].t0.toFixed(1)} s decoded to ${(audio.length / rate).toFixed(3)} s instead of ${(expect / rate).toFixed(3)} s.`,
        { reason: 'decode', gaps: [[run.segs[0].t0, run.segs.at(-1).t1]] });
    }
    // This run's own audio ends one codec delay before the next run's first segment (or where its decode ends, if a
    // boundary is a few samples off); the next run, decoded with its warm-up, must already be playing there.
    const next = runs[i + 1] ? Math.round(runs[i + 1].segs[0].t0 * rate) - Math.round(run.delay * rate) : total;
    const stop = Math.min(next, total, base + audio.length);
    if (filled < base && i > 0) {
      const t = run.segs[0].t0;
      throw new AssemblyError(`The join at ${t.toFixed(1)} s is not covered by the decoded audio.`, { reason: 'splice', gaps: [[t, t]] });
    }
    // The first piece may start up to one frame in, as gapsFor allows: silence before it, and it at its own time.
    filled = Math.max(filled, base);
    if (stop <= filled) continue;
    const a = audio.getChannelData(0), b = audio.numberOfChannels > 1 ? audio.getChannelData(1) : a;
    L.set(a.subarray(filled - base, stop - base), filled);
    R.set(b.subarray(filled - base, stop - base), filled);
    filled = stop;
  }
  if (filled < total) { L = L.slice(0, filled); R = R.slice(0, filled); }               // the last frame ends within tolerance of the duration
  if (rate !== ctx.sampleRate) [L, R] = await resample(L, R, rate, ctx.sampleRate);
  return { L, R, sampleRate: ctx.sampleRate };
}

async function resample(L, R, from, to) {
  const oc = new OfflineAudioContext(2, Math.max(1, Math.round(L.length * to / from)), to);
  const buf = oc.createBuffer(2, L.length, from);
  buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
  const src = oc.createBufferSource();
  src.buffer = buf; src.connect(oc.destination); src.start();
  const out = await oc.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}
