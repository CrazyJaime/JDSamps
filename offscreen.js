// offscreen.js — the audio engine.
//
// One offscreen document handles ALL captured tabs at once, each in its own
// isolated Web Audio graph so the tab audios stay fully separated.
//
// Per-tab graph:
//
//   MediaStreamSource ─► Gain ─┬─► Analyser            (metering + visualizer)
//                              ├─► MonitorGain ─► out  (so the tab stays audible)
//                              ├─► MediaStreamDest ─► MediaRecorder   (WebM/Opus)
//                              ├─► rec-worklet ─► silent sink         (WAV/PCM)
//                              └─► Mix bus              (combined recording)

const ctx = new AudioContext();

// Load the PCM-capture worklet once; startTab awaits this.
const workletReady = ctx.audioWorklet
  .addModule('recorder-worklet.js')
  .then(() => true)
  .catch((e) => { console.error('worklet load failed', e); return false; });

// A muted sink keeps worklet nodes alive in the render graph.
const silentSink = ctx.createGain();
silentSink.gain.value = 0;
silentSink.connect(ctx.destination);

// tabId -> per-tab state
const tabs = new Map();

// Master mix bus for the combined recording.
const mixBus = ctx.createGain();
const mixDest = ctx.createMediaStreamDestination();
mixBus.connect(mixDest);
let mixRecorder = null;
let mixChunks = [];
let mixRecording = false;
let mixFormat = 'webm';
let mixWavChunks = [];
let mixRecNode = null;

const FFT_SIZE = 2048;
const WAVE_POINTS = 72;
const SPEC_BINS = 56;

function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}
const MIME = pickMime();

function safeName(s) {
  return (s || 'tab').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60);
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// WAV (PCM 16-bit stereo) encoding
// ---------------------------------------------------------------------------
function encodeWAV(chunks, sampleRate) {
  let length = 0;
  for (const c of chunks) length += c[0].length;
  const numCh = 2;
  const bytesPerSample = 2;
  const dataBytes = length * numCh * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * bytesPerSample, true);
  view.setUint16(32, numCh * bytesPerSample, true);
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  let off = 44;
  for (const [l, r] of chunks) {
    for (let i = 0; i < l.length; i++) {
      let sl = Math.max(-1, Math.min(1, l[i]));
      view.setInt16(off, sl < 0 ? sl * 0x8000 : sl * 0x7fff, true); off += 2;
      let sr = Math.max(-1, Math.min(1, r[i]));
      view.setInt16(off, sr < 0 ? sr * 0x8000 : sr * 0x7fff, true); off += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------
async function startTab(tabId, streamId, meta) {
  if (tabs.has(tabId)) return;
  if (ctx.state === 'suspended') await ctx.resume();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });

  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = 1;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.6;

  const monitorGain = ctx.createGain();
  monitorGain.gain.value = 1;

  const recDest = ctx.createMediaStreamDestination();

  source.connect(gain);
  gain.connect(analyser);
  gain.connect(monitorGain);
  monitorGain.connect(ctx.destination);
  gain.connect(recDest);
  gain.connect(mixBus);

  const t = {
    stream, source, gain, analyser, monitorGain, recDest,
    recorder: null, recChunks: [],
    recNode: null, wavChunks: [], recFormat: 'webm',
    meta: meta || {}, monitor: true, recording: false,
    level: 0, peak: 0, clip: false,
    timeBuf: new Uint8Array(analyser.fftSize),
    freqBuf: new Uint8Array(analyser.frequencyBinCount),
    floatBuf: new Float32Array(analyser.fftSize),
    wave: new Array(WAVE_POINTS).fill(128),
    spec: new Array(SPEC_BINS).fill(0)
  };

  // PCM worklet tap for WAV recording.
  if (await workletReady) {
    const recNode = new AudioWorkletNode(ctx, 'rec-processor', { numberOfOutputs: 1, outputChannelCount: [2] });
    gain.connect(recNode);
    recNode.connect(silentSink);
    recNode.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'data') {
        if (t.recording && t.recFormat === 'wav') t.wavChunks.push(...d.chunks);
        if (d.final && t.recFormat === 'wav') {
          const blob = encodeWAV(t.wavChunks, ctx.sampleRate);
          deliver(blob, `${safeName(t.meta.title)}-${stamp()}.wav`);
          t.wavChunks = [];
          t.recording = false;
        }
      }
    };
    t.recNode = recNode;
  }

  tabs.set(tabId, t);

  stream.getAudioTracks().forEach((tr) => tr.addEventListener('ended', () => stopTab(tabId)));
}

function stopTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  try { if (t.recorder && t.recorder.state !== 'inactive') t.recorder.stop(); } catch (_) {}
  try { if (t.recNode) t.recNode.port.postMessage({ type: 'stop' }); } catch (_) {}
  try { t.stream.getTracks().forEach((tr) => tr.stop()); } catch (_) {}
  try {
    t.source.disconnect(); t.gain.disconnect(); t.monitorGain.disconnect();
    if (t.recNode) t.recNode.disconnect();
  } catch (_) {}
  tabs.delete(tabId);
}

function stopAll() {
  for (const id of [...tabs.keys()]) stopTab(id);
  if (mixRecording) stopMixRecording();
}

function setGain(tabId, value) {
  const t = tabs.get(tabId);
  if (t) t.gain.gain.value = Math.max(0, value);
}
function setMonitor(tabId, on) {
  const t = tabs.get(tabId);
  if (!t) return;
  t.monitor = !!on;
  t.monitorGain.gain.value = on ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Per-tab recording
// ---------------------------------------------------------------------------
function startRecording(tabId, format) {
  const t = tabs.get(tabId);
  if (!t || t.recording) return;
  t.recFormat = format === 'wav' ? 'wav' : 'webm';

  if (t.recFormat === 'wav') {
    if (!t.recNode) return; // worklet unavailable
    t.wavChunks = [];
    t.recording = true;
    t.recNode.port.postMessage({ type: 'arm' });
  } else {
    t.recChunks = [];
    const rec = new MediaRecorder(t.recDest.stream, MIME ? { mimeType: MIME } : undefined);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) t.recChunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(t.recChunks, { type: MIME || 'audio/webm' });
      deliver(blob, `${safeName(t.meta.title)}-${stamp()}.webm`);
      t.recChunks = [];
    };
    rec.start();
    t.recorder = rec;
    t.recording = true;
  }
}

function stopRecording(tabId) {
  const t = tabs.get(tabId);
  if (!t || !t.recording) return;
  if (t.recFormat === 'wav') {
    t.recNode.port.postMessage({ type: 'stop' }); // worklet flushes -> onmessage encodes
  } else if (t.recorder && t.recorder.state !== 'inactive') {
    t.recorder.stop();
    t.recording = false;
  }
}

// ---------------------------------------------------------------------------
// Combined-mix recording
// ---------------------------------------------------------------------------
function startMixRecording(format) {
  if (mixRecording) return;
  mixFormat = format === 'wav' ? 'wav' : 'webm';

  if (mixFormat === 'wav') {
    if (!mixRecNode) return;
    mixWavChunks = [];
    mixRecording = true;
    mixRecNode.port.postMessage({ type: 'arm' });
  } else {
    mixChunks = [];
    mixRecorder = new MediaRecorder(mixDest.stream, MIME ? { mimeType: MIME } : undefined);
    mixRecorder.ondataavailable = (e) => { if (e.data && e.data.size) mixChunks.push(e.data); };
    mixRecorder.onstop = () => {
      const blob = new Blob(mixChunks, { type: MIME || 'audio/webm' });
      deliver(blob, `mix-${stamp()}.webm`);
      mixChunks = [];
    };
    mixRecorder.start();
    mixRecording = true;
  }
}

function stopMixRecording() {
  if (!mixRecording) return;
  if (mixFormat === 'wav') {
    if (mixRecNode) mixRecNode.port.postMessage({ type: 'stop' });
  } else if (mixRecorder && mixRecorder.state !== 'inactive') {
    mixRecorder.stop();
    mixRecording = false;
  }
}

// Set up the mix-bus PCM tap once the worklet is ready.
workletReady.then((ok) => {
  if (!ok) return;
  mixRecNode = new AudioWorkletNode(ctx, 'rec-processor', { numberOfOutputs: 1, outputChannelCount: [2] });
  mixBus.connect(mixRecNode);
  mixRecNode.connect(silentSink);
  mixRecNode.port.onmessage = (e) => {
    const d = e.data;
    if (d && d.type === 'data') {
      if (mixRecording && mixFormat === 'wav') mixWavChunks.push(...d.chunks);
      if (d.final && mixFormat === 'wav') {
        const blob = encodeWAV(mixWavChunks, ctx.sampleRate);
        deliver(blob, `mix-${stamp()}.wav`);
        mixWavChunks = [];
        mixRecording = false;
      }
    }
  };
});

function deliver(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.runtime.sendMessage({ target: 'background', type: 'DOWNLOAD', url, filename });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------------------
// Metering + visualizer data, pushed to the worker ~25fps
// ---------------------------------------------------------------------------
setInterval(() => {
  for (const t of tabs.values()) {
    // Level (RMS + peak) from float time-domain data.
    t.analyser.getFloatTimeDomainData(t.floatBuf);
    let sum = 0, peak = 0;
    for (let i = 0; i < t.floatBuf.length; i++) {
      const v = t.floatBuf[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    t.level = Math.sqrt(sum / t.floatBuf.length);
    t.peak = peak;
    if (peak >= 0.999) t.clip = true;

    // Waveform (byte time domain, downsampled to WAVE_POINTS).
    t.analyser.getByteTimeDomainData(t.timeBuf);
    const stepW = Math.floor(t.timeBuf.length / WAVE_POINTS);
    for (let i = 0; i < WAVE_POINTS; i++) t.wave[i] = t.timeBuf[i * stepW];

    // Spectrum (byte frequency, averaged into SPEC_BINS over the lower range).
    t.analyser.getByteFrequencyData(t.freqBuf);
    const usable = Math.floor(t.freqBuf.length * 0.62); // emphasize audible band
    const stepS = Math.max(1, Math.floor(usable / SPEC_BINS));
    for (let i = 0; i < SPEC_BINS; i++) {
      let acc = 0;
      for (let j = 0; j < stepS; j++) acc += t.freqBuf[i * stepS + j] || 0;
      t.spec[i] = Math.round(acc / stepS);
    }
  }

  const snapshot = { tabs: {}, audioContextState: ctx.state, mixRecording, mixFormat, sampleRate: ctx.sampleRate };
  for (const [id, t] of tabs.entries()) {
    snapshot.tabs[id] = {
      title: t.meta.title || `Tab ${id}`,
      favIconUrl: t.meta.favIconUrl || '',
      level: t.level, peak: t.peak, clip: t.clip,
      gain: t.gain.gain.value, monitor: t.monitor,
      recording: t.recording, recFormat: t.recFormat,
      wave: t.wave, spec: t.spec
    };
  }
  chrome.runtime.sendMessage({ target: 'background', type: 'STATE_UPDATE', state: snapshot });
}, 40);

// ---------------------------------------------------------------------------
// Messages from the worker
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  (async () => {
    try {
      switch (msg.type) {
        case 'START': await startTab(msg.tabId, msg.streamId, msg.meta); break;
        case 'STOP': stopTab(msg.tabId); break;
        case 'STOP_ALL': stopAll(); break;
        case 'SET_GAIN': setGain(msg.tabId, msg.gain); break;
        case 'SET_MONITOR': setMonitor(msg.tabId, msg.monitor); break;
        case 'RECORD_START': startRecording(msg.tabId, msg.format); break;
        case 'RECORD_STOP': stopRecording(msg.tabId); break;
        case 'RECORD_MIX_START': startMixRecording(msg.format); break;
        case 'RECORD_MIX_STOP': stopMixRecording(); break;
      }
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});
