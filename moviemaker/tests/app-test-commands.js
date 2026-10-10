// Test-only stand-in for js/commands.js (owner G), used by tests/app-test.html when the real
// module is not available yet. Implements a small, real subset of the command contract and logs
// every call to window.__cmdLog so the app.js test can assert what was invoked.

import { createVisualItem, createMusicItem } from '../js/model.js';
import { ACCEPT_VISUAL, ACCEPT_AUDIO } from '../js/media.js';

export function createCommands(app) {
  const log = (window.__cmdLog = window.__cmdLog || []);
  const store = app.store;
  const importAll = async (files, accept) => {
    const list = files && files.length ? files : await app.media.pickFiles(accept);
    return app.media.importFiles(list, { onError: (f, err) => app.dialogs.toast(err.message, { type: 'error' }) });
  };
  const table = {
    async addMedia(files) {
      const ms = await importAll(files, ACCEPT_VISUAL);
      if (!ms.length) return;
      for (const m of ms) store.addMedia(m);
      const items = ms.filter((m) => m.type !== 'audio').map((m) => createVisualItem(m.type === 'video' ? 'video' : 'image', { mediaId: m.id }));
      store.update((p) => { p.items.push(...items); }, { label: 'Add videos and photos' });
      store.select('item', items.map((i) => i.id));
    },
    async addMusic(files) {
      const ms = await importAll(files, ACCEPT_AUDIO);
      for (const m of ms) store.addMedia(m);
      store.update((p) => { for (const m of ms) p.music.push(createMusicItem({ mediaId: m.id })); }, { label: 'Add music' });
    },
    togglePlay() { return app.player.toggle(); },
    play() { return app.player.play(); },
    pause() { app.player.pause(); },
    prevFrame() { return app.player.stepFrame(-1); },
    nextFrame() { return app.player.stepFrame(1); },
    goStart() { return app.player.seek(0); },
    goEnd() { return app.player.seek(app.player.duration); },
    undo() { store.undo(); },
    redo() { store.redo(); },
    selectAll() { store.select('item', store.project.items.map((i) => i.id)); },
    remove() {
      const ids = store.selection.ids.slice();
      if (!ids.length) return;
      store.update((p) => { p.items = p.items.filter((i) => !ids.includes(i.id)); }, { label: 'Remove' });
    },
    cut() {}, copy() {}, paste() {}, split() {},
    saveProject() { return app.dialogs.saveProject(); },
    saveProjectAs() { return app.dialogs.saveProjectAs(); },
    openProject() { return app.dialogs.openProjects(); },
    newProject() { return app.dialogs.newProject(); },
    saveMovie(id) { return app.dialogs.openExport(id); },
    trimTool() { return app.dialogs.openTrim(store.selection.ids[0]); },
    about() { return app.dialogs.openAbout(); },
    help() { return app.dialogs.openHelp(); },
  };
  return {
    run(name, arg) {
      log.push([name, Array.isArray(arg) ? arg.map((f) => (f && f.name) || String(f)) : arg]);
      const fn = table[name];
      if (!fn) { console.warn(`[stub commands] unknown command ${name}`); return undefined; }
      return fn(arg);
    },
    isEnabled(name) { return Object.prototype.hasOwnProperty.call(table, name); },
    isChecked() { return false; },
    list() { return Object.keys(table); },
  };
}
