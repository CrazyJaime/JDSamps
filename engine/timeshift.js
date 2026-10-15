// engine/timeshift.js — one deck's playhead over its buffered input, driving a Signalsmith
// Stretch node in buffer mode. The model mirrors the node exactly: every segment we send
// carries an explicit input computed with the node's own formula p(t) = input + rate·(t − output),
// and at most one future change is ever pending in the node (a new schedule() drops all
// changes at/after currentTime), so later changes wait here until the pending one has passed.

export const GUARD = 0.5;        // s of reserve below which the deck may not play faster than 1×
export const LIVE_RESERVE = 0.6; // s of reserve kept by the LIVE jump

const FIELDS = ['active', 'rate', 'semitones', 'input', 'loopStart', 'loopEnd'];
const TRANSPORT = ['active', 'input', 'loopStart', 'loopEnd']; // start/pause, jump, loop: intent a rate update must not undo

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
    seg.transport = TRANSPORT.some((k) => fields[k] !== undefined);
    return seg;
  }

  /**
   * Replace everything planned after `now` with one change at T. A planned transport change
   * (start, pause, jump, loop) that has not happened yet is folded in rather than lost: the new
   * change keeps every field it does not restate and lands at the planned time (or at T, if it
   * jumps and T is later). So a rate update never cancels a pending PLAY or SYNC-PLAY. Only a
   * change that reverses its play state (PAUSE during a pending start) cancels it.
   */
  change(now, T, fields) {
    const planned = this.segs.find((s) => s.output > now && s.transport && (fields.active === undefined || fields.active === s.active));
    this.segs = this.segs.filter((s) => s.output <= now);
    if (!this.segs.length) this.segs = [{ output: -Infinity, input: 0, rate: 1, active: false, semitones: 0, loopStart: 0, loopEnd: 0 }];
    this.queue = [];
    if (planned) {
      T = fields.input === undefined ? planned.output : Math.max(T, planned.output);
      const merged = {};
      for (const k of FIELDS) merged[k] = fields[k] !== undefined ? fields[k] : planned[k];
      fields = merged;
    }
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

  /**
   * Bend the rate in effect at T by `factor` for `duration`, then settle at `end` ({rate, semitones};
   * default: the rate in effect). With `pitchFollows` (vinyl), the pitch bends with the speed.
   */
  bend(now, T, factor, duration, end = {}, pitchFollows = false) {
    const base = this.segAt(T);
    const bent = { rate: base.rate * factor };
    if (pitchFollows) bent.semitones = base.semitones + 12 * Math.log2(factor);
    this.change(now, T, bent);
    this.then(now, T + duration, { rate: base.rate, ...end });
    return T + duration;
  }

  flush(now) {
    while (this.queue.length && this.lastSentOut < now) {
      this.send(this.queue.shift());
    }
  }

  send(seg) {
    const out = { output: seg.output };
    for (const k of FIELDS) out[k] = seg[k];
    // A pause becomes audible ~outLatency after its output time: send it that much earlier.
    if (seg.active === false && this.segAt(seg.output - 1e-9).active) out.output = seg.output - this.outLat;
    this.lastSentOut = out.output;
    const r = this.node.schedule(out);
    if (r && typeof r.then === 'function') r.catch(() => {});
  }

  /** Drop audio older than keepFrom (input s); never keep more than capSec. */
  async trim(now, keepFrom) {
    if (this.trimming) return { dropped: false, start: this.historyStart };
    const target = Math.max(keepFrom, this.liveEdge - this.capSec);
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

/** Beat grid as a step function of input position (assist steps change the input tempo). */
export class GridMap {
  constructor() { this.segs = []; }
  update(grid) {
    if (!grid) return;
    if (!this.segs.length) this.segs.push({ from: -Infinity, grid: { ...grid } });
    else this.segs[this.segs.length - 1].grid = { ...grid };
  }
  split(inPos, grid) {
    if (!grid) return;
    this.segs = this.segs.filter((s) => s.from < inPos);
    this.segs.push({ from: this.segs.length ? inPos : -Infinity, grid: { ...grid } });
  }
  at(inPos) {
    let g = null;
    for (const s of this.segs) { if (s.from <= inPos) g = s.grid; else break; }
    return g;
  }
  prune(inPos) {
    let i = 0;
    while (i + 1 < this.segs.length && this.segs[i + 1].from <= inPos) i++;
    if (i > 0) { this.segs = [{ from: -Infinity, grid: this.segs[i].grid }, ...this.segs.slice(i + 1)]; }
  }
}
