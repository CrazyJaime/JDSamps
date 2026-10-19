// A virtual clock for code that takes {now, setTimeout, clearTimeout} (engine/loader.js deps.clock), and for the
// delays of the harnesses that drive it. Time stands still until a pump moves it to the next timer, and the pump moves
// it only once the microtask and immediate queues have drained: one virtual timer fires per macrotask. Whatever the
// code under test and its fakes do "at once" (promises, setImmediate) always comes before anything "later", however
// busy the machine is, and a test of a 60-second wait takes no real time.

let pumps = 0; // pumps' own immediates queued, of every clock: two clocks never wait on each other
/** Immediates still to run, but for pumps (the one running now is not counted). */
const pending = () => process.getActiveResourcesInfo().reduce((n, r) => n + (r === 'Immediate'), 0) - pumps;
const later = (fn) => { pumps++; setImmediate(() => { pumps--; fn(); }); };

export class VirtualClock {
  constructor() {
    this.t = 0;
    this.seq = 0;
    this.timers = new Set();
    this.pumping = false;
  }

  now() { return this.t; }

  setTimeout(fn, ms = 0, ...args) {
    const h = { at: this.t + Math.max(0, Number(ms) || 0), seq: this.seq++, fn: () => fn(...args), every: 0, live: true, refd: true,
      unref() { this.refd = false; return this; }, ref() { this.refd = true; return this; }, hasRef() { return this.refd; } };
    this.timers.add(h);
    this.wake();
    return h;
  }
  clearTimeout(h) { if (h && this.timers.delete(h)) h.live = false; }
  setInterval(fn, ms = 0, ...args) { const h = this.setTimeout(fn, ms, ...args); h.every = Math.max(1, Number(ms) || 0); return h; }
  clearInterval(h) { this.clearTimeout(h); }
  /** Resolves after ms of virtual time. */
  sleep(ms) { return new Promise((r) => this.setTimeout(r, ms)); }

  wake() {
    if (this.pumping) return;
    this.pumping = true;
    later(() => this.pump());
  }

  pump() {
    if (pending() > 0) { later(() => this.pump()); return; }
    let next = null, refd = false;
    for (const h of this.timers) {
      refd = refd || h.refd;
      if (!next || h.at < next.at || (h.at === next.at && h.seq < next.seq)) next = h;
    }
    if (!next || !refd) { this.pumping = false; return; } // nothing to wait for: the clock stands still until a timer is set
    this.t = Math.max(this.t, next.at);
    if (next.every) { next.at = this.t + next.every; next.seq = this.seq++; } else { this.timers.delete(next); next.live = false; }
    later(() => this.pump());
    try { next.fn(); } catch (err) { process.nextTick(() => { throw err; }); }
  }
}
