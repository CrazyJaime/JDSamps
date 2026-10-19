// ui/load.js — whole tracks from the deck page: an audio file dropped anywhere on the page, or a link
// (the Sources drawer's field, or one pasted on the board). Each goes onto a new resident deck; the
// engine answers once the track is decoded and analysed, and the deck shows its progress meanwhile.
// A tab loaded from the Sources drawer is followed the same way, to its whole track.
import { HUB } from '../shared/protocol.js';

// Once a load's answer time is up and its deck has gone, how long its answer still has to say why.
const GONE_MS = 2000;
const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|flac|m4a|mp4|aac|webm|weba|aif|aiff|caf)$/i;

/** An audio file by its type, or by its extension when the system gives none (or a video type for an audio container). */
export const isAudioFile = (f) => /^audio\//.test(f.type) || AUDIO_EXT.test(f.name);

/** The web link (http or https) that text is, or null. */
export function webLink(text) {
  const s = String(text ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  try { return /^https?:$/.test(new URL(s).protocol) ? s : null; } catch (_) { return null; }
}

export class TrackLoader {
  constructor({ conn, toast }) {
    this.conn = conn;
    this.toast = toast;
    this.loads = []; // loads waiting for their answer, oldest first: {token, tabId, after, deckId, seen, cancelled, settle}
    this.decks = []; // the latest snapshot's decks
    this.maxId = 0;  // the newest deck id seen
    this.tabbed = new Set(); // decks seen with a tab: none of them is a file's or a link's
    this.engineId = undefined;
  }

  /** The engine fetches the file through a blob: URL made here, revoked once its load has settled either way. */
  async loadFile(file) {
    const blobUrl = URL.createObjectURL(file);
    try {
      return await this.load('loadFile', { name: file.name, blobUrl });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  loadLink(url) { return this.load('loadUrl', { url }); }

  /**
   * A cancel the DJ asked for (✕, eject, STOP ALL) is not an error: the load onto that deck ends without a word. The
   * load's token goes with it, and its deck shows it (load.token), so the load knows its deck exactly.
   */
  async load(a, arg) {
    const l = { token: crypto.randomUUID(), tabId: null, after: this.maxId, deckId: null, seen: false, cancelled: false, settle: null };
    this.loads.push(l);
    try {
      const r = await this.conn.act(null, a, { ...arg, token: l.token }, { late: () => this.late(l) });
      if (!r.ok && r.error && !l.cancelled) this.toast(r.error, 'warn');
      return r;
    } finally {
      this.loads.splice(this.loads.indexOf(l), 1);
    }
  }

  /**
   * A tab from the Sources drawer. LOAD_TAB answers once its deck is made (or, from a hub that waits, once the whole
   * track is in): the load follows its deck until it holds the track. The engine says so itself, once, naming the
   * track and the deck (or why it plays live instead), so nothing more is said here; a hub's refusal is said; a
   * cancel the DJ asked for says nothing.
   */
  async loadTab(tabId) {
    const l = { token: null, tabId, after: this.maxId, deckId: null, seen: false, cancelled: false, settle: null, at: 0 };
    this.loads.push(l);
    try {
      let r = await this.conn.hub(HUB.LOAD_TAB, { tabId }).catch((e) => ({ ok: false, error: e.message }));
      r = r || { ok: false };
      let gone = false;
      if (r.ok && r.deckId != null) {
        l.deckId = r.deckId;
        l.at = performance.now();
        gone = !(await new Promise((resolve) => { l.settle = resolve; this.follow(l); })).ok;
      }
      if (!r.ok && !l.cancelled) this.toast(r.error || 'Could not load that tab.', 'warn');
      return gone ? { ok: false } : r;
    } finally {
      this.loads.splice(this.loads.indexOf(l), 1);
    }
  }

  /**
   * Each snapshot: a load's deck is the one showing its token; a tab load's is the newer deck on its tab. A load
   * without a token takes, as before, the oldest deck without a tab (and never one seen with a tab, or one showing
   * a token) that is newer than any deck seen when it was asked for, and than every earlier such load's deck.
   */
  update(s) {
    if (s.engineId !== this.engineId) { this.engineId = s.engineId; this.maxId = 0; this.tabbed.clear(); } // a new engine numbers its decks from 1
    for (const d of s.decks) if (d.tabId != null) this.tabbed.add(d.id);
    let floor = 0;
    for (const l of this.loads) {
      const byOrder = !l.token && l.tabId == null;
      if (byOrder) l.after = Math.max(l.after, floor);
      if (l.deckId == null) {
        const d = l.token ? s.decks.find((x) => x.load && x.load.token === l.token)
          : l.tabId != null ? s.decks.find((x) => x.tabId === l.tabId && x.id > l.after)
            : s.decks.filter((x) => x.id > l.after && x.tabId == null && !this.tabbed.has(x.id) && !(x.load && x.load.token)).sort((x, y) => x.id - y.id)[0];
        if (d) l.deckId = d.id;
      }
      if (l.deckId != null && s.decks.some((x) => x.id === l.deckId)) l.seen = true;
      if (byOrder && l.deckId != null) floor = Math.max(floor, l.deckId);
    }
    for (const d of s.decks) this.maxId = Math.max(this.maxId, d.id);
    this.decks = s.decks;
    for (const l of this.loads) if (l.settle) this.follow(l);
  }

  /**
   * A load's answer time is up. With no deck of its own yet, the engine did not answer. Otherwise it waits while
   * its deck loads (a slow link can take minutes) and settles from the deck: resident is done, gone is settled.
   */
  late(l) {
    if (l.deckId == null) return null;
    return new Promise((resolve) => { l.settle = resolve; this.follow(l); });
  }

  follow(l) {
    const d = this.decks.find((x) => x.id === l.deckId);
    if (d) l.seen = true;
    if (d && d.kind === 'loading') return;
    // A tab load's answer can come before the first snapshot that shows its deck: gone only once it was there.
    if (!d && !l.seen && l.tabId != null && performance.now() - l.at < GONE_MS) return;
    const settle = l.settle;
    l.settle = null;
    if (d) settle({ ok: true });
    else setTimeout(() => settle({ ok: false }), l.tabId != null ? 0 : GONE_MS); // a tab load has no answer still to come
  }

  /** The DJ asked for deck `id` to go (✕ or eject). */
  cancelled(id) { for (const l of this.loads) if (l.deckId === id) l.cancelled = true; }
  /** STOP ALL: every deck goes. */
  cancelledAll() { for (const l of this.loads) l.cancelled = true; }

  /** Each audio file onto a deck of its own; the rest are named and left alone. */
  drop(files) {
    const other = files.filter((f) => !isAudioFile(f));
    if (other.length) this.toast(`Not an audio file: ${other.map((f) => `“${f.name}”`).join(', ')}.`, 'warn');
    for (const f of files) if (isAudioFile(f)) this.loadFile(f);
  }

  /**
   * Files dragged onto the page: shown while over it (body.dropping), loaded on drop. Every file drop is
   * taken, so one that misses the board never opens the file in place of the deck page.
   */
  bindDrop() {
    const files = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    let depth = 0;
    const show = (on) => document.body.classList.toggle('dropping', on);
    document.addEventListener('dragenter', (e) => { if (files(e)) { depth++; show(true); } });
    document.addEventListener('dragleave', (e) => { if (files(e) && --depth <= 0) { depth = 0; show(false); } });
    document.addEventListener('dragover', (e) => {
      if (!files(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', (e) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      show(false);
      this.drop([...e.dataTransfer.files]);
    });
  }

  /** Ctrl/Cmd+V of a web link anywhere on the board (not in a text field): offered, not loaded. */
  bindPaste() {
    document.addEventListener('paste', (e) => {
      const t = e.target;
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      const url = webLink(e.clipboardData && e.clipboardData.getData('text/plain'));
      if (!url) return;
      e.preventDefault();
      this.toast(`Load this link? ${url}`, 'info', { label: 'Load', run: () => this.loadLink(url) });
    });
  }
}
