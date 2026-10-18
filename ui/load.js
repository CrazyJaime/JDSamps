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
  }

  /** The engine fetches the file through a blob: URL made here, revoked once its load has settled either way. */
  async loadFile(file) {
    const blobUrl = URL.createObjectURL(file);
    try {
      return this.said(await this.conn.act(null, 'loadFile', { name: file.name, blobUrl }));
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async loadLink(url) { return this.said(await this.conn.act(null, 'loadUrl', { url })); }

  said(r) {
    if (!r.ok && r.error) this.toast(r.error, 'warn');
    return r;
  }

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
