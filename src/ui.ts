// ui.ts — screen-space button layout shared by render (drawing) and input
// (hit-testing), so the two can never disagree about where a button is.

import type { GameState, Rect, Viewport } from './types';

export interface UiButton extends Rect {
  id: 'pause' | 'mute' | 'hold' | 'primary' | 'retry';
  label: string;
}

export interface UiContext {
  paused: boolean;
  muted: boolean;
  status: GameState['status'];
  selectedAirborne: boolean; // an airborne arrival is selected (HOLD applies)
  selectedHolding: boolean;
}

/** In-game HUD buttons (bottom-right corner; thumb-reachable on touch). */
export function hudButtons(vp: Viewport, ui: UiContext): UiButton[] {
  if (ui.status !== 'playing') return [];
  const h = 38;
  const pad = 10;
  const y = vp.cssH - h - 12;
  const btns: UiButton[] = [];
  let x = vp.cssW - 12;
  const add = (id: UiButton['id'], label: string, w: number) => {
    x -= w;
    btns.push({ id, label, x, y, w, h });
    x -= pad;
  };
  add('mute', ui.muted ? 'SOUND OFF' : 'SOUND ON', 104);
  add('pause', ui.paused ? 'RESUME' : 'PAUSE', 88);
  if (ui.selectedAirborne) add('hold', ui.selectedHolding ? 'RESUME FLT' : 'HOLD', 104);
  return btns;
}

/** End-screen buttons (debrief / fired). */
export function endButtons(vp: Viewport, status: GameState['status']): UiButton[] {
  if (status !== 'debrief' && status !== 'fired') return [];
  const w = 220;
  const h = 52;
  const cy = vp.cssH / 2 + 132;
  if (status === 'debrief') {
    return [
      { id: 'primary', label: 'NEXT SHIFT →', x: vp.cssW / 2 - w - 12, y: cy, w, h },
      { id: 'retry', label: 'RETRY SHIFT', x: vp.cssW / 2 + 12, y: cy, w, h },
    ];
  }
  return [{ id: 'retry', label: 'TRY AGAIN', x: vp.cssW / 2 - w / 2, y: cy, w, h }];
}

export function buttonAt(buttons: UiButton[], sx: number, sy: number): UiButton | null {
  for (const b of buttons) {
    if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return b;
  }
  return null;
}
