// engine/recorder.js — per-deck and mix recorders with an explicit state machine
// (idle → recording → finalizing → idle). WAV streams Int16 batches into Blob parts;
// WebM uses MediaRecorder with a timeslice. Errors always return the state to idle.
import { recordingFilename } from '../shared/protocol.js';

export const WAV_ROLL_BYTES = 4 * 1024 ** 3 - 64 * 1024 ** 2;

export function wavHeader(dataBytes, sampleRate, channels = 2, bits = 16) {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  const blockAlign = (channels * bits) / 8;
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bits, true);
  w(36, 'data');
  v.setUint32(40, dataBytes, true);
  return b;
}

export class WavStreamWriter {
  constructor(sampleRate, channels = 2) {
    this.sr = sampleRate;
    this.ch = channels;
    this.parts = [];
    this.bytes = 0;
    this.frames = 0;
  }
  push(int16, frames) {
    if (!frames) return;
    this.parts.push(new Blob([int16]));
    this.bytes += frames * this.ch * 2;
    this.frames += frames;
  }
  get seconds() { return this.frames / this.sr; }
  shouldRoll() { return this.bytes >= WAV_ROLL_BYTES; }
  finish() {
    const blob = new Blob([wavHeader(this.bytes, this.sr, this.ch), ...this.parts], { type: 'audio/wav' });
    this.parts = [];
    return blob;
  }
}

export function pickWebmMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export class Recorder {
  constructor(ctx, source, o) {
    this.ctx = ctx;
    this.source = source;
    this.o = o;
    this.state = 'idle';
    this.format = o.format;
    this.startedAt = 0;
    this.stoppedSeconds = 0;
    this.part = 1;
    this.node = null;
    this.writer = null;
    this.mr = null;
    this.dest = null;
  }

  get seconds() {
    return this.state === 'recording' ? this.ctx.currentTime - this.startedAt : this.stoppedSeconds;
  }

  filename(ext) {
    const title = this.part > 1 ? `${this.o.title()} part${this.part}` : this.o.title();
    return recordingFilename(this.o.who, title, ext, this.startDate);
  }

  start(format = this.format) {
    if (this.state !== 'idle') throw new Error('Already recording');
    this.format = format;
    this.startDate = new Date();
    this.part = 1;
    if (format === 'wav') {
      this.node = new AudioWorkletNode(this.ctx, 'jds-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit',
      });
      this.writer = new WavStreamWriter(this.ctx.sampleRate);
      this.node.port.onmessage = (e) => this.onData(e.data);
      this.source.connect(this.node);
      this.node.connect(this.o.sink);
      this.node.port.postMessage({ t: 'start' });
    } else {
      const mime = pickWebmMime();
      this.dest = this.ctx.createMediaStreamDestination();
      this.source.connect(this.dest);
      const chunks = [];
      this.mr = new MediaRecorder(this.dest.stream, mime ? { mimeType: mime } : undefined);
      this.mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      this.mr.onerror = (e) => this.fail(`Recording failed: ${e.error ? e.error.message : 'MediaRecorder error'}`);
      this.mr.onstop = () => this.finalize(() => this.deliver(new Blob(chunks, { type: mime || 'audio/webm' }), 'webm'));
      this.mr.start(1000);
    }
    this.startedAt = this.ctx.currentTime;
    this.state = 'recording';
    this.o.onChange();
  }

  stop() {
    if (this.state !== 'recording') return;
    this.stoppedSeconds = this.ctx.currentTime - this.startedAt;
    this.state = 'finalizing';
    this.o.onChange();
    if (this.format === 'wav') this.node.port.postMessage({ t: 'stop' });
    else if (this.mr && this.mr.state !== 'inactive') this.mr.stop();
    else this.finalize(() => {});
  }

  onData(m) {
    if (!m || m.t !== 'data' || !this.writer) return;
    try {
      this.writer.push(m.buf, m.frames);
      if (!m.final && this.writer.shouldRoll()) {
        this.deliver(this.writer.finish(), 'wav');
        this.writer = new WavStreamWriter(this.ctx.sampleRate);
        this.part++;
      }
    } catch (err) {
      this.fail(`Recording failed: ${err.message}`);
      return;
    }
    if (m.final) this.finalize(() => this.deliver(this.writer.finish(), 'wav'));
  }

  deliver(blob, ext) { this.o.deliver(blob, this.filename(ext)); }

  finalize(fn) {
    try {
      fn();
    } catch (err) {
      this.o.onError(`Saving the recording failed: ${err.message}`);
    } finally {
      this.teardown();
      this.state = 'idle';
      this.o.onChange();
    }
  }

  fail(msg) {
    this.o.onError(msg);
    this.teardown();
    this.state = 'idle';
    this.o.onChange();
  }

  teardown() {
    if (this.node) {
      try { this.source.disconnect(this.node); } catch (_) {}
      try { this.node.disconnect(); } catch (_) {}
      this.node.port.onmessage = null;
      this.node.port.postMessage({ t: 'dispose' }); // else Chrome keeps running the disconnected processor
      this.node.port.close();
      this.node = null;
    }
    if (this.dest) {
      try { this.source.disconnect(this.dest); } catch (_) {}
      this.dest = null;
    }
    this.mr = null;
    this.writer = null;
  }

  dispose() {
    if (this.state === 'recording') this.stop();
    else if (this.state === 'idle') this.teardown();
  }
}
