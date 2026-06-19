// main.ts — wiring + fixed-timestep loop.
// Sim advances in fixed 1/60s steps; render runs on rAF and interpolates train
// positions with the leftover accumulator (`alpha`). Decoupling the two keeps
// motion smooth regardless of display refresh rate.

import { CONFIG } from './config';
import { createInput } from './input';
import { render } from './render';
import { sdk } from './sdk';
import { createGame, createLine, extendLine, update } from './sim';
import type { GameState, Viewport } from './types';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

// Seed override via ?seed= for reproducibility tests; otherwise the dev default.
const seedParam = new URLSearchParams(location.search).get('seed');
const seed = seedParam != null && seedParam !== '' ? Number(seedParam) >>> 0 : CONFIG.defaultSeed;

let state: GameState = createGame(seed);

const viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0, cssW: 1, cssH: 1 };
let dpr = 1;

function resize(): void {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));

  // Fit the logical world into the window with letterboxing + a small inset.
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

const input = createInput({
  canvas,
  getState: () => state,
  setState: (s) => {
    state = s;
  },
  getViewport: () => viewport,
});

// expose for debugging / determinism poking from the console
(window as unknown as { __headway: unknown }).__headway = {
  get state() {
    return state;
  },
  restart: (s?: number) => {
    state = createGame(s ?? seed);
  },
};

// QA aid (gated by ?autodraw=1): auto-connect the starting stations so demos
// and screenshots show a live, delivering network without manual drawing.
if (new URLSearchParams(location.search).has('autodraw') && state.stations.length >= 3) {
  const s = state.stations;
  createLine(state, s[0].id, s[1].id);
  if (state.lines[0]) extendLine(state, state.lines[0].id, s[1].id, s[2].id);
}

sdk.init().then(() => sdk.gameplayStart());

// ---- fixed-timestep loop ----
const STEP = 1 / CONFIG.simStepHz;
let acc = 0;
let last = performance.now();

function frame(now: number): void {
  let dt = (now - last) / 1000;
  last = now;
  // Clamp huge gaps (tab was backgrounded) so we don't spiral on catch-up.
  if (dt > 0.25) dt = 0.25;
  acc += dt;

  let steps = 0;
  while (acc >= STEP && steps < 240) {
    update(state, STEP);
    acc -= STEP;
    steps++;
  }
  if (steps >= 240) acc = 0; // safety: drop backlog

  const alpha = acc / STEP;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render(ctx, state, alpha, viewport, input.hints(), input.pointerScreen());

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
