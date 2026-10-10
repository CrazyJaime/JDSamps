// Browser harness for js/media.js + js/persist.js (+ Store autosave).
import * as media from '../js/media.js';
import * as persist from '../js/persist.js';
import * as M from '../js/model.js';
import { Store } from '../js/store.js';

const logEl = document.getElementById('log');
const thumbsEl = document.getElementById('thumbs');
const results = [];
function log(msg, cls) {
  const line = document.createElement('div');
  line.textContent = msg;
  if (cls) line.className = cls;
  logEl.appendChild(line);
}
function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function near(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, `${msg}: expected ~${b}, got ${a}`); }
async function test(name, fn) {
  const t0 = performance.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Math.round(performance.now() - t0) });
    log(`ok   ${name} (${Math.round(performance.now() - t0)}ms)`, 'ok');
  } catch (err) {
    results.push({ name, ok: false, error: String((err && err.stack) || err) });
    log(`FAIL ${name}: ${err && err.message}`, 'bad');
    console.error(name, err);
  }
}
function showThumb(src) {
  if (!src) return;
  const img = document.createElement('img');
  img.src = src;
  thumbsEl.appendChild(img);
}
async function fixture(path, name, type) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fixture ${path} ${res.status}`);
  const blob = await res.blob();
  return new File([blob], name || path.split('/').pop(), { type: type === undefined ? blob.type : type });
}
function checkMediaShape(m) {
  for (const k of ['id', 'type', 'name', 'mime', 'blob', 'url', 'duration', 'width', 'height', 'hasAudio', 'thumb', 'filmstrip', 'peaks']) {
    assert(k in m, `media has ${k}`);
  }
  assert(m.url.startsWith('blob:'), 'url is a blob: URL');
  assert(m.thumb.startsWith('data:image/'), 'thumb is a data URL');
  assert(Array.isArray(m.filmstrip), 'filmstrip array');
}
function loadVideoMeta(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.onloadedmetadata = () => resolve(v.duration);
    v.onerror = () => reject(new Error('video failed to load'));
    v.src = url;
  });
}
function rawIDB(storeName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('wlmm-web');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(storeName, 'readonly');
      const all = tx.objectStore(storeName).getAll();
      all.onsuccess = () => { db.close(); resolve(all.result); };
      all.onerror = () => reject(all.error);
    };
    req.onerror = () => reject(req.error);
  });
}

const imported = {};

async function runAll() {
  results.length = 0;
  logEl.textContent = '';
  thumbsEl.textContent = '';

  await test('detectMediaType: mime, extension, generic mime', () => {
    const d = (name, type) => media.detectMediaType({ name, type });
    assert(d('a.webm', 'video/webm').type === 'video', 'webm');
    assert(d('IMG_0001.MOV', '').mime === 'video/quicktime', 'mov ext');
    assert(d('clip.mkv', 'application/octet-stream').type === 'video', 'mkv');
    assert(d('x.3gp', '').type === 'video', '3gp');
    assert(d('x.m4v', '').type === 'video', 'm4v');
    assert(d('IMG_1.HEIC', '').mime === 'image/heic', 'heic');
    assert(d('a.heif', '').type === 'image', 'heif');
    assert(d('a.webp', '').type === 'image', 'webp');
    assert(d('a.gif', '').type === 'image', 'gif');
    assert(d('song.m4a', '').type === 'audio', 'm4a');
    assert(d('song.mp3', 'audio/mpeg').type === 'audio', 'mp3');
    assert(d('notes.txt', 'text/plain') === null, 'txt');
  });

  await test('importFile: webm video (metadata, thumb, 8-frame filmstrip, peaks)', async () => {
    const progress = [];
    const m = await media.importFile(await fixture('fixtures/clip1.webm'), { onProgress: (p, t) => progress.push([p, t]) });
    checkMediaShape(m);
    assert(m.type === 'video', `type ${m.type}`);
    near(m.duration, 4, 0.15, 'duration');
    assert(m.width === 640 && m.height === 360, `size ${m.width}x${m.height}`);
    assert(m.filmstrip.length === 8, `filmstrip ${m.filmstrip.length}`);
    assert(new Set(m.filmstrip).size > 1, 'filmstrip frames differ');
    assert(m.hasAudio === true, 'hasAudio');
    assert(Array.isArray(m.peaks) && Math.abs(m.peaks.length - 80) <= 2, `peaks length ${m.peaks && m.peaks.length}`);
    assert(m.peaks.every((p) => p >= 0 && p <= 1), 'peaks normalized');
    assert(Math.max(...m.peaks) === 1, 'peaks max 1');
    assert(progress.length > 3 && progress[progress.length - 1][0] === 1, 'progress reported');
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = m.thumb; });
    assert(img.width === 160 && img.height === 90, `thumb ${img.width}x${img.height}`);
    imported.video = m;
    showThumb(m.thumb);
    m.filmstrip.forEach(showThumb);
  });

  await test('importFile: portrait webm without mime type (extension detection)', async () => {
    const m = await media.importFile(await fixture('fixtures/portrait.webm', 'portrait.webm', ''));
    checkMediaShape(m);
    assert(m.mime === 'video/webm' && m.blob.type === 'video/webm', `mime ${m.mime}`);
    assert(m.width === 360 && m.height === 640, `size ${m.width}x${m.height}`);
    near(m.duration, 3, 0.15, 'duration');
    assert(m.filmstrip.length === 6, `filmstrip ${m.filmstrip.length}`);
    imported.portrait = m;
    showThumb(m.thumb);
  });

  await test('importFile: ogg music (duration + peaks)', async () => {
    const m = await media.importFile(await fixture('fixtures/music.ogg'));
    checkMediaShape(m);
    assert(m.type === 'audio', `type ${m.type}`);
    near(m.duration, 8, 0.2, 'duration');
    assert(m.peaks && Math.abs(m.peaks.length - 160) <= 3, `peaks ${m.peaks && m.peaks.length}`);
    assert(m.width === 0 && m.height === 0, 'no size');
    assert(m.filmstrip.length === 1, 'audio filmstrip = [thumb]');
    imported.music = m;
    showThumb(m.thumb);
  });

  await test('importFile: jpg + png photos', async () => {
    const a = await media.importFile(await fixture('fixtures/photo1.jpg'));
    checkMediaShape(a);
    assert(a.type === 'image' && a.width === 800 && a.height === 600, `jpg ${a.width}x${a.height}`);
    assert(a.duration === 0 && a.peaks === null && a.hasAudio === false, 'image defaults');
    assert(a.filmstrip.length === 1 && a.filmstrip[0] === a.thumb, 'image filmstrip = [thumb]');
    const b = await media.importFile(await fixture('fixtures/photo2.png'));
    assert(b.type === 'image' && b.width === 600 && b.height === 800, `png ${b.width}x${b.height}`);
    imported.photo1 = a;
    imported.photo2 = b;
    showThumb(a.thumb);
    showThumb(b.thumb);
  });

  await test('importFile: sniffs files with no name extension and no mime', async () => {
    const m = await media.importFile(await fixture('fixtures/photo1.jpg', 'image', ''));
    assert(m.type === 'image' && m.mime === 'image/jpeg', `sniffed ${m.type} ${m.mime}`);
    const v = await media.importFile(await fixture('fixtures/clip1.webm', 'VID_0001', ''));
    assert(v.type === 'video', `sniffed video ${v.type}`);
    media.revokeMedia(m);
    media.revokeMedia(v);
    assert(m.url === '', 'revoked url cleared');
  });

  await test('importFile: EXIF orientation honored', async () => {
    const f = await fixture('core-fixtures/exif6.jpg');
    assert(await media.readExifOrientation(f) === 6, 'EXIF parser reads 6');
    const m = await media.importFile(f);
    assert(m.width === 200 && m.height === 400, `oriented size ${m.width}x${m.height}`);
    // thumbnail must be portrait too
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = m.thumb; });
    assert(img.height > img.width, `thumb portrait ${img.width}x${img.height}`);
    // the green band (raw left) must be on top after rotating 90° clockwise
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const top = ctx.getImageData(Math.floor(img.width / 2), 2, 1, 1).data;
    const bottom = ctx.getImageData(Math.floor(img.width / 2), img.height - 3, 1, 1).data;
    assert(top[1] > 150 && top[0] < 100, `top is green (${top.join(',')})`);
    assert(bottom[0] > 150 && bottom[1] < 100, `bottom is red (${bottom.join(',')})`);
    showThumb(m.thumb);
  });

  await test('importFile: huge photo is downscaled to <= 3840px', async () => {
    const c = document.createElement('canvas');
    c.width = 6000; c.height = 4000;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3366cc'; ctx.fillRect(0, 0, 6000, 4000);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    c.width = 0; c.height = 0;
    const m = await media.importFile(new File([blob], 'big.jpg', { type: 'image/jpeg' }));
    assert(Math.max(m.width, m.height) <= 3840 && m.width * m.height <= 3840 * 2880, `downscaled ${m.width}x${m.height}`);
    near(m.width / m.height, 1.5, 0.01, 'aspect kept');
    media.revokeMedia(m);
  });

  await test('importFile: MediaRecorder WebM (Infinity duration until seeked)', async () => {
    if (typeof MediaRecorder === 'undefined') return;
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const ctx = c.getContext('2d');
    const stream = c.captureStream(30);
    const mime = ['video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    let frame = 0;
    const timer = setInterval(() => { ctx.fillStyle = `hsl(${(frame++ * 12) % 360},80%,50%)`; ctx.fillRect(0, 0, 320, 240); }, 33);
    rec.start(250);
    await new Promise((r) => setTimeout(r, 1600));
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: 'video/webm' });
    const m = await media.importFile(new File([blob], 'Webcam recording.webm', { type: 'video/webm' }));
    assert(m.type === 'video', `type ${m.type}`);
    assert(Number.isFinite(m.duration) && m.duration > 1 && m.duration < 2.5, `finite duration ${m.duration}`);
    assert(m.width === 320 && m.height === 240, `size ${m.width}x${m.height}`);
    assert(m.hasAudio === false, 'no soundtrack');
    assert(m.filmstrip.length >= 2, `filmstrip ${m.filmstrip.length}`);
    showThumb(m.thumb);
    media.revokeMedia(m);
  });

  await test('importFile: audio-only file labelled video/webm becomes audio', async () => {
    const m = await media.importFile(await fixture('core-fixtures/audio-only.webm', 'voice.webm', 'video/webm'));
    assert(m.type === 'audio', `type ${m.type}`);
    near(m.duration, 3, 0.2, 'duration');
    assert(m.peaks && m.peaks.length >= 55, 'peaks');
    media.revokeMedia(m);
  });

  await test('importFile: friendly errors for unsupported / unknown / empty files', async () => {
    const tries = [
      [new File(['this is not a video'], 'fake.mp4', { type: 'video/mp4' }), /video format isn't supported/],
      [new File(['not an image'], 'fake.png', { type: 'image/png' }), /photo format isn't supported/],
      [new File(['nope'], 'IMG_1.heic', { type: 'image/heic' }), /HEIC/],
      [new File(['nope'], 'song.mp3', { type: 'audio/mpeg' }), /audio format isn't supported/],
      [new File(['hello'], 'notes.txt', { type: 'text/plain' }), /isn't a video, photo or music file/],
      [new File([], 'empty.webm', { type: 'video/webm' }), /is empty/],
    ];
    for (const [file, re] of tries) {
      let err = null;
      try { await media.importFile(file); } catch (e) { err = e; }
      assert(err, `${file.name} should fail`);
      assert(err.name === 'MediaImportError' && err.friendly, `${file.name} friendly error (${err.name})`);
      assert(re.test(err.message), `${file.name}: message "${err.message}"`);
    }
  });

  await test('importFiles: sequential, skips failures, reports onError + progress', async () => {
    const files = [await fixture('fixtures/photo2.png'), new File(['x'], 'bad.txt', { type: 'text/plain' }), await fixture('fixtures/music.ogg')];
    const errors = [];
    const progress = [];
    const out = await media.importFiles(files, { onError: (f, e) => errors.push([f.name, e.message]), onProgress: (p, t) => progress.push([p, t]) });
    assert(out.length === 2, `2 successes, got ${out.length}`);
    assert(errors.length === 1 && errors[0][0] === 'bad.txt', 'one error');
    assert(progress.every((p, i) => i === 0 || p[0] >= progress[i - 1][0] - 1e-9), 'monotonic progress');
    assert(/of 3/.test(progress[1][1]), `progress text "${progress[1][1]}"`);
    out.forEach(media.revokeMedia);
  });

  await test('computePeaks: shared job, cached result, null for images', async () => {
    const m = { ...imported.music, id: 'peaks-test', peaks: null };
    const p1 = media.computePeaks(m);
    const p2 = media.computePeaks(m);
    assert(p1 === p2, 'concurrent calls share one decode');
    const peaks = await p1;
    assert(peaks && peaks.length > 100 && m.peaks === peaks, 'peaks stored on media');
    assert(await media.computePeaks(imported.photo1) === null, 'image → null');
  });

  await test('pickFiles: cancel event resolves []', async () => {
    const p = media.pickFiles(media.ACCEPT_VISUAL);
    const input = [...document.querySelectorAll('input[type=file]')].pop();
    assert(input && input.accept === 'video/*,image/*' && input.multiple, 'input configured');
    input.dispatchEvent(new Event('cancel'));
    const files = await p;
    assert(Array.isArray(files) && files.length === 0, 'resolved []');
  });

  // ---------------- persistence ----------------
  let project;
  await test('saveProject / listProjects / loadProject round trip', async () => {
    project = M.createProject('Harness project');
    project.items.push(M.createVisualItem('video', { mediaId: imported.video.id, trimStart: 0.5 }));
    project.items.push(M.createVisualItem('image', { mediaId: imported.photo1.id, transition: { type: 'crossfade', duration: 1 } }));
    project.items.push(M.createVisualItem('title', { text: 'The End' }));
    project.music.push(M.createMusicItem({ mediaId: imported.music.id }));
    const map = new Map([imported.video, imported.photo1, imported.music].map((m) => [m.id, m]));
    await persist.saveProject(project, map);
    await persist.saveProject(project, map); // second save is a cheap metadata no-op
    const list = await persist.listProjects();
    const entry = list.find((p) => p.id === project.id);
    assert(entry && entry.name === 'Harness project', 'listed');
    assert(entry.thumb === imported.video.thumb, 'project thumb = first visual');
    const loaded = await persist.loadProject(project.id);
    assert(loaded.project.items.length === 3 && loaded.project.items[0].trimStart === 0.5, 'project restored');
    assert(loaded.media instanceof Map && loaded.media.size === 3, `media restored (${loaded.media.size})`);
    const v = loaded.media.get(imported.video.id);
    assert(v.url.startsWith('blob:') && v.url !== imported.video.url, 'fresh object URL');
    assert(v.blob.size === imported.video.blob.size, 'blob size');
    assert(v.peaks && v.peaks.length === imported.video.peaks.length, 'peaks persisted');
    assert(v.filmstrip.length === 8, 'filmstrip persisted');
    near(await loadVideoMeta(v.url), 4, 0.2, 'stored video still plays');
    const tl = M.computeTimeline(loaded.project, loaded.media);
    near(tl.segments[1].start, 3.5 - 1, 0.2, 'timeline from loaded media');
  });

  await test('saveProject prunes media no longer used; deleteProject removes orphans', async () => {
    const map = new Map([imported.video, imported.music].map((m) => [m.id, m]));
    project.items.splice(1, 1); // drop the photo
    await persist.saveProject(project, map);
    let recs = await rawIDB('media');
    assert(!recs.some((r) => r.id === imported.photo1.id), 'unused photo removed');
    assert(recs.some((r) => r.id === imported.video.id), 'video kept');
    // a second project sharing the video keeps it alive
    const other = M.createProject('Other');
    other.items.push(M.createVisualItem('video', { mediaId: imported.video.id }));
    await persist.saveProject(other, new Map([[imported.video.id, imported.video]]));
    await persist.deleteProject(project.id);
    recs = await rawIDB('media');
    assert(recs.some((r) => r.id === imported.video.id), 'shared video survives');
    assert(!recs.some((r) => r.id === imported.music.id), 'music orphan deleted');
    await persist.deleteProject(other.id);
    recs = await rawIDB('media');
    assert(!recs.some((r) => r.id === imported.video.id), 'video deleted with last project');
    const list = await persist.listProjects();
    assert(!list.some((p) => p.id === project.id || p.id === other.id), 'projects gone');
    let err = null;
    try { await persist.loadProject(project.id); } catch (e) { err = e; }
    assert(err && err.friendly && /couldn't be found/.test(err.message), 'friendly not-found');
  });

  // A fresh copy of an imported record under a new id (tests must not share media records).
  const freshCopy = (m) => ({ ...m, id: M.uid('media') });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextPersist = (store) => new Promise((resolve) => store.addEventListener('persist', (e) => resolve(e.detail), { once: true }));
  const withUA = async (ua, fn) => {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
    try { return await fn(); } finally { delete navigator.userAgent; }
  };
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1';
  const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:115.0) Gecko/20100101 Firefox/115.0';

  await test('storage notice: Safari outside the Home Screen is warned once; persist() never asked at start-up', async () => {
    const sm = navigator.storage;
    let persistCalls = 0;
    let persisted = false;
    sm.persist = async () => { persistCalls++; return false; };
    sm.persisted = async () => persisted;
    try {
      assert(!(await persist.storageEvictionRisk()).atRisk, 'Chromium is not at risk');
      await withUA(IPHONE_UA, async () => {
        const r = await persist.storageEvictionRisk();
        assert(r.atRisk && r.ios && /Home Screen/.test(r.message) && /Export project file/.test(r.message), `iPhone Safari at risk: ${JSON.stringify(r)}`);
        persisted = true;
        assert(!(await persist.storageEvictionRisk()).atRisk, 'persistent storage is not at risk');
        persisted = false;
        localStorage.removeItem('wlmm-web:storageNoticeShown');
        const store = new Store();
        const ctl = persist.enableAutosave(store, 60000);
        try {
          store.replaceProject(M.createProject('Notice'));
          store.update((p) => { p.items.push(M.createVisualItem('title', { text: 'Hi' })); });
          let ev = nextPersist(store);
          await ctl.flush();
          const first = await ev;
          assert(first.ok && first.notice && first.notice.kind === 'eviction' && /Safari may delete/.test(first.notice.message), `first save carries the notice: ${JSON.stringify(first)}`);
          ev = nextPersist(store);
          store.update((p) => { p.name = 'Notice 2'; });
          await ctl.flush();
          const second = await ev;
          assert(second.ok && !second.notice, 'only once');
          assert(localStorage.getItem('wlmm-web:storageNoticeShown'), 'remembered');
        } finally {
          ctl.disable();
          await persist.deleteProject(store.project.id);
        }
      });
      assert(persistCalls === 0, `enableAutosave never calls persist() (${persistCalls})`);
      await withUA(FIREFOX_UA, async () => {
        assert(await persist.requestPersistentStorage() === false && persistCalls === 0, 'Firefox: no prompt without a user action');
        await persist.requestPersistentStorage({ userAction: true });
        assert(persistCalls === 1, 'Firefox: asked after an explicit save');
        await persist.requestPersistentStorage({ userAction: true });
        assert(persistCalls === 1, 'asked at most once per session');
      });
    } finally {
      delete sm.persist;
      delete sm.persisted;
    }
  });

  await test('autosave flush() waits for a running save and stores edits made during it', async () => {
    const store = new Store();
    const ctl = persist.enableAutosave(store, 60000);
    try {
      store.replaceProject(M.createProject('Race'));
      const pic = freshCopy(imported.photo2);
      store.addMedia(pic);
      store.update((p) => { p.items.push(M.createVisualItem('image', { mediaId: pic.id })); p.name = 'Edit 1'; });
      const first = ctl.flush();
      assert(ctl.saving, 'a save is running');
      store.update((p) => { p.name = 'Edit 2'; });
      await ctl.flush();
      assert((await persist.loadProject(store.project.id)).project.name === 'Edit 2', 'edit made during the save is stored');
      await first;
      // disable() keeps edits that were still waiting for the debounce, but nothing after it
      store.update((p) => { p.name = 'Edit 3'; });
      assert(ctl.pending, 'edit waiting for the debounce');
      const ev = nextPersist(store);
      ctl.disable();
      store.update((p) => { p.name = 'Edit 4 (after disable)'; });
      assert((await ev).ok, 'final save');
      await sleep(50);
      assert((await persist.loadProject(store.project.id)).project.name === 'Edit 3', 'state at disable() is stored');
    } finally {
      ctl.disable();
      await persist.deleteProject(store.project.id);
    }
  });

  await test('removed media leaves storage once undo can no longer bring it back', async () => {
    const store = new Store();
    const ctl = persist.enableAutosave(store, 60000);
    const vid = freshCopy(imported.portrait);
    const pic = freshCopy(imported.photo2);
    const attached = async (id) => (await rawIDB('media')).find((r) => r.id === id && (r.projectIds || []).includes(store.project.id));
    try {
      store.replaceProject(M.createProject('Leak'));
      store.addMedia(vid);
      store.addMedia(pic);
      store.update((p) => {
        p.items.push(M.createVisualItem('video', { mediaId: vid.id }));
        p.items.push(M.createVisualItem('image', { mediaId: pic.id }));
      });
      await ctl.flush();
      assert(await attached(vid.id) && await attached(pic.id), 'both stored');
      store.update((p) => { p.items = p.items.filter((i) => i.mediaId !== vid.id); }, { label: 'Remove' });
      await ctl.flush();
      assert(await attached(vid.id), 'kept while undo can bring it back');
      const copy = M.createProject('Copy');
      copy.items = structuredClone(store.project.items);
      await persist.saveProject(copy, store.media);
      const copyRec = (await rawIDB('media')).find((r) => r.id === vid.id);
      assert(!(copyRec.projectIds || []).includes(copy.id), '"Save as" copy does not take unused media along');
      await persist.deleteProject(copy.id);
      const loaded = await persist.loadProject(store.project.id);
      assert(!loaded.media.has(vid.id) && loaded.media.has(pic.id), `only used media is loaded (${[...loaded.media.keys()]})`);
      store.replaceProject(loaded.project, loaded.media); // reload: no undo history
      await ctl.flush();
      assert(!(await rawIDB('media')).some((r) => r.id === vid.id), 'unused media deleted');
      assert(await attached(pic.id), 'used media kept');
      // a save that knows nothing about undo drops the photo; undo then writes it back
      store.update((p) => { p.items = []; p.texts.push(M.createTextItem('caption', { start: 0 })); }, { label: 'Remove' });
      await ctl.flush();
      assert(await attached(pic.id), 'kept for undo');
      await persist.saveProject(store.project, store.media, { keep: [] });
      assert(!(await rawIDB('media')).some((r) => r.id === pic.id), 'dropped by a plain save');
      store.undo();
      await ctl.flush();
      const back = await persist.loadProject(store.project.id);
      assert(back.media.has(pic.id) && back.media.get(pic.id).blob.size === pic.blob.size, 'undone removal is stored again');
    } finally {
      ctl.disable();
      await persist.deleteProject(store.project.id);
    }
  });

  await test('raw-bytes fallback (Safari Blob bug): one file per transaction, round trip, metadata, detach', async () => {
    persist.__test.setBlobsAsBytes(true);
    const p = M.createProject('Bytes');
    try {
      const vid = freshCopy(imported.video);
      const pic = freshCopy(imported.photo1);
      p.items.push(M.createVisualItem('video', { mediaId: vid.id }));
      p.items.push(M.createVisualItem('image', { mediaId: pic.id }));
      const map = new Map([[vid.id, vid], [pic.id, pic]]);
      await persist.saveProject(p, map);
      let recs = await rawIDB('media');
      const rv = recs.find((r) => r.id === vid.id);
      assert(rv && rv.blob === null && rv.bytes && rv.bytes.byteLength === vid.blob.size, 'video stored as bytes');
      const loaded = await persist.loadProject(p.id);
      const lv = loaded.media.get(vid.id);
      assert(lv && lv.blob.size === vid.blob.size && lv.filmstrip.length === vid.filmstrip.length, 'loaded back');
      near(await loadVideoMeta(lv.url), 4, 0.2, 'stored video still plays');
      await persist.saveProject(p, map); // unchanged: no rewrite needed
      vid.peaks = new Array(7).fill(0.5);
      await persist.saveProject(p, map);
      recs = await rawIDB('media');
      assert(recs.find((r) => r.id === vid.id).peaks.length === 7, 'metadata refreshed');
      assert(recs.find((r) => r.id === vid.id).bytes.byteLength === vid.blob.size, 'bytes kept');
      p.items.pop();
      await persist.saveProject(p, map);
      recs = await rawIDB('media');
      assert(!recs.some((r) => r.id === pic.id), 'unused photo removed');
      assert(recs.some((r) => r.id === vid.id), 'video kept');
    } finally {
      persist.__test.setBlobsAsBytes(false);
      await persist.deleteProject(p.id);
    }
  });

  await test('computePeaks: a failed decode clears hasAudio only when no audio track was reported', async () => {
    const junk = () => new Blob([new Uint8Array(8192).fill(7)], { type: 'video/mp4' });
    const withTrack = { id: M.uid('media'), type: 'video', blob: junk(), duration: 2, hasAudio: true, hasAudioHint: true, peaks: null };
    assert(await media.computePeaks(withTrack) === null, 'no peaks');
    assert(withTrack.hasAudio === true, 'a video with an audio track this engine cannot decode keeps hasAudio');
    assert(await media.computePeaks(withTrack) === null, 'failure remembered');
    const unknown = { id: M.uid('media'), type: 'video', blob: junk(), duration: 2, hasAudio: true, hasAudioHint: null, peaks: null };
    await media.computePeaks(unknown);
    assert(unknown.hasAudio === false, 'no track reported + undecodable → no soundtrack');
    // the hint survives a save / load
    const p = M.createProject('Hint');
    const rec = { ...freshCopy(imported.photo2), type: 'video', hasAudioHint: true };
    p.items.push(M.createVisualItem('video', { mediaId: rec.id }));
    try {
      await persist.saveProject(p, new Map([[rec.id, rec]]));
      const back = await persist.loadProject(p.id);
      assert(back.media.get(rec.id).hasAudioHint === true, 'hasAudioHint persisted');
    } finally {
      await persist.deleteProject(p.id);
    }
  });

  await test('enableAutosave: debounced save via Store, flush, last project id', async () => {
    const store = new Store();
    const events = [];
    store.addEventListener('persist', (e) => events.push(e.detail));
    const ctl = persist.enableAutosave(store, 150);
    // blank project: nothing is written
    store.replaceProject(M.createProject('Blank'));
    await new Promise((r) => setTimeout(r, 400));
    assert(!(await persist.listProjects()).some((p) => p.id === store.project.id), 'blank project not saved');
    store.addMedia(imported.portrait);
    store.update((p) => { p.items.push(M.createVisualItem('video', { mediaId: imported.portrait.id })); }, { label: 'Add' });
    for (let i = 0; i < 5; i++) store.update((p) => { p.items[0].brightness = i * 10; }, { coalesceKey: 'b' });
    await new Promise((r) => setTimeout(r, 600));
    assert(events.length === 1 && events[0].ok, `one debounced save (${events.length})`);
    assert(await persist.getLastProjectId() === store.project.id, 'last project id set');
    const loaded = await persist.loadProject(store.project.id);
    assert(loaded.project.items[0].brightness === 40, 'latest state saved');
    // emptying a saved project is saved too
    store.update((p) => { p.items.length = 0; });
    await ctl.flush();
    const again = await persist.loadProject(store.project.id);
    assert(again.project.items.length === 0, 'emptied project saved');
    ctl.disable();
    await persist.deleteProject(store.project.id);
    assert(await persist.getLastProjectId() === null, 'last id cleared on delete');
  });

  await test('exportProjectFile / importProjectFile in the browser', async () => {
    const p = M.createProject('Export me');
    p.items.push(M.createVisualItem('video', { mediaId: imported.video.id }));
    p.music.push(M.createMusicItem({ mediaId: imported.music.id }));
    const map = new Map([imported.video, imported.music].map((m) => [m.id, m]));
    const blob = await persist.exportProjectFile(p, map);
    const file = new File([blob], persist.projectFileName(p), { type: 'application/json' });
    assert(file.name === 'Export me.wlmmweb', file.name);
    const res = await persist.importProjectFile(file);
    assert(res.project.name === 'Export me' && res.media.size === 2, 'imported');
    const v = res.media.get(imported.video.id);
    near(await loadVideoMeta(v.url), 4, 0.2, 'imported video plays');
    // importing when the same project id exists in the DB yields a copy
    await persist.saveProject(res.project, res.media);
    const res2 = await persist.importProjectFile(file);
    assert(res2.project.id !== res.project.id, 'import as copy');
    await persist.deleteProject(res.project.id);
  });

  const summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  log(`\n${summary.passed} passed, ${summary.failed} failed`, summary.failed ? 'bad' : 'ok');
  return summary;
}

window.runCoreTests = runAll;
document.getElementById('run').addEventListener('click', () => { runAll(); });

async function pickAndImport(accept) {
  const files = await media.pickFiles(accept);
  window.__picked = files.map((f) => f.name);
  log(`picked: ${window.__picked.join(', ') || '(cancelled)'}`);
  const out = await media.importFiles(files, {
    onError: (f, e) => log(`error: ${e.message}`, 'bad'),
    onProgress: (p, t) => { document.title = `${Math.round(p * 100)}% ${t}`; },
  });
  for (const m of out) {
    log(`${m.type} ${m.name}: ${m.width}x${m.height} ${m.duration.toFixed(2)}s audio=${m.hasAudio} frames=${m.filmstrip.length} peaks=${m.peaks ? m.peaks.length : 'null'}`);
    showThumb(m.thumb);
  }
  window.__pickImported = out.map((m) => ({ type: m.type, name: m.name, duration: m.duration }));
}
document.getElementById('pick').addEventListener('click', () => pickAndImport(media.ACCEPT_VISUAL));
document.getElementById('pickAudio').addEventListener('click', () => pickAndImport(media.ACCEPT_AUDIO));
window.__harnessReady = true;
