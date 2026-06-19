// main.ts — wiring + fixed-timestep loop (sim @ 60 Hz; render on rAF with
// interpolation). Decoupling sim from render keeps motion smooth at any refresh.

import { CONFIG } from './config';
import { createInput } from './input';
import { render } from './render';
import { sdk } from './sdk';
import { assignApproach, createGame, update } from './sim';
import type { GameState, Viewport } from './types';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

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

(window as unknown as { __atc: unknown }).__atc = {
  get state() {
    return state;
  },
  restart: (s?: number) => {
    state = createGame(s ?? seed);
  },
};

// QA aid (?autoplay=1): naive controller that clears inbound planes to the
// least-busy runway, so demos/screenshots show a live, landing airport.
const autoplay = new URLSearchParams(location.search).has('autoplay');
function runAutoplay(): void {
  if (state.status !== 'playing') return;
  for (const ac of state.aircraft) {
    if (ac.phase === 'inbound' && ac.assignedRunwayId == null) {
      const rw = [...state.runways].sort((a, b) => a.occupiedUntil - b.occupiedUntil)[0];
      if (rw) assignApproach(state, ac.id, rw.id);
    }
  }
}

sdk.init().then(() => sdk.gameplayStart());

const STEP = 1 / CONFIG.simStepHz;
let acc = 0;
let last = performance.now();
let autoTick = 0;

function frame(now: number): void {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  acc += dt;

  let steps = 0;
  while (acc >= STEP && steps < 240) {
    if (autoplay && autoTick++ % 30 === 0) runAutoplay();
    update(state, STEP);
    acc -= STEP;
    steps++;
  }
  if (steps >= 240) acc = 0;

  const alpha = acc / STEP;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render(ctx, state, alpha, viewport, input.hints(), input.pointerScreen());

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
