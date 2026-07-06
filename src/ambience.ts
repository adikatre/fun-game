// ambience.ts — dynamic airport soundscape.
//
// Layers under the master gain: a generated room-tone bed (MP3 loop), an
// engine rumble that swells with the number of planes being worked, sparse
// randomized "distant activity" one-shots during gameplay, and a low tension
// drone that tracks the alert level. Headless-safe like music.ts.

import { AUDIO_CLIPS } from './assets/audio-data';

export interface AmbienceDynamics {
  scene: 'menu' | 'game';
  planeCount: number;
  alertLevel: 0 | 1 | 2;
  ducked: boolean;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export class AmbienceDirector {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private busFilter: BiquadFilterNode | null = null; // lowpassed while ducked (pause)
  private bedGain: GainNode | null = null;
  private rumbleGain: GainNode | null = null;
  private tensionGain: GainNode | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private inGame = false;

  attach(ctx: AudioContext, master: GainNode): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.busFilter = ctx.createBiquadFilter();
    this.busFilter.type = 'lowpass';
    this.busFilter.frequency.value = 20000;
    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(this.busFilter).connect(master);
    this.startRumble();
    this.startTension();
    void this.loadBed();
  }

  private async loadBed(): Promise<void> {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    try {
      const clip = AUDIO_CLIPS.ambienceBed;
      const buf = await ctx.decodeAudioData(base64ToArrayBuffer(clip.b64));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopEnd = Math.min(buf.duration, clip.dur);
      this.bedGain = ctx.createGain();
      this.bedGain.gain.value = 0;
      src.connect(this.bedGain).connect(bus);
      src.start();
      this.bedGain.gain.setTargetAtTime(0.09, ctx.currentTime, 2);
    } catch {
      // bed stays silent; procedural layers still run
    }
  }

  /** Engine rumble whose level tracks how many planes are in play. */
  private startRumble(): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    const dur = 3;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + (Math.random() * 2 - 1) * 0.02) * 0.998;
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 160;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    src.connect(f).connect(this.rumbleGain).connect(bus);
    src.start();
  }

  /** Low pulsing drone that brews under the amber/red alerts. */
  private startTension(): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 92;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = 97; // beats against o at ~5 Hz for unease
    this.tensionGain = ctx.createGain();
    this.tensionGain.gain.value = 0;
    o.connect(this.tensionGain);
    o2.connect(this.tensionGain);
    this.tensionGain.connect(bus);
    o.start();
    o2.start();
  }

  /** Per-frame driver. */
  setDynamics(d: AmbienceDynamics): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const game = d.scene === 'game' && !d.ducked;
    // rumble swells with traffic (slow, so spawns/landings feel organic)
    const rumble = game ? Math.min(0.12, 0.015 * d.planeCount) : 0;
    this.rumbleGain?.gain.setTargetAtTime(rumble, t, 1.5);
    // tension: fast attack, slow release
    const tension = game ? (d.alertLevel === 2 ? 0.05 : d.alertLevel === 1 ? 0.022 : 0) : 0;
    const cur = this.tensionGain?.gain.value ?? 0;
    this.tensionGain?.gain.setTargetAtTime(tension, t, tension > cur ? 0.15 : 1.2);
    // pause/duck muffles the whole ambience
    this.busFilter?.frequency.setTargetAtTime(d.ducked ? 500 : 20000, t, 0.15);
    // distant-activity scheduler runs only during gameplay
    if (game && !this.inGame) this.scheduleActivity();
    if (!game && this.inGame && this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
    this.inGame = game;
  }

  private scheduleActivity(): void {
    const delay = 6000 + Math.random() * 12000;
    this.activityTimer = setTimeout(() => {
      if (this.inGame) this.playActivity();
      if (this.inGame) this.scheduleActivity();
    }, delay);
  }

  /** One faint faraway event: jet whoosh, radio squelch, or reverse thrust. */
  private playActivity(): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    const pick = Math.floor(Math.random() * 3);
    if (pick === 0) this.distantNoise(0.035, 3.2, 500, 1400, 300); // passing jet
    else if (pick === 1) {
      this.distantNoise(0.02, 0.05, 2800, 3200, 2800); // radio squelch double-click
      this.distantNoise(0.018, 0.04, 2600, 3000, 2600, 0.09);
    } else this.distantNoise(0.04, 2.2, 700, 250, 180); // reverse-thrust roar
  }

  private distantNoise(gain: number, dur: number, f0: number, fMid: number, f1: number, delay = 0): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, fMid), t0 + dur * 0.4);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(t0);
  }
}
