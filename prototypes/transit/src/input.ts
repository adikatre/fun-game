// input.ts — translates mouse/keyboard into player actions on the sim.
// It never advances time; it only mutates structure (lines) and toggles flags,
// all of which are legal while paused. It also produces RenderHints each frame.

import { CONFIG } from './config';
import { draftCardRects, lineChipRects } from './render';
import {
  applyDraftOption,
  canCreateLine,
  createLine,
  deleteLine,
  endpointLinesAt,
  extendLine,
  previewNewLineColor,
  restart,
} from './sim';
import { sdk } from './sdk';
import type { GameState, RenderHints, Station, Viewport } from './types';

export interface InputContext {
  canvas: HTMLCanvasElement;
  getState: () => GameState;
  /** Replace the live state (restart). */
  setState: (s: GameState) => void;
  getViewport: () => Viewport;
}

export interface InputController {
  hints: () => RenderHints;
  pointerScreen: () => { x: number; y: number } | null;
  dispose: () => void;
}

export function createInput(ctx: InputContext): InputController {
  const { canvas, getState, setState, getViewport } = ctx;

  let pointerScreen: { x: number; y: number } | null = null;
  let pointerWorld: { x: number; y: number } | null = null;
  let dragFromStationId: number | null = null;

  // --- coordinate helpers ---
  function toScreen(e: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function screenToWorld(p: { x: number; y: number }): { x: number; y: number } {
    const vp = getViewport();
    return { x: (p.x - vp.offsetX) / vp.scale, y: (p.y - vp.offsetY) / vp.scale };
  }
  function stationAt(world: { x: number; y: number }, radius: number): Station | null {
    const state = getState();
    let best: Station | null = null;
    let bestD = radius;
    for (const s of state.stations) {
      const d = Math.hypot(s.x - world.x, s.y - world.y);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
  // distance from point to a line segment
  function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }
  function lineNear(world: { x: number; y: number }): number | null {
    const state = getState();
    const byId = new Map(state.stations.map((s) => [s.id, s]));
    let bestLine: number | null = null;
    let bestD: number = CONFIG.lineHitRadius;
    for (const line of state.lines) {
      for (let i = 0; i + 1 < line.stationIds.length; i++) {
        const a = byId.get(line.stationIds[i])!;
        const b = byId.get(line.stationIds[i + 1])!;
        const d = distToSeg(world.x, world.y, a.x, a.y, b.x, b.y);
        if (d < bestD) {
          bestD = d;
          bestLine = line.id;
        }
      }
    }
    return bestLine;
  }

  // --- mouse ---
  function onMouseDown(e: MouseEvent): void {
    const screen = toScreen(e);
    pointerScreen = screen;
    pointerWorld = screenToWorld(screen);
    const state = getState();

    if (e.button === 2) return; // right-click handled by contextmenu

    // Draft modal takes priority.
    if (state.draft) {
      const rects = draftCardRects(getViewport(), state.draft.options.length);
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (screen.x >= r.x && screen.x <= r.x + r.w && screen.y >= r.y && screen.y <= r.y + r.h) {
          pickDraft(i);
          return;
        }
      }
      return;
    }

    if (state.status === 'gameover') return;

    // Line-slot chip click deletes that line.
    const chips = lineChipRects(getViewport(), state.availableLineSlots);
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i];
      if (screen.x >= r.x && screen.x <= r.x + r.w && screen.y >= r.y && screen.y <= r.y + r.h) {
        const line = state.lines[i];
        if (line) deleteLine(state, line.id);
        return;
      }
    }

    // Otherwise begin a drag from a station, if one is under the cursor.
    const st = stationAt(pointerWorld, 26);
    if (st) dragFromStationId = st.id;
  }

  function onMouseMove(e: MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
  }

  function onMouseUp(e: MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if (e.button === 2) return;
    if (dragFromStationId == null) return;

    const fromId = dragFromStationId;
    dragFromStationId = null;

    const target = stationAt(pointerWorld, CONFIG.snapRadius);
    if (!target || target.id === fromId) return;

    const state = getState();
    const endpointLines = endpointLinesAt(state, fromId);
    if (endpointLines.length > 0) {
      // extend: prefer a line that doesn't already contain the target
      const line = endpointLines.find((l) => !l.stationIds.includes(target.id)) ?? endpointLines[0];
      extendLine(state, line.id, fromId, target.id);
    } else if (canCreateLine(state)) {
      createLine(state, fromId, target.id);
    }
  }

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const world = screenToWorld(toScreen(e));
    const state = getState();
    if (state.draft || state.status === 'gameover') return;
    const lineId = lineNear(world);
    if (lineId != null) deleteLine(state, lineId);
  }

  // --- keyboard ---
  function onKeyDown(e: KeyboardEvent): void {
    const state = getState();

    // CrazyGames key rules: pause on Space; never bind Escape or Ctrl/Cmd+W.
    if (e.code === 'Space') {
      e.preventDefault();
      if (!state.draft && state.status === 'playing') {
        state.paused = !state.paused;
        if (state.paused) sdk.gameplayStop();
        else sdk.gameplayStart();
      }
      return;
    }

    if (e.code === 'KeyR') {
      doRestart();
      return;
    }

    if (state.draft && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3')) {
      const idx = Number(e.code.slice(-1)) - 1;
      if (idx < state.draft.options.length) pickDraft(idx);
    }
  }

  function pickDraft(index: number): void {
    const state = getState();
    if (!state.draft) return;
    const opt = state.draft.options[index];
    if (!opt) return;
    applyDraftOption(state, opt.id);
    sdk.gameplayStart();
  }

  function doRestart(): void {
    setState(restart(getState().rngSeed));
    sdk.gameplayStart();
  }

  // --- render hints (computed fresh each frame) ---
  function hints(): RenderHints {
    const state = getState();
    let hoverStationId: number | null = null;
    let drag: RenderHints['drag'] = null;

    if (pointerWorld && !state.draft && state.status === 'playing') {
      const hover = stationAt(pointerWorld, 26);
      hoverStationId = hover ? hover.id : null;

      if (dragFromStationId != null) {
        const snap = stationAt(pointerWorld, CONFIG.snapRadius);
        const snapId = snap && snap.id !== dragFromStationId ? snap.id : null;
        const endpointLines = endpointLinesAt(state, dragFromStationId);
        let action: 'create' | 'extend' | 'invalid';
        let color: string;
        if (endpointLines.length > 0) {
          action = 'extend';
          const line =
            endpointLines.find((l) => snapId == null || !l.stationIds.includes(snapId)) ??
            endpointLines[0];
          color = line.color;
        } else if (canCreateLine(state)) {
          action = 'create';
          color = previewNewLineColor(state);
        } else {
          action = 'invalid';
          color = '#888';
        }
        drag = {
          fromStationId: dragFromStationId,
          toX: pointerWorld.x,
          toY: pointerWorld.y,
          snapStationId: snapId,
          action,
          color,
        };
      }
    }

    return { pointerWorld, hoverStationId, drag };
  }

  // --- wire up ---
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);

  return {
    hints,
    pointerScreen: () => pointerScreen,
    dispose: () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}
