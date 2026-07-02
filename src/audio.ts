// audio.ts — fully synthesized WebAudio sound: UI feedback, alerts, ambience.
// Zero asset files (stays a single-file build). Safe under Node/headless: every
// entry point no-ops until a real AudioContext exists and the user has gestured.

import type { GameEvent } from './types';

type Ctor = typeof AudioContext;

function getCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private alarmGain: GainNode | null = null; // looping conflict klaxon level
  private alarmOsc: OscillatorNode | null = null;
  private lastPing = 0;
  muted: boolean;

  constructor(muted = false) {
    this.muted = muted;
  }

  /** Call from a user gesture. Creates/resumes the context and ambience. */
  unlock(): void {
    const Ctor = getCtor();
    if (!Ctor) return;
    if (!this.ctx) {
      try {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 1;
        this.master.connect(this.ctx.destination);
        this.startAmbient();
        this.startAlarmLoop();
      } catch {
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
    }
  }
  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // --- building blocks -------------------------------------------------------

  private tone(freq: number, type: OscillatorType, gain: number, dur: number, delay = 0, slideTo?: number): void {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    g.connect(this.master!);
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    o.connect(g);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private noise(gain: number, dur: number, filterFreq: number, delay = 0, slideTo?: number): void {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(filterFreq, t0);
    if (slideTo != null) f.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t0);
  }

  /** Quiet control-room floor: filtered noise hum, always on. */
  private startAmbient(): void {
    if (!this.ctx || !this.master) return;
    const dur = 4;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // brown-ish noise
      last = (last + (Math.random() * 2 - 1) * 0.02) * 0.998;
      data[i] = last * 3.5;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 240;
    const g = this.ctx.createGain();
    g.gain.value = 0.05;
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  /** Looping conflict klaxon whose level is driven per-frame by setAlertLevel. */
  private startAlarmLoop(): void {
    if (!this.ctx || !this.master) return;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 620;
    const lfo = this.ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 3.4;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain).connect(o.frequency);
    const g = this.ctx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(this.master);
    o.start();
    lfo.start();
    this.alarmOsc = o;
    this.alarmGain = g;
  }

  /** 0 = calm, 1 = predicted conflict (amber), 2 = active conflict (red). */
  setAlertLevel(level: 0 | 1 | 2): void {
    if (!this.ctx || !this.alarmGain || !this.alarmOsc) return;
    const t = this.ctx.currentTime;
    const target = level === 2 ? 0.05 : 0;
    this.alarmGain.gain.setTargetAtTime(target, t, 0.05);
    // amber: soft periodic ping instead of the klaxon
    if (level === 1 && t - this.lastPing > 1.15) {
      this.lastPing = t;
      this.tone(880, 'sine', 0.045, 0.16);
    }
  }

  // --- event router ----------------------------------------------------------

  onEvent(e: GameEvent): void {
    if (!this.ctx) return;
    switch (e.kind) {
      case 'assign': // radio "cleared to land" chirp
        this.tone(520, 'square', 0.05, 0.06);
        this.tone(760, 'square', 0.05, 0.08, 0.07);
        this.noise(0.02, 0.1, 2400, 0.02);
        break;
      case 'dispatch':
        this.tone(430, 'square', 0.05, 0.06);
        this.tone(620, 'square', 0.05, 0.08, 0.07);
        break;
      case 'hold':
        this.tone(500, 'triangle', 0.06, 0.1, 0, 340);
        break;
      case 'unhold':
        this.tone(340, 'triangle', 0.06, 0.1, 0, 500);
        break;
      case 'land': {
        // touchdown thump + cash chime that rises with the streak
        this.noise(0.09, 0.22, 300, 0, 90);
        const base = 660 * Math.pow(1.0595, Math.min(12, e.streak)); // up a semitone per streak
        this.tone(base, 'sine', 0.07, 0.14, 0.1);
        this.tone(base * 1.5, 'sine', 0.06, 0.18, 0.18);
        break;
      }
      case 'depart': {
        this.noise(0.06, 0.5, 900, 0, 2600); // spool-up whoosh
        const base = 550 * Math.pow(1.0595, Math.min(12, e.streak));
        this.tone(base, 'sine', 0.06, 0.14, 0.28);
        this.tone(base * 1.5, 'sine', 0.05, 0.18, 0.36);
        break;
      }
      case 'goAround':
        this.tone(420, 'sawtooth', 0.05, 0.16, 0, 260);
        break;
      case 'nearMiss':
        this.tone(300, 'sawtooth', 0.07, 0.12);
        this.tone(300, 'sawtooth', 0.07, 0.12, 0.16);
        break;
      case 'divert':
        this.tone(360, 'triangle', 0.06, 0.22, 0, 200);
        break;
      case 'crash':
        this.noise(0.32, 1.1, 900, 0, 60);
        this.tone(70, 'sine', 0.22, 0.9, 0, 30);
        break;
      case 'emergency': // mayday two-tone
        this.tone(720, 'square', 0.05, 0.12);
        this.tone(560, 'square', 0.05, 0.12, 0.14);
        this.tone(720, 'square', 0.05, 0.12, 0.28);
        break;
      case 'rush':
        this.tone(520, 'sine', 0.05, 0.1);
        this.tone(660, 'sine', 0.05, 0.1, 0.11);
        break;
      case 'finalRush':
        this.tone(440, 'square', 0.06, 0.11);
        this.tone(554, 'square', 0.06, 0.11, 0.12);
        this.tone(660, 'square', 0.07, 0.2, 0.24);
        break;
      case 'shiftEnd':
        this.tone(523, 'sine', 0.07, 0.16);
        this.tone(659, 'sine', 0.07, 0.16, 0.15);
        this.tone(784, 'sine', 0.07, 0.16, 0.3);
        this.tone(1047, 'sine', 0.08, 0.4, 0.45);
        break;
      case 'fired':
        this.tone(220, 'sawtooth', 0.09, 0.5, 0, 110);
        this.tone(165, 'sawtooth', 0.09, 0.7, 0.4, 82);
        break;
    }
  }

  /** Small UI blip for selecting a plane / pressing a button. */
  uiClick(): void {
    this.tone(980, 'sine', 0.035, 0.05);
  }
}
