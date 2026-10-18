// shared/protocol.js — message names, parameter tables and validators shared by
// the deck UI (deck.html), the offscreen engine and the service worker.
// Pure module: no chrome.*, no DOM, safe to import from Node tests.

export const PORT_UI = 'jds-ui';
export const PORT_AGENT = 'jds-agent';
export const MAX_DECKS = 6;
export const DECK_COLORS = Object.freeze(['#22d3ee', '#f59e0b', '#e879f9', '#a3e635', '#fb7185', '#60a5fa']);

export const TARGET = Object.freeze({ HUB: 'hub', ENGINE: 'engine' });
export const HUB = Object.freeze({
  ENSURE_ENGINE: 'ENSURE_ENGINE', LIST_SOURCES: 'LIST_SOURCES', LOAD_TAB: 'LOAD_TAB', GOTO_TAB: 'GOTO_TAB',
  DOWNLOAD: 'DOWNLOAD', AGENT_CONNECT: 'AGENT_CONNECT', DECKS_CHANGED: 'DECKS_CHANGED', STOP_TAB: 'STOP_TAB',
});
export const ENGINE = Object.freeze({
  START: 'START', EJECT: 'EJECT', META: 'META', PING: 'PING', DOWNLOAD_DONE: 'DOWNLOAD_DONE', NOTIFY: 'NOTIFY',
});

export const FX_TYPES = Object.freeze(['ECHO', 'REVERB', 'GATE', 'FLANGER', 'CRUSH']);
export const FX_BEATS = Object.freeze([0.0625, 0.125, 0.25, 0.5, 0.75, 1, 2, 4]);
export const PITCH_RANGES = Object.freeze([0.06, 0.1, 0.16, 0.5]);
export const ROLL_BEATS = Object.freeze([0.125, 0.25, 0.5, 1]);
export const BPM_RANGES = Object.freeze({
  AUTO: [70, 180], '55-115': [55, 115], '68-135': [68, 135], '78-155': [78, 155], '88-175': [88, 175], '98-195': [98, 195],
});

const num = (min, max, def) => Object.freeze({ type: 'num', min, max, def });
const bool = (def) => Object.freeze({ type: 'bool', def });
const oneOf = (values, def) => Object.freeze({ type: 'enum', values, def });

export const DECK_PARAMS = Object.freeze({
  trim: num(0, 1, 0.5),
  'eq.hi': num(0, 1, 0.5),
  'eq.mid': num(0, 1, 0.5),
  'eq.low': num(0, 1, 0.5),
  'kill.hi': bool(false),
  'kill.mid': bool(false),
  'kill.low': bool(false),
  filter: num(-1, 1, 0),
  'filter.res': num(0, 1, 0.3),
  fader: num(0, 1, 1),
  xf: oneOf(['A', 'THRU', 'B'], 'THRU'),
  'fx.type': oneOf(FX_TYPES, 'ECHO'),
  'fx.beats': oneOf(FX_BEATS, 0.5),
  'fx.level': num(0, 1, 0.5),
  'fx.on': bool(false),
  keyLock: bool(true),
  range: oneOf(PITCH_RANGES, 0.1),
  pitch: num(-0.5, 0.5, 0),
  syncMode: oneOf(['BEAT', 'TEMPO'], 'BEAT'),
});

export const MASTER_PARAMS = Object.freeze({
  'master.volume': num(0, 1, 0.5),
  'master.limiter': bool(true),
  'xfader.pos': num(0, 1, 0.5),
  'xfader.curve': oneOf(['SMOOTH', 'SHARP'], 'SMOOTH'),
  'rec.format': oneOf(['wav', 'webm'], 'wav'),
  'bpm.range': oneOf(Object.keys(BPM_RANGES), 'AUTO'),
  'buffer.capSec': oneOf([120, 240, 480], 240),
  'assist.on': bool(true),
  'pitch.defaultRange': oneOf(PITCH_RANGES, 0.1),
});

/** Master params saved to chrome.storage.local by the UI and restored on engine start. */
export const PERSISTED_MASTER_KEYS = Object.freeze([
  'master.limiter', 'xfader.curve', 'rec.format', 'bpm.range', 'buffer.capSec', 'assist.on', 'pitch.defaultRange',
]);

export const DECK_ACTIONS = Object.freeze([
  'play', 'pause', 'cueDown', 'cueUp', 'syncPlay', 'sync', 'master', 'nudge', 'tap', 'mult', 'gridShift',
  'tap1', 'live', 'rollStart', 'rollEnd', 'recStart', 'recStop', 'eject', 'clipReset', 'playToggle',
  'setBpm', 'setNativeBpm',
]);
/** Tempos the DJ may type (setBpm: the tempo to play at; setNativeBpm: the track's own tempo). */
export const TYPED_BPM = Object.freeze([20, 400]);

/** A typed tempo: digits with a dot or comma decimal ("128", "128.0", "128,5"). {ok, bpm} or {ok: false, error}. */
export function parseTypedBpm(text) {
  const s = String(text ?? '').trim();
  if (!/^\d{1,3}([.,]\d*)?$/.test(s)) return { ok: false, error: 'Type a tempo like 128 or 128.5.' };
  const bpm = Number(s.replace(',', '.'));
  if (!(bpm >= TYPED_BPM[0] && bpm <= TYPED_BPM[1])) return { ok: false, error: `Type a tempo from ${TYPED_BPM[0]} to ${TYPED_BPM[1]} BPM.` };
  return { ok: true, bpm };
}
export const MASTER_ACTIONS = Object.freeze(['mixRecStart', 'mixRecStop', 'clipReset', 'stopAll']);

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function defaults(table) {
  const out = {};
  for (const k of Object.keys(table)) out[k] = table[k].def;
  return out;
}

export function validateValue(spec, value) {
  if (!spec) return { ok: false, error: 'unknown parameter' };
  switch (spec.type) {
    case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'expected a finite number' };
      return { ok: true, value: Math.min(spec.max, Math.max(spec.min, value)) };
    case 'bool':
      if (typeof value !== 'boolean') return { ok: false, error: 'expected a boolean' };
      return { ok: true, value };
    case 'enum':
      if (!spec.values.includes(value)) return { ok: false, error: `expected one of ${spec.values.join(', ')}` };
      return { ok: true, value };
    default:
      return { ok: false, error: 'bad parameter spec' };
  }
}

const isDeckRef = (d) => d === null || Number.isInteger(d);

function validateActArg(a, arg) {
  const fail = (error) => ({ ok: false, error });
  switch (a) {
    case 'nudge':
      if (![-1, 0, 1].includes(arg.dir)) return fail('nudge.dir must be -1, 0 or 1');
      return { ok: true, arg: { dir: arg.dir, fine: !!arg.fine } };
    case 'mult':
      if (![0.5, 2].includes(arg.factor)) return fail('mult.factor must be 0.5 or 2');
      return { ok: true, arg: { factor: arg.factor } };
    case 'gridShift': {
      const beats = arg.beats ?? 0, ms = arg.ms ?? 0;
      if (![-0.5, 0, 0.5].includes(beats) || ![-10, 0, 10].includes(ms) || (beats === 0) === (ms === 0)) {
        return fail('gridShift needs beats ±0.5 or ms ±10');
      }
      return { ok: true, arg: { beats, ms } };
    }
    case 'rollStart':
      if (!ROLL_BEATS.includes(arg.beats)) return fail(`roll beats must be one of ${ROLL_BEATS.join(', ')}`);
      return { ok: true, arg: { beats: arg.beats } };
    case 'sync':
      if (arg.on != null && typeof arg.on !== 'boolean') return fail('sync.on must be boolean');
      return { ok: true, arg: { on: arg.on ?? null } };
    case 'tap':
      if (arg.wallMs != null && (typeof arg.wallMs !== 'number' || !Number.isFinite(arg.wallMs))) return fail('tap.wallMs must be a number');
      return { ok: true, arg: arg.wallMs == null ? {} : { wallMs: arg.wallMs } };
    case 'setBpm': case 'setNativeBpm':
      if (typeof arg.bpm !== 'number' || !(arg.bpm >= TYPED_BPM[0] && arg.bpm <= TYPED_BPM[1])) return fail(`${a}.bpm must be a number from ${TYPED_BPM[0]} to ${TYPED_BPM[1]}`);
      return { ok: true, arg: { bpm: arg.bpm } };
    default:
      return { ok: true, arg: {} };
  }
}

export function validateUiMessage(m) {
  if (!m || typeof m !== 'object') return { ok: false, error: 'not an object' };
  if (m.t === 'hello') return { ok: true };
  // {t:'vis', hidden}: the page is hidden (no per-tick state or waveform needed) or shown again.
  if (m.t === 'vis') return typeof m.hidden === 'boolean' ? { ok: true } : { ok: false, error: 'vis.hidden must be a boolean' };
  if (m.t === 'set') {
    if (!isDeckRef(m.deck)) return { ok: false, error: 'bad deck id' };
    const table = m.deck === null ? MASTER_PARAMS : DECK_PARAMS;
    if (typeof m.key !== 'string' || !has(table, m.key)) return { ok: false, error: `unknown parameter ${String(m.key)}` };
    return validateValue(table[m.key], m.value);
  }
  if (m.t === 'act') {
    if (!isDeckRef(m.deck)) return { ok: false, error: 'bad deck id' };
    const list = m.deck === null ? MASTER_ACTIONS : DECK_ACTIONS;
    if (!list.includes(m.a)) return { ok: false, error: `unknown action ${String(m.a)}` };
    const arg = m.arg == null ? {} : m.arg;
    if (typeof arg !== 'object') return { ok: false, error: 'bad action argument' };
    return validateActArg(m.a, arg);
  }
  return { ok: false, error: 'unknown message type' };
}

/**
 * What a frame's agent did with the page's player when its tab was loaded onto a deck: no player
 * to start, nothing it could say in time ('timeout', from the relay), too many players to choose
 * between, one that refused to play, one already playing, one it started. Ordered weakest claim
 * first, so a tab's frames combine by taking the last of them: what one frame found beats
 * another's 'none', and not knowing beats claiming there is nothing.
 */
export const START_WHY = Object.freeze(['none', 'timeout', 'ambiguous', 'refused', 'playing', 'started']);

/** Agent (content script) messages are untrusted page-adjacent data. */
export function validateAgentMessage(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.t === 'status') {
    const rate = m.rate;
    if (typeof m.hasMedia !== 'boolean' || typeof m.playing !== 'boolean') return null;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 16) return null;
    const count = Number.isInteger(m.count) && m.count >= 0 && m.count < 1000 ? m.count : 0;
    // audible = playing, unmuted elements with volume > 0; muted/volume describe the reported one;
    // seq echoes the last command the agent applied.
    const audible = Number.isInteger(m.audible) && m.audible >= 0 && m.audible < 1000 ? m.audible : 0;
    const volume = typeof m.volume === 'number' && m.volume >= 0 && m.volume <= 1 ? m.volume : 1;
    const seq = Number.isSafeInteger(m.seq) && m.seq >= 0 ? m.seq : -1;
    const s = { t: 'status', hasMedia: m.hasMedia, playing: m.playing, rate, preservesPitch: m.preservesPitch === true, count, muted: m.muted === true, volume, audible, seq };
    // The agent let go of the page by itself (no command for a long while) at wall-clock ms releasedAt.
    if (m.selfReleased === true && typeof m.releasedAt === 'number' && Number.isFinite(m.releasedAt) && m.releasedAt > 0) {
      s.selfReleased = true; s.releasedAt = m.releasedAt;
    }
    return s;
  }
  // The site kept pausing a decked tab, so the agent stopped resisting (said once per tab).
  if (m.t === 'external-pause') return { t: 'external-pause' };
  if (m.t === 'external-rate') {
    if (typeof m.rate !== 'number' || !Number.isFinite(m.rate) || m.rate <= 0 || m.rate > 16) return null;
    return { t: 'external-rate', rate: m.rate };
  }
  if (m.t === 'stopped') {
    // Answer to an eject's stop: how many heard players the frame's agent paused.
    if (!Number.isInteger(m.count) || m.count < 0 || m.count >= 1000) return null;
    return { t: 'stopped', count: m.count };
  }
  if (m.t === 'started') {
    // Answer to a load's start: how many players the frame's agent started, and why not more.
    if (!Number.isInteger(m.count) || m.count < 0 || m.count >= 1000) return null;
    if (!START_WHY.includes(m.why)) return null;
    return { t: 'started', count: m.count, why: m.why };
  }
  return null;
}

const ICON_DATA = /^data:image\/(png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i;
export function isSafeIconUrl(u) {
  if (typeof u !== 'string' || !u || u.length > 4096) return false;
  return /^https?:\/\/[^\s"'<>]+$/i.test(u) || ICON_DATA.test(u);
}

export function sanitizeTitle(s) {
  const t = String(s ?? '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .replace(/ *_ */g, '_')
    .replace(/_+/g, '_')
    .replace(/^[ ._]+|[ ._]+$/g, '')
    .slice(0, 60)
    .replace(/[ ._]+$/g, '');
  return t || 'tab';
}

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function recordingFilename(who, title, ext, d = new Date()) {
  return `JDSamps-${who}-${sanitizeTitle(title)}-${timestamp(d)}.${ext}`;
}
