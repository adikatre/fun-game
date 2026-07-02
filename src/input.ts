// input.ts — translates pointer/keyboard into player actions on the sim.
// Never advances time; only issues commands (legal while paused) and produces
// RenderHints. Pointer events cover mouse AND touch: drag a plane onto a runway
// side (or tap a plane, then tap the side) to clear it to land from that end;
// right-click or double-tap = hold; Space = pause; M = mute; R = restart.

import { commandToRunway, toggleHold } from './sim';
import type { Aircraft, GameState, RenderHints, Vec, Viewport } from './types';
import { buttonAt, endButtons, hudButtons, type UiButton, type UiContext } from './ui';

export interface UiActions {
  startShift(): void; // leave the briefing screen
  nextShift(): void; // debrief -> next (harder) day
  retryShift(): void; // debrief/fired -> replay this day
  restartKey(): void; // R
  togglePause(): void;
  toggleMute(): void;
  commandFeedback(): void; // small UI blip (select / button press)
  unlockAudio(): void; // call on every user gesture
  getMuted(): boolean;
  getBest(): number;
}

export interface InputContext {
  canvas: HTMLCanvasElement;
  getState: () => GameState;
  getViewport: () => Viewport;
  actions: UiActions;
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
  const { canvas, getState, getViewport, actions } = ctx;

  let pointerScreen: Vec | null = null;
  let pointerWorld: Vec | null = null;
  let selectedId: number | null = null;

  let downPlaneId: number | null = null;
  let downWorld: Vec | null = null;
  let dragging = false;

  // double-tap detection (touch-friendly hold command)
  let lastTapTime = 0;
  let lastTapPlaneId: number | null = null;

  const toScreen = (e: { clientX: number; clientY: number }): Vec => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const screenToWorld = (p: Vec): Vec => {
    const vp = getViewport();
    return { x: (p.x - vp.offsetX) / vp.scale, y: (p.y - vp.offsetY) / vp.scale };
  };

  function uiCtx(): UiContext {
    const state = getState();
    const sel = selectedId != null ? state.aircraft.find((a) => a.id === selectedId) : undefined;
    const selAirborne = !!sel && (sel.phase === 'inbound' || sel.phase === 'holding' || sel.phase === 'approach');
    return {
      paused: state.paused,
      muted: actions.getMuted(),
      status: state.status,
      selectedAirborne: selAirborne,
      selectedHolding: !!sel && sel.phase === 'holding',
    };
  }
  function allButtons(): UiButton[] {
    const state = getState();
    const vp = getViewport();
    return [...hudButtons(vp, uiCtx()), ...endButtons(vp, state.status)];
  }

  function pressButton(b: UiButton): void {
    actions.commandFeedback();
    const state = getState();
    switch (b.id) {
      case 'pause':
        actions.togglePause();
        break;
      case 'mute':
        actions.toggleMute();
        break;
      case 'hold':
        if (selectedId != null) toggleHold(state, selectedId);
        break;
      case 'primary':
        actions.nextShift();
        selectedId = null;
        break;
      case 'retry':
        actions.retryShift();
        selectedId = null;
        break;
    }
  }

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

  // --- pointer (mouse + touch) ---
  function onPointerDown(e: PointerEvent | MouseEvent): void {
    actions.unlockAudio();
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if ((e as MouseEvent).button === 2) return;
    const state = getState();

    // menu screens: buttons, or anywhere to start
    if (state.status === 'briefing') {
      actions.commandFeedback();
      actions.startShift();
      return;
    }
    if (state.status === 'debrief' || state.status === 'fired') {
      const b = buttonAt(allButtons(), pointerScreen.x, pointerScreen.y);
      if (b) pressButton(b);
      return;
    }

    // in-game HUD buttons take priority over the scope
    const b = buttonAt(allButtons(), pointerScreen.x, pointerScreen.y);
    if (b) {
      pressButton(b);
      return;
    }

    const plane = planeAt(pointerWorld);
    if (plane) {
      // double-tap/double-click a plane -> hold
      const now = Date.now();
      if (lastTapPlaneId === plane.id && now - lastTapTime < 350) {
        toggleHold(state, plane.id);
        lastTapTime = 0;
        lastTapPlaneId = null;
      } else {
        lastTapTime = now;
        lastTapPlaneId = plane.id;
      }
      downPlaneId = plane.id;
      downWorld = pointerWorld;
      dragging = false;
      return;
    }
    lastTapPlaneId = null;

    // empty / runway click acts on the current selection
    const sel = validSelected();
    if (sel != null) {
      const re = runwayEndAt(pointerWorld);
      if (re) commandToRunway(state, sel, re.runwayId, re.end);
      else selectedId = null; // tap on empty space deselects
    } else {
      selectedId = null;
    }
  }

  function onPointerMove(e: PointerEvent | MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if (downPlaneId != null && downWorld && !dragging) {
      if (Math.hypot(pointerWorld.x - downWorld.x, pointerWorld.y - downWorld.y) > 9) dragging = true;
    }
  }

  function onPointerUp(e: PointerEvent | MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if ((e as MouseEvent).button === 2) return;

    if (downPlaneId != null) {
      const state = getState();
      if (dragging) {
        // released on a runway side => land (if airborne) or take off (if parked)
        const re = runwayEndAt(pointerWorld);
        if (re) commandToRunway(state, downPlaneId, re.runwayId, re.end);
        selectedId = downPlaneId;
      } else {
        selectedId = downPlaneId; // a tap selects
        actions.commandFeedback();
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
    if (state.status !== 'playing') return;
    const plane = planeAt(world);
    if (plane) toggleHold(state, plane.id);
  }

  // --- keyboard ---
  function onKeyDown(e: KeyboardEvent): void {
    const state = getState();
    if (e.code === 'Space') {
      e.preventDefault();
      actions.unlockAudio();
      if (state.status === 'briefing') actions.startShift();
      else if (state.status === 'playing') actions.togglePause();
      else actions.retryShift();
      return;
    }
    if (e.code === 'KeyM') {
      actions.toggleMute();
      return;
    }
    if (e.code === 'KeyR') {
      actions.restartKey();
      selectedId = null;
    }
  }

  // --- render hints ---
  function hints(): RenderHints {
    const state = getState();
    let hoverAircraftId: number | null = null;
    let hoverRunwayId: number | null = null;
    let hoverEnd: 0 | 1 | null = null;
    let hoverButtonId: string | null = null;
    let drag: RenderHints['drag'] = null;

    if (pointerScreen) {
      const hb = buttonAt(allButtons(), pointerScreen.x, pointerScreen.y);
      hoverButtonId = hb ? hb.id : null;
    }

    if (pointerWorld && state.status === 'playing' && hoverButtonId == null) {
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

    return {
      pointerWorld,
      hoverAircraftId,
      hoverRunwayId,
      hoverEnd,
      selectedAircraftId: validSelected(),
      drag,
      hoverButtonId,
      muted: actions.getMuted(),
      best: actions.getBest(),
    };
  }

  canvas.addEventListener('pointerdown', onPointerDown as EventListener);
  window.addEventListener('pointermove', onPointerMove as EventListener);
  window.addEventListener('pointerup', onPointerUp as EventListener);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);

  return {
    hints,
    pointerScreen: () => pointerScreen,
    dispose: () => {
      canvas.removeEventListener('pointerdown', onPointerDown as EventListener);
      window.removeEventListener('pointermove', onPointerMove as EventListener);
      window.removeEventListener('pointerup', onPointerUp as EventListener);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}
