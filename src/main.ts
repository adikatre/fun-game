// main.ts — wiring + fixed-timestep loop (sim @ 60 Hz; render on rAF with
// interpolation). Owns the session flow (menu -> tutorial -> shift -> debrief ->
// next day), persistence (day / best / mute), and drains the sim's event queue
// into audio + fx each frame. Decoupling sim from render keeps motion smooth.

import { AudioEngine } from './audio';
import { CONFIG } from './config';
import { Fx } from './fx';
import { createInput } from './input';
import { render } from './render';
import { sdk, storage } from './sdk';
import { commandToRunway, createGame, startShift, update, authorizeCrossing } from './sim';
import { loadCareerStats, saveCareerStats, recordShiftStats, createCareerStats, resetAllCareerData } from './stats';
import type { GameState, Viewport } from './types';
import { createUpgradeState, loadUpgradeState, saveUpgradeState, purchaseUpgrade as doPurchase } from './upgrades';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

// Canvas text does not reliably trigger @font-face loading, so eagerly load the
// Inter weights we render with; otherwise the first frames fall back to system.
try {
  const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
  if (fonts) {
    for (const w of [400, 500, 600, 700, 800, 900]) fonts.load(`${w} 16px Inter`);
  }
} catch {
  /* no-op: canvas falls back to the system font stack */
}

// --- persistence -------------------------------------------------------------
// Saves go through the CrazyGames data module (cloud save for logged-in players,
// localStorage otherwise), which is only usable after init() resolves — so boot
// blocks on it before reading any persisted state.

await sdk.init();
sdk.loadingStart();

function loadNum(key: string, fallback: number): number {
  const v = storage.getItem(key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function save(key: string, value: number | string): void {
  storage.setItem(key, String(value));
}

let day = Math.max(1, Math.floor(loadNum('fa.day', 1)));
let best = loadNum('fa.best', 0);
const audio = new AudioEngine(loadNum('fa.muted', 0) === 1);
const fx = new Fx();

// --- career stats ---
let careerStats = loadCareerStats();

// --- game state ---------------------------------------------------------------

const seedParam = new URLSearchParams(location.search).get('seed');
const urlSeed = seedParam != null && seedParam !== '' ? Number(seedParam) >>> 0 : null;
const freshSeed = () => (urlSeed != null ? urlSeed : (Math.random() * 0xffffffff) >>> 0);

let seed = urlSeed ?? CONFIG.defaultSeed;
let upgradeState = loadUpgradeState();
let state: GameState = createGame(seed, day, true, upgradeState);
// Boot to menu instead of tutorial
state.status = 'menu' as any;
let shiftRecorded = false;
let isAdPlaying = false;

const viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0, cssW: 1, cssH: 1 };
let dpr = 1;

function resize(): void {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const inset = 12;
  const scale = Math.min((cssW - inset * 2) / CONFIG.worldW, (cssH - inset * 2) / CONFIG.worldH);
  viewport.scale = scale;
  viewport.offsetX = (cssW - CONFIG.worldW * scale) / 2;
  viewport.offsetY = (cssH - CONFIG.worldH * scale) / 2;
  viewport.cssW = cssW;
  viewport.cssH = cssH;
}
window.addEventListener('resize', resize);
resize();

function newShift(nextDay: number, tutorial: boolean): void {
  day = nextDay;
  save('fa.day', day);
  seed = freshSeed();
  state = createGame(seed, day, tutorial, upgradeState);
  shiftRecorded = false;
  fx.reset(state);
  if (!tutorial) sdk.gameplayStart();
}

/** Called once when a shift ends (debrief or fired): record bests. */
function recordShift(): void {
  if (shiftRecorded) return;
  shiftRecorded = true;
  if (state.cash > best) {
    best = state.cash;
    save('fa.best', best);
  }
  upgradeState.totalCashEarned += state.cash;
  upgradeState.bankBalance += state.cash;
  saveUpgradeState(upgradeState);
  
  // Record career stats
  recordShiftStats(careerStats, state);
  saveCareerStats(careerStats);
  
  sdk.gameplayStop();
  if (state.status === 'debrief' && (state.grade === 'S' || state.grade === 'A')) sdk.happytime();
}

const input = createInput({
  canvas,
  getState: () => state,
  getViewport: () => viewport,
  actions: {
    startShift: () => {
      startShift(state);
      sdk.gameplayStart();
    },
    nextShift: () => newShift(day + 1, false),
    retryShift: () => newShift(day, false),
    restartKey: () => newShift(day, false),
    showUpgrades: () => {
      state.status = 'upgrade';
    },
    purchaseUpgrade: (id: string) => {
      if (doPurchase(upgradeState, id as any)) {
        saveUpgradeState(upgradeState);
        state.events.push({ kind: 'purchase', upgradeId: id });
        audio.uiClick();
      }
    },
    authorizeCross: (id: number) => {
      authorizeCrossing(state, id);
    },
    togglePause: () => {
      if (state.status !== 'playing') return;
      state.paused = !state.paused;
      if (state.paused) sdk.gameplayStop();
      else sdk.gameplayStart();
    },
    toggleMute: () => {
      audio.unlock();
      const m = audio.toggleMuted();
      save('fa.muted', m ? 1 : 0);
    },
    commandFeedback: () => audio.uiClick(),
    unlockAudio: () => audio.unlock(),
    getMuted: () => audio.muted,
    getBest: () => best,
    getUpgrades: () => upgradeState,
    // --- new actions for menu/stats/settings ---
    goToMenu: () => {
      state.status = 'menu' as any;
    },
    goToStats: () => {
      state.status = 'stats' as any;
    },
    goToSettings: () => {
      state.status = 'settings' as any;
    },
    goToTutorial: () => {
      // Create a fresh game for the new shift
      seed = freshSeed();
      state = createGame(seed, day, true, upgradeState);
      shiftRecorded = false;
      fx.reset(state);
    },
    setVolume: (v: number) => {
      audio.setVolume(v);
    },
    getVolume: () => audio.getVolume(),
    setMusicVolume: (v: number) => {
      audio.setMusicVolume(v);
    },
    getMusicVolume: () => audio.getMusicVolume(),
    setSfxVolume: (v: number) => {
      audio.setSfxVolume(v);
    },
    getSfxVolume: () => audio.getSfxVolume(),
    resetCareer: () => {
      resetAllCareerData();
      day = 1;
      save('fa.day', 1);
      best = 0;
      save('fa.best', 0);
      upgradeState = createUpgradeState();
      saveUpgradeState(upgradeState);
      careerStats = createCareerStats();
      saveCareerStats(careerStats);
      state = createGame(seed, day, true, upgradeState);
      state.status = 'menu' as any;
      shiftRecorded = false;
      fx.reset(state);
    },
    getCareerStats: () => careerStats,
    adContinue: () => {
      if (isAdPlaying) return;
      const prevMute = audio.muted;
      sdk.requestRewardedAd(
        () => {
          // Success: reset crash, revive
          isAdPlaying = false;
          audio.setMuted(prevMute);
          state.incidents = Math.max(0, state.incidents - 1); // undo the crash
          state.adContinueUsed = true;
          state.status = 'playing'; // resume shift
          state.crashFx = []; // clear crash markers
          sdk.gameplayStart();
        },
        () => {
          // Error: resume UI but keep fired
          isAdPlaying = false;
          audio.setMuted(prevMute);
        },
        () => {
          // Started: pause game
          isAdPlaying = true;
          audio.setMuted(true);
        }
      );
    },
    adDouble: () => {
      if (isAdPlaying) return;
      const prevMute = audio.muted;
      sdk.requestRewardedAd(
        () => {
          // Success: double cash
          isAdPlaying = false;
          audio.setMuted(prevMute);
          state.cash *= 2;
          state.adDoubleUsed = true;
        },
        () => {
          // Error: resume UI
          isAdPlaying = false;
          audio.setMuted(prevMute);
        },
        () => {
          // Started: pause game
          isAdPlaying = true;
          audio.setMuted(true);
        }
      );
    },
  },
});

(window as unknown as { __atc: unknown }).__atc = {
  get state() {
    return state;
  },
  restart: (s?: number) => {
    state = createGame(s ?? seed, day, false, upgradeState);
    shiftRecorded = false;
    fx.reset(state);
  },
};

// QA aid (?autoplay=1): naive controller that clears inbound planes to the
// least-busy runway, so demos/screenshots show a live, landing airport.
const autoplay = new URLSearchParams(location.search).has('autoplay');
if (autoplay) startShift(state);
function runAutoplay(): void {
  if (state.status !== 'playing') return;
  for (const ac of state.aircraft) {
    const wantsRunway = ac.phase === 'inbound' || ac.phase === 'readyDep';
    if (!wantsRunway) continue;
    const rw = [...state.runways].sort((a, b) => a.occupiedUntil - b.occupiedUntil)[0];
    if (!rw) continue;
    // pick the end nearest the plane (its current side)
    const d0 = Math.hypot(ac.x - rw.ends[0].finalEntry.x, ac.y - rw.ends[0].finalEntry.y);
    const d1 = Math.hypot(ac.x - rw.ends[1].finalEntry.x, ac.y - rw.ends[1].finalEntry.y);
    commandToRunway(state, ac.id, rw.id, d0 <= d1 ? 0 : 1);
  }
}

const STEP_FF = 1 / CONFIG.simStepHz;
// QA aid (?ff=SECONDS): fast-forward the sim at load for screenshots/testing.
{
  const ff = Number(new URLSearchParams(location.search).get('ff')) || 0;
  if (ff > 0) {
    startShift(state);
    for (let i = 0; i < ff * CONFIG.simStepHz; i++) {
      if (autoplay && i % 30 === 0) runAutoplay();
      update(state, STEP_FF, upgradeState);
    }
    state.events.length = 0;
    fx.reset(state);
  }
}

/** Drain sim events into audio + fx (works while paused too: commands emit). */
function drainEvents(): void {
  if (state.events.length === 0) return;
  for (const e of state.events) {
    if (e.kind === 'rush' || e.kind === 'finalRush') rushUntil = performance.now() + 25_000;
    audio.onEvent(e);
    fx.onEvent(e);
  }
  state.events.length = 0;
}

let rushUntil = 0; // music treats a wave as "hot" for a while after it spawns

const STEP = 1 / CONFIG.simStepHz;
let acc = 0;
let last = performance.now();
let autoTick = 0;

function frame(now: number): void {
  if (isAdPlaying) {
    last = now; // prevent delta time from spiraling when ad finishes
    requestAnimationFrame(frame);
    return;
  }

  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  acc += dt;

  let steps = 0;
  while (acc >= STEP && steps < 240) {
    if (autoplay && autoTick++ % 30 === 0) runAutoplay();
    update(state, STEP, upgradeState);
    acc -= STEP;
    steps++;
  }
  if (steps >= 240) acc = 0;

  drainEvents();
  fx.update(dt, state);
  if (state.status === 'debrief' || state.status === 'fired') recordShift();

  // adaptive audio: alert siren, music intensity, ambience density
  const anyRed = state.status === 'playing' && !state.paused && state.aircraft.some((a) => a.conflict);
  const anyAmber = state.status === 'playing' && !state.paused && state.predicted.length > 0;
  const playingLive = state.status === 'playing' && !state.paused;
  const rushActive = playingLive && now < rushUntil;
  const intensity = playingLive
    ? Math.min(1, 0.15 + 0.05 * state.aircraft.length
        + (state.predicted.length > 0 ? 0.2 : 0)
        + (anyRed ? 0.35 : 0)
        + (rushActive ? 0.2 : 0))
    : 0;
  audio.setDynamics({
    scene: state.status === 'playing' ? 'game' : 'menu',
    intensity,
    planeCount: playingLive ? state.aircraft.length : 0,
    alertLevel: anyRed ? 2 : anyAmber ? 1 : 0,
    ducked: state.status === 'playing' && state.paused,
  }, dt);

  const alpha = state.paused || state.status !== 'playing' ? 1 : acc / STEP;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render(ctx, state, alpha, viewport, input.hints(), fx, now / 1000);

  requestAnimationFrame(frame);
}
// Boot is done (single-file bundle: nothing left to fetch) — tell CrazyGames
// before the first frame renders the menu.
sdk.loadingStop();
requestAnimationFrame(frame);
