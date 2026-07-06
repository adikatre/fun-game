// gen-audio.mjs — offline renderer for the game's music stems + ambience bed.
//
// Pure-JS DSP (no deps): renders WAV, encodes to MP3 via `lame` (fallback
// `ffmpeg`), and emits src/assets/audio-data.ts (base64 + loop metadata).
// The generated .ts is committed; builds/CI never need the encoders.
//
// Usage: npm run gen:audio
//
// Music design: D minor, 100 BPM, 4 bars (9.6 s). The three game stems share
// the same length and bar grid so they can be started sample-synced and
// gain-crossfaded while staying phase-locked. Each clip gets a tail->head
// equal-power crossfade baked in so looping the whole region is seamless
// (browsers strip LAME encoder padding via the gapless header).

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const SR = 22050;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_MP3_DIR = join(ROOT, 'src', 'assets', 'audio');
const OUT_TS = join(ROOT, 'src', 'assets', 'audio-data.ts');

// --- small DSP kit -----------------------------------------------------------

const TAU = Math.PI * 2;

function buffer(sec) {
  return new Float32Array(Math.round(SR * sec));
}

/** Add an oscillator note into `out`. type: sine|triangle|square|saw */
function note(out, { freq, start, dur, gain, type = 'sine', attack = 0.01, release = 0.05, detune = 0 }) {
  const f = freq * Math.pow(2, detune / 1200);
  const i0 = Math.max(0, Math.round(start * SR));
  const i1 = Math.min(out.length, Math.round((start + dur) * SR));
  let phase = 0;
  const dp = (TAU * f) / SR;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const tEnd = (i1 - i) / SR;
    let env = 1;
    if (t < attack) env = t / attack;
    if (tEnd < release) env = Math.min(env, tEnd / release);
    let s;
    const p = phase % TAU;
    switch (type) {
      case 'triangle': s = 1 - 4 * Math.abs(Math.round(p / TAU) - p / TAU); break;
      case 'square': s = Math.sin(p) > 0 ? 0.7 : -0.7; break;
      case 'saw': s = 2 * (p / TAU) - 1; break;
      default: s = Math.sin(p);
    }
    out[i] += s * env * gain;
    phase += dp;
  }
}

/** Plucky note: exponential decay envelope. */
function pluck(out, { freq, start, gain, type = 'triangle', decay = 0.18 }) {
  const i0 = Math.max(0, Math.round(start * SR));
  const i1 = Math.min(out.length, i0 + Math.round(decay * 5 * SR));
  let phase = 0;
  const dp = (TAU * freq) / SR;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const env = Math.exp(-t / decay) * Math.min(1, t / 0.004);
    const p = phase % TAU;
    const s = type === 'square' ? (Math.sin(p) > 0 ? 0.6 : -0.6) : 1 - 4 * Math.abs(Math.round(p / TAU) - p / TAU);
    out[i] += s * env * gain;
    phase += dp;
  }
}

function brownNoise(out, gain) {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    last = (last + (Math.random() * 2 - 1) * 0.02) * 0.998;
    out[i] += last * 3.5 * gain;
  }
}

/** In-place one-pole lowpass. */
function lowpass(buf, cutoff) {
  const a = 1 - Math.exp((-TAU * cutoff) / SR);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += a * (buf[i] - y);
    buf[i] = y;
  }
}

/** Slow sine amplitude undulation. */
function slowLfo(buf, hz, depth) {
  for (let i = 0; i < buf.length; i++) {
    buf[i] *= 1 - depth * 0.5 * (1 + Math.sin((TAU * hz * i) / SR));
  }
}

/** Schroeder-ish reverb (4 combs + 2 allpass), mixed wet into the buffer.
 *  Comb delays are read modulo the loop so the tail wraps musically. */
function reverb(buf, wet) {
  const combs = [1687, 1601, 2053, 2251].map((d) => ({ d, fb: 0.72, mem: new Float32Array(d), i: 0 }));
  const allp = [389, 307].map((d) => ({ d, mem: new Float32Array(d), i: 0 }));
  const out = new Float32Array(buf.length);
  // run twice through the loop so the tail from the end colors the start (loop-friendly)
  for (let pass = 0; pass < 2; pass++) {
    for (let n = 0; n < buf.length; n++) {
      const x = buf[n];
      let acc = 0;
      for (const c of combs) {
        const y = c.mem[c.i];
        c.mem[c.i] = x + y * c.fb;
        c.i = (c.i + 1) % c.d;
        acc += y;
      }
      acc *= 0.25;
      for (const a of allp) {
        const y = a.mem[a.i];
        a.mem[a.i] = acc + y * 0.5;
        acc = y - 0.5 * a.mem[a.i];
        a.i = (a.i + 1) % a.d;
      }
      if (pass === 1) out[n] = acc;
    }
  }
  for (let n = 0; n < buf.length; n++) buf[n] += out[n] * wet;
}

function normalize(buf, peak = 0.85) {
  let max = 0;
  for (const s of buf) max = Math.max(max, Math.abs(s));
  if (max > 0) for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] / max) * peak;
}

/** Bake tail->head equal-power crossfade so looping the whole clip is seamless. */
function loopBake(buf, fadeSec = 0.06) {
  const n = Math.round(fadeSec * SR);
  const len = buf.length - n;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    if (i < n) {
      const t = i / n;
      out[i] = buf[i] * Math.sin((t * Math.PI) / 2) + buf[len + i] * Math.cos((t * Math.PI) / 2);
    } else {
      out[i] = buf[i];
    }
  }
  return out;
}

// --- WAV + MP3 ---------------------------------------------------------------

function writeWav(path, buf) {
  const n = buf.length;
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // mono
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf[i] * 32767))), 44 + i * 2);
  }
  writeFileSync(path, data);
}

function encodeMp3(wavPath, mp3Path, kbps = 64) {
  try {
    execFileSync('lame', ['--quiet', '-b', String(kbps), '-m', 'm', wavPath, mp3Path]);
    return;
  } catch { /* fall through to ffmpeg */ }
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-b:a', `${kbps}k`, mp3Path]);
    return;
  } catch (err) {
    throw new Error(`Neither lame nor ffmpeg could encode ${wavPath}: ${err}`);
  }
}

// --- score data --------------------------------------------------------------

// D minor, 100 BPM. beat = 0.6 s, bar = 2.4 s, 4 bars = 9.6 s.
const BEAT = 0.6;
const BAR = BEAT * 4;
const MUSIC_DUR = BAR * 4;

const HZ = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI note -> Hz
// Progression: Dm | Bb | F | C  (i - VI - III - VII)
const CHORDS = [
  { root: 38, pad: [50, 53, 57, 62] }, // D2  | D3 F3 A3 D4
  { root: 34, pad: [46, 50, 53, 58] }, // Bb1 | Bb2 D3 F3 Bb3
  { root: 41, pad: [53, 57, 60, 65] }, // F2  | F3 A3 C4 F4
  { root: 36, pad: [48, 52, 55, 60] }, // C2  | C3 E3 G3 C4
];

// --- clip renderers ----------------------------------------------------------

function renderMenu() {
  // warm slow pad, sparse — "tower at dusk". Two chords over the full loop.
  const buf = buffer(MUSIC_DUR + 0.06);
  const half = (MUSIC_DUR + 0.06) / 2;
  for (const [k, chord] of [CHORDS[0], CHORDS[1]].entries()) {
    for (const m of chord.pad) {
      for (const det of [-6, 5]) {
        note(buf, { freq: HZ(m), start: k * half, dur: half, gain: 0.1, type: 'sine', attack: 1.6, release: 1.6, detune: det });
        note(buf, { freq: HZ(m), start: k * half, dur: half, gain: 0.045, type: 'triangle', attack: 2.0, release: 1.8, detune: det * 1.5 });
      }
    }
    // soft root an octave down
    note(buf, { freq: HZ(chord.root + 12), start: k * half, dur: half, gain: 0.09, type: 'sine', attack: 1.8, release: 1.8 });
  }
  lowpass(buf, 900);
  reverb(buf, 0.5);
  slowLfo(buf, 0.08, 0.25);
  normalize(buf, 0.8);
  return loopBake(buf);
}

function renderGameBase() {
  // pad + sub bass root movement — always on during gameplay
  const buf = buffer(MUSIC_DUR + 0.06);
  for (const [bar, chord] of CHORDS.entries()) {
    const t0 = bar * BAR;
    for (const m of chord.pad) {
      for (const det of [-5, 4]) {
        note(buf, { freq: HZ(m), start: t0, dur: BAR, gain: 0.075, type: 'sine', attack: 0.5, release: 0.6, detune: det });
      }
    }
    // sub bass: root on beats 1 and 3, fifth on beat 4
    note(buf, { freq: HZ(chord.root), start: t0, dur: BEAT * 1.8, gain: 0.22, type: 'sine', attack: 0.02, release: 0.15 });
    note(buf, { freq: HZ(chord.root), start: t0 + BEAT * 2, dur: BEAT * 0.9, gain: 0.2, type: 'sine', attack: 0.02, release: 0.12 });
    note(buf, { freq: HZ(chord.root + 7), start: t0 + BEAT * 3, dur: BEAT * 0.9, gain: 0.17, type: 'sine', attack: 0.02, release: 0.12 });
  }
  lowpass(buf, 1100);
  reverb(buf, 0.3);
  normalize(buf, 0.85);
  return loopBake(buf);
}

function renderGamePulse() {
  // rhythmic arpeggio layer, fades in with intensity at runtime
  const buf = buffer(MUSIC_DUR + 0.06);
  for (const [bar, chord] of CHORDS.entries()) {
    const t0 = bar * BAR;
    const arp = [chord.pad[0], chord.pad[1], chord.pad[2], chord.pad[3], chord.pad[2], chord.pad[1]];
    for (let e = 0; e < 8; e++) { // 8th notes
      const m = arp[e % arp.length] + 12;
      pluck(buf, { freq: HZ(m), start: t0 + e * (BEAT / 2), gain: e % 2 === 0 ? 0.16 : 0.11, type: 'triangle', decay: 0.14 });
    }
    // offbeat square tick for drive
    for (let b = 0; b < 4; b++) {
      pluck(buf, { freq: HZ(chord.root + 24), start: t0 + b * BEAT + BEAT / 2, gain: 0.05, type: 'square', decay: 0.05 });
    }
  }
  lowpass(buf, 2100);
  reverb(buf, 0.22);
  normalize(buf, 0.8);
  return loopBake(buf);
}

function renderGameTension() {
  // dissonant high tremolo drone — creeps in near max intensity
  const buf = buffer(MUSIC_DUR + 0.06);
  const dur = MUSIC_DUR + 0.06;
  note(buf, { freq: HZ(69), start: 0, dur, gain: 0.16, type: 'sine', attack: 1.2, release: 1.2 }); // A4
  note(buf, { freq: HZ(70), start: 0, dur, gain: 0.14, type: 'sine', attack: 1.4, release: 1.2 }); // Bb4 — minor 2nd beat
  note(buf, { freq: HZ(62), start: 0, dur, gain: 0.1, type: 'triangle', attack: 1.0, release: 1.0, detune: 8 }); // D4
  // urgent pulse: 16th-note ticks on the root, low in the mix
  for (let s = 0; s < MUSIC_DUR / (BEAT / 4); s++) {
    pluck(buf, { freq: HZ(50), start: s * (BEAT / 4), gain: s % 4 === 0 ? 0.09 : 0.05, type: 'square', decay: 0.03 });
  }
  // tremolo
  for (let i = 0; i < buf.length; i++) {
    buf[i] *= 0.65 + 0.35 * Math.sin((TAU * 6.2 * i) / SR);
  }
  lowpass(buf, 2600);
  reverb(buf, 0.35);
  normalize(buf, 0.75);
  return loopBake(buf);
}

function renderAmbienceBed() {
  // airport room tone: distant rumble + faint hum + slow undulation
  const DUR = 8 + 0.06;
  const buf = buffer(DUR);
  brownNoise(buf, 0.7);
  lowpass(buf, 320);
  const hum = buffer(DUR);
  note(hum, { freq: 55, start: 0, dur: DUR, gain: 0.12, type: 'sine', attack: 0.5, release: 0.5 });
  note(hum, { freq: 110, start: 0, dur: DUR, gain: 0.05, type: 'sine', attack: 0.5, release: 0.5, detune: 6 });
  for (let i = 0; i < buf.length; i++) buf[i] += hum[i];
  slowLfo(buf, 0.11, 0.35);
  normalize(buf, 0.7);
  return loopBake(buf);
}

// --- main --------------------------------------------------------------------

const clips = {
  menu: renderMenu(),
  gameBase: renderGameBase(),
  gamePulse: renderGamePulse(),
  gameTension: renderGameTension(),
  ambienceBed: renderAmbienceBed(),
};

mkdirSync(OUT_MP3_DIR, { recursive: true });
const tmp = join(tmpdir(), `fa-gen-audio-${process.pid}`);
mkdirSync(tmp, { recursive: true });

const entries = [];
for (const [name, buf] of Object.entries(clips)) {
  const wav = join(tmp, `${name}.wav`);
  const mp3 = join(OUT_MP3_DIR, `${name}.mp3`);
  writeWav(wav, buf);
  encodeMp3(wav, mp3);
  const bytes = readFileSync(mp3);
  const dur = buf.length / SR;
  entries.push({ name, b64: bytes.toString('base64'), dur, kb: (bytes.length / 1024).toFixed(1) });
  console.log(`${name}: ${dur.toFixed(3)}s, ${(bytes.length / 1024).toFixed(1)} KB mp3`);
}
rmSync(tmp, { recursive: true, force: true });

const ts = [
  '// AUTO-GENERATED by tools/gen-audio.mjs — do not edit by hand.',
  '// Base64 MP3 clips + exact loop duration (seconds of real content; the',
  '// encoder padding is stripped by browsers via the LAME gapless header).',
  '',
  'export interface AudioClip { b64: string; dur: number }',
  '',
  'export const AUDIO_CLIPS: Record<string, AudioClip> = {',
  ...entries.map((e) => `  ${e.name}: { dur: ${e.dur}, b64: '${e.b64}' },`),
  '};',
  '',
].join('\n');
writeFileSync(OUT_TS, ts);
const total = entries.reduce((s, e) => s + Number(e.kb), 0);
console.log(`\nWrote ${OUT_TS} (${total.toFixed(0)} KB of mp3 across ${entries.length} clips)`);
