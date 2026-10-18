// Realistic engine snapshots for UI tests and screenshots.
export function deck(over = {}) {
  const base = {
    id: 1, slot: 1, tabId: 101, title: 'Daft Punk — One More Time', favIconUrl: '', url: 'https://www.youtube.com/watch?v=x',
    playing: true, previewing: false, cue: 2.0, playhead: 41.3, engineRate: 1.0323, liveEdge: 63.0, reserve: 21.4, starved: false, historyStart: 0,
    kind: 'live', duration: null, load: { state: 'ready', progress: 1, strategy: null, error: null, report: null }, analysis: null,
    bpm: { state: 'LOCKED', native: 124.0, out: 128.0, conf: 0.92, mult: 1, tapped: false, manual: null },
    grid: { t0: 2.0, T: 60 / 124, bar1: 2.0 },
    sync: { on: true, mode: 'BEAT', isMaster: false, outOfRange: false, phaseMs: 3.2 },
    assist: { available: true, active: false, sourceRate: 1 },
    params: {
      trim: 0.5, 'eq.hi': 0.5, 'eq.mid': 0.5, 'eq.low': 0.5, 'kill.hi': false, 'kill.mid': false, 'kill.low': false,
      filter: 0, 'filter.res': 0.3, fader: 1, xf: 'THRU', 'fx.type': 'ECHO', 'fx.beats': 0.5, 'fx.level': 0.5, 'fx.on': false,
      keyLock: true, range: 0.1, pitch: 0.0323, syncMode: 'BEAT',
    },
    roll: null, loop: null, nudge: 0,
    meter: { peak: 0.7, rms: 0.3, clip: false },
    rec: { state: 'idle', format: 'wav', seconds: 0 },
    error: null,
  };
  return { ...base, ...over, params: { ...base.params, ...(over.params || {}) }, load: { ...base.load, ...(over.load || {}) } };
}

const NO_SYNC = { on: false, mode: 'BEAT', isMaster: false, outOfRange: false, phaseMs: null };
const NO_ASSIST = { available: false, active: false, sourceRate: 1 };

/** A whole-track deck: no tab, all of its track buffered (0 to its duration), gridded by its analysis, paused at 1:23. */
export function residentDeck(over = {}) {
  const duration = over.duration ?? 244.9, playhead = over.playhead ?? 83.2;
  return deck({
    id: 2, slot: 2, tabId: null, title: 'kick', url: '', kind: 'resident', duration, historyStart: 0, liveEdge: duration,
    playing: false, engineRate: 0, playhead, cue: 0.4, reserve: duration - playhead, sync: NO_SYNC, assist: NO_ASSIST,
    grid: { t0: 0.4, T: 60 / 124, bar1: null }, analysis: { bar1: { t: 2.34, conf: 0.6 }, conf: 0.9 },
    ...over,
  });
}

/** A deck whose track is on its way: nothing buffered or gridded yet, 42 % in. */
export function loadingDeck(over = {}) {
  return deck({
    id: 3, slot: 3, tabId: null, title: 'slow', url: 'https://example.com/slow.wav', kind: 'loading', duration: null,
    playing: false, engineRate: 0, playhead: 0, cue: 0, liveEdge: 0, historyStart: 0, reserve: 0, sync: NO_SYNC, assist: NO_ASSIST,
    bpm: { state: 'SEARCH', native: null, out: null, conf: 0, mult: 1, tapped: false, manual: null }, grid: null,
    meter: { peak: 0, rms: 0, clip: false },
    ...over,
    load: { state: 'loading', progress: 0.42, strategy: 'fetching the link', error: null, report: null, ...(over.load || {}) },
  });
}

export function makeState({ decks = [deck()], clock = { mode: 'deck', deckId: 2, bpm: 128 }, master = {} } = {}) {
  return {
    ctxTime: 100, wallMs: Date.now(), sampleRate: 48000, engineState: 'running', outputLatency: 0.012, clock,
    master: {
      peakL: 0.8, peakR: 0.75, rmsL: 0.35, rmsR: 0.33, clipL: false, clipR: false, gr: -1.2, residentBytes: 0, rec: { state: 'idle', format: 'wav', seconds: 0 },
      ...master,
      params: {
        'master.volume': 0.5, 'master.limiter': true, 'xfader.pos': 0.5, 'xfader.curve': 'SMOOTH', 'rec.format': 'wav', 'bpm.range': 'AUTO', 'buffer.capSec': 240, 'assist.on': true, 'pitch.defaultRange': 0.1,
        'resident.limitMin': 15, 'resident.recordWhole': false,
        ...(master.params || {}),
      },
    },
    decks,
  };
}

export function threeDecks() {
  return makeState({
    decks: [
      deck(),
      deck({ id: 2, slot: 2, tabId: 102, title: 'Peggy Gou — (It Goes Like) Nanana', playhead: 40.2, engineRate: 1, bpm: { state: 'LOCKED', native: 128, out: 128, conf: 0.97, mult: 1, tapped: false }, grid: { t0: 1.1, T: 60 / 128, bar1: null }, sync: { on: false, mode: 'BEAT', isMaster: true, outOfRange: false, phaseMs: null }, params: { pitch: 0, xf: 'B', 'fx.on': true, 'fx.type': 'REVERB' }, rec: { state: 'recording', format: 'wav', seconds: 73.4 } }),
      deck({ id: 3, slot: 3, tabId: 103, title: '<img src=x onerror="window.pwned=1"> Bandcamp exclusive', playing: false, playhead: 2.0, cue: 2.0, reserve: 34.0, liveEdge: 36, bpm: { state: 'SEARCH', native: null, out: null, conf: 0.1, mult: 1, tapped: false }, grid: null, sync: { on: false, mode: 'BEAT', isMaster: false, outOfRange: false, phaseMs: null }, params: { xf: 'A', 'kill.low': true }, meter: { peak: 0, rms: 0, clip: false } }),
    ],
  });
}

/** Synthetic waveform backlog: kick-like low pulses on the beat. */
export function makeWave(deckId, seconds, bpm = 124) {
  const hop = 512 / 48000, n = Math.floor(seconds / hop);
  const data = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i * hop, ph = (t * bpm) / 60 % 1;
    data[i * 3] = Math.round(120 + 135 * Math.exp(-ph * 8));
    data[i * 3 + 1] = Math.round(110 + 60 * Math.exp(-((ph * 2) % 1) * 6));
    data[i * 3 + 2] = Math.round(90 + 80 * Math.exp(-((ph * 4) % 1) * 10));
  }
  return { t: 'wave', deck: deckId, tStart: 0, hop, data };
}
