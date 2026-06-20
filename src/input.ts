// input.ts — translates mouse/keyboard into player actions on the sim.
// Never advances time; only issues commands (legal while paused) and produces
// RenderHints. Drag a plane onto a runway side (or click a plane, then click the
// side) to clear it to land from that end; right-click = hold; Space = pause; R.

import { commandToRunway, restart, toggleHold } from './sim';
import { sdk } from './sdk';
import type { Aircraft, GameState, RenderHints, Vec, Viewport } from './types';

export interface InputContext {
  canvas: HTMLCanvasElement;
  getState: () => GameState;
  setState: (s: GameState) => void;
  getViewport: () => Viewport;
}

export interface InputController {
  hints: () => RenderHints;
  pointerScreen: () => Vec | null;
  dispose: () => void;
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export function createInput(ctx: InputContext): InputController {
  const { canvas, getState, setState, getViewport } = ctx;

  let pointerScreen: Vec | null = null;
  let pointerWorld: Vec | null = null;
  let selectedId: number | null = null;

  let downPlaneId: number | null = null;
  let downWorld: Vec | null = null;
  let dragging = false;

  const toScreen = (e: MouseEvent): Vec => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const screenToWorld = (p: Vec): Vec => {
    const vp = getViewport();
    return { x: (p.x - vp.offsetX) / vp.scale, y: (p.y - vp.offsetY) / vp.scale };
  };

  function planeAt(world: Vec): Aircraft | null {
    const state = getState();
    let best: Aircraft | null = null;
    let bestD = 22;
    for (const a of state.aircraft) {
      const d = Math.hypot(a.x - world.x, a.y - world.y);
      if (d <= bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  /** Which runway + end the point targets (nearest approach line; end by nearer corridor). */
  function runwayEndAt(world: Vec): { runwayId: number; end: 0 | 1 } | null {
    const state = getState();
    let bestRw: GameState['runways'][number] | null = null;
    let bestD = 38;
    for (const r of state.runways) {
      // the whole approach line passes through both corridors + the strip
      const d = distToSeg(
        world.x,
        world.y,
        r.ends[0].finalEntry.x,
        r.ends[0].finalEntry.y,
        r.ends[1].finalEntry.x,
        r.ends[1].finalEntry.y,
      );
      if (d < bestD) {
        bestD = d;
        bestRw = r;
      }
    }
    if (!bestRw) return null;
    const d0 = Math.hypot(world.x - bestRw.ends[0].finalEntry.x, world.y - bestRw.ends[0].finalEntry.y);
    const d1 = Math.hypot(world.x - bestRw.ends[1].finalEntry.x, world.y - bestRw.ends[1].finalEntry.y);
    return { runwayId: bestRw.id, end: d0 <= d1 ? 0 : 1 };
  }

  function validSelected(): number | null {
    if (selectedId == null) return null;
    return getState().aircraft.some((a) => a.id === selectedId) ? selectedId : (selectedId = null);
  }

  // --- mouse ---
  function onMouseDown(e: MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if (e.button === 2) return;
    const state = getState();
    if (state.status === 'gameover') return;

    const plane = planeAt(pointerWorld);
    if (plane) {
      downPlaneId = plane.id;
      downWorld = pointerWorld;
      dragging = false;
      return;
    }

    // empty / runway click acts on the current selection
    const sel = validSelected();
    if (sel != null) {
      const re = runwayEndAt(pointerWorld);
      if (re) commandToRunway(state, sel, re.runwayId, re.end);
    } else {
      selectedId = null;
    }
  }

  function onMouseMove(e: MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if (downPlaneId != null && downWorld && !dragging) {
      if (Math.hypot(pointerWorld.x - downWorld.x, pointerWorld.y - downWorld.y) > 9) dragging = true;
    }
  }

  function onMouseUp(e: MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if (e.button === 2) return;

    if (downPlaneId != null) {
      const state = getState();
      if (dragging) {
        // released on a runway side => land (if airborne) or take off (if parked)
        const re = runwayEndAt(pointerWorld);
        if (re) commandToRunway(state, downPlaneId, re.runwayId, re.end);
        selectedId = downPlaneId;
      } else {
        selectedId = downPlaneId; // a click selects
      }
    }
    downPlaneId = null;
    downWorld = null;
    dragging = false;
  }

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const world = screenToWorld(toScreen(e));
    const state = getState();
    if (state.status === 'gameover') return;
    const plane = planeAt(world);
    if (plane) toggleHold(state, plane.id);
  }

  // --- keyboard ---
  function onKeyDown(e: KeyboardEvent): void {
    const state = getState();
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.status === 'playing') {
        state.paused = !state.paused;
        if (state.paused) sdk.gameplayStop();
        else sdk.gameplayStart();
      }
      return;
    }
    if (e.code === 'KeyR') {
      setState(restart(getState().rngSeed));
      selectedId = null;
      sdk.gameplayStart();
    }
  }

  // --- render hints ---
  function hints(): RenderHints {
    const state = getState();
    let hoverAircraftId: number | null = null;
    let hoverRunwayId: number | null = null;
    let hoverEnd: 0 | 1 | null = null;
    let drag: RenderHints['drag'] = null;

    if (pointerWorld && state.status === 'playing') {
      const hp = planeAt(pointerWorld);
      hoverAircraftId = hp ? hp.id : null;
      const re = runwayEndAt(pointerWorld);
      hoverRunwayId = re ? re.runwayId : null;
      hoverEnd = re ? re.end : null;

      if (dragging && downPlaneId != null) {
        const endName =
          re != null ? state.runways.find((r) => r.id === re.runwayId)?.ends[re.end].name ?? null : null;
        drag = {
          fromAircraftId: downPlaneId,
          toX: pointerWorld.x,
          toY: pointerWorld.y,
          targetRunwayId: re ? re.runwayId : null,
          targetEnd: re ? re.end : null,
          endName,
        };
      }
    }

    return { pointerWorld, hoverAircraftId, hoverRunwayId, hoverEnd, selectedAircraftId: validSelected(), drag };
  }

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
