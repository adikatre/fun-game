// music.ts — adaptive background music built from generated MP3 stems.
//
// Four loops (see tools/gen-audio.mjs): a calm menu pad, plus three game
// stems in the same key and bar grid. The game stems start sample-synced and
// stay phase-locked; intensity crossfades layers in and out. Headless-safe:
// nothing happens until attach() is called with a live AudioContext, and a
// decode failure quietly leaves the game on procedural-only audio.

import { AUDIO_CLIPS } from './assets/audio-data';

export type MusicScene = 'menu' | 'game' | 'off';

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function smoothstep(x: number, lo: number, hi: number): number {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

const MUSIC_LEVEL = 0.32; // overall music level under the master gain

export class MusicDirector {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null; // music master (also the duck target)
  private stems: Record<string, GainNode> = {}; // per-stem gains
  private scene: MusicScene = 'menu';
  private intensity = 0; // smoothed 0..1
  private targetIntensity = 0;
  private ducked = false;
  private duckPulseUntil = 0;
  private started = false;

  /** Kick off async decode + playback graph. Call once, from a user gesture. */
  attach(ctx: AudioContext, master: GainNode): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = MUSIC_LEVEL;
    this.bus.connect(master);
    void this.load();
  }

  private async load(): Promise<void> {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    try {
      const names = ['menu', 'gameBase', 'gamePulse', 'gameTension'] as const;
      const buffers = await Promise.all(
        names.map((n) => ctx.decodeAudioData(base64ToArrayBuffer(AUDIO_CLIPS[n].b64))),
      );
      const t0 = ctx.currentTime + 0.05;
      names.forEach((name, i) => {
        const buf = buffers[i];
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        // loop exactly the rendered content; browsers strip LAME padding so
        // the decoded length should match, but clamp defensively.
        src.loopEnd = Math.min(buf.duration, AUDIO_CLIPS[name].dur);
        const g = ctx.createGain();
        g.gain.value = 0;
        src.connect(g).connect(bus);
        src.start(t0); // all stems share t0 -> game layers stay phase-locked
        this.stems[name] = g;
      });
      this.started = true;
      this.applyLevels(0.8);
    } catch {
      // decode failed (old browser / corrupt data): stay procedural-only
    }
  }

  /** Per-frame driver. dt in seconds. */
  update(scene: MusicScene, targetIntensity: number, ducked: boolean, dt: number): void {
    this.scene = scene;
    this.targetIntensity = Math.max(0, Math.min(1, targetIntensity));
    this.ducked = ducked;
    // ~3s time constant so the music breathes instead of twitching
    const k = 1 - Math.exp(-dt / 3);
    this.intensity += (this.targetIntensity - this.intensity) * k;
    if (this.started) this.applyLevels(0.7);
  }

  /** Briefly pull all music down (e.g. under a crash) then recover. */
  pulseDuck(seconds: number): void {
    if (!this.ctx) return;
    this.duckPulseUntil = this.ctx.currentTime + seconds;
  }

  private applyLevels(tc: number): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    const duckPulse = t < this.duckPulseUntil ? 0.25 : 1;
    const duck = (this.ducked ? 0.35 : 1) * duckPulse;
    bus.gain.setTargetAtTime(MUSIC_LEVEL * duck, t, duckPulse < 1 ? 0.08 : 0.3);
    const off = this.scene === 'off';
    const menu = !off && this.scene === 'menu' ? 1 : 0;
    const game = !off && this.scene === 'game' ? 1 : 0;
    const set = (name: string, v: number): void => {
      this.stems[name]?.gain.setTargetAtTime(v, t, tc);
    };
    set('menu', menu);
    set('gameBase', game);
    set('gamePulse', game * smoothstep(this.intensity, 0.25, 0.7));
    set('gameTension', game * smoothstep(this.intensity, 0.6, 1.0));
  }
}
