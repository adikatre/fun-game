// Minimal DOM + Canvas2D stub so the real render/input/main stack runs under
// Node for a runtime smoke test (catches load-time crashes, render exceptions,
// input bugs) without a browser. Draw calls are no-ops.

import { CONFIG } from '../src/config';

type Listener = (e: any) => void;
const CSS_W = 1280;
const CSS_H = 800;

const ctx: any = new Proxy(
  {},
  {
    get(target: any, prop: string) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (prop === 'measureText') return () => ({ width: 8 });
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target: any, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  },
);

const canvasListeners: Record<string, Listener[]> = {};
const canvas: any = {
  width: 0,
  height: 0,
  clientWidth: CSS_W,
  clientHeight: CSS_H,
  getContext: () => ctx,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: CSS_W, height: CSS_H, right: CSS_W, bottom: CSS_H }),
  addEventListener: (type: string, fn: Listener) => {
    (canvasListeners[type] ??= []).push(fn);
  },
  removeEventListener: () => {},
};

const windowListeners: Record<string, Listener[]> = {};
let rafCb: ((now: number) => void) | null = null;

const g = globalThis as any;
g.document = { getElementById: () => canvas };
// Pin the seed so smoke runs are deterministic (the sim's only randomness);
// main.ts routes every freshSeed() through ?seed= when present.
g.location = { search: '?seed=7' };
g.window = {
  devicePixelRatio: 1,
  innerWidth: CSS_W,
  innerHeight: CSS_H,
  addEventListener: (type: string, fn: Listener) => {
    (windowListeners[type] ??= []).push(fn);
  },
  removeEventListener: () => {},
};
g.requestAnimationFrame = (cb: (now: number) => void) => {
  rafCb = cb;
  return 1;
};
const storageData: Record<string, string> = {
  'fa.upgrades': JSON.stringify({ purchased: ['runway_2', 'gates_1'], bankBalance: 1500, totalCashEarned: 1500 }),
};
g.localStorage = {
  getItem: (key: string) => storageData[key] ?? null,
  setItem: (key: string, value: string) => {
    storageData[key] = value;
  },
  removeItem: (key: string) => {
    delete storageData[key];
  },
  clear: () => {
    for (const key of Object.keys(storageData)) delete storageData[key];
  },
};

let nowMs = 0;
export function drive(frames: number, msPerFrame = 16.7): void {
  for (let i = 0; i < frames; i++) {
    if (!rafCb) break;
    const cb = rafCb;
    rafCb = null;
    nowMs += msPerFrame;
    cb(nowMs);
  }
}

function fire(listeners: Record<string, Listener[]>, type: string, e: any): void {
  for (const fn of listeners[type] ?? []) fn(e);
}

export function worldToScreen(wx: number, wy: number): { x: number; y: number } {
  const inset = 12;
  const scale = Math.min((CSS_W - inset * 2) / CONFIG.worldW, (CSS_H - inset * 2) / CONFIG.worldH);
  const ox = (CSS_W - CONFIG.worldW * scale) / 2;
  const oy = (CSS_H - CONFIG.worldH * scale) / 2;
  return { x: wx * scale + ox, y: wy * scale + oy };
}

export function getGame(): any {
  return g.window.__atc.state;
}

export function getStorageItem(key: string): string | null {
  return storageData[key] ?? null;
}

const ev = (p: { x: number; y: number }, button = 0) => ({
  clientX: p.x,
  clientY: p.y,
  button,
  preventDefault() {},
});

/** Click (no drag) at a world point. */
export function fireClick(world: { x: number; y: number }): void {
  const p = worldToScreen(world.x, world.y);
  fire(canvasListeners, 'pointerdown', ev(p));
  fire(windowListeners, 'pointerup', ev(p));
}

/** Click at a raw screen point (menu buttons etc.). */
export function fireScreenClick(p: { x: number; y: number }): void {
  fire(canvasListeners, 'pointerdown', ev(p));
  fire(windowListeners, 'pointerup', ev(p));
}

/** Right-click at a world point. */
export function fireRightClick(world: { x: number; y: number }): void {
  const p = worldToScreen(world.x, world.y);
  fire(canvasListeners, 'contextmenu', ev(p, 2));
}

/** Drag from one world point to another (draws a path / vectors a plane). */
export function fireDrag(fromW: { x: number; y: number }, toW: { x: number; y: number }): void {
  const a = worldToScreen(fromW.x, fromW.y);
  const b = worldToScreen(toW.x, toW.y);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  fire(canvasListeners, 'pointerdown', ev(a));
  fire(windowListeners, 'pointermove', ev(mid));
  fire(windowListeners, 'pointermove', ev(b));
  fire(windowListeners, 'pointerup', ev(b));
}

export function fireKey(code: string): void {
  fire(windowListeners, 'keydown', { code, preventDefault() {} });
}
