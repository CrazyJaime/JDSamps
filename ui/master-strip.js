// ui/master-strip.js — master meters/limiter/volume, crossfader bar, REC MIX, clock and settings.
import { $, $$, setText, toggleAttr, pageHidden, fmtBpm, fmtClock } from './util.js';
import { Knob, Fader, bindSeg } from './controls.js';
import { VMeter } from './meters.js';
import { bindHold } from './hold.js';

export class MasterStrip {
  constructor({ conn, toast, persist }) {
    this.conn = conn;
    this.toast = toast;
    this.persist = persist;
    this.params = {};
    this.rec = { state: 'idle' };
    const vdb = (v) => { if (v <= 0) return '−∞'; const g = v >= 0.5 ? (6 * (v - 0.5)) / 0.5 : 20 * Math.log10((2 * v) ** 3); return `${g >= 0 ? '+' : '−'}${Math.abs(g).toFixed(1)} dB`; };
    this.vol = new Knob($('#masterVol'), { label: 'VOLUME', def: 0.5, value: 0.5, format: vdb, onChange: (v) => conn.set(null, 'master.volume', v) });
    this.limiter = $('#limiterBtn');
    this.limiter.addEventListener('click', () => this.setPersisted('master.limiter', !this.params['master.limiter']));
    // On-air control: no wheel and no double-click jump to centre (\ centres it on purpose).
    this.xf = new Fader($('#crossfader'), { orientation: 'horizontal', label: 'Crossfader', min: 0, max: 1, def: 0.5, value: 0.5, center: true, step: 0.02, fine: 0.004, wheel: false, reset: false, format: (v) => `${Math.round(v * 100)}`, onChange: (v) => conn.set(null, 'xfader.pos', v) });
    this.curve = bindSeg($('#xfCurve'), { onSelect: (v) => this.setPersisted('xfader.curve', v) });
    this.settings = $$('[data-setting]').map((el) => ({ key: el.dataset.setting, seg: bindSeg(el, { onSelect: (v) => this.setPersisted(el.dataset.setting, v) }) }));
    this.meter = new VMeter($('#masterMeter'), { channels: 2 });
    this.gr = new VMeter($('#grMeter'), { mode: 'gr' });
    for (const id of ['#clipL', '#clipR']) $(id).addEventListener('click', () => conn.act(null, 'clipReset'));
    // REC MIX starts on one press; stopping needs a 600 ms hold so a slip never splits the set.
    this.recLabel = $('#mixRecBtn span');
    this.recHold = bindHold($('#mixRecBtn'), {
      ms: 600,
      needsHold: () => this.rec.state === 'recording',
      onPress: () => (this.rec.state === 'finalizing' ? toast('Still saving the last mix recording.', 'info') : this.mixRec('mixRecStart')),
      onHold: () => this.mixRec('mixRecStop'),
      onShort: () => toast('Hold REC MIX (or Shift+R) to stop the mix recording.', 'info'),
    });
    document.addEventListener('visibilitychange', () => { if (this.stale && !pageHidden()) this.render(this.snap); });
  }

  setPersisted(key, value) {
    this.conn.set(null, key, value);
    this.persist(key, value);
  }

  async mixRec(a) {
    const r = await this.conn.act(null, a);
    if (!r.ok && r.error) this.toast(r.error, 'warn');
  }

  // Local commits (sent via onChange), so a stale snapshot cannot undo a key press.
  nudgeXf(delta) { this.xf.commit(this.xf.value + delta); }
  setXf(v) { this.xf.commit(v); }

  /** Every snapshot is stored; the DOM follows only while the page is visible (and catches up when it shows). */
  update(s) {
    this.params = s.master.params;
    this.rec = s.master.rec;
    this.snap = s;
    if (pageHidden()) { this.stale = true; return; }
    this.render(s);
  }

  render(s) {
    this.stale = false;
    const m = s.master, p = m.params;
    this.vol.set(p['master.volume']);
    toggleAttr(this.limiter, 'aria-pressed', p['master.limiter']);
    this.xf.set(p['xfader.pos']);
    this.curve.set(p['xfader.curve']);
    for (const st of this.settings) st.seg.set(p[st.key]);
    const recBtn = $('#mixRecBtn');
    toggleAttr(recBtn, 'aria-pressed', m.rec.state === 'recording');
    const saving = m.rec.state === 'finalizing';
    if (recBtn.disabled !== saving) recBtn.disabled = saving;
    setText(this.recLabel, saving ? 'SAVING' : 'REC MIX');
    setText($('#mixRecTime'), m.rec.state === 'idle' ? '' : fmtClock(m.rec.seconds));
    $('#clipL').classList.toggle('on', m.clipL);
    $('#clipR').classList.toggle('on', m.clipR);
    setText($('#grText'), m.gr < -0.05 ? m.gr.toFixed(1) : '0.0');
    this.meter.update([{ peak: m.peakL, rms: m.rmsL, clip: m.clipL }, { peak: m.peakR, rms: m.rmsR, clip: m.clipR }]);
    this.gr.update({ gr: m.gr });
    const c = s.clock;
    setText($('#clockBpm'), c.bpm ? fmtBpm(c.bpm) : '—');
    const slot = c.mode === 'deck' ? (s.decks.find((d) => d.id === c.deckId) || {}).slot : null;
    setText($('#clockMode'), c.mode === 'deck' ? `DECK ${slot ?? '?'}` : c.mode === 'free' ? 'FREE RUNNING' : 'no master');
  }

  frame() { this.meter.draw(); this.gr.draw(); }
}
