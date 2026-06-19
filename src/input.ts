// input.ts — translates mouse/keyboard into player actions on the sim.
// Never advances time; only issues commands (legal while paused) and produces
// RenderHints. Click a plane then a runway = clear to land; drag from a plane =
// vector it; right-click = hold; Space = pause; R = new shift.

import { CONFIG } from './config';
import { assignApproach, restart, setPath, toggleHold } from './sim';
import { sdk } from './sdk';
import type { Aircraft, GameState, RenderHints, Runway, Vec, Viewport } from './types';

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

  // drag state
  let downPlaneId: number | null = null;
  let downWorld: Vec | null = null;
  let dragging = false;
  let dragPoints: Vec[] = [];

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
    let bestD: number = CONFIG.planeHitRadius;
    for (const a of state.aircraft) {
      const d = Math.hypot(a.x - world.x, a.y - world.y);
      if (d <= bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }
  function runwayAt(world: Vec): Runway | null {
    const state = getState();
    let best: Runway | null = null;
    let bestD = 36;
    for (const r of state.runways) {
      const dStrip = distToSeg(world.x, world.y, r.approachEnd.x, r.approachEnd.y, r.rollEnd.x, r.rollEnd.y);
      const dCorr = distToSeg(world.x, world.y, r.approachEnd.x, r.approachEnd.y, r.finalEntry.x, r.finalEntry.y);
      const d = Math.min(dStrip, dCorr);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  function validSelected(): number | null {
    if (selectedId == null) return null;
    return getState().aircraft.some((a) => a.id === selectedId) ? selectedId : (selectedId = null);
  }

  // --- mouse ---
  function onMouseDown(e: MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if (e.button === 2) return; // contextmenu handles right-click
    const state = getState();
    if (state.status === 'gameover') return;

    const plane = planeAt(pointerWorld);
    if (plane) {
      downPlaneId = plane.id;
      downWorld = pointerWorld;
      dragging = false;
      dragPoints = [];
      return;
    }

    // empty / runway click — acts on the current selection
    const sel = validSelected();
    if (sel != null) {
      const rw = runwayAt(pointerWorld);
      if (rw) assignApproach(state, sel, rw.id);
      else setPath(state, sel, [pointerWorld]);
    } else {
      selectedId = null;
    }
  }

  function onMouseMove(e: MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if (downPlaneId != null && downWorld) {
      if (!dragging && Math.hypot(pointerWorld.x - downWorld.x, pointerWorld.y - downWorld.y) > 9) {
        dragging = true;
      }
      if (dragging) {
        const last = dragPoints[dragPoints.length - 1];
        if (!last || Math.hypot(pointerWorld.x - last.x, pointerWorld.y - last.y) > CONFIG.pathSampleDist) {
          dragPoints.push({ ...pointerWorld });
        }
      }
    }
  }

  function onMouseUp(e: MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if (e.button === 2) return;

    if (downPlaneId != null) {
      const state = getState();
      if (dragging && dragPoints.length > 0) {
        // drag released: onto a runway => clear to land; else => vector along the path
        const rw = runwayAt(pointerWorld);
        if (rw) assignApproach(state, downPlaneId, rw.id);
        else setPath(state, downPlaneId, dragPoints);
        selectedId = downPlaneId;
      } else {
        // a click (no drag) selects the plane
        selectedId = downPlaneId;
      }
    }
    downPlaneId = null;
    downWorld = null;
    dragging = false;
    dragPoints = [];
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
    let drag: RenderHints['drag'] = null;

    if (pointerWorld && state.status === 'playing') {
      const hp = planeAt(pointerWorld);
      hoverAircraftId = hp ? hp.id : null;
      const hr = runwayAt(pointerWorld);
      hoverRunwayId = hr ? hr.id : null;

      if (dragging && downPlaneId != null && dragPoints.length > 0) {
        const rw = runwayAt(pointerWorld);
        drag = {
          fromAircraftId: downPlaneId,
          points: [...dragPoints, pointerWorld],
          snapRunwayId: rw ? rw.id : null,
          valid: true,
        };
      }
    }

    return { pointerWorld, hoverAircraftId, hoverRunwayId, selectedAircraftId: validSelected(), drag };
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
