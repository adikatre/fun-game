// ui.ts — screen-space button layout shared by render (drawing) and input
// (hit-testing), so the two can never disagree about where a button is.

import type { GameState, Rect, Viewport, Vec } from './types';

export type ButtonId =
  | 'pause' | 'mute' | 'hold' | 'primary' | 'retry' | 'cross' | 'shop_done'
  | 'speed_slow' | 'speed_normal' | 'speed_expedite' | 'go_around'
  | 'taxi_hold' | 'taxi_continue' | 'takeoff'
  | 'vector_left' | 'vector_right' | 'vector_cancel'
  // menu
  | 'menu_play' | 'menu_stats' | 'menu_settings' | 'menu_tutorial'
  // stats
  | 'stats_back'
  // settings
  | 'settings_back' | 'settings_reset' | 'settings_reset_confirm' | 'settings_reset_cancel'
  | 'settings_mute'
  // ads
  | 'ad_continue' | 'ad_double';

export interface UiButton extends Rect {
  id: ButtonId;
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
export function endButtons(vp: Viewport, state: GameState): UiButton[] {
  const status = state.status;
  if (status !== 'debrief' && status !== 'fired') return [];
  const w = 220;
  const h = 54;
  const cy = vp.cssH / 2 + 132;
  const btns: UiButton[] = [];

  if (status === 'debrief') {
    btns.push({ id: 'primary', label: 'UPGRADES & NEXT →', x: vp.cssW / 2 - w - 12, y: cy, w, h });
    btns.push({ id: 'retry', label: 'RETRY SHIFT', x: vp.cssW / 2 + 12, y: cy, w, h });
    if (!state.adDoubleUsed && window.CrazyGames) {
      btns.push({ id: 'ad_double', label: '▶ WATCH AD: DOUBLE $', x: vp.cssW / 2 - w / 2, y: cy + h + 16, w, h });
    }
    return btns;
  }
  
  btns.push({ id: 'retry', label: 'TRY AGAIN', x: vp.cssW / 2 - w / 2, y: cy, w, h });
  if (!state.adContinueUsed && window.CrazyGames) {
    btns.push({ id: 'ad_continue', label: '▶ WATCH AD: 2ND CHANCE', x: vp.cssW / 2 - w / 2, y: cy + h + 16, w, h });
  }
  return btns;
}

/** Upgrade screen buttons. */
export function upgradeButtons(vp: Viewport): UiButton[] {
  const w = 240;
  const h = 54;
  return [
    { id: 'shop_done', label: 'START NEXT SHIFT →', x: vp.cssW / 2 - w / 2, y: vp.cssH - 80, w, h },
  ];
}

/** Main menu buttons — centered 2x2 grid. */
export function menuButtons(vp: Viewport): UiButton[] {
  const bw = 220;
  const bh = 56;
  const gap = 20;
  const cx = vp.cssW / 2;
  const cy = vp.cssH / 2 + 30;
  return [
    { id: 'menu_play', label: '▶  START SHIFT', x: cx - bw - gap / 2, y: cy, w: bw, h: bh },
    { id: 'menu_stats', label: '📊  STATISTICS', x: cx + gap / 2, y: cy, w: bw, h: bh },
    { id: 'menu_settings', label: '⚙  SETTINGS', x: cx - bw - gap / 2, y: cy + bh + gap, w: bw, h: bh },
    { id: 'menu_tutorial', label: '❓  HOW TO PLAY', x: cx + gap / 2, y: cy + bh + gap, w: bw, h: bh },
  ];
}

/** Stats screen buttons. */
export function statsButtons(vp: Viewport): UiButton[] {
  const w = 180;
  const h = 48;
  return [
    { id: 'stats_back', label: '← BACK TO MENU', x: vp.cssW / 2 - w / 2, y: vp.cssH - 80, w, h },
  ];
}

/** Settings screen buttons. */
export function settingsButtons(vp: Viewport, confirmingReset: boolean): UiButton[] {
  const btns: UiButton[] = [];
  const cx = vp.cssW / 2;

  // Back button
  const bw = 180;
  const bh = 48;
  btns.push({ id: 'settings_back', label: '← BACK TO MENU', x: cx - bw / 2, y: vp.cssH - 80, w: bw, h: bh });

  // Mute toggle
  btns.push({ id: 'settings_mute', label: 'MUTE', x: cx + 140, y: vp.cssH / 2 - 80, w: 70, h: 36 });

  // Reset career
  if (confirmingReset) {
    const rw = 160;
    const rh = 44;
    const ry = vp.cssH / 2 + 100;
    btns.push({ id: 'settings_reset_confirm', label: 'YES, RESET', x: cx - rw - 10, y: ry, w: rw, h: rh });
    btns.push({ id: 'settings_reset_cancel', label: 'CANCEL', x: cx + 10, y: ry, w: rw, h: rh });
  } else {
    const rw = 240;
    const rh = 44;
    btns.push({ id: 'settings_reset', label: '⚠ RESET ALL PROGRESS', x: cx - rw / 2, y: vp.cssH / 2 + 100, w: rw, h: rh });
  }

  return btns;
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
