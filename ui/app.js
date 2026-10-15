// ui/app.js — deck page entry point.
import { PERSISTED_MASTER_KEYS } from '../shared/protocol.js';
import { $, setText, wallNow } from './util.js';
import { EngineConnection } from './connection.js';
import { DeckStrip } from './deck-strip.js';
import { MasterStrip } from './master-strip.js';
import { SourcesDrawer } from './sources.js';
import { bindKeys } from './keys.js';

const strips = new Map();
let snap = null;
let selected = null;
let restored = false;
let wakeLock = null;

const toastTimers = new WeakMap();
/** Toasts sit top centre (no controls there), click to dismiss; a repeated text bumps a counter. */
function toast(text, level = 'info') {
  const box = $('#toasts');
  const msg = String(text);
  let t = [...box.children].find((x) => x.dataset.text === msg && x.dataset.level === level);
  if (t) {
    t.dataset.count = String(Number(t.dataset.count) + 1);
    setText(t.lastElementChild, `×${t.dataset.count}`);
    clearTimeout(toastTimers.get(t));
  } else {
    t = document.createElement('div');
    t.className = `toast ${level}`;
    t.title = `${msg} (click to dismiss)`;
    Object.assign(t.dataset, { text: msg, level, count: '1' });
    const body = document.createElement('span'), count = document.createElement('span');
    body.textContent = msg;
    count.className = 'toast-count mono';
    t.append(body, count);
    t.addEventListener('click', () => t.remove());
  }
  box.append(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  toastTimers.set(t, setTimeout(() => t.remove(), level === 'error' ? 8000 : 4000));
}

const persist = (key, value) => { try { chrome.storage.local.set({ [key]: value }); } catch (_) {} };

const conn = new EngineConnection({
  onState,
  onWave: (m) => { const st = strips.get(m.deck); if (st) st.addWave(m); },
  onEvent: (e) => toast(e.text, e.level),
  onStatus,
});
const master = new MasterStrip({ conn, toast, persist });
const sources = new SourcesDrawer({ conn, toast });

function select(id) {
  selected = id;
  for (const [k, st] of strips) st.setSelected(k === id);
}

function onStatus(status) {
  $('#engineStatus').dataset.status = status;
  $('#banner').hidden = status !== 'down';
  if (status === 'down') setText($('#engineText'), 'Engine offline');
}

async function restoreSettings(s) {
  restored = true;
  let stored = {};
  try { stored = await chrome.storage.local.get([...PERSISTED_MASTER_KEYS]); } catch (_) {}
  for (const k of PERSISTED_MASTER_KEYS) if (k in stored && stored[k] !== s.master.params[k]) conn.set(null, k, stored[k]);
}

function onState(s) {
  snap = s;
  if (!restored) restoreSettings(s);
  const ids = new Set(s.decks.map((d) => d.id));
  for (const [id, st] of strips) if (!ids.has(id)) { st.destroy(); strips.delete(id); }
  const decksEl = $('#decks'), wavesEl = $('#waves');
  s.decks.forEach((d, i) => {
    let st = strips.get(d.id);
    if (!st) {
      st = new DeckStrip(d, { conn, toast, onSelect: select });
      strips.set(d.id, st);
    }
    if (decksEl.children[i + 1] !== st.el) decksEl.insertBefore(st.el, decksEl.children[i + 1] || null);
    if (wavesEl.children[i] !== st.waveRow) wavesEl.insertBefore(st.waveRow, wavesEl.children[i] || null);
    st.setSnapshotTime(s.ctxTime);
    st.update(d, s);
  });
  if (!strips.has(selected)) select(s.decks.length ? s.decks[0].id : null);
  else select(selected);
  $('#empty').hidden = s.decks.length > 0;
  document.body.dataset.decks = String(s.decks.length); // deck.css: wave row height, compact decks above 3
  document.body.classList.toggle('compact', s.decks.length > 3);
  master.update(s);
  setText($('#engineText'), `${s.engineState === 'running' ? 'Engine' : `Engine ${s.engineState}`} · ${(s.sampleRate / 1000).toFixed(1)} kHz · ${Math.round(s.outputLatency * 1000)} ms`);
  const n = s.decks.length;
  document.title = n ? `JD Samps — ${n} deck${n > 1 ? 's' : ''}` : 'JD Samps — Deck';
  if (n && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
    navigator.wakeLock.request('screen').then((l) => { wakeLock = l; l.addEventListener('release', () => { wakeLock = null; }); }).catch(() => {});
  } else if (!n && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function frame() {
  requestAnimationFrame(frame);
  if (!snap) return;
  const now = snap.ctxTime + Math.min(0.25, Math.max(0, (wallNow() - snap.wallMs) / 1000));
  for (const st of strips.values()) st.frame(now);
  master.frame();
}

function toggle(el, open) { el.hidden = open == null ? !el.hidden : !open; }
const settings = $('#settings'), help = $('#help');
$('#settingsBtn').addEventListener('click', () => toggle(settings));
settings.querySelector('[data-close]').addEventListener('click', () => toggle(settings, false));
$('#helpBtn').addEventListener('click', () => toggle(help));
help.querySelector('[data-close]').addEventListener('click', () => toggle(help, false));
help.addEventListener('click', (e) => { if (e.target === help) toggle(help, false); });
$('#stopAllBtn').addEventListener('click', async () => {
  if (!snap || !snap.decks.length) return;
  if (!confirm('Stop all decks and finish all recordings?')) return;
  const r = await conn.act(null, 'stopAll');
  if (!r.ok && r.error) toast(r.error, 'warn');
});

bindKeys({
  getStrip: () => strips.get(selected) || null,
  selectSlot: (slot) => { const d = snap && snap.decks.find((x) => x.slot === slot); if (d) select(d.id); },
  conn,
  master,
  toggleHelp: () => toggle(help),
  closePanels: () => { toggle(help, false); toggle(settings, false); sources.close(); },
});

window.addEventListener('beforeunload', (e) => {
  if (snap && snap.decks.length) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && snap && snap.decks.length && !wakeLock && navigator.wakeLock) {
    navigator.wakeLock.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
  }
});

conn.start();
requestAnimationFrame(frame);
