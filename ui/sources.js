// ui/sources.js — the Sources drawer: open tabs, which are on decks, which can be loaded.
import { HUB, isSafeIconUrl } from '../shared/protocol.js';
import { $, clone, setText } from './util.js';

export class SourcesDrawer {
  constructor({ conn, toast }) {
    this.conn = conn;
    this.toast = toast;
    this.el = $('#sources');
    this.list = $('#sourceList');
    this.timer = 0;
    for (const id of ['#sourcesBtn', '#emptySourcesBtn']) $(id).addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    this.el.querySelector('[data-close]').addEventListener('click', () => this.close());
  }

  get isOpen() { return !this.el.hidden; }

  open() {
    this.el.hidden = false;
    $('#sourcesBtn').setAttribute('aria-expanded', 'true');
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), 1500);
  }

  close() {
    this.el.hidden = true;
    $('#sourcesBtn').setAttribute('aria-expanded', 'false');
    clearInterval(this.timer);
  }

  async refresh() {
    let r;
    try { r = await this.conn.hub(HUB.LIST_SOURCES); } catch (_) { r = null; }
    if (!r || !r.ok) { this.toast('Could not list browser tabs.', 'warn'); return; }
    this.list.replaceChildren(...r.tabs.map((t) => this.row(t)));
  }

  row(t) {
    const li = clone('tpl-source-row');
    setText(li.querySelector('[data-title]'), t.title || t.url || `Tab ${t.id}`);
    let host = '';
    try { host = new URL(t.url).host; } catch (_) {}
    setText(li.querySelector('[data-host]'), host);
    const fav = li.querySelector('[data-fav]');
    if (isSafeIconUrl(t.favIconUrl)) fav.src = t.favIconUrl; else fav.hidden = true;
    li.querySelector('[data-audible]').hidden = !t.audible;
    const onDeck = li.querySelector('[data-ondeck]'), load = li.querySelector('[data-load]'), go = li.querySelector('[data-goto]');
    if (t.deckSlot) { onDeck.hidden = false; setText(onDeck, `ON DECK ${t.deckSlot}`); }
    else if (t.granted) load.hidden = false;
    else go.hidden = false;
    load.addEventListener('click', async () => {
      load.disabled = true;
      const res = await this.conn.hub(HUB.LOAD_TAB, { tabId: t.id }).catch((e) => ({ ok: false, error: e.message }));
      if (res && res.ok) this.toast('Loaded onto a deck. It is cued: press PLAY when ready.', 'info');
      else this.toast((res && res.error) || 'Could not load that tab.', 'warn');
      this.refresh();
    });
    go.addEventListener('click', () => this.conn.hub(HUB.GOTO_TAB, { tabId: t.id }));
    return li;
  }
}
