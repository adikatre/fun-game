// Minimal DOM + Canvas2D stub so the real render/input/main stack can be
// executed under Node for a runtime smoke test (catches load-time crashes,
// render exceptions, and input-handler bugs without a browser). NOT a renderer
// — every draw call is a no-op; we only care that nothing throws.

import { CONFIG } from '../src/config';

type Listener = (e: any) => void;

const CSS_W = 1280;
const CSS_H = 800;

// no-op 2d context: methods do nothing, gradients/measureText return stubs.
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
g.location = { search: '' };
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

// ---- drivers for the smoke test ----

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

// world -> screen using the same transform main.ts computes.
function worldToScreen(wx: number, wy: number): { x: number; y: number } {
  const inset = 12;
  const scale = Math.min((CSS_W - inset * 2) / CONFIG.worldW, (CSS_H - inset * 2) / CONFIG.worldH);
  const ox = (CSS_W - CONFIG.worldW * scale) / 2;
  const oy = (CSS_H - CONFIG.worldH * scale) / 2;
  return { x: wx * scale + ox, y: wy * scale + oy };
}

export function getGame(): any {
  return g.window.__headway.state;
}

/** Drag from one world point to another (new line / extend). */
export function fireDrag(fromW: { x: number; y: number }, toW: { x: number; y: number }): void {
  const a = worldToScreen(fromW.x, fromW.y);
  const b = worldToScreen(toW.x, toW.y);
  const ev = (p: { x: number; y: number }, button = 0) => ({
    clientX: p.x,
    clientY: p.y,
    button,
    preventDefault() {},
  });
  fire(canvasListeners, 'mousedown', ev(a));
  fire(windowListeners, 'mousemove', ev(b));
  fire(windowListeners, 'mouseup', ev(b));
}

export function fireKey(code: string): void {
  fire(windowListeners, 'keydown', { code, preventDefault() {} });
}
