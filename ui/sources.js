// ui/sources.js — the Sources drawer: open tabs, which are on decks, which can be loaded.
import { HUB, isSafeIconUrl } from '../shared/protocol.js';
import { $, clone, setText, setHidden, pageHidden } from './util.js';

export class SourcesDrawer {
  constructor({ conn, toast }) {
    this.conn = conn;
    this.toast = toast;
    this.el = $('#sources');
    this.list = $('#sourceList');
    this.timer = 0;
    this.rows = new Map(); // tab id → row, kept across refreshes so focus and presses survive them
    this.failed = false;
    for (const id of ['#sourcesBtn', '#emptySourcesBtn']) $(id).addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    this.el.querySelector('[data-close]').addEventListener('click', () => this.close());
    document.addEventListener('visibilitychange', () => { if (this.isOpen && !pageHidden()) this.refresh(); });
  }

  get isOpen() { return !this.el.hidden; }

  open() {
    this.el.hidden = false;
    $('#sourcesBtn').setAttribute('aria-expanded', 'true');
    this.failed = false;
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), 1500);
  }

  close() {
    this.el.hidden = true;
    $('#sourcesBtn').setAttribute('aria-expanded', 'false');
    clearInterval(this.timer);
  }

  /** No hub round trip while nobody can see the list (drawer closed or page hidden). */
  async refresh() {
    if (!this.isOpen || pageHidden()) return;
    let r;
    try { r = await this.conn.hub(HUB.LIST_SOURCES); } catch (_) { r = null; }
    if (!r || !r.ok) {
      if (!this.failed) this.toast('Could not list browser tabs.', 'warn'); // once, not every 1.5 s
      this.failed = true;
      return;
    }
    this.failed = false;
    const ids = new Set(r.tabs.map((t) => t.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.li.remove(); this.rows.delete(id); }
    r.tabs.forEach((t, i) => {
      let row = this.rows.get(t.id);
      if (!row) this.rows.set(t.id, (row = this.row(t.id)));
      this.fill(row, t);
      if (this.list.children[i] !== row.li) this.list.insertBefore(row.li, this.list.children[i] || null);
    });
  }

  row(tabId) {
    const li = clone('tpl-source-row');
    const q = (sel) => li.querySelector(sel);
    const row = { li, title: q('[data-title]'), host: q('[data-host]'), fav: q('[data-fav]'), audible: q('[data-audible]'), onDeck: q('[data-ondeck]'), load: q('[data-load]'), go: q('[data-goto]') };
    row.load.addEventListener('click', async () => {
      row.load.disabled = true;
      const res = await this.conn.hub(HUB.LOAD_TAB, { tabId }).catch((e) => ({ ok: false, error: e.message }));
      row.load.disabled = false;
      if (res && res.ok) this.toast('Loaded onto a deck. It is cued: press PLAY when ready.', 'info');
      else this.toast((res && res.error) || 'Could not load that tab.', 'warn');
      this.refresh();
    });
    row.go.addEventListener('click', () => this.conn.hub(HUB.GOTO_TAB, { tabId }));
    return row;
  }

  fill(row, t) {
    setText(row.title, t.title || t.url || `Tab ${t.id}`);
    let host = '';
    try { host = new URL(t.url).host; } catch (_) {}
    setText(row.host, host);
    const icon = isSafeIconUrl(t.favIconUrl) ? t.favIconUrl : null;
    if (icon && row.fav.getAttribute('src') !== icon) row.fav.src = icon;
    setHidden(row.fav, !icon);
    setHidden(row.audible, !t.audible);
    setHidden(row.onDeck, !t.deckSlot);
    if (t.deckSlot) setText(row.onDeck, `ON DECK ${t.deckSlot}`);
    setHidden(row.load, !!t.deckSlot || !t.granted);
    setHidden(row.go, !!t.deckSlot || !!t.granted);
  }
}
