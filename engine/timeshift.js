// engine/timeshift.js — one deck's playhead over its buffered input, driving a Signalsmith
// Stretch node in buffer mode. The model mirrors the node exactly: every segment we send
// carries an explicit input computed with the node's own formula p(t) = input + rate·(t − output),
// and at most one future change is ever pending in the node (a new schedule() drops all
// changes at/after currentTime), so later changes wait here until the pending one has passed.

export const GUARD = 0.5;        // s of reserve below which the deck may not play faster than 1×
export const LIVE_RESERVE = 0.6; // s of reserve kept by the LIVE jump

const FIELDS = ['active', 'rate', 'semitones', 'input', 'loopStart', 'loopEnd'];

export class Timeshift {
  constructor(node, { sampleRate, latency, outLatency, capSec = 240, historySec = 60 }) {
    this.node = node;
    this.sr = sampleRate;
    this.lat = latency;
    this.outLat = outLatency;
    this.capSec = capSec;
    this.historySec = historySec;
    this.liveEdge = 0;
    this.historyStart = 0;
    this.segs = [{ output: -Infinity, input: 0, rate: 1, active: false, semitones: 0, loopStart: 0, loopEnd: 0 }];
    this.queue = [];
    this.lastSentOut = -Infinity;
    this.trimming = false;
  }

  append(L, R) {
    this.liveEdge += L.length / this.sr;
    this.node.addBuffers([L, R], [L.buffer, R.buffer]);
    return this.liveEdge;
  }

  soon(now) { return now + this.lat + 0.03; }

  segAt(t) {
    let s = this.segs[0];
    for (const x of this.segs) { if (x.output <= t) s = x; else break; }
    return s;
  }

  posAt(t) {
    const s = this.segAt(t);
    if (!s.active || s.output === -Infinity) return s.input;
    let p = s.input + s.rate * (t - s.output);
    if (s.loopEnd > s.loopStart && p >= s.loopEnd) p = s.loopStart + ((p - s.loopStart) % (s.loopEnd - s.loopStart));
    return p;
  }

  playingAt(t) { return this.segAt(t).active; }
  rateAt(t) { return this.segAt(t).rate; }
  reserveAt(t) { return Math.max(0, this.liveEdge - this.lat - this.posAt(t)); }

  clampInput(x) {
    return Math.min(Math.max(x, this.historyStart + 0.01), Math.max(this.historyStart + 0.01, this.liveEdge - this.lat - 0.3));
  }

  /** Output time of the last planned change (pending or queued), or -Infinity. */
  pendingUntil() { return this.segs.length > 1 ? this.segs[this.segs.length - 1].output : -Infinity; }

  build(T, fields) {
    const base = this.segAt(T);
    const seg = { output: T };
    for (const k of FIELDS) seg[k] = fields[k] !== undefined ? fields[k] : base[k];
    if (fields.input === undefined) seg.input = this.posAt(T);
    return seg;
  }

  /** Replace everything planned after `now` with one change at T. */
  change(now, T, fields) {
    this.segs = this.segs.filter((s) => s.output <= now);
    if (!this.segs.length) this.segs = [{ output: -Infinity, input: 0, rate: 1, active: false, semitones: 0, loopStart: 0, loopEnd: 0 }];
    this.queue = [];
    const seg = this.build(T, fields);
    this.segs.push(seg);
    this.send(seg);
    return seg;
  }

  /** Plan a change after the currently planned one (it is sent once that one has passed). */
  then(now, T, fields) {
    const seg = this.build(T, fields);
    this.segs.push(seg);
    this.segs.sort((a, b) => a.output - b.output);
    this.queue.push(seg);
    this.flush(now);
    return seg;
  }

  bend(now, T, factor, duration) {
    const base = this.segAt(T);
    this.change(now, T, { rate: base.rate * factor });
    this.then(now, T + duration, { rate: base.rate });
    return T + duration;
  }

  flush(now) {
    while (this.queue.length && this.lastSentOut < now) {
      this.send(this.queue.shift());
    }
  }

  send(seg) {
    const out = { ...seg };
    // A pause becomes audible ~outLatency after its output time: send it that much earlier.
    if (seg.active === false && this.segAt(seg.output - 1e-9).active) out.output = seg.output - this.outLat;
    this.lastSentOut = out.output;
    const r = this.node.schedule(out);
    if (r && typeof r.then === 'function') r.catch(() => {});
  }

  /** Drop audio older than keepFrom (input s); never keep more than capSec, but never drop past limit. */
  async trim(now, keepFrom, limit = Infinity) {
    if (this.trimming) return { dropped: false, start: this.historyStart };
    const target = Math.min(Math.max(keepFrom, this.liveEdge - this.capSec), limit);
    if (target <= this.historyStart + 1) return { dropped: false, start: this.historyStart };
    this.trimming = true;
    try {
      const r = await this.node.dropBuffers(target);
      if (r && typeof r.start === 'number') this.historyStart = Math.max(this.historyStart, r.start);
      return { dropped: true, start: this.historyStart };
    } finally {
      this.trimming = false;
    }
  }
}

/** Source playbackRate (player assist) as a step function of input position. */
export class SourceMap {
  constructor() { this.steps = [{ inPos: -Infinity, rate: 1 }]; }
  set(inPos, rate) {
    this.steps = this.steps.filter((s) => s.inPos < inPos);
    this.steps.push({ inPos, rate });
  }
  rateAt(inPos) {
    let r = this.steps[0].rate;
    for (const s of this.steps) { if (s.inPos <= inPos) r = s.rate; else break; }
    return r;
  }
  nextChangeAfter(inPos) {
    const s = this.steps.find((x) => x.inPos > inPos);
    return s ? { inPos: s.inPos, rate: s.rate } : null;
  }
  prune(inPos) {
    let i = 0;
    while (i + 1 < this.steps.length && this.steps[i + 1].inPos <= inPos) i++;
    if (i > 0) { const keep = this.steps[i]; this.steps = [{ inPos: -Infinity, rate: keep.rate }, ...this.steps.slice(i + 1)]; }
  }
}

/**
 * Beat grid as a step function of input position. Assist steps split a track's grid (the input
 * tempo changes); a new track (DeckTempo's track.n) starts a segment of its own, so the audio
 * still to be played from the old track keeps the old grid. Each segment is tagged with its track.
 */
export class GridMap {
  constructor() { this.segs = []; }
  /**
   * Follow the tracker's live grid. A new track.n starts a segment at track.from, with the old
   * track's grid track.prev before it; assist steps already past track.from become part of the
   * new track, carried from the live grid at their source rates (rateAt(input)).
   */
  update(grid, track, rateAt = () => 1) {
    const last = this.segs[this.segs.length - 1];
    const n = track ? track.n : last ? last.track : 0;
    if (last && n !== last.track) {
      const old = this.segs.filter((s) => s.from < track.from);
      if (track.prev && old.length) old[old.length - 1].grid = { ...track.prev };
      const steps = this.segs.filter((s) => s.from > track.from).map((s) => ({ from: s.from, grid: null, track: n }));
      this.segs = [...old, { from: track.from, grid: null, track: n }, ...steps];
      if (grid) this.retime(Infinity, grid, rateAt);
    } else if (grid) {
      if (!last) this.segs.push({ from: -Infinity, grid: { ...grid }, track: n });
      else last.grid = { ...grid };
    }
  }
  split(inPos, grid) {
    if (!grid) return;
    const track = this.segs.length ? this.segs[this.segs.length - 1].track : 0;
    this.segs = this.segs.filter((s) => s.from < inPos);
    this.segs.push({ from: this.segs.length ? inPos : -Infinity, grid: { ...grid }, track });
  }
  seg(inPos) {
    let g = null;
    for (const s of this.segs) { if (s.from <= inPos) g = s; else break; }
    return g;
  }
  at(inPos) { const s = this.seg(inPos); return s ? s.grid : null; }
  trackAt(inPos) { const s = this.seg(inPos); return s ? s.track : null; }
  /** Apply fn(grid) to every segment of track n (a manual correction). */
  editTrack(n, fn) {
    for (const s of this.segs) if (s.track === n && s.grid) s.grid = fn(s.grid);
  }
  /**
   * Give the segment at inPos the grid {t0, T[, bar1]} and carry it across the rest of its track:
   * the beat phase stays continuous at each boundary and the period follows the source rate there.
   * Segments keep their own bar 1 unless the grid brings one.
   */
  retime(inPos, grid, rateAt) {
    const segs = this.segs, k = segs.indexOf(this.seg(inPos));
    if (k < 0) return;
    const set = (j, t0, T, bar1 = segs[j].grid ? segs[j].grid.bar1 : null) => { segs[j].grid = { t0, T, bar1 }; };
    const carry = (j, i, b) => { // segment j from neighbour i, continuous at input b
      const g = segs[i].grid, T = (g.T * rateAt(segs[i].from)) / rateAt(segs[j].from), ph = (b - g.t0) / g.T;
      set(j, b - (ph - Math.floor(ph)) * T, T, grid.bar1 !== undefined ? grid.bar1 : undefined);
    };
    set(k, grid.t0, grid.T, grid.bar1 !== undefined ? grid.bar1 : undefined);
    for (let j = k + 1; j < segs.length && segs[j].track === segs[k].track; j++) carry(j, j - 1, segs[j].from);
    for (let j = k - 1; j >= 0 && segs[j].track === segs[k].track; j--) carry(j, j + 1, segs[j + 1].from);
  }
  prune(inPos) {
    let i = 0;
    while (i + 1 < this.segs.length && this.segs[i + 1].from <= inPos) i++;
    if (i > 0) { const s = this.segs[i]; this.segs = [{ from: -Infinity, grid: s.grid, track: s.track }, ...this.segs.slice(i + 1)]; }
  }
}
