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
  'resident.limitMin': num(1, 60, 15), // a resident deck holds at most this many minutes of a track
  'resident.recordWhole': bool(false), // record a whole track at 2× when its bytes cannot be had
  'resident.auto': bool(true), // loading a tab tries for the whole track (resident); off: the tab plays live
});

/** Master params saved to chrome.storage.local by the UI and restored on engine start. */
export const PERSISTED_MASTER_KEYS = Object.freeze([
  'master.limiter', 'xfader.curve', 'rec.format', 'bpm.range', 'buffer.capSec', 'assist.on', 'pitch.defaultRange',
  'resident.limitMin', 'resident.recordWhole', 'resident.auto',
]);

export const DECK_ACTIONS = Object.freeze([
  'play', 'pause', 'cueDown', 'cueUp', 'syncPlay', 'sync', 'master', 'nudge', 'tap', 'mult', 'gridShift',
  'tap1', 'live', 'rollStart', 'rollEnd', 'recStart', 'recStop', 'eject', 'clipReset', 'playToggle',
  'setBpm', 'setNativeBpm',
  'loadCancel', 'recordWhole',
  'seek', 'beatJump',
]);
/** Beat-jump sizes the deck page offers (any whole number of beats up to MAX_JUMP_BEATS is accepted). */
export const JUMP_BEATS = Object.freeze([1, 4, 8, 16, 32]);
export const MAX_JUMP_BEATS = 128;
/** Largest jog bend (a nudge with an amount): ±10 % of the tempo. */
export const MAX_BEND = 0.1;
export const MASTER_ACTIONS = Object.freeze(['mixRecStart', 'mixRecStop', 'clipReset', 'stopAll', 'loadFile', 'loadUrl']);

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
const isHttpUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch (_) { return false; } };

function validateActArg(a, arg) {
  const fail = (error) => ({ ok: false, error });
  switch (a) {
    case 'nudge':
      if (![-1, 0, 1].includes(arg.dir)) return fail('nudge.dir must be -1, 0 or 1');
      // amt: a jog bend's size (fraction of the tempo), in place of the fixed fine/coarse steps.
      if (arg.amt == null) return { ok: true, arg: { dir: arg.dir, fine: !!arg.fine } };
      if (typeof arg.amt !== 'number' || !(arg.amt > 0 && arg.amt <= MAX_BEND)) return fail(`nudge.amt must be a number in (0, ${MAX_BEND}]`);
      return { ok: true, arg: { dir: arg.dir, fine: !!arg.fine, amt: arg.amt } };
    case 'seek':
      if (typeof arg.pos !== 'number' || !Number.isFinite(arg.pos)) return fail('seek.pos must be a finite number (input seconds)');
      if (arg.quantize != null && typeof arg.quantize !== 'boolean') return fail('seek.quantize must be boolean');
      return { ok: true, arg: { pos: arg.pos, quantize: !!arg.quantize } };
    case 'beatJump':
      if (!Number.isInteger(arg.beats) || arg.beats === 0 || Math.abs(arg.beats) > MAX_JUMP_BEATS) return fail(`beatJump.beats must be a whole number of beats, 1 to ${MAX_JUMP_BEATS} either way`);
      return { ok: true, arg: { beats: arg.beats } };
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
    case 'tap1': // t: mark bar 1 at this input position (an analysis's suggestion) instead of the playhead
      if (arg.t == null) return { ok: true, arg: {} };
      if (typeof arg.t !== 'number' || !Number.isFinite(arg.t) || arg.t < 0) return fail('tap1.t must be a position in seconds');
      return { ok: true, arg: { t: arg.t } };
    case 'setBpm': case 'setNativeBpm':
      if (typeof arg.bpm !== 'number' || !(arg.bpm >= TYPED_BPM[0] && arg.bpm <= TYPED_BPM[1])) return fail(`${a}.bpm must be a number from ${TYPED_BPM[0]} to ${TYPED_BPM[1]}`);
      return { ok: true, arg: { bpm: arg.bpm } };
    // A local file reaches the engine as a blob: URL the deck page made for it.
    case 'loadFile':
      if (typeof arg.name !== 'string' || !arg.name || arg.name.length > 300) return fail('loadFile.name must be a file name');
      if (typeof arg.blobUrl !== 'string' || !arg.blobUrl.startsWith('blob:') || arg.blobUrl.length > 2048) return fail('loadFile.blobUrl must be a blob: URL');
      return { ok: true, arg: { name: arg.name, blobUrl: arg.blobUrl } };
    case 'loadUrl':
      if (typeof arg.url !== 'string' || arg.url.length > 8192 || !isHttpUrl(arg.url)) return fail('That is not a web link (http or https).');
      return { ok: true, arg: { url: arg.url } };
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

/**
 * Why a frame's page tap cannot give the engine the track: protected media, MSE inside a worker
 * (out of the tap's reach), a preview only, a stream with no end, nothing to capture (or too
 * much), or a page-context fetch that failed.
 */
export const TAP_ERRORS = Object.freeze(['drm', 'worker', 'preview', 'live', 'none', 'fetch']);
const TAP_KINDS = ['init', 'media', 'file'];
const TAP_DRIVES = ['seekhop', 'accelerate'], TAP_DRIVE_STATES = ['running', 'done', 'stalled', 'refused', 'flushed'];
// Why a drive asked to flush did not (and drove on unflushed): the player holds pictures only, its media source has
// ended (a remove would reopen it), or it has no media source the tap can flush.
const TAP_UNFLUSHED = ['video', 'ended', 'none'];
const isCount = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const tapDuration = (d) => (typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : null);
const isMime = (s) => typeof s === 'string' && s.length <= 256;
// A page-minted blob: URL (the tap's bytes never travel on the port, only these).
const BLOB_URL = /^blob:(https?:\/\/[^\s/?#]+|null)\/[0-9a-f-]{36}$/i;
const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/** The tap messages: bounded lists of plain numbers and strings, or null. */
function validateTapMessage(m) {
  if (m.t === 'tap-progress') {
    const { bytes, buffered, mimes } = m;
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
    if (!Array.isArray(buffered) || buffered.length > 64) return null;
    if (!buffered.every((r) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[0] >= 0 && r[0] <= r[1])) return null;
    if (!Array.isArray(mimes) || mimes.length > 16 || !mimes.every(isMime)) return null;
    const out = { t: m.t, bytes, buffered: buffered.map(([a, b]) => [a, b]), duration: tapDuration(m.duration), mimes: [...mimes] };
    // The SourceBuffers (tap-ready's sb numbers) that feed the reported player: [] when it plays a plain source;
    // left out when the tap cannot tell. Another player's appends are on other numbers.
    if (Array.isArray(m.sbs) && m.sbs.length <= 64 && m.sbs.every((n) => Number.isInteger(n) && n >= 0 && n < 1000)) out.sbs = [...m.sbs];
    // How a drive of the player is going: still at it, done (all of it buffered), stalled (it
    // stopped buffering) or refused (the page fights the rate, or the media cannot be seek-hopped);
    // flushed (said once) when it was asked to empty the player's buffer first and has.
    const d = m.drive;
    if (d && typeof d === 'object' && TAP_DRIVES.includes(d.mode) && TAP_DRIVE_STATES.includes(d.state) && Number.isFinite(d.at) && d.at >= 0) {
      out.drive = { mode: d.mode, state: d.state, at: d.at };
      if (TAP_UNFLUSHED.includes(d.unflushed)) out.drive.unflushed = d.unflushed;
    }
    return out;
  }
  if (m.t === 'tap-urls') {
    if (!Array.isArray(m.reqs) || !m.reqs.length || m.reqs.length > 64) return null;
    const reqs = [];
    for (const r of m.reqs) {
      if (!r || typeof r.url !== 'string' || r.url.length > 8192 || !HTTP_URL.test(r.url)) return null;
      if (typeof r.method !== 'string' || !/^[A-Z]{1,16}$/.test(r.method) || typeof r.media !== 'boolean') return null;
      if (r.range !== null && (typeof r.range !== 'string' || r.range.length > 128)) return null;
      if (r.size !== null && !isCount(r.size)) return null;
      const q = { url: r.url, method: r.method, range: r.range, size: r.size, media: r.media };
      // Not seen by the tap's own hooks (the page's resource history, a media element's source):
      // the method and Range header are not known.
      if (r.past === true) q.past = true;
      reqs.push(q);
    }
    return { t: m.t, reqs };
  }
  if (m.t === 'tap-ready') {
    if (!Array.isArray(m.parts) || !m.parts.length || m.parts.length > 256) return null;
    const parts = [];
    for (const p of m.parts) {
      if (!p || typeof p.blobUrl !== 'string' || !BLOB_URL.test(p.blobUrl) || !isMime(p.mime) || !TAP_KINDS.includes(p.kind)) return null;
      if (!Number.isInteger(p.sb) || p.sb < -1 || p.sb >= 1000 || !isCount(p.seq)) return null;
      parts.push({ blobUrl: p.blobUrl, mime: p.mime, kind: p.kind, sb: p.sb, seq: p.seq });
    }
    return { t: m.t, parts, duration: tapDuration(m.duration) };
  }
  if (m.t === 'tap-error') {
    if (!TAP_ERRORS.includes(m.reason)) return null;
    const out = { t: m.t, reason: m.reason, detail: typeof m.detail === 'string' ? m.detail.slice(0, 300) : '' };
    if (isCount(m.seq)) out.seq = m.seq; // a failed fetch: the link's place in the request
    return out;
  }
  return null;
}

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
  if (typeof m.t === 'string' && m.t.startsWith('tap-')) return validateTapMessage(m);
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
