// audio.ts — fully synthesized WebAudio sound: UI feedback, alerts, ambience.
// Zero asset files (stays a single-file build). Safe under Node/headless: every
// entry point no-ops until a real AudioContext exists and the user has gestured.

import type { GameEvent } from './types';
import { MusicDirector, type MusicScene } from './music';
import { AmbienceDirector } from './ambience';

/** Per-frame snapshot of everything the adaptive layers react to. */
export interface AudioDynamics {
  scene: 'menu' | 'game';
  intensity: number; // 0..1 gameplay pressure, drives music layers
  planeCount: number;
  alertLevel: 0 | 1 | 2;
  ducked: boolean; // paused: pull music down, muffle ambience
}

type Ctor = typeof AudioContext;

function loadVolume(key: string): number {
  try {
    const v = globalThis.localStorage?.getItem(key);
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
    }
  } catch { /* ignore */ }
  return 1.0;
}

function getCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGroup: GainNode | null = null; // music volume slider
  private sfxGroup: GainNode | null = null; // sfx/ambience volume slider
  private sfxBus: GainNode | null = null;
  private reverbIn: GainNode | null = null; // send this much of a sound into the shared reverb
  private alarmGain: GainNode | null = null; // looping conflict klaxon level
  private alarmOsc: OscillatorNode | null = null;
  private lastPing = 0;
  private music = new MusicDirector();
  private ambience = new AmbienceDirector();
  muted: boolean;
  private volume: number; // 0.0–1.0 master volume
  private musicVolume: number;
  private sfxVolume: number;

  constructor(muted = false) {
    this.muted = muted;
    this.volume = loadVolume('fa.volume');
    this.musicVolume = loadVolume('fa.musicVolume');
    this.sfxVolume = loadVolume('fa.sfxVolume');
  }

  /** Call from a user gesture. Creates/resumes the context and ambience. */
  unlock(): void {
    const Ctor = getCtor();
    if (!Ctor) return;
    if (!this.ctx) {
      try {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.master.connect(this.ctx.destination);
        this.musicGroup = this.ctx.createGain();
        this.musicGroup.gain.value = this.musicVolume;
        this.musicGroup.connect(this.master);
        this.sfxGroup = this.ctx.createGain();
        this.sfxGroup.gain.value = this.sfxVolume;
        this.sfxGroup.connect(this.master);
        this.sfxBus = this.ctx.createGain();
        this.sfxBus.connect(this.sfxGroup);
        this.buildReverb();
        this.startAlarmLoop();
        this.music.attach(this.ctx, this.musicGroup);
        this.ambience.attach(this.ctx, this.sfxGroup);
      } catch {
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private applyGain(): void {
    if (this.ctx && this.master) {
      const target = this.muted ? 0 : this.volume;
      this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyGain();
  }
  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Set master volume (0.0–1.0) and persist. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyGain();
    try { globalThis.localStorage?.setItem('fa.volume', String(this.volume)); } catch { /* ignore */ }
  }

  /** Get current master volume (0.0–1.0). */
  getVolume(): number {
    return this.volume;
  }

  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.ctx && this.musicGroup) this.musicGroup.gain.setTargetAtTime(this.musicVolume, this.ctx.currentTime, 0.02);
    try { globalThis.localStorage?.setItem('fa.musicVolume', String(this.musicVolume)); } catch { /* ignore */ }
  }
  getMusicVolume(): number {
    return this.musicVolume;
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.ctx && this.sfxGroup) this.sfxGroup.gain.setTargetAtTime(this.sfxVolume, this.ctx.currentTime, 0.02);
    try { globalThis.localStorage?.setItem('fa.sfxVolume', String(this.sfxVolume)); } catch { /* ignore */ }
  }
  getSfxVolume(): number {
    return this.sfxVolume;
  }

  // --- building blocks -------------------------------------------------------

  /** Shared reverb: exponentially-decaying noise impulse response, small hall feel. */
  private buildReverb(): void {
    if (!this.ctx || !this.master) return;
    const sr = this.ctx.sampleRate;
    const dur = 0.8;
    const len = Math.floor(sr * dur);
    const ir = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
      }
    }
    const conv = this.ctx.createConvolver();
    conv.buffer = ir;
    this.reverbIn = this.ctx.createGain();
    this.reverbIn.gain.value = 1;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.5;
    this.reverbIn.connect(conv).connect(wet).connect(this.sfxGroup ?? this.master);
  }

  /** Route an already-enveloped node to the SFX bus, with optional reverb send. */
  private out(g: GainNode, reverb: number): void {
    g.connect(this.sfxBus ?? this.master!);
    if (reverb > 0 && this.reverbIn && this.ctx) {
      const send = this.ctx.createGain();
      send.gain.value = reverb;
      g.connect(send).connect(this.reverbIn);
    }
  }

  private tone(freq: number, type: OscillatorType, gain: number, dur: number, delay = 0, slideTo?: number, reverb = 0): void {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    this.out(g, reverb);
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    o.connect(g);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private noise(gain: number, dur: number, filterFreq: number, delay = 0, slideTo?: number, reverb = 0): void {
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
    src.connect(f).connect(g);
    this.out(g, reverb);
    src.start(t0);
  }

  /** Looping conflict klaxon whose level is driven per-frame via setDynamics. */
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
    o.connect(g).connect(this.sfxGroup ?? this.master);
    o.start();
    lfo.start();
    this.alarmOsc = o;
    this.alarmGain = g;
  }

  /** Per-frame driver for every adaptive layer: klaxon, music, ambience. */
  setDynamics(d: AudioDynamics, dt: number): void {
    if (!this.ctx) return;
    // klaxon / amber ping (0 = calm, 1 = predicted conflict, 2 = active)
    if (this.alarmGain && this.alarmOsc) {
      const t = this.ctx.currentTime;
      this.alarmGain.gain.setTargetAtTime(d.alertLevel === 2 ? 0.05 : 0, t, 0.05);
      if (d.alertLevel === 1 && t - this.lastPing > 1.15) {
        this.lastPing = t;
        this.tone(880, 'sine', 0.045, 0.16);
      }
    }
    const musicScene: MusicScene = d.scene;
    this.music.update(musicScene, d.intensity, d.ducked, dt);
    this.ambience.setDynamics({ scene: d.scene, planeCount: d.planeCount, alertLevel: d.alertLevel, ducked: d.ducked });
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
        // tire screech + touchdown thump + cash chime that rises with the streak
        this.noise(0.05, 0.12, 3600, 0, 1200);
        this.noise(0.1, 0.24, 300, 0.05, 90, 0.35);
        const base = 660 * Math.pow(1.0595, Math.min(12, e.streak)); // up a semitone per streak
        this.tone(base, 'sine', 0.07, 0.14, 0.12, undefined, 0.2);
        this.tone(base * 1.5, 'sine', 0.06, 0.18, 0.2, undefined, 0.2);
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
      case 'corridorBusy':
        this.tone(280, 'sawtooth', 0.08, 0.12);
        break;
      case 'nearMiss':
        this.tone(300, 'sawtooth', 0.07, 0.12);
        this.tone(300, 'sawtooth', 0.07, 0.12, 0.16);
        break;
      case 'divert':
        this.tone(360, 'triangle', 0.06, 0.22, 0, 200);
        break;
      case 'crash':
        this.noise(0.2, 0.03, 6000); // initial transient crack
        this.noise(0.32, 1.1, 900, 0.02, 60, 0.8);
        this.tone(70, 'sine', 0.22, 0.9, 0.02, 30);
        this.noise(0.06, 0.2, 1600, 0.5, 500, 0.6); // debris
        this.noise(0.05, 0.18, 1300, 0.85, 400, 0.6);
        this.noise(0.04, 0.25, 900, 1.25, 250, 0.6);
        this.duckMusic(2.2);
        break;
      case 'groundCrash':
        this.noise(0.22, 0.03, 6000);
        this.noise(0.35, 1.3, 600, 0.02, 40, 0.8);
        this.tone(55, 'sine', 0.25, 1.1, 0.02, 25);
        this.noise(0.15, 0.5, 1200, 0.3, undefined, 0.6);
        this.noise(0.06, 0.22, 1500, 0.75, 450, 0.6); // debris
        this.noise(0.05, 0.28, 1000, 1.15, 300, 0.6);
        this.duckMusic(2.4);
        break;
      case 'crossRunway':
        this.tone(660, 'triangle', 0.04, 0.08);
        this.tone(440, 'triangle', 0.04, 0.08, 0.09);
        break;
      case 'takeoffClearance': // radio squelch + rising "cleared for takeoff" confirm
        this.noise(0.025, 0.06, 3000);
        this.tone(520, 'square', 0.045, 0.07, 0.05);
        this.tone(780, 'square', 0.05, 0.09, 0.13);
        break;
      case 'lineUp': // quiet low double-blip acknowledgment
        this.tone(330, 'triangle', 0.045, 0.06);
        this.tone(330, 'triangle', 0.045, 0.06, 0.09);
        break;
      case 'manualHold': // ground hold/release: short dull slide, duller than air hold
        if (e.hold) this.tone(460, 'triangle', 0.045, 0.07, 0, 300);
        else this.tone(300, 'triangle', 0.045, 0.07, 0, 460);
        break;
      case 'purchase':
        this.tone(523, 'sine', 0.06, 0.12, 0, undefined, 0.25);
        this.tone(659, 'sine', 0.06, 0.12, 0.1, undefined, 0.25);
        this.tone(784, 'sine', 0.07, 0.18, 0.2, undefined, 0.25);
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
        this.tone(523, 'sine', 0.07, 0.16, 0, undefined, 0.3);
        this.tone(659, 'sine', 0.07, 0.16, 0.15, undefined, 0.3);
        this.tone(784, 'sine', 0.07, 0.16, 0.3, undefined, 0.3);
        this.tone(1047, 'sine', 0.08, 0.4, 0.45, undefined, 0.4);
        break;
      case 'fired':
        this.tone(220, 'sawtooth', 0.09, 0.5, 0, 110);
        this.tone(165, 'sawtooth', 0.09, 0.7, 0.4, 82);
        break;
    }
  }

  /** Momentarily pull the music down so a big impact reads clearly. */
  private duckMusic(seconds: number): void {
    this.music.pulseDuck(seconds);
  }

  /** Small UI blip for selecting a plane / pressing a button. */
  uiClick(): void {
    this.tone(980, 'sine', 0.035, 0.05);
  }
}
