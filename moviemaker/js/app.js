// Movie Maker (web) — bootstrap. Builds every part of the app in the order the architecture
// contract requires, restores the last project, turns on autosave, and wires the app-wide
// behaviour: keyboard shortcuts, drag & drop / paste of files, the window title, the service
// worker (offline + "update available"), Web Share Target pick-up and global error reporting.

import { Store } from './store.js';
import * as persist from './persist.js';
import * as media from './media.js';
import { AudioEngine } from './audio.js';
import { Player } from './player.js';
import { Exporter, supportedFormats } from './exporter.js';
import { createCommands } from './commands.js';
import { Ribbon } from './ui/ribbon.js';
import { Preview } from './ui/preview.js';
import { Storyboard } from './ui/storyboard.js';
import { Dialogs, getOption, APP_VERSION } from './ui/dialogs.js';

const SW_URL = new URL('../sw.js', import.meta.url);
const SW_SCOPE = new URL('../', import.meta.url);
const SHARE_CACHE = 'movie-maker-share';
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|wave|ogg|oga|opus|flac|weba|wma|aif|aiff|aifc|caf|amr|mka)$/i;
const PROJECT_EXT = /\.wlmmweb(\.json)?$/i;

// ---------------------------------------------------------------------------
// helpers

function $(id) { return document.getElementById(id); }

function ensureEl(id, attrs) {
  let el = $(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    document.body.appendChild(el);
  }
  return el;
}

/** Hidden parking spot for the player's <video> elements (kept "visible" for iOS decoding). */
function setupMediaHost() {
  const host = ensureEl('media-host', { 'aria-hidden': 'true' });
  let styled = false;
  try {
    const cs = getComputedStyle(host);
    styled = cs.position === 'fixed' && cs.overflow === 'hidden' && cs.pointerEvents === 'none' && cs.display !== 'none';
  } catch (_) { styled = false; }
  if (!styled) {
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;'
      + 'overflow:hidden;z-index:-1;display:block;visibility:visible;';
  }
  host.setAttribute('aria-hidden', 'true');
  return host;
}

function isEditable(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function hasFiles(dt) {
  if (!dt || !dt.types) return false;
  const types = dt.types;
  if (typeof types.includes === 'function') return types.includes('Files');
  if (typeof types.contains === 'function') return types.contains('Files'); // old Firefox DOMStringList
  return Array.prototype.indexOf.call(types, 'Files') >= 0;
}

function isAudioFile(f) {
  const type = String((f && f.type) || '').toLowerCase();
  if (type.startsWith('audio/') || type === 'application/ogg') return true;
  if (type.startsWith('video/') || type.startsWith('image/')) return false;
  return AUDIO_EXT.test((f && f.name) || '');
}

function isProjectFile(f) { return PROJECT_EXT.test((f && f.name) || ''); }

function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
}

function bootFail(message) {
  try { if (typeof window.__mmBootFail === 'function') window.__mmBootFail(message); } catch (_) { /* ignore */ }
}
function bootDone() {
  try { if (typeof window.__mmBootDone === 'function') window.__mmBootDone(); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// construction (order fixed by docs/ARCHITECTURE.md)

const mediaHost = setupMediaHost();
ensureEl('dialog-root');
ensureEl('toast-root', { 'aria-live': 'polite', 'aria-atomic': 'false' });

const app = {};
app.version = APP_VERSION;
app.exporting = false;
app.installPrompt = null;
app.autosave = null;
app.options = {
  get photoDuration() { return getOption('photoDuration'); },
  get transitionDuration() { return getOption('transitionDuration'); },
};

let coreReady = false;
try {
  app.store = new Store(); app.persist = persist; app.media = media;
  app.audio = new AudioEngine();
  app.dialogs = new Dialogs(app);
  app.preview = new Preview($('preview-pane'), app);   // creates canvas
  app.player = new Player({ store: app.store, audio: app.audio, canvas: app.preview.canvas, mediaHost });
  app.exporter = new Exporter({ store: app.store, player: app.player, audio: app.audio });
  app.commands = createCommands(app);
  app.preview.attach();   // preview subscribes to player events now that it exists
  coreReady = true;
} catch (err) {
  console.error('[Movie Maker] startup failed', err);
  bootFail('Something went wrong while starting. Please reload the page, or update your browser.');
}

if (coreReady) {
  // The ribbon and storyboard are built last; one failing must not take the whole app down.
  try {
    app.ribbon = new Ribbon($('ribbon'), app);
  } catch (err) {
    console.error('[Movie Maker] ribbon failed', err);
    app.dialogs.toast('The ribbon couldn’t be shown. Please reload the page.', { type: 'error', timeout: 0 });
  }
  try {
    app.storyboard = new Storyboard($('storyboard-pane'), app);
  } catch (err) {
    console.error('[Movie Maker] storyboard failed', err);
    app.dialogs.toast('The storyboard couldn’t be shown. Please reload the page.', { type: 'error', timeout: 0 });
  }
  window.app = app;
  bootDone();
  start();
}

export default app;

// ---------------------------------------------------------------------------

async function start() {
  installErrorReporting();
  installTitle();
  installKeyboard();
  installDragAndDrop();
  installPaste();
  installVisibility();
  installInstallPrompt();
  installPersistReporting();

  // Don't overwrite anything the user did while the last project was loading (an edit, or a
  // project opened from the menu).
  let userEdited = false;
  const startProject = app.store.project;
  const markEdit = (e) => { if (!e || !e.detail || e.detail.label !== 'load' || app.store.project !== startProject) userEdited = true; };
  app.store.addEventListener('change', markEdit);
  try {
    await restoreLastProject(() => userEdited);
  } finally {
    app.store.removeEventListener('change', markEdit);
  }
  try {
    app.autosave = persist.enableAutosave(app.store);
  } catch (err) {
    console.warn('[Movie Maker] autosave unavailable', err);
  }
  warnAboutMissingFeatures();
  registerServiceWorker();
  pickUpSharedFiles();
}

// ---------------------------------------------------------------------------
// last project

async function restoreLastProject(userEdited) {
  let id = null;
  try { id = await persist.getLastProjectId(); } catch (_) { id = null; }
  if (!id) return false;
  try {
    const { project, media: mediaMap } = await persist.loadProject(id);
    if (userEdited()) return false; // the user already started something new; keep it
    app.store.replaceProject(project, mediaMap);
    return true;
  } catch (err) {
    console.warn('[Movie Maker] could not restore the last project', err);
    try { await persist.setLastProjectId(null); } catch (_) { /* ignore */ }
    if (!userEdited()) {
      const why = err && err.friendly && err.message ? ` ${err.message}` : '';
      app.dialogs.toast(`Your last project couldn’t be opened, so a new project was started.${why}`, { type: 'error' });
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// title bar: "<project name> - Movie Maker", tap to rename

function installTitle() {
  const t = $('doc-title');
  const update = () => {
    const name = (app.store.project && String(app.store.project.name || '').trim()) || 'My Movie';
    const full = `${name} - Movie Maker`;
    if (document.title !== full) document.title = full;
    if (t && t.textContent !== full) {
      // Same markup the ribbon uses (phones hide the " - Movie Maker" part).
      while (t.firstChild) t.removeChild(t.firstChild);
      const a = document.createElement('span');
      a.className = 'doc-title-name';
      a.textContent = name;
      const b = document.createElement('span');
      b.className = 'doc-title-app';
      b.textContent = ' - Movie Maker';
      t.append(a, b);
    }
    if (t) t.setAttribute('aria-label', `${full}. Rename project`);
  };
  app.store.addEventListener('change', update);
  update();
  if (!t) return;
  t.setAttribute('role', 'button');
  t.tabIndex = 0;
  t.title = 'Rename project';
  t.style.cursor = 'pointer';
  t.style.pointerEvents = 'auto'; // the stylesheet makes the centered desktop title click-through
  // The name field opens synchronously from the tap (phones only show the keyboard then).
  const rename = async () => {
    const d = app.dialogs;
    if (d.isModalOpen) return;
    if (typeof d.renameProject === 'function') { await d.renameProject(); return; }
    const cur = app.store.project.name || 'My Movie';
    const next = await app.dialogs.promptText('Rename project', cur, { label: 'Project name', okLabel: 'Rename' });
    if (next === null) return;
    const name = next.trim();
    if (!name || name === cur) return;
    app.store.update((p) => { p.name = name; }, { label: 'Rename project' });
  };
  t.addEventListener('click', () => { rename().catch(reportError); });
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rename().catch(reportError); }
  });
}

// ---------------------------------------------------------------------------
// commands

function runCommand(name, arg) {
  const c = app.commands;
  if (!c || typeof c.run !== 'function') return undefined;
  let r;
  try { r = arg === undefined ? c.run(name) : c.run(name, arg); } catch (err) { reportError(err); return undefined; }
  if (r && typeof r.then === 'function') r.then(null, reportError);
  return r;
}

function hasCommand(name) {
  const c = app.commands;
  if (!c || typeof c.run !== 'function') return false;
  if (typeof c.list !== 'function') return true;
  try { return c.list().includes(name); } catch (_) { return true; }
}

function commandEnabled(name) {
  const c = app.commands;
  if (!c || typeof c.isEnabled !== 'function') return true;
  try { return c.isEnabled(name) !== false; } catch (_) { return true; }
}

// ---------------------------------------------------------------------------
// keyboard shortcuts (desktop)

let pasteTimer = 0;

function installKeyboard() {
  const BUTTONISH = 'button, [role="button"], a[href], summary, [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"]';
  const ARROWISH = '[role="tab"], [role="tablist"], [role="slider"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"], [role="radiogroup"], [role="radio"], [role="spinbutton"], [role="grid"], [role="tree"]';
  const POPUP = '.rb-popup, .rb-sheet, [role="dialog"], [role="menu"], [role="listbox"]';
  // Was the focused control reached with the keyboard (Tab)? Then Space activates it; after a
  // mouse click / tap Space plays the movie, as in Windows Live Movie Maker. (':focus-visible'
  // can't be used for this: browsers switch a clicked element to :focus-visible on any key press.)
  let keyboardFocus = false;
  document.addEventListener('pointerdown', () => { keyboardFocus = false; }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') keyboardFocus = true; }, true);
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.altKey) return;
    const target = e.target;
    if (isEditable(target)) return;
    const d = app.dialogs;
    if (d && d.isModalOpen) return;
    if (target && target.closest && target.closest(POPUP)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const trim = !!(d && d.trimActive);
    let cmd = null;
    let arg;

    if (mod) {
      const k = key.length === 1 ? key.toLowerCase() : key;
      const textSelected = () => { try { const s = window.getSelection(); return !!(s && String(s).length); } catch (_) { return false; } };
      switch (k) {
        case 'z': cmd = e.shiftKey ? 'redo' : 'undo'; break;
        case 'y': cmd = 'redo'; break;
        case 'x': if (textSelected()) return; cmd = 'cut'; break;
        case 'c': if (textSelected()) return; cmd = 'copy'; break;
        case 'v':
          // Let the browser fire 'paste' (files from the clipboard are handled there); if no
          // paste event arrives, paste Movie Maker's own clipboard.
          if (trim) return;
          clearTimeout(pasteTimer);
          pasteTimer = setTimeout(() => { pasteTimer = 0; runCommand('paste'); }, 80);
          return;
        case 'a': cmd = 'selectAll'; break;
        case 'b': case 'i': {
          // Text Tools › Format: Bold / Italic on the selected caption, credits or title.
          if (e.shiftKey) return;
          const style = k === 'b' ? 'bold' : 'italic';
          const value = textToggleValue(style);
          if (value === null) return; // no text selected: leave the browser's own shortcut alone
          cmd = 'textSet';
          arg = { key: style, value };
          break;
        }
        case 's': cmd = e.shiftKey ? 'saveProjectAs' : 'saveProject'; break;
        case 'o': cmd = 'openProject'; break;
        default: return;
      }
      e.preventDefault();
      // Trim mode keeps the clip temporarily untrimmed: no editing or saving until it is closed.
      if (trim) return;
    } else {
      if (e.ctrlKey || e.metaKey) return;
      switch (key) {
        case ' ': case 'Spacebar':
          if (e.repeat) { e.preventDefault(); return; }
          // A keyboard-focused button keeps its own Space behaviour; after a mouse click Space plays.
          // Storyboard items have no Space action of their own: Space always plays there.
          if (keyboardFocus && target && target.closest && target.closest(BUTTONISH) && !target.closest('#storyboard-pane')) return;
          cmd = 'togglePlay';
          break;
        case 'Delete': case 'Backspace': cmd = 'remove'; break;
        case 'ArrowLeft': cmd = 'prevFrame'; break;
        case 'ArrowRight': cmd = 'nextFrame'; break;
        case 'Home': cmd = 'goStart'; break;
        case 'End': cmd = 'goEnd'; break;
        case 'm': case 'M': if (e.shiftKey && key === 'M') return; cmd = 'split'; break;
        case 'i': case 'I': case 'o': case 'O': {
          // Set start point (I) / Set end point (O) at the playhead, as in Windows Live Movie Maker:
          // the trim tool's points while it is open, else the selected video or music.
          if (e.shiftKey && (key === 'I' || key === 'O')) return;
          const start = key === 'i' || key === 'I';
          if (trim) {
            if (d && typeof d.trimSetPoint === 'function') { e.preventDefault(); d.trimSetPoint(start ? 'start' : 'end'); }
            return;
          }
          const sel = app.store && app.store.selection;
          if (sel && sel.type === 'music') cmd = start ? 'musicSetStartPoint' : 'musicSetEndPoint';
          else cmd = start ? 'setStartPoint' : 'setEndPoint';
          break;
        }
        case 'F1': e.preventDefault(); d && d.openHelp(); return;
        default: return;
      }
      if ((key.startsWith('Arrow') || key === 'Home' || key === 'End') && target && target.closest && target.closest(ARROWISH)) return;
      if (trim && !['togglePlay', 'prevFrame', 'nextFrame', 'goStart', 'goEnd'].includes(cmd)) return;
      e.preventDefault();
    }
    if (!hasCommand(cmd)) {
      const fallback = d && { openProject: () => d.openProjects(), saveProject: () => d.saveProject(), saveProjectAs: () => d.saveProjectAs() }[cmd];
      if (fallback) Promise.resolve(fallback()).catch(reportError);
      return;
    }
    if (!commandEnabled(cmd)) return;
    runCommand(cmd, arg);
  });
  // Ctrl/⌘+B / I also work while a text is being edited on the preview (the inline editor keeps
  // its keys to itself, so this listens before it).
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.isComposing || e.defaultPrevented) return;
    const k = typeof e.key === 'string' && e.key.length === 1 ? e.key.toLowerCase() : '';
    if (k !== 'b' && k !== 'i') return;
    const pv = app.preview;
    const id = pv && pv.editingTextId;
    if (!id || !e.target || !(pv.editor ? e.target === pv.editor : (e.target.closest && e.target.closest('#preview-pane')))) return;
    const sel = app.store.selection;
    if (!sel || !Array.isArray(sel.ids) || !sel.ids.includes(id)) return;
    const style = k === 'b' ? 'bold' : 'italic';
    const value = textToggleValue(style);
    if (value === null || !hasCommand('textSet') || !commandEnabled('textSet')) return;
    e.preventDefault();
    runCommand('textSet', { key: style, value });
  }, true);
}

/**
 * The value Ctrl+B / Ctrl+I sets for `style` ('bold' | 'italic') on the selected captions /
 * credits or title items: off when every one of them has it, else on. null when no text is selected.
 */
function textToggleValue(style) {
  const store = app.store;
  if (!store || !store.selection) return null;
  const type = store.selection.type;
  let objs = [];
  try { objs = typeof store.selectedItems === 'function' ? store.selectedItems() : []; } catch (_) { objs = []; }
  if (type === 'item') objs = objs.filter((o) => o && o.kind === 'title');
  else if (type !== 'text') objs = [];
  objs = objs.filter(Boolean);
  if (!objs.length) return null;
  return !objs.every((o) => !!(o.style && o.style[style]));
}

// ---------------------------------------------------------------------------
// drag & drop and paste

function routeFiles(files) {
  const list = Array.from(files || []).filter((f) => f && typeof f.size === 'number');
  if (!list.length) return Promise.resolve();
  const d = app.dialogs;
  if (app.exporting) { d.toast('Please wait until your movie has finished saving.', { type: 'error' }); return Promise.resolve(); }
  if (d.trimActive) { d.toast('Finish trimming first (Save trim or Cancel), then add files.'); return Promise.resolve(); }
  const projects = list.filter(isProjectFile);
  const audio = list.filter((f) => !isProjectFile(f) && isAudioFile(f));
  const visual = list.filter((f) => !isProjectFile(f) && !isAudioFile(f));
  return (async () => {
    if (projects.length) {
      await d.importProjectFromFile(projects[0]);
      if (projects.length > 1) d.toast('Only one project file can be opened at a time.');
    }
    if (visual.length) await runCommand('addMedia', visual);
    if (audio.length) await runCommand('addMusic', audio);
  })().catch(reportError);
}

function installDragAndDrop() {
  const overlay = $('drop-overlay');
  let hideTimer = 0;
  let shown = false;
  const show = () => {
    if (!overlay || shown) return;
    shown = true;
    overlay.hidden = false;
    overlay.classList.add('is-active');
  };
  const hide = () => {
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (!overlay || !shown) return;
    shown = false;
    overlay.classList.remove('is-active');
    overlay.hidden = true;
  };
  const accepting = () => !(app.dialogs.isModalOpen || app.exporting || app.dialogs.trimActive);

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (accepting()) show();
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    // Always prevent the default, or the browser would open the file and leave Movie Maker.
    e.preventDefault();
    try { e.dataTransfer.dropEffect = accepting() ? 'copy' : 'none'; } catch (_) { /* ignore */ }
    if (accepting()) show();
    // 'dragleave' is unreliable across browsers: hide once dragover stops arriving.
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 350);
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    if (!e.relatedTarget || e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) hide();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    hide();
    if (!accepting()) {
      if (app.exporting) app.dialogs.toast('Please wait until your movie has finished saving.', { type: 'error' });
      return;
    }
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    routeFiles(files);
  });
  window.addEventListener('dragend', hide);
}

function clipboardFiles(cd) {
  if (!cd) return [];
  let files = Array.from(cd.files || []);
  if (!files.length && cd.items) {
    for (const it of Array.from(cd.items)) {
      if (it && it.kind === 'file') {
        const f = it.getAsFile && it.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  files = files.filter((f) => f && f.size > 0);
  // Pasted screenshots are usually called "image.png": give them a useful name.
  return files.map((f) => {
    if (!/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || '') && f.name) return f;
    const ext = (/\/(png|jpeg|gif|webp|bmp)$/i.exec(f.type || '') || [null, 'png'])[1].replace('jpeg', 'jpg');
    try { return new File([f], `Pasted image ${stamp()}.${ext}`, { type: f.type || 'image/png', lastModified: Date.now() }); } catch (_) { return f; }
  });
}

function installPaste() {
  document.addEventListener('paste', (e) => {
    if (isEditable(e.target) || app.dialogs.isModalOpen) return;
    const files = clipboardFiles(e.clipboardData);
    const hadTimer = !!pasteTimer;
    clearTimeout(pasteTimer);
    pasteTimer = 0;
    if (app.dialogs.trimActive) return;
    if (files.length) {
      e.preventDefault();
      routeFiles(files);
    } else if (hadTimer) {
      // Ctrl/⌘+V with nothing usable on the system clipboard: Movie Maker's own clipboard.
      runCommand('paste');
    }
  });
}

// ---------------------------------------------------------------------------
// visibility, install prompt, persistence messages

function installVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    // While exporting, the exporter decides what to do (it pauses and resumes on its own).
    if (app.exporting) return;
    try { if (app.player && app.player.playing) app.player.pause(); } catch (_) { /* ignore */ }
  });
  window.addEventListener('beforeunload', (e) => {
    if (!app.exporting) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

function installInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Keep the browser's own install UI; also remember the event so the menu can offer "Install".
    app.installPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    app.installPrompt = null;
    app.dialogs.toast('Movie Maker was installed. You can open it from your home screen or apps list.', { type: 'success' });
  });
}

function installPersistReporting() {
  let askedPersistence = false;
  let noticeShown = false;
  app.store.addEventListener('persist', (e) => {
    const d = e && e.detail;
    if (!d) return;
    if (d.ok) {
      if (!askedPersistence) {
        askedPersistence = true;
        // Quietly ask the browser to keep our data once there is something to keep. Without
        // userAction this does nothing in engines that would show a permission prompt (Firefox);
        // dialogs.js asks there after an explicit Save project / Save movie.
        try { persist.requestPersistentStorage().catch(() => {}); } catch (_) { /* ignore */ }
      }
      // Safari outside the Home Screen may delete stored projects on its own: persist.js sends this
      // notice once per browser, with the first successful save.
      // A short, dismissible note (a long one would cover the storyboard and Play on phones);
      // "Keep them safe" opens the full advice with Export project file.
      if (d.notice && d.notice.message && !noticeShown) {
        noticeShown = true;
        const full = d.notice.message;
        app.dialogs.toast('Safari may delete projects you haven’t opened for a while.', {
          type: 'info',
          timeout: 0,
          action: {
            label: 'Keep them safe',
            onClick: () => {
              if (typeof app.dialogs.openStorageAdvice === 'function') app.dialogs.openStorageAdvice(full).catch(reportError);
              else app.commands.run('exportProjectFile');
            },
          },
        });
      }
      return;
    }
    const msg = d.error && d.error.message ? d.error.message : 'Your project couldn’t be saved on this device.';
    app.dialogs.toast(msg, { type: 'error' });
  });

  // Sound that can't be decoded in this browser (a video's soundtrack in a codec it can't read,
  // music that isn't readable, or a file too big to decode on this device): say so once per file,
  // since every <video> is muted and the movie would otherwise just be silent.
  const soundWarned = new Set();
  try {
    app.audio.addEventListener('decodeerror', (e) => {
      const d = (e && e.detail) || {};
      if (!d.mediaId || soundWarned.has(d.mediaId)) return;
      // Only tell about media the open project uses (a removed clip decoding late is not news).
      const p = app.store.project;
      const used = (p.items || []).some((it) => it.mediaId === d.mediaId) || (p.music || []).some((m) => m.mediaId === d.mediaId);
      if (!used) return;
      soundWarned.add(d.mediaId);
      const name = d.name ? `“${d.name}”` : 'this file';
      const msg = d.reason === 'too-large'
        ? `${name} is too large for its sound to be played on this device.`
        : `The sound of ${name} can’t be played in this browser.`;
      app.dialogs.toast(msg, { type: 'info', timeout: 8000 });
    });
  } catch (_) { /* ignore */ }
}

function warnAboutMissingFeatures() {
  const d = app.dialogs;
  let idbOk = false;
  try { idbOk = typeof indexedDB !== 'undefined' && !!indexedDB; } catch (_) { idbOk = false; }
  if (!idbOk) {
    d.toast('This browser can’t save projects on this device (private browsing may block it). Use Export project file in the Movie Maker menu to keep your work.', { type: 'error', timeout: 12000 });
  } else {
    // Some private modes only fail when the database is opened: check quietly.
    persist.listProjects().catch((err) => {
      if (err && (err.code === 'unavailable' || err.code === 'version')) d.toast(err.message, { type: 'error', timeout: 12000 });
    });
  }
  let canRecord = false;
  try {
    canRecord = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined'
      && typeof HTMLCanvasElement.prototype.captureStream === 'function' && supportedFormats().length > 0;
  } catch (_) { canRecord = false; }
  if (!canRecord) {
    setTimeout(() => d.toast('Saving movies isn’t supported in this browser, but you can still edit and save projects. To save movies, use the latest Chrome, Edge, Firefox or Safari.', { type: 'info', timeout: 10000 }), 1200);
  }
}

// ---------------------------------------------------------------------------
// errors

const recentErrors = new Map();

function isBenign(err) {
  if (!err) return true;
  const name = err.name || '';
  const msg = String(err.message || err || '');
  if (name === 'AbortError' || err.handled) return true;
  if (/ResizeObserver loop/i.test(msg)) return true;
  if (/play\(\) request was interrupted|The play\(\) request|interrupted by a (call to pause|new load)/i.test(msg)) return true;
  if (name === 'NotAllowedError' && /play/i.test(msg)) return true;
  if (msg === 'Script error.' || msg === 'Script error') return true;
  return false;
}

function reportError(err) {
  if (isBenign(err)) return;
  console.error('[Movie Maker]', err);
  const friendly = err && err.friendly && err.message
    ? err.message
    : 'Something went wrong. If Movie Maker stops responding, reload the page — your project is saved automatically.';
  const t = Date.now();
  for (const [k, at] of recentErrors) if (t - at > 6000) recentErrors.delete(k);
  if (recentErrors.has(friendly) || recentErrors.size >= 3) return;
  recentErrors.set(friendly, t);
  try { app.dialogs.toast(friendly, { type: 'error' }); } catch (_) { /* ignore */ }
}

function installErrorReporting() {
  window.addEventListener('error', (e) => {
    if (e && e.target && e.target !== window && e.target.nodeType === 1) return; // failed <img>/<video> loads
    reportError((e && e.error) || (e && e.message ? { message: e.message } : null));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    if (isBenign(r)) { if (r && r.name === 'AbortError') e.preventDefault(); return; }
    reportError(r);
  });
}

// ---------------------------------------------------------------------------
// service worker: offline shell + "Update available — tap to reload"

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const host = location.hostname;
  const allowed = location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (!allowed) return;
  // Embedded in another page (e.g. a hosted preview frame): the host owns caching and updates.
  let framed = false;
  try { framed = window.top !== window.self; } catch (_) { framed = true; }
  if (framed) return;
  const sw = navigator.serviceWorker;
  if (/[?&]nosw\b/.test(location.search)) {
    // Development escape hatch: ?nosw removes the worker and its caches.
    sw.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
    if (window.caches) caches.keys().then((ks) => ks.filter((k) => k.startsWith('movie-maker-')).forEach((k) => caches.delete(k))).catch(() => {});
    return;
  }
  let reloadRequested = false;
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (!reloadRequested || reloading) return;
    reloading = true;
    location.reload();
  });
  let prompted = false;
  let registration = null;
  const promptUpdate = (worker) => {
    if (prompted || !worker) return;
    prompted = true;
    const apply = async () => {
      if (app.exporting) {
        prompted = false;
        app.dialogs.toast('The update will be installed after your movie has finished saving.');
        setTimeout(() => promptUpdate(worker), 30000);
        return;
      }
      if (app.autosave && typeof app.autosave.flush === 'function') { try { await app.autosave.flush(); } catch (_) { /* ignore */ } }
      reloadRequested = true;
      // A newer version may have replaced the one we announced: always activate the latest.
      const target = (registration && (registration.waiting || registration.installing)) || worker;
      try { target.postMessage({ type: 'SKIP_WAITING' }); } catch (_) { /* ignore */ }
      // If the new worker can't take over (e.g. it became redundant), reload anyway.
      setTimeout(() => { if (!reloading) { reloading = true; location.reload(); } }, 3000);
    };
    app.dialogs.toast('Update available — tap to reload', { type: 'info', timeout: 0, onClick: () => { apply(); }, action: { label: 'Reload', onClick: () => { apply(); } } });
  };
  const doRegister = () => {
    sw.register(SW_URL.href, { scope: SW_SCOPE.pathname }).then((reg) => {
      registration = reg;
      if (reg.waiting && sw.controller) promptUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && sw.controller) promptUpdate(nw);
        });
      });
      // Look for updates when the app comes back to the foreground (at most hourly).
      let lastCheck = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden || Date.now() - lastCheck < 3600e3) return;
        lastCheck = Date.now();
        reg.update().catch(() => {});
      });
    }).catch((err) => {
      console.warn('[Movie Maker] service worker registration failed (offline use unavailable)', err);
    });
  };
  if (document.readyState === 'complete') setTimeout(doRegister, 500);
  else window.addEventListener('load', () => setTimeout(doRegister, 500), { once: true });
}

// ---------------------------------------------------------------------------
// Web Share Target: files shared to the installed app arrive via the service worker.

async function pickUpSharedFiles() {
  let params;
  try { params = new URLSearchParams(location.search); } catch (_) { return; }
  const mode = params.get('share-target');
  if (!mode) return;
  try {
    params.delete('share-target');
    const q = params.toString();
    history.replaceState(history.state, '', location.pathname + (q ? `?${q}` : '') + location.hash);
  } catch (_) { /* ignore */ }
  if (mode === 'error') { app.dialogs.toast('The shared files couldn’t be received. Please try again.', { type: 'error' }); return; }
  if (mode !== 'files' || !window.caches) { if (mode === 'empty') app.dialogs.toast('Nothing was shared.'); return; }
  const files = [];
  try {
    const cache = await caches.open(SHARE_CACHE);
    const keys = await cache.keys();
    for (const req of keys) {
      const res = await cache.match(req);
      if (res) {
        const blob = await res.blob();
        let name = 'Shared file';
        try { name = decodeURIComponent(res.headers.get('X-File-Name') || name); } catch (_) { /* ignore */ }
        const type = res.headers.get('Content-Type') || blob.type || '';
        const lm = Number(res.headers.get('X-Last-Modified')) || Date.now();
        try { files.push(new File([blob], name, { type, lastModified: lm })); } catch (_) { files.push(blob); }
      }
      await cache.delete(req);
    }
  } catch (err) {
    console.warn('[Movie Maker] shared files', err);
    app.dialogs.toast('The shared files couldn’t be read. Please try again.', { type: 'error' });
    return;
  }
  if (files.length) await routeFiles(files);
  else app.dialogs.toast('Nothing was shared.');
}
