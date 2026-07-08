// ui.ts — screen-space button layout shared by render (drawing) and input
// (hit-testing), so the two can never disagree about where a button is.

import type { GameState, Rect, Viewport, Vec } from './types';
import { FULL_LAUNCH } from './sdk';

export type ButtonId =
  | 'pause' | 'mute' | 'hold' | 'primary' | 'retry' | 'cross' | 'shop_done'
  | 'go_around'
  | 'speed_slower' | 'speed_faster'
  | 'taxi_hold' | 'taxi_continue' | 'takeoff'
  // pause menu
  | 'pause_resume' | 'pause_restart' | 'pause_sound' | 'pause_quit'
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
  selectedAirborneSpeed: boolean; // any airborne plane selected (speed +/- applies)
  selectedHolding: boolean;
  selectedWaitCross: boolean; // a ground plane waiting to cross a runway
  selectedTaxi: boolean; // a ground plane taxiing
  selectedTakeoff: boolean; // a plane lined up and waiting for takeoff
  selectedManualHold?: boolean;
  selectedScreenPos?: Vec;
}

export interface PlaneActionSpec {
  id: ButtonId;
  label: string;
  floatW: number;
  hudW: number;
}

/** Plane-specific actions shown in both the floating menu and the bottom-right HUD. */
export function planeActionSpecs(ui: UiContext): PlaneActionSpec[] {
  if (ui.selectedTakeoff) {
    return [{ id: 'takeoff', label: 'TAKEOFF', floatW: 80, hudW: 100 }];
  }
  if (ui.selectedWaitCross) {
    return [{ id: 'cross', label: 'CROSS', floatW: 80, hudW: 100 }];
  }
  const specs: PlaneActionSpec[] = [];
  if (ui.selectedAirborne) {
    const holdLabel = ui.selectedHolding ? '↩ RESUME' : '🔄 HOLD';
    specs.push(
      { id: 'go_around', label: 'ABORT', floatW: 70, hudW: 90 },
      { id: 'hold', label: holdLabel, floatW: 75, hudW: 110 },
    );
  }
  if (ui.selectedAirborneSpeed) {
    specs.push(
      { id: 'speed_slower', label: '− SLOW', floatW: 62, hudW: 78 },
      { id: 'speed_faster', label: '+ FAST', floatW: 62, hudW: 78 },
    );
  }
  if (specs.length > 0) return specs;
  if (ui.selectedTaxi) {
    return [
      { id: 'taxi_hold', label: ui.selectedManualHold ? '▶ HOLD' : 'HOLD', floatW: 65, hudW: 85 },
      { id: 'taxi_continue', label: !ui.selectedManualHold ? '▶ GO' : 'GO', floatW: 60, hudW: 75 },
    ];
  }
  return [];
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
  add('mute', ui.muted ? '🔇 SOUND OFF' : '🔊 SOUND ON', 120);
  add('pause', ui.paused ? '▶ RESUME' : '⏸ PAUSE', 110);
  for (const spec of planeActionSpecs(ui)) add(spec.id, spec.label, spec.hudW);
  return btns;
}

/** Pause menu card geometry (render draws the card, buttons live inside it). */
export function pauseMenuRect(vp: Viewport): Rect {
  const w = Math.min(320, vp.cssW - 48);
  const h = 320;
  return { x: vp.cssW / 2 - w / 2, y: vp.cssH / 2 - h / 2, w, h };
}

/** Modal pause menu buttons (shown while a shift is paused). */
export function pauseButtons(vp: Viewport, restartArmed: boolean, muted: boolean): UiButton[] {
  const card = pauseMenuRect(vp);
  const bw = card.w - 56;
  const bh = 46;
  const gap = 12;
  const x = card.x + (card.w - bw) / 2;
  let y = card.y + 74;
  const btns: UiButton[] = [];
  const add = (id: ButtonId, label: string) => {
    btns.push({ id, label, x, y, w: bw, h: bh });
    y += bh + gap;
  };
  add('pause_resume', '▶ RESUME');
  add('pause_restart', restartArmed ? 'RESTART — ARE YOU SURE?' : '⟲ RESTART SHIFT');
  add('pause_sound', muted ? '🔇 SOUND OFF' : '🔊 SOUND ON');
  add('pause_quit', '✕ QUIT TO MENU');
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
    // Ads are disabled during Basic Launch, so only surface the CTA in Full Launch.
    if (FULL_LAUNCH && !state.adDoubleUsed && window.CrazyGames) {
      btns.push({ id: 'ad_double', label: '▶ WATCH AD: DOUBLE $', x: vp.cssW / 2 - w / 2, y: cy + h + 16, w, h });
    }
    return btns;
  }
  
  btns.push({ id: 'retry', label: 'TRY AGAIN', x: vp.cssW / 2 - w / 2, y: cy, w, h });
  if (FULL_LAUNCH && !state.adContinueUsed && window.CrazyGames) {
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

/** Main menu buttons — centered 2x2 grid; scales down to fit narrow screens. */
export function menuButtons(vp: Viewport): UiButton[] {
  // Native row width is 2*220 + 20 = 460; shrink proportionally on small screens.
  const maxRowW = Math.min(vp.cssW - 40, 460);
  const scale = maxRowW / 460;
  const bw = 220 * scale;
  const bh = 56;
  const gap = 20 * scale;
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
export function settingsButtons(vp: Viewport, confirmingReset: boolean, muted: boolean): UiButton[] {
  const btns: UiButton[] = [];
  const cx = vp.cssW / 2;

  // Back button
  const bw = 180;
  const bh = 48;
  btns.push({ id: 'settings_back', label: '← BACK TO MENU', x: cx - bw / 2, y: vp.cssH - 80, w: bw, h: bh });

  // Mute toggle — top-right of the volume card, above the slider rows so it
  // never overlaps the track hit areas or % readouts (mirror of render).
  const volCardW = Math.min(440, vp.cssW - 24);
  const volCardX = cx - volCardW / 2;
  const volCardY = vp.cssH / 2 - 230;
  const muteW = 90;
  const muteH = 30;
  btns.push({
    id: 'settings_mute',
    label: muted ? 'UNMUTE' : 'MUTE',
    x: volCardX + volCardW - 24 - muteW,
    y: volCardY + 12,
    w: muteW,
    h: muteH,
  });

  // Reset career
  if (confirmingReset) {
    const rw = Math.min(160, (vp.cssW - 40) / 2);
    const rh = 44;
    const ry = vp.cssH / 2 + 100;
    btns.push({ id: 'settings_reset_confirm', label: 'YES, RESET', x: cx - rw - 10, y: ry, w: rw, h: rh });
    btns.push({ id: 'settings_reset_cancel', label: 'CANCEL', x: cx + 10, y: ry, w: rw, h: rh });
  } else {
    const rw = Math.min(240, vp.cssW - 60);
    const rh = 44;
    btns.push({ id: 'settings_reset', label: '⚠ RESET ALL PROGRESS', x: cx - rw / 2, y: vp.cssH / 2 + 100, w: rw, h: rh });
  }

  return btns;
}

/** Floating context menu next to the selected plane. */
export function floatingButtons(vp: Viewport, ui: UiContext): UiButton[] {
  if (ui.status !== 'playing' || !ui.selectedScreenPos) return [];
  const h = 32;
  const pad = 6;

  const specs = planeActionSpecs(ui);
  if (specs.length === 0) return [];

  const totalW = specs.reduce((sum, s) => sum + s.floatW, 0) + pad * (specs.length - 1);
  const margin = 8;
  // Prefer up-and-right of the plane, but keep the whole strip on-screen.
  let x = ui.selectedScreenPos.x + 30;
  x = Math.max(margin, Math.min(x, vp.cssW - totalW - margin));
  let y = ui.selectedScreenPos.y - 40;
  y = Math.max(margin, Math.min(y, vp.cssH - h - margin));

  const btns: UiButton[] = [];
  for (const s of specs) {
    btns.push({ id: s.id, label: s.label, x, y, w: s.floatW, h });
    x += s.floatW + pad;
  }
  return btns;
}

export function buttonAt(buttons: UiButton[], sx: number, sy: number): UiButton | null {
  for (const b of buttons) {
    if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return b;
  }
  return null;
}
