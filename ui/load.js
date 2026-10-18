// ui/load.js — whole tracks from the deck page: an audio file dropped anywhere on the page, or a link
// (the Sources drawer's field, or one pasted on the board). Each goes onto a new resident deck; the
// engine answers once the track is decoded and analysed, and the deck shows its progress meanwhile.

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
    this.loads = []; // loads waiting for their answer, oldest first: {after, deckId, cancelled}
    this.maxId = 0;  // the newest deck id seen
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

  /** A cancel the DJ asked for (✕, eject, STOP ALL) is not an error: the load onto that deck ends without a word. */
  async load(a, arg) {
    const l = { after: this.maxId, deckId: null, cancelled: false };
    this.loads.push(l);
    try {
      const r = await this.conn.act(null, a, arg);
      if (!r.ok && r.error && !l.cancelled) this.toast(r.error, 'warn');
      return r;
    } finally {
      this.loads.splice(this.loads.indexOf(l), 1);
    }
  }

  /**
   * Each snapshot: a load's deck is the oldest deck without a tab that is newer than any deck seen when it was
   * asked for, and than the deck of every earlier load (the engine makes them in that order, with rising ids).
   */
  update(s) {
    if (s.engineId !== this.engineId) { this.engineId = s.engineId; this.maxId = 0; } // a new engine numbers its decks from 1
    let floor = 0;
    for (const l of this.loads) {
      l.after = Math.max(l.after, floor);
      if (l.deckId == null) {
        const d = s.decks.filter((x) => x.id > l.after && x.tabId == null).sort((x, y) => x.id - y.id)[0];
        if (d) l.deckId = d.id;
      }
      if (l.deckId != null) floor = Math.max(floor, l.deckId);
    }
    for (const d of s.decks) this.maxId = Math.max(this.maxId, d.id);
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
