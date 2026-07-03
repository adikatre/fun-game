// ui.ts — screen-space button layout shared by render (drawing) and input
// (hit-testing), so the two can never disagree about where a button is.

import type { GameState, Rect, Viewport, Vec } from './types';

export interface UiButton extends Rect {
  id: 'pause' | 'mute' | 'hold' | 'primary' | 'retry' | 'cross' | 'shop_done' | 'speed_slow' | 'speed_normal' | 'speed_expedite' | 'go_around' | 'taxi_hold' | 'taxi_continue' | 'takeoff' | 'vector_left' | 'vector_right' | 'vector_cancel';
  label: string;
}

export interface UiContext {
  paused: boolean;
  muted: boolean;
  status: GameState['status'];
  selectedAirborne: boolean; // an airborne arrival is selected (HOLD applies)
  selectedHolding: boolean;
  selectedWaitCross: boolean; // a ground plane waiting to cross a runway
  selectedTaxi: boolean; // a ground plane taxiing
  selectedTakeoff: boolean; // a plane lined up and waiting for takeoff
  selectedSpeedTarget?: 'slow' | 'normal' | 'expedite';
  selectedVectorTarget?: number | null;
  selectedManualHold?: boolean;
  selectedScreenPos?: Vec;
}

/** In-game HUD buttons (bottom-right corner; thumb-reachable on touch). */
export function hudButtons(vp: Viewport, ui: UiContext): UiButton[] {
  if (ui.status !== 'playing') return [];
  const h = 42;
  const pad = 10;
  const y = vp.cssH - h - 14;
  const btns: UiButton[] = [];
  let x = vp.cssW - 14;
  const add = (id: UiButton['id'], label: string, w: number) => {
    x -= w;
    btns.push({ id, label, x, y, w, h });
    x -= pad;
  };
  add('mute', ui.muted ? '🔇 OFF' : '🔊 ON', 90);
  add('pause', ui.paused ? '▶ RESUME' : '⏸ PAUSE', 110);
  if (ui.selectedAirborne) add('hold', ui.selectedHolding ? '↩ RESUME' : '🔄 HOLD', 110);
  if (ui.selectedWaitCross) add('cross', '✈ CROSS', 100);
  return btns;
}

/** End-screen buttons (debrief / fired). */
export function endButtons(vp: Viewport, status: GameState['status']): UiButton[] {
  if (status !== 'debrief' && status !== 'fired') return [];
  const w = 220;
  const h = 54;
  const cy = vp.cssH / 2 + 132;
  if (status === 'debrief') {
    return [
      { id: 'primary', label: 'UPGRADES & NEXT →', x: vp.cssW / 2 - w - 12, y: cy, w, h },
      { id: 'retry', label: 'RETRY SHIFT', x: vp.cssW / 2 + 12, y: cy, w, h },
    ];
  }
  return [{ id: 'retry', label: 'TRY AGAIN', x: vp.cssW / 2 - w / 2, y: cy, w, h }];
}

/** Upgrade screen buttons. */
export function upgradeButtons(vp: Viewport): UiButton[] {
  const w = 240;
  const h = 54;
  return [
    { id: 'shop_done', label: 'START NEXT SHIFT →', x: vp.cssW / 2 - w / 2, y: vp.cssH - 80, w, h },
  ];
}

/** Floating context menu next to the selected plane. */
export function floatingButtons(vp: Viewport, ui: UiContext): UiButton[] {
  if (ui.status !== 'playing' || !ui.selectedScreenPos) return [];
  const btns: UiButton[] = [];
  
  // Position menu above and to the right of the plane
  let x = ui.selectedScreenPos.x + 30;
  let y = ui.selectedScreenPos.y - 40;
  const h = 32;
  const pad = 6;
  
  const add = (id: UiButton['id'], label: string, w: number) => {
    btns.push({ id, label, x, y, w, h });
    x += w + pad;
  };

  if (ui.selectedTakeoff) {
    add('takeoff', 'TAKEOFF', 80);
  } else if (ui.selectedAirborne) {
    const spd = ui.selectedSpeedTarget;
    add('speed_slow', spd === 'slow' ? '▶ SLOW' : 'SLOW', 65);
    add('speed_normal', spd === 'normal' ? '▶ NORM' : 'NORM', 65);
    add('speed_expedite', spd === 'expedite' ? '▶ EXP' : 'EXP', 65);
    add('go_around', 'ABORT', 70);
    add('vector_left', '⬅', 40);
    add('vector_right', '➡', 40);
    if (ui.selectedVectorTarget != null) {
      add('vector_cancel', '✕', 40);
    }
  } else if (ui.selectedTaxi) {
    add('taxi_hold', ui.selectedManualHold ? '▶ HOLD' : 'HOLD', 65);
    add('taxi_continue', !ui.selectedManualHold ? '▶ GO' : 'GO', 60);
  }
  
  return btns;
}

export function buttonAt(buttons: UiButton[], sx: number, sy: number): UiButton | null {
  for (const b of buttons) {
    if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return b;
  }
  return null;
}
