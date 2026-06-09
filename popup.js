// popup.js — UI. Talks only to the background hub.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage({ target: 'hub', ...msg });

const capturedEl = $('captured');
const availableEl = $('available');
const capCountEl = $('capCount');
const statusEl = $('status');
const engineMetaEl = $('engineMeta');

let availableTabs = [];
let capturedIds = new Set();
let recordFormat = 'wav'; // 'wav' | 'webm'

function gainToDb(g) {
  if (g <= 0.0001) return '-∞';
  return (20 * Math.log10(g)).toFixed(1);
}
function levelToDb(rms) {
  if (rms <= 0.00001) return '-∞';
  return Math.max(-60, 20 * Math.log10(rms)).toFixed(0);
}
function status(msg) {
  statusEl.textContent = msg;
}

// ---------------------------------------------------------------------------
// Available tab list
// ---------------------------------------------------------------------------
async function loadTabs() {
  const res = await send({ type: 'LIST_TABS' });
  if (!res || !res.ok) { status('Could not list tabs.'); return; }
  availableTabs = res.tabs;
  renderAvailable();
}

function renderAvailable() {
  availableEl.innerHTML = '';
  const free = availableTabs.filter((t) => !capturedIds.has(t.id));
  if (!free.length) {
    availableEl.innerHTML = '<div class="empty">No other capturable tabs.</div>';
    return;
  }
  for (const t of free) {
    const row = document.createElement('div');
    row.className = 'avrow';
    row.innerHTML = `
      <img class="fav" src="${t.favIconUrl || ''}" onerror="this.style.visibility='hidden'"/>
      <span class="title" title="${escapeAttr(t.title)}">${escapeHtml(t.title)}</span>
      ${t.audible ? '<span class="audible">♪</span>' : ''}
      <button data-add="${t.id}">+ Capture</button>`;
    availableEl.appendChild(row);
  }
  availableEl.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.add);
      btn.disabled = true;
      status('Starting capture…');
      const res = await send({ type: 'START', tabId: id });
      if (res && res.ok) {
        capturedIds.add(id);
        status('Capturing.');
        renderAvailable();
      } else {
        btn.disabled = false;
        status('Failed: ' + (res && res.error ? res.error : 'unknown'));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Captured cards — created once, then updated in place by the poll loop
// ---------------------------------------------------------------------------
const cardEls = new Map(); // tabId -> { root, fill, peak, db, gain, gainval, mon, rec }

function ensureCard(id, t) {
  if (cardEls.has(id)) return cardEls.get(id);
  const root = document.createElement('div');
  root.className = 'card';
  root.innerHTML = `
    <div class="row">
      <img class="fav" src="${t.favIconUrl || ''}" onerror="this.style.visibility='hidden'"/>
      <span class="title" title="${escapeAttr(t.title)}">${escapeHtml(t.title)}</span>
      <span class="dbreadout" data-db>-∞ dB</span>
      <button class="iconbtn" data-stop title="Stop capturing this tab">✕</button>
    </div>
    <canvas class="viz" data-viz width="700" height="96"></canvas>
    <div class="meter"><div class="fill" data-fill></div><div class="peak" data-peak></div></div>
    <div class="controls">
      <button class="iconbtn on" data-mon title="Monitor (hear this tab)">🔊</button>
      <input type="range" min="0" max="2" step="0.01" value="1" data-gain />
      <span class="gainval" data-gainval>0.0</span>
      <button class="iconbtn" data-rec title="Record this tab to a file">●</button>
    </div>`;
  capturedEl.appendChild(root);

  const canvas = root.querySelector('[data-viz]');
  const refs = {
    root,
    canvas,
    cctx: canvas.getContext('2d'),
    fill: root.querySelector('[data-fill]'),
    peak: root.querySelector('[data-peak]'),
    db: root.querySelector('[data-db]'),
    gain: root.querySelector('[data-gain]'),
    gainval: root.querySelector('[data-gainval]'),
    mon: root.querySelector('[data-mon]'),
    rec: root.querySelector('[data-rec]')
  };

  root.querySelector('[data-stop]').addEventListener('click', async () => {
    await send({ type: 'STOP', tabId: id });
    capturedIds.delete(id);
    removeCard(id);
    renderAvailable();
    status('Stopped tab.');
  });
  refs.gain.addEventListener('input', () => {
    const g = Number(refs.gain.value);
    refs.gainval.textContent = gainToDb(g) + (g > 0 ? '' : '');
    send({ type: 'SET_GAIN', tabId: id, gain: g });
  });
  refs.mon.addEventListener('click', () => {
    const on = !refs.mon.classList.contains('on');
    refs.mon.classList.toggle('on', on);
    refs.mon.textContent = on ? '🔊' : '🔇';
    send({ type: 'SET_MONITOR', tabId: id, monitor: on });
  });
  refs.rec.addEventListener('click', () => {
    const recording = refs.rec.classList.contains('recon');
    if (recording) {
      send({ type: 'RECORD_STOP', tabId: id });
      status(`Saving ${recordFormat.toUpperCase()}…`);
    } else {
      send({ type: 'RECORD_START', tabId: id, format: recordFormat });
      status(`Recording ${recordFormat.toUpperCase()}…`);
    }
  });

  cardEls.set(id, refs);
  return refs;
}

function removeCard(id) {
  const refs = cardEls.get(id);
  if (refs) refs.root.remove();
  cardEls.delete(id);
}

function updateCard(id, s) {
  const refs = cardEls.get(id);
  if (!refs) return;
  const pct = Math.min(100, s.level * 140); // RMS scaled for visibility
  refs.fill.style.width = pct + '%';
  refs.peak.style.left = Math.min(100, s.peak * 100) + '%';
  refs.db.textContent = levelToDb(s.level) + ' dB';
  refs.root.classList.toggle('clip', !!s.clip);
  // Reflect engine truth without stomping a slider the user is dragging.
  if (document.activeElement !== refs.gain) {
    refs.gain.value = s.gain;
    refs.gainval.textContent = gainToDb(s.gain);
  }
  refs.mon.classList.toggle('on', s.monitor);
  refs.mon.textContent = s.monitor ? '🔊' : '🔇';
  refs.rec.classList.toggle('recon', s.recording);
  drawViz(refs, s);
}

// Draw spectrum bars + waveform overlay onto a card's canvas.
function drawViz(refs, s) {
  const c = refs.cctx;
  if (!c) return;
  const W = refs.canvas.width;
  const H = refs.canvas.height;
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#0a0c10';
  c.fillRect(0, 0, W, H);

  // Spectrum bars
  const spec = s.spec || [];
  if (spec.length) {
    const bw = W / spec.length;
    for (let i = 0; i < spec.length; i++) {
      const v = spec[i] / 255;
      const h = v * H;
      const hue = 145 - v * 145; // green -> red as it gets loud
      c.fillStyle = `hsl(${hue}, 80%, ${30 + v * 25}%)`;
      c.fillRect(i * bw + 0.5, H - h, bw - 1, h);
    }
  }

  // Waveform overlay
  const wave = s.wave || [];
  if (wave.length) {
    c.lineWidth = 2;
    c.strokeStyle = s.clip ? '#f43f5e' : 'rgba(231,234,240,0.92)';
    c.beginPath();
    const step = W / (wave.length - 1);
    for (let i = 0; i < wave.length; i++) {
      const y = H / 2 - ((wave[i] - 128) / 128) * (H / 2) * 0.92;
      const x = i * step;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }
}

// ---------------------------------------------------------------------------
// Poll engine state
// ---------------------------------------------------------------------------
async function poll() {
  const res = await send({ type: 'GET_STATE' });
  if (res && res.ok && res.state) {
    const st = res.state;
    const ids = Object.keys(st.tabs).map(Number);
    capturedIds = new Set(ids);

    // Remove cards for tabs that vanished.
    for (const id of [...cardEls.keys()]) {
      if (!st.tabs[id]) { removeCard(id); }
    }
    // Create/update.
    for (const id of ids) {
      ensureCard(id, st.tabs[id]);
      updateCard(id, st.tabs[id]);
    }
    capCountEl.textContent = ids.length;
    if (!ids.length) {
      capturedEl.innerHTML = '<div class="empty">Nothing captured yet. Add a tab below.</div>';
      cardEls.clear();
    } else if (capturedEl.querySelector('.empty')) {
      capturedEl.querySelector('.empty').remove();
    }

    const sr = st.sampleRate ? (st.sampleRate / 1000).toFixed(1) + ' kHz' : '—';
    engineMetaEl.textContent = `${st.audioContextState} · ${sr}${st.mixRecording ? ' · ● MIX' : ''}`;
    $('mixRecBtn').classList.toggle('active', !!st.mixRecording);
  }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
$('refreshBtn').addEventListener('click', loadTabs);
$('formatBtn').addEventListener('click', () => {
  recordFormat = recordFormat === 'wav' ? 'webm' : 'wav';
  $('formatBtn').textContent = recordFormat.toUpperCase();
  status(`Recording format: ${recordFormat.toUpperCase()}`);
});
$('stopAllBtn').addEventListener('click', async () => {
  await send({ type: 'STOP_ALL' });
  for (const id of [...cardEls.keys()]) removeCard(id);
  capturedIds.clear();
  status('Stopped all.');
  loadTabs();
});
$('mixRecBtn').addEventListener('click', async () => {
  const active = $('mixRecBtn').classList.contains('active');
  if (active) {
    await send({ type: 'RECORD_MIX_STOP' });
    status(`Saving mix ${recordFormat.toUpperCase()}…`);
  } else {
    await send({ type: 'RECORD_MIX_START', format: recordFormat });
    status(`Recording mix ${recordFormat.toUpperCase()}…`);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

// Boot
$('formatBtn').textContent = recordFormat.toUpperCase();
loadTabs();
setInterval(poll, 50); // ~20fps visuals
poll();
