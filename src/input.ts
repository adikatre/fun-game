// input.ts — translates pointer/keyboard into player actions on the sim.
// Never advances time; only issues commands and produces RenderHints. Pointer
// events cover mouse AND touch: drag a plane onto a runway side (or tap a
// plane, then tap the side) to clear it to land from that end; right-click or
// double-tap = hold; Space/Esc = pause menu; M = mute; R = restart (press
// twice mid-shift). While paused the modal pause menu captures all input.

import { commandToRunway, toggleHold, commandGoAround, toggleManualHold, commandTakeoff, adjustAirborneSpeed } from './sim';
import type { Aircraft, CareerStats, GameState, RenderHints, Vec, Viewport } from './types';
import { AIRBORNE_PHASES } from './types';
import { buttonAt, endButtons, hudButtons, upgradeButtons, floatingButtons, menuButtons, statsButtons, settingsButtons, pauseButtons, type UiButton, type UiContext } from './ui';
import { upgradeAtPoint, upgradeScrollMax } from './upgrade-layout';
import { type UpgradeState } from './upgrades';
import { sdk, FULL_LAUNCH } from './sdk';

export interface UiActions {
  startShift(): void; // leave the tutorial screen
  nextShift(): void; // debrief -> next (harder) day
  retryShift(): void; // debrief/fired -> replay this day
  restartKey(): void; // R
  togglePause(): void;
  toggleMute(): void;
  commandFeedback(): void; // small UI blip (select / button press)
  unlockAudio(): void; // call on every user gesture
  getMuted(): boolean;
  getBest(): number;
  showUpgrades(): void;
  purchaseUpgrade(id: string): void;
  authorizeCross(id: number): void;
  getUpgrades(): UpgradeState;
  goToMenu(): void;
  goToStats(): void;
  goToSettings(): void;
  goToTutorial(): void;
  playFromMenu(): void; // straight into a shift, or via the tutorial on first run
  quitToMenu(): void; // abandon the current shift (nothing is recorded)
  setVolume(v: number): void;
  getVolume(): number;
  setMusicVolume(v: number): void;
  getMusicVolume(): number;
  setSfxVolume(v: number): void;
  getSfxVolume(): number;
  resetCareer(): void;
  getCareerStats(): CareerStats;
  adContinue(): void;
  adDouble(): void;
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

  // new UI state
  let shopScrollY = 0;
  let confirmingReset = false;
  let volumeSliderDragging: number | null = null; // slider row being dragged
  let tutorialReadOnly = false; // HOW TO PLAY from the menu (returns instead of starting)
  let restartArmedUntil = 0; // restart needs a second press within this window
  const restartArmed = () => Date.now() < restartArmedUntil;

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
    const selAirborneSpeed = !!sel && AIRBORNE_PHASES.includes(sel.phase);
    const selTaxi = !!sel && (sel.phase === 'taxiIn' || sel.phase === 'taxiOut');
    
    let selectedScreenPos: Vec | undefined;
    if (sel) {
      const vp = getViewport();
      selectedScreenPos = { x: sel.x * vp.scale + vp.offsetX, y: sel.y * vp.scale + vp.offsetY };
    }
    
    return {
      paused: state.paused,
      muted: actions.getMuted(),
      status: state.status,
      selectedAirborne: selAirborne,
      selectedAirborneSpeed: selAirborneSpeed,
      selectedHolding: !!sel && sel.phase === 'holding',
      selectedWaitCross: !!sel && sel.phase === 'waitCross',
      selectedTaxi: selTaxi,
      selectedTakeoff: !!sel && sel.phase === 'lineUpWait',
      selectedManualHold: sel?.manualHold,
      selectedScreenPos,
    };
  }
  function allButtons(): UiButton[] {
    const state = getState();
    const vp = getViewport();
    if (state.status === 'menu') return menuButtons(vp);
    if (state.status === 'stats') return statsButtons(vp);
    if (state.status === 'settings') return settingsButtons(vp, confirmingReset, actions.getMuted());
    if (state.status === 'upgrade') return upgradeButtons(vp);
    // the pause menu is modal: while it is up, it owns every button on screen
    if (state.status === 'playing' && state.paused) return pauseButtons(vp, restartArmed(), actions.getMuted());
    const uictx = uiCtx();
    return [...hudButtons(vp, uictx), ...endButtons(vp, state), ...floatingButtons(vp, uictx)];
  }

  function measureCtx(): CanvasRenderingContext2D {
    return canvas.getContext('2d')!;
  }

  function upgradeAt(sx: number, sy: number): string | null {
    const vp = getViewport();
    const ups = actions.getUpgrades();
    const id = upgradeAtPoint(measureCtx(), vp, shopScrollY, ups, sx, sy);
    return id;
  }

  /** Volume slider geometry helpers. Row 0 = master, 1 = music, 2 = sfx. */
  function sliderGeom(row: number) {
    const vp = getViewport();
    // Must mirror drawSettingsScreen in render.ts so the hit area sits on the track.
    const cx = vp.cssW / 2;
    const volCardW = Math.min(440, vp.cssW - 24);
    const volCardX = cx - volCardW / 2;
    const volCardY = vp.cssH / 2 - 230;
    const sliderWidth = Math.min(300, volCardW - 118);
    const sliderLeft = volCardX + 24;
    const sliderY = volCardY + 60 + row * 62 + 4; // track centerline (track y + half of 8px height)
    const sliderH = 36; // hit-test height around the track
    return { sliderLeft, sliderWidth, sliderY, sliderH };
  }
  function volumeFromX(px: number, row: number): number {
    const { sliderLeft, sliderWidth } = sliderGeom(row);
    return Math.max(0, Math.min(1, (px - sliderLeft) / sliderWidth));
  }
  /** Which slider row is under the point, or null. */
  function sliderRowAt(sx: number, sy: number): number | null {
    for (let row = 0; row < 3; row++) {
      const { sliderLeft, sliderWidth, sliderY, sliderH } = sliderGeom(row);
      if (sx >= sliderLeft && sx <= sliderLeft + sliderWidth &&
          sy >= sliderY - sliderH / 2 && sy <= sliderY + sliderH / 2) return row;
    }
    return null;
  }
  function applySliderVolume(row: number, v: number): void {
    if (row === 0) actions.setVolume(v);
    else if (row === 1) actions.setMusicVolume(v);
    else actions.setSfxVolume(v);
  }

  function pressButton(b: UiButton): void {
    actions.commandFeedback();
    if (b.id !== 'pause_restart') restartArmedUntil = 0;
    const state = getState();
    switch (b.id) {
      case 'pause':
      case 'pause_resume':
        actions.togglePause();
        break;
      case 'pause_restart':
        if (restartArmed()) {
          restartArmedUntil = 0;
          actions.retryShift();
          selectedId = null;
        } else {
          restartArmedUntil = Date.now() + 3000;
        }
        break;
      case 'pause_sound':
        actions.toggleMute();
        break;
      case 'pause_quit':
        actions.quitToMenu();
        selectedId = null;
        break;
      case 'mute':
        actions.toggleMute();
        break;
      case 'hold':
        if (selectedId != null) toggleHold(state, selectedId);
        break;
      case 'cross':
        if (selectedId != null) actions.authorizeCross(selectedId);
        break;
      case 'primary':
        if (state.status === 'debrief') {
          shopScrollY = 0;
          actions.showUpgrades();
        } else if (FULL_LAUNCH) {
          sdk.requestMidgameAd(() => { actions.nextShift(); }, () => {});
        } else {
          actions.nextShift();
        }
        selectedId = null;
        break;
      case 'shop_done':
        // Midgame ads are disabled in Basic Launch; advance without gating.
        if (FULL_LAUNCH) sdk.requestMidgameAd(() => { actions.nextShift(); }, () => {});
        else actions.nextShift();
        selectedId = null;
        break;
      case 'retry':
        actions.retryShift();
        selectedId = null;
        break;
      case 'takeoff':
        if (selectedId != null) commandTakeoff(state, selectedId);
        selectedId = null;
        break;
      case 'go_around':
        if (selectedId != null) commandGoAround(state, selectedId);
        break;
      case 'speed_slower':
        if (selectedId != null) adjustAirborneSpeed(state, selectedId, false);
        break;
      case 'speed_faster':
        if (selectedId != null) adjustAirborneSpeed(state, selectedId, true);
        break;
      case 'taxi_hold':
      case 'taxi_continue':
        if (selectedId != null) toggleManualHold(state, selectedId);
        break;
      // --- new menu/stats/settings buttons ---
      case 'menu_play':
        tutorialReadOnly = false;
        actions.playFromMenu();
        break;
      case 'menu_stats':
        actions.goToStats();
        break;
      case 'menu_settings':
        actions.goToSettings();
        break;
      case 'menu_tutorial':
        tutorialReadOnly = true;
        actions.goToTutorial();
        break;
      case 'stats_back':
        actions.goToMenu();
        break;
      case 'settings_back':
        confirmingReset = false;
        actions.goToMenu();
        break;
      case 'settings_mute':
        actions.toggleMute();
        break;
      case 'settings_reset':
        confirmingReset = true;
        break;
      case 'settings_reset_confirm':
        actions.resetCareer();
        confirmingReset = false;
        break;
      case 'settings_reset_cancel':
        confirmingReset = false;
        break;
      case 'ad_continue':
        actions.adContinue();
        break;
      case 'ad_double':
        actions.adDouble();
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

    // menu screens: only handle buttons (and volume slider for settings)
    if (state.status === 'menu' || state.status === 'stats') {
      const b = buttonAt(allButtons(), pointerScreen.x, pointerScreen.y);
      if (b) pressButton(b);
      return;
    }

    if (state.status === 'settings') {
      // Check volume sliders first
      const row = sliderRowAt(pointerScreen.x, pointerScreen.y);
      if (row != null) {
        volumeSliderDragging = row;
        applySliderVolume(row, volumeFromX(pointerScreen.x, row));
        return;
      }
      const b = buttonAt(allButtons(), pointerScreen.x, pointerScreen.y);
      if (b) pressButton(b);
      return;
    }

    // tutorial: click anywhere to start (or return, if opened via HOW TO PLAY)
    if (state.status === 'tutorial') {
      actions.commandFeedback();
      if (tutorialReadOnly) actions.goToMenu();
      else actions.startShift();
      return;
    }
    
    if (state.status === 'upgrade') {
      const b = buttonAt(allButtons(), pointerScreen.x, pointerScreen.y);
      if (b) pressButton(b);
      else {
        const upId = upgradeAt(pointerScreen.x, pointerScreen.y);
        if (upId) actions.purchaseUpgrade(upId);
      }
      return;
    }

    if (state.status === 'debrief' || state.status === 'fired') {
      const b = buttonAt(endButtons(getViewport(), state), pointerScreen.x, pointerScreen.y);
      if (b) pressButton(b);
      return;
    }

    // in-game HUD buttons take priority over the scope
    const b = buttonAt(allButtons(), pointerScreen.x, pointerScreen.y);
    if (b) {
      pressButton(b);
      return;
    }

    // the pause menu is modal: clicks outside its buttons do nothing
    if (state.paused) return;

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

    // Volume slider dragging
    if (volumeSliderDragging != null) {
      applySliderVolume(volumeSliderDragging, volumeFromX(pointerScreen.x, volumeSliderDragging));
      return;
    }

    if (downPlaneId != null && downWorld && !dragging) {
      if (Math.hypot(pointerWorld.x - downWorld.x, pointerWorld.y - downWorld.y) > 9) dragging = true;
    }
  }

  function onPointerUp(e: PointerEvent | MouseEvent): void {
    pointerScreen = toScreen(e);
    pointerWorld = screenToWorld(pointerScreen);
    if ((e as MouseEvent).button === 2) return;

    // Release volume slider drag
    if (volumeSliderDragging != null) {
      volumeSliderDragging = null;
      return;
    }

    if (downPlaneId != null) {
      const state = getState();
      if (state.paused) {
        // pause opened mid-gesture: swallow the release
        downPlaneId = null;
        downWorld = null;
        dragging = false;
        return;
      }
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
    if (state.status !== 'playing' || state.paused) return;
    const plane = planeAt(world);
    if (plane) toggleHold(state, plane.id);
  }

  function onWheel(e: WheelEvent): void {
    const state = getState();
    if (state.status === 'upgrade') {
      e.preventDefault();
      shopScrollY += e.deltaY;
      const maxScroll = upgradeScrollMax(measureCtx(), getViewport(), actions.getUpgrades());
      shopScrollY = Math.max(0, Math.min(maxScroll, shopScrollY));
    }
  }

  // --- keyboard ---
  function onKeyDown(e: KeyboardEvent): void {
    const state = getState();
    if (e.code === 'Space') {
      e.preventDefault();
      actions.unlockAudio();
      if (state.status === 'tutorial') {
        if (tutorialReadOnly) actions.goToMenu();
        else actions.startShift();
      } else if (state.status === 'playing') {
        restartArmedUntil = 0;
        actions.togglePause();
      } else if (state.status === 'debrief' || state.status === 'fired') {
        actions.retryShift();
      }
      return;
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      if (state.status === 'playing') {
        restartArmedUntil = 0;
        actions.togglePause();
      } else if (state.status === 'tutorial') {
        if (tutorialReadOnly) actions.goToMenu();
        else actions.startShift();
      } else if (state.status === 'stats' || state.status === 'settings') {
        confirmingReset = false;
        actions.goToMenu();
      }
      return;
    }
    if (e.code === 'KeyM') {
      actions.toggleMute();
      return;
    }
    if (e.code === 'KeyR') {
      if (state.status === 'playing') {
        // an in-progress shift needs a second press to confirm
        if (restartArmed()) {
          restartArmedUntil = 0;
          actions.restartKey();
          selectedId = null;
        } else {
          restartArmedUntil = Date.now() + 3000;
          actions.commandFeedback();
        }
      } else if (state.status === 'debrief' || state.status === 'fired') {
        actions.restartKey();
        selectedId = null;
      }
    }
  }

  // --- render hints ---
  function hints(): RenderHints {
    const state = getState();
    let hoverAircraftId: number | null = null;
    let hoverRunwayId: number | null = null;
    let hoverEnd: 0 | 1 | null = null;
    let hoverButtonId: string | null = null;
    let hoverUpgradeId: string | null = null;
    let drag: RenderHints['drag'] = null;

    if (pointerScreen) {
      const hb = buttonAt(allButtons(), pointerScreen.x, pointerScreen.y);
      hoverButtonId = hb ? hb.id : null;
      if (state.status === 'upgrade') {
        const hu = upgradeAt(pointerScreen.x, pointerScreen.y);
        if (hu) hoverUpgradeId = hu;
      }
    }

    if (pointerWorld && state.status === 'playing' && !state.paused && hoverButtonId == null) {
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
      hoverUpgradeId,
      muted: actions.getMuted(),
      best: actions.getBest(),
      upgrades: actions.getUpgrades(),
      shopScrollY,
      confirmingReset,
      restartArmed: restartArmed(),
      tutorialReadOnly,
      volume: actions.getVolume(),
      musicVolume: actions.getMusicVolume(),
      sfxVolume: actions.getSfxVolume(),
      careerStats: actions.getCareerStats(),
    };
  }

  canvas.addEventListener('pointerdown', onPointerDown as EventListener);
  window.addEventListener('pointermove', onPointerMove as EventListener);
  window.addEventListener('pointerup', onPointerUp as EventListener);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);

  return {
    hints,
    pointerScreen: () => pointerScreen,
    dispose: () => {
      canvas.removeEventListener('pointerdown', onPointerDown as EventListener);
      window.removeEventListener('pointermove', onPointerMove as EventListener);
      window.removeEventListener('pointerup', onPointerUp as EventListener);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}
