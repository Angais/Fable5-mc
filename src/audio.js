// ============================================================
// Audio — 100% synthesized with WebAudio (no sound assets).
// Filtered noise bursts tuned per material for digging,
// placing and footsteps, sine pings for glass, a deep boom
// for TNT, plus a gentle generative pentatonic music box that
// plays a soft phrase every so often (very C418-ish mood).
// ============================================================

import { BLOCKS } from './blocks.js';

const MATERIAL_PARAMS = {
  stone: { type: 'lowpass', freq: 760, q: 0.8, dur: 0.16, gain: 0.5 },
  dirt: { type: 'lowpass', freq: 360, q: 0.7, dur: 0.18, gain: 0.55 },
  grass: { type: 'lowpass', freq: 520, q: 0.6, dur: 0.16, gain: 0.5 },
  sand: { type: 'bandpass', freq: 1300, q: 0.6, dur: 0.14, gain: 0.4 },
  wood: { type: 'lowpass', freq: 620, q: 1.6, dur: 0.14, gain: 0.5 },
  glass: { type: 'highpass', freq: 2200, q: 1.0, dur: 0.22, gain: 0.4 },
  snow: { type: 'lowpass', freq: 900, q: 0.4, dur: 0.1, gain: 0.35 },
};

const NOTES = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33]; // C major pentatonic-ish

export class AudioFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.volume = 0.7;
    this.musicOn = true;
    this._noiseBuf = null;
    this._musicTimer = null;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.musicOn ? 1 : 0;
    this.musicGain.connect(this.master);

    const len = this.ctx.sampleRate;
    this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this._noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this._scheduleMusic(8 + Math.random() * 10);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  setMusicOn(on) {
    this.musicOn = on;
    if (this.musicGain) this.musicGain.gain.value = on ? 1 : 0;
  }

  // ----------------------------------------------------------
  // Noise-burst engine
  // ----------------------------------------------------------

  _noise({ type = 'lowpass', freq = 600, q = 0.8, dur = 0.15, gain = 0.5, rate = 1 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.playbackRate.value = rate * (0.9 + Math.random() * 0.2);
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq * (0.85 + Math.random() * 0.3);
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  _tone({ freq = 440, dur = 0.2, gain = 0.2, type = 'sine', attack = 0.005, dest = null }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(dest || this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  _materialOf(id) {
    return (BLOCKS[id] && MATERIAL_PARAMS[BLOCKS[id].sound]) || MATERIAL_PARAMS.stone;
  }

  // ----------------------------------------------------------
  // Game sounds
  // ----------------------------------------------------------

  blockBreak(id) {
    const p = this._materialOf(id);
    this._noise({ ...p });
    if (BLOCKS[id] && BLOCKS[id].sound === 'glass') {
      this._tone({ freq: 2600, dur: 0.12, gain: 0.1 });
      this._tone({ freq: 3400, dur: 0.09, gain: 0.07 });
    }
  }

  blockPlace(id) {
    const p = this._materialOf(id);
    this._noise({ ...p, dur: p.dur * 0.75, gain: p.gain * 0.8, freq: p.freq * 1.25 });
  }

  step(id) {
    const p = this._materialOf(id);
    this._noise({ ...p, dur: 0.07, gain: p.gain * 0.28, freq: p.freq * 1.2 });
  }

  land(impact) {
    this._noise({ type: 'lowpass', freq: 300, dur: 0.16, gain: Math.min(0.7, impact / 30) });
  }

  splash() {
    this._noise({ type: 'bandpass', freq: 900, q: 0.5, dur: 0.4, gain: 0.45 });
    this._noise({ type: 'highpass', freq: 2000, dur: 0.25, gain: 0.2 });
  }

  fuse() {
    this._noise({ type: 'highpass', freq: 3200, dur: 1.3, gain: 0.16 });
  }

  explosion() {
    if (!this.ctx) return;
    this._noise({ type: 'lowpass', freq: 130, q: 0.4, dur: 1.1, gain: 1.0 });
    this._noise({ type: 'lowpass', freq: 500, q: 0.4, dur: 0.35, gain: 0.5 });
    this._tone({ freq: 48, dur: 0.9, gain: 0.6, type: 'sine' });
  }

  click() {
    this._noise({ type: 'bandpass', freq: 1900, q: 2.5, dur: 0.05, gain: 0.35 });
  }

  pop() {
    this._tone({ freq: 820, dur: 0.06, gain: 0.12, type: 'square' });
  }

  // ----------------------------------------------------------
  // Generative ambient music
  // ----------------------------------------------------------

  _scheduleMusic(delaySec) {
    if (this._musicTimer) clearTimeout(this._musicTimer);
    this._musicTimer = setTimeout(() => {
      this._playPhrase();
      this._scheduleMusic(22 + Math.random() * 30);
    }, delaySec * 1000);
  }

  _playPhrase() {
    if (!this.ctx || !this.musicOn) return;
    const n = 3 + (Math.random() * 4) | 0;
    let when = 0;
    let last = (Math.random() * NOTES.length) | 0;
    for (let i = 0; i < n; i++) {
      // wander the scale instead of jumping randomly — sounds calmer
      last = Math.max(0, Math.min(NOTES.length - 1, last + ((Math.random() * 3) | 0) - 1));
      const freq = NOTES[last] * (Math.random() < 0.3 ? 0.5 : 1);
      const startIn = when;
      setTimeout(() => {
        this._tone({ freq, dur: 3.2, gain: 0.05, attack: 0.9, dest: this.musicGain });
        this._tone({ freq: freq * 2.003, dur: 2.6, gain: 0.018, attack: 1.1, dest: this.musicGain });
      }, startIn * 1000);
      when += 0.9 + Math.random() * 1.1;
    }
  }
}
