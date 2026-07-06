// render.ts — draws a GameState with a clean pastel/soft aesthetic.
// No game logic, no mutation. Aircraft motion is interpolated between sim ticks
// via `alpha`. `nowSec` is wall-clock time for cosmetic animation.

import { CONFIG, PALETTE, MENU_PALETTE, dayDifficulty } from './config';
import type { Fx } from './fx';
import { approachCountOnCorridor } from './sim';
import { AIRBORNE_PHASES } from './types';
import type { Aircraft, CareerStats, GameState, RenderHints, Runway, Viewport, Vec } from './types';
import { UPGRADE_DEFS, isUnlocked, canPurchase } from './upgrades';
import { TIER_DEFS, UPGRADE_HEADER_H, UPGRADE_BOTTOM_BAR_H, upgradeCardWidth, upgradeCardHeight } from './upgrade-layout';
import { drawFittedText, drawFittedTextLeft, drawWrappedText, measureWrappedLines, truncateText } from './text';
import { endButtons, hudButtons, upgradeButtons, menuButtons, statsButtons, settingsButtons, floatingButtons, type UiButton, type UiContext } from './ui';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function typeHalfSize(t: Aircraft['type']): number {
  return t === 'heavy' ? 12 : t === 'medium' ? 9.5 : 7.5;
}

function uiContext(state: GameState, hints: RenderHints, vp: Viewport, alpha: number): UiContext {
  const sel = hints.selectedAircraftId != null ? state.aircraft.find((a) => a.id === hints.selectedAircraftId) : undefined;
  const selAirborne = !!sel && (sel.phase === 'inbound' || sel.phase === 'holding' || sel.phase === 'approach');
  const selTaxi = !!sel && (sel.phase === 'taxiIn' || sel.phase === 'taxiOut');
  
  let selectedScreenPos: Vec | undefined;
  if (sel) {
    const x = lerp(sel.ppx, sel.px, alpha);
    const y = lerp(sel.ppy, sel.py, alpha);
    selectedScreenPos = { x: x * vp.scale + vp.offsetX, y: y * vp.scale + vp.offsetY };
  }
  
  return {
    paused: state.paused,
    muted: hints.muted,
    status: state.status,
    selectedAirborne: selAirborne,
    selectedHolding: !!sel && sel.phase === 'holding',
    selectedWaitCross: !!sel && sel.phase === 'waitCross',
    selectedTaxi: selTaxi,
    selectedTakeoff: !!sel && sel.phase === 'lineUpWait',
    selectedManualHold: sel?.manualHold,
    selectedScreenPos,
  };
}

/** All buttons currently on screen (render + input share this). */
export function visibleButtons(state: GameState, vp: Viewport, hints: RenderHints, alpha: number = 1): UiButton[] {
  if (state.status === 'upgrade') return upgradeButtons(vp);
  if (state.status === 'menu') return menuButtons(vp);
  if (state.status === 'stats') return statsButtons(vp);
  if (state.status === 'settings') return settingsButtons(vp, (hints as any).confirmingReset ?? false);
  const uictx = uiContext(state, hints, vp, alpha);
  return [...hudButtons(vp, uictx), ...endButtons(vp, state), ...floatingButtons(vp, uictx)];
}

// ----------------------------------------------------------------------------

export function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  alpha: number,
  vp: Viewport,
  hints: RenderHints,
  fx: Fx,
  nowSec: number,
): void {
  // clear with bg color
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);

  ctx.save();
  // screen shake
  let sx = 0;
  let sy = 0;
  if (fx.shake > 0.2) {
    sx = Math.sin(nowSec * 61) * fx.shake;
    sy = Math.cos(nowSec * 53) * fx.shake;
  }
  ctx.translate(vp.offsetX + sx * vp.scale, vp.offsetY + sy * vp.scale);
  ctx.scale(vp.scale, vp.scale);

  // world layers
  drawTerrainHints(ctx);
  drawRangeRings(ctx);
  drawWeather(ctx, state, nowSec);
  for (const rw of state.runways) drawRunway(ctx, rw, state, hints, nowSec);
  drawGates(ctx, state);
  drawSelectedPath(ctx, state, hints);
  drawDragPreview(ctx, state, hints);
  for (const ac of state.aircraft) drawTrailAndVector(ctx, ac, alpha);
  drawPredicted(ctx, state, alpha, nowSec);
  for (const ac of state.aircraft) drawAircraft(ctx, ac, alpha, state, hints, nowSec);
  drawConflicts(ctx, state, alpha, nowSec);
  drawCrashFx(ctx, state);
  drawPopups(ctx, fx);

  ctx.restore();

  // full-screen incident flash
  if (fx.flash > 0.01) {
    ctx.fillStyle = `rgba(232,84,84,${(fx.flash * 0.4).toFixed(3)})`;
    ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  }

  // screen-space HUD
  if (state.status === 'playing') {
    drawHud(ctx, state, vp, fx, nowSec);
    drawInboundStrip(ctx, state, vp, hints);
    drawHelp(ctx, vp);
    drawBanner(ctx, fx, vp, nowSec);
    if (state.showHint) drawHint(ctx, vp);
    else if (state.paused) drawPausedBanner(ctx, vp);
  }

  if (state.status === 'tutorial') drawTutorial(ctx, state, vp, hints, nowSec);
  else if (state.status === 'debrief') drawDebrief(ctx, state, vp, hints, nowSec);
  else if (state.status === 'fired') drawFired(ctx, state, vp, hints, nowSec);
  else if (state.status === 'upgrade') drawUpgradeScreen(ctx, state, vp, hints, nowSec);
  else if (state.status === 'menu') drawMainMenu(ctx, state, vp, hints, nowSec);
  else if (state.status === 'stats') drawStatsScreen(ctx, vp, hints, nowSec);
  else if (state.status === 'settings') drawSettingsScreen(ctx, vp, hints, nowSec);

  drawButtons(ctx, state, vp, hints, alpha);
}

// ----------------------------------------------------------------------------
// world layers
// ----------------------------------------------------------------------------

function drawTerrainHints(ctx: CanvasRenderingContext2D): void {
  // Subtle terrain patches to make the world feel alive
  ctx.fillStyle = PALETTE.terrain;
  // parks / green areas
  roundRectPath(ctx, 100, 80, 180, 120, 30);
  ctx.fill();
  roundRectPath(ctx, 1200, 700, 200, 150, 25);
  ctx.fill();
  roundRectPath(ctx, 1350, 100, 120, 90, 20);
  ctx.fill();
  // water
  ctx.fillStyle = PALETTE.water;
  ctx.beginPath();
  ctx.ellipse(200, 800, 120, 60, 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(1400, 350, 80, 50, -0.3, 0, Math.PI * 2);
  ctx.fill();
  // city blocks
  ctx.fillStyle = PALETTE.cityBlock;
  for (const b of [
    [350, 120, 60, 50], [420, 140, 45, 40], [380, 180, 55, 35],
    [1100, 150, 50, 45], [1160, 130, 40, 55],
    [350, 750, 55, 45], [420, 770, 40, 35],
  ] as [number, number, number, number][]) {
    roundRectPath(ctx, b[0], b[1], b[2], b[3], 4);
    ctx.fill();
  }
}

function drawRangeRings(ctx: CanvasRenderingContext2D): void {
  const cx = CONFIG.airportX;
  const cy = CONFIG.airportY;
  ctx.save();
  ctx.strokeStyle = PALETTE.ring;
  ctx.lineWidth = 1;
  for (const r of [160, 320, 480, 640]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWeather(ctx: CanvasRenderingContext2D, state: GameState, nowSec: number): void {
  for (const w of state.weather) {
    const fade = Math.min(1, w.ttl / 10);
    ctx.save();
    ctx.globalAlpha = fade * 0.5;
    // cloud shape: overlapping circles
    ctx.fillStyle = PALETTE.weatherCell;
    const wobble = Math.sin(nowSec * 0.5 + w.id) * 3;
    ctx.beginPath();
    ctx.arc(w.x + wobble, w.y, w.radius * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w.x - w.radius * 0.3, w.y - w.radius * 0.2, w.radius * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w.x + w.radius * 0.4, w.y - w.radius * 0.15, w.radius * 0.55, 0, Math.PI * 2);
    ctx.fill();
    // rain streaks
    ctx.strokeStyle = PALETTE.weatherRain;
    ctx.lineWidth = 1;
    const t = (nowSec * 30) % 20;
    for (let i = 0; i < 8; i++) {
      const rx = w.x - w.radius * 0.5 + (i / 8) * w.radius;
      const ry = w.y + w.radius * 0.3 + ((t + i * 7) % 20);
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx - 2, ry + 8);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawRunway(
  ctx: CanvasRenderingContext2D,
  rw: Runway,
  state: GameState,
  hints: RenderHints,
  nowSec: number,
): void {
  const busy = state.time < rw.occupiedUntil;
  const pulse = 0.55 + 0.45 * Math.sin(nowSec * 4);

  // both approach corridors (dashed), each from its threshold out to its finalEntry
  for (let e = 0; e < 2; e++) {
    const end = rw.ends[e];
    const approachCount = approachCountOnCorridor(state, rw.id, e as 0 | 1);
    const targeted =
      (hints.hoverRunwayId === rw.id && hints.hoverEnd === e) ||
      (hints.drag?.targetRunwayId === rw.id && hints.drag?.targetEnd === e);
    ctx.save();
    const stacked = approachCount >= 2;
    const corridorTaken = approachCount >= 1;
    if (targeted) {
      ctx.setLineDash([5, 10]);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = PALETTE.blip;
    } else if (stacked) {
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(232,160,48,${(0.45 + 0.45 * pulse).toFixed(3)})`;
    } else if (corridorTaken) {
      ctx.setLineDash([]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = PALETTE.corridorBusy;
    } else {
      ctx.setLineDash([5, 10]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = busy ? PALETTE.corridorBusy : PALETTE.corridorFree;
    }
    ctx.beginPath();
    ctx.moveTo(end.threshold.x, end.threshold.y);
    ctx.lineTo(end.finalEntry.x, end.finalEntry.y);
    ctx.stroke();
    // arrowhead at the threshold pointing the landing direction
    ctx.setLineDash([]);
    if (targeted) {
      const a = end.dir;
      ctx.beginPath();
      ctx.moveTo(end.threshold.x, end.threshold.y);
      ctx.lineTo(end.threshold.x - Math.cos(a - 0.4) * 14, end.threshold.y - Math.sin(a - 0.4) * 14);
      ctx.moveTo(end.threshold.x, end.threshold.y);
      ctx.lineTo(end.threshold.x - Math.cos(a + 0.4) * 14, end.threshold.y - Math.sin(a + 0.4) * 14);
      ctx.strokeStyle = PALETTE.blip;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    if (corridorTaken) {
      ctx.beginPath();
      ctx.arc(end.threshold.x, end.threshold.y, 16, 0, Math.PI * 2);
      ctx.strokeStyle = stacked
        ? `rgba(232,160,48,${(0.5 + 0.4 * pulse).toFixed(3)})`
        : `rgba(230,160,60,${(0.35 + 0.25 * pulse).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  // runway strip
  ctx.save();
  ctx.translate(rw.cx, rw.cy);
  ctx.rotate(rw.angle);

  // shadow
  ctx.shadowColor = PALETTE.panelShadow;
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  roundRectPath(ctx, -rw.length / 2, -rw.width / 2, rw.length, rw.width, 4);
  ctx.fillStyle = PALETTE.runway;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = busy ? PALETTE.corridorBusy : PALETTE.runwayEdge;
  ctx.stroke();

  // Threshold markings (piano keys) and aiming points
  ctx.fillStyle = PALETTE.runwayCenter;
  for (const sign of [-1, 1]) {
    const endX = sign * (rw.length / 2);
    // Piano keys at the threshold
    for (let i = 0; i < 4; i++) {
      const yOffset = -rw.width / 2 + 5 + i * ((rw.width - 10) / 3);
      const w = 12;
      const x = sign === 1 ? endX - w - 2 : endX + 2;
      ctx.fillRect(x, yOffset - 1.5, w, 3);
    }
    // Aiming point markers (touchdown zone)
    const aimW = 20;
    const aimX = sign === 1 ? endX - aimW - 35 : endX + 35;
    ctx.fillRect(aimX, -rw.width / 2 + 5, aimW, 4);
    ctx.fillRect(aimX, rw.width / 2 - 9, aimW, 4);
  }

  // center dashed line (avoiding thresholds)
  ctx.setLineDash([10, 8]);
  ctx.strokeStyle = PALETTE.runwayCenter;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-rw.length / 2 + 60, 0);
  ctx.lineTo(rw.length / 2 - 60, 0);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // a label at each end
  ctx.font = '700 12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const end of rw.ends) {
    const endIdx = end === rw.ends[0] ? 0 : 1;
    const corridorTaken = approachCountOnCorridor(state, rw.id, endIdx as 0 | 1) >= 1;
    ctx.fillStyle = corridorTaken || busy ? PALETTE.warn : PALETTE.ringText;
    ctx.fillText(end.name, end.threshold.x + Math.cos(end.dir + Math.PI) * 18, end.threshold.y - 16);
  }
}

function drawSelectedPath(ctx: CanvasRenderingContext2D, state: GameState, hints: RenderHints): void {
  const id = hints.selectedAircraftId;
  if (id == null) return;
  const ac = state.aircraft.find((a) => a.id === id);
  if (!ac || ac.waypoints.length === 0) return;
  ctx.save();
  ctx.setLineDash([3, 8]);
  ctx.strokeStyle = 'rgba(74,144,217,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ac.x, ac.y);
  for (const wp of ac.waypoints) ctx.lineTo(wp.x, wp.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawDragPreview(ctx: CanvasRenderingContext2D, state: GameState, hints: RenderHints): void {
  const drag = hints.drag;
  if (!drag) return;
  const ac = state.aircraft.find((a) => a.id === drag.fromAircraftId);
  if (!ac) return;
  const onTarget = drag.targetRunwayId != null;
  const isArrival = ac.phase === 'inbound' || ac.phase === 'holding' || ac.phase === 'approach';
  const corridorBusy =
    onTarget &&
    isArrival &&
    drag.targetRunwayId != null &&
    drag.targetEnd != null &&
    approachCountOnCorridor(state, drag.targetRunwayId, drag.targetEnd, drag.fromAircraftId) >= 1;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.setLineDash([3, 8]);
  ctx.strokeStyle = corridorBusy ? PALETTE.warn : onTarget ? PALETTE.blip : 'rgba(74,144,217,0.5)';
  ctx.lineWidth = onTarget ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(ac.x, ac.y);
  ctx.lineTo(drag.toX, drag.toY);
  ctx.stroke();
  ctx.setLineDash([]);
  if (onTarget && drag.endName) {
    const verb =
      ac.phase === 'readyDep' || ac.phase === 'taxiOut' || ac.phase === 'holdShort' ? 'TAKE OFF' : 'LAND';
    ctx.fillStyle = corridorBusy ? PALETTE.warn : PALETTE.text;
    ctx.font = '700 13px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${verb} ${drag.endName}`, drag.toX + 14, drag.toY - 14);
  }
  ctx.restore();
}

function drawGates(ctx: CanvasRenderingContext2D, state: GameState): void {
  // terminal backdrop
  const gs = state.gates;
  if (gs.length) {
    // group gates by y position
    const rows = new Map<number, typeof gs>();
    for (const g of gs) {
      const ry = Math.round(g.y / 10) * 10;
      if (!rows.has(ry)) rows.set(ry, []);
      rows.get(ry)!.push(g);
    }
    for (const [, row] of rows) {
      const minX = Math.min(...row.map((g) => g.x)) - 18;
      const maxX = Math.max(...row.map((g) => g.x)) + 18;
      const gy = row[0].y;
      // terminal building
      ctx.shadowColor = PALETTE.panelShadow;
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 3;
      roundRectPath(ctx, minX, gy - 15, maxX - minX, 30, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.strokeStyle = 'rgba(100,120,160,0.2)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  for (const g of state.gates) {
    const occ = g.occupantId != null ? state.aircraft.find((a) => a.id === g.occupantId) : undefined;
    const ready = occ?.phase === 'readyDep';
    const atGate = occ?.phase === 'atGate';
    ctx.beginPath();
    roundRectPath(ctx, g.x - 7, g.y - 7, 14, 14, 3);
    ctx.fillStyle = ready ? PALETTE.gateReady : occ ? PALETTE.gateBusy : PALETTE.gateFree;
    ctx.globalAlpha = occ ? 0.6 : 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ready ? PALETTE.gateReady : occ ? PALETTE.gateBusy : 'rgba(90,192,107,0.3)';
    ctx.stroke();
    // turnaround progress arc
    if (atGate && occ) {
      const frac = 1 - occ.turnaround / CONFIG.turnaroundSeconds;
      ctx.beginPath();
      ctx.arc(g.x, g.y, 12, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.strokeStyle = PALETTE.gateBusy;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }
}

function drawTrailAndVector(ctx: CanvasRenderingContext2D, ac: Aircraft, alpha: number): void {
  if (!AIRBORNE_PHASES.includes(ac.phase)) return;

  // trail dots
  for (let i = 0; i < ac.trail.length; i++) {
    const a = (i / ac.trail.length) * 0.45;
    ctx.fillStyle = `rgba(74,144,217,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(ac.trail[i].x, ac.trail[i].y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  // heading vector
  const x = lerp(ac.ppx, ac.px, alpha);
  const y = lerp(ac.ppy, ac.py, alpha);
  const L = ac.speed * 1.7;
  ctx.strokeStyle = 'rgba(74,144,217,0.25)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(ac.heading) * L, y + Math.sin(ac.heading) * L);
  ctx.stroke();
}

function drawPredicted(ctx: CanvasRenderingContext2D, state: GameState, alpha: number, nowSec: number): void {
  if (state.predicted.length === 0) return;
  const pulse = 0.55 + 0.45 * Math.sin(nowSec * 4);
  ctx.save();
  for (const pc of state.predicted) {
    const a = state.aircraft.find((p) => p.id === pc.aId);
    const b = state.aircraft.find((p) => p.id === pc.bId);
    if (!a || !b) continue;
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = `rgba(232,160,48,${(0.4 * pulse).toFixed(3)})`;
    ctx.lineWidth = 1.3;
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.moveTo(lerp(p.ppx, p.px, alpha), lerp(p.ppy, p.py, alpha));
      ctx.lineTo(pc.x, pc.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // X marker
    ctx.strokeStyle = PALETTE.warn;
    ctx.globalAlpha = 0.5 + 0.5 * pulse;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(pc.x - 7, pc.y - 7);
    ctx.lineTo(pc.x + 7, pc.y + 7);
    ctx.moveTo(pc.x + 7, pc.y - 7);
    ctx.lineTo(pc.x - 7, pc.y + 7);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = PALETTE.warn;
    ctx.font = '700 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${pc.t.toFixed(0)}s`, pc.x + 11, pc.y - 11);
  }
  ctx.restore();
}

function drawAircraft(
  ctx: CanvasRenderingContext2D,
  ac: Aircraft,
  alpha: number,
  state: GameState,
  hints: RenderHints,
  nowSec: number,
): void {
  const x = lerp(ac.ppx, ac.px, alpha);
  const y = lerp(ac.ppy, ac.py, alpha);
  const selected = hints.selectedAircraftId === ac.id;
  const hover = hints.hoverAircraftId === ac.id;
  const emerg = ac.emergency !== 'none';
  const pulse = 0.5 + 0.5 * Math.sin(nowSec * 6);

  const isDep = ac.phase === 'taxiOut' || ac.phase === 'holdShort' || ac.phase === 'takeoff' || ac.phase === 'departing' || ac.phase === 'readyDep';
  const isGroundArrival = ac.phase === 'landing' || ac.phase === 'taxiIn' || ac.phase === 'atGate';
  const isWaiting = ac.phase === 'waitCross';

  let color: string = PALETTE.blip;
  if (ac.conflict) color = PALETTE.danger;
  else if (ac.emergency === 'medical') color = PALETTE.danger;
  else if (ac.emergency === 'lowFuel') color = PALETTE.warn;
  else if (ac.warn) color = PALETTE.warn;
  else if (isDep) color = PALETTE.departure;
  else if (ac.phase === 'readyDep') color = PALETTE.gateReady;
  else if (isGroundArrival) color = PALETTE.blipDim;
  else if (isWaiting) color = PALETTE.holdShort;

  // selection / emergency rings
  if (selected || hover) {
    ctx.strokeStyle = PALETTE.selected;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (emerg) {
    ctx.strokeStyle = ac.emergency === 'medical' ? PALETTE.danger : PALETTE.warn;
    ctx.globalAlpha = 0.4 + 0.6 * pulse;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (ac.phase === 'readyDep') {
    ctx.strokeStyle = PALETTE.gateReady;
    ctx.globalAlpha = 0.35 + 0.55 * pulse;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (isWaiting) {
    // pulsing amber ring for planes waiting to cross
    ctx.strokeStyle = PALETTE.holdShort;
    ctx.globalAlpha = 0.4 + 0.5 * pulse;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // "TAP TO CROSS" label
    ctx.fillStyle = PALETTE.holdShort;
    ctx.font = '700 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('TAP TO CROSS', x, y + 22);
  } else if (ac.warn && !ac.conflict) {
    ctx.strokeStyle = PALETTE.warn;
    ctx.globalAlpha = 0.25 + 0.35 * pulse;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // plane icon (filled triangle)
  const s = typeHalfSize(ac.type);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ac.heading);

  // shadow
  ctx.shadowColor = 'rgba(0,0,0,0.15)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;

  ctx.beginPath();
  ctx.moveTo(s, 0);
  ctx.lineTo(-s * 0.72, s * 0.62);
  ctx.lineTo(-s * 0.4, 0);
  ctx.lineTo(-s * 0.72, -s * 0.62);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.restore();

  // data block
  const showFull = selected || hover || emerg || ac.conflict || ac.warn;
  const tx = x + 15;
  const ty = y - 15;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (showFull) {
    // connection line
    ctx.strokeStyle = 'rgba(45,55,72,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + s, y - s);
    ctx.lineTo(tx - 2, ty + 2);
    ctx.stroke();
    // card background
    const cardW = 110;
    const cardH = 28;
    ctx.shadowColor = 'rgba(0,0,0,0.08)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;
    roundRectPath(ctx, tx - 4, ty - 14, cardW, cardH, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.font = '700 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = ac.conflict ? PALETTE.danger : emerg || ac.warn ? PALETTE.warn : PALETTE.text;
    ctx.fillText(truncateText(ctx, ac.callsign, cardW - 8), tx, ty);
    ctx.font = '500 9.5px Inter, system-ui, sans-serif';
    ctx.fillStyle = PALETTE.textDim;
    const tag = ac.emergency === 'medical' ? 'MAYDAY' : ac.emergency === 'lowFuel' ? 'FUEL' : CONFIG.types[ac.type].label;
    const detail = `${Math.round(ac.altitude / 100)}·${Math.round(ac.fuelSeconds)}s·${tag}`;
    ctx.fillText(truncateText(ctx, detail, cardW - 8), tx, ty + 11);
  } else {
    ctx.font = '600 9.5px Inter, system-ui, sans-serif';
    ctx.fillStyle = PALETTE.textDim;
    ctx.fillText(ac.callsign, tx, ty + 4);
  }
}

function drawConflicts(ctx: CanvasRenderingContext2D, state: GameState, alpha: number, nowSec: number): void {
  const pulse = 0.45 + 0.55 * Math.abs(Math.sin(nowSec * 7));
  for (const ac of state.aircraft) {
    if (!ac.conflict) continue;
    const x = lerp(ac.ppx, ac.px, alpha);
    const y = lerp(ac.ppy, ac.py, alpha);
    ctx.strokeStyle = PALETTE.danger;
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // countdown arc
    const frac = Math.max(0, Math.min(1, ac.conflictTimeLeft / CONFIG.conflictToCrash));
    ctx.strokeStyle = PALETTE.danger;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 31, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = PALETTE.danger;
    ctx.font = '700 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ac.conflictTimeLeft.toFixed(1), x, y + 44);
    if (ac.conflictPartner != null) {
      const p = state.aircraft.find((a) => a.id === ac.conflictPartner);
      if (p && p.id > ac.id) {
        ctx.strokeStyle = `rgba(232,84,84,${(0.5 * pulse).toFixed(3)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(lerp(p.ppx, p.px, alpha), lerp(p.ppy, p.py, alpha));
        ctx.stroke();
      }
    }
  }
}

function drawCrashFx(ctx: CanvasRenderingContext2D, state: GameState): void {
  for (const fx of state.crashFx) {
    const k = fx.ttl / 1.5;
    ctx.globalAlpha = k;
    ctx.fillStyle = PALETTE.danger;
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, (1 - k) * 36 + 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = PALETTE.danger;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, (1 - k) * 100 + 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawPopups(ctx: CanvasRenderingContext2D, fx: Fx): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of fx.popups) {
    const k = p.ttl / p.ttl0;
    ctx.globalAlpha = Math.min(1, k * 2);
    ctx.font = `800 ${p.size}px Inter, system-ui, sans-serif`;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 3;
    ctx.strokeText(p.text, p.x, p.y);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
}

// ----------------------------------------------------------------------------
// HUD (screen space)
// ----------------------------------------------------------------------------

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function drawHud(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, fx: Fx, nowSec: number): void {
  // frosted glass top bar
  ctx.shadowColor = PALETTE.panelShadow;
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  roundRectPath(ctx, 8, 8, vp.cssW - 16, 62, 12);
  ctx.fillStyle = PALETTE.panel;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = PALETTE.panelEdge;
  ctx.lineWidth = 1;
  ctx.stroke();

  // cash + streak (left)
  const narrow = vp.cssW < 640;
  const statsX = narrow ? 130 : 160;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.fillText(`SHIFT ${state.day}`, 24, 28);
  const shownCash = Math.round(fx.displayCash);
  ctx.fillStyle = shownCash < 0 ? PALETTE.danger : PALETTE.cash;
  ctx.font = `800 ${narrow ? 22 : 26}px Inter, system-ui, sans-serif`;
  const cashStr = `$${shownCash}`;
  drawFittedTextLeft(ctx, cashStr, 24, 54, statsX - 28, narrow ? 22 : 26, 14);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  const landedStr = `${state.handled} landed · ${state.departed} out`;
  drawFittedTextLeft(ctx, landedStr, statsX, 38, vp.cssW / 2 - statsX - 24, 11, 9);
  if (state.streak >= 2) {
    const mult = Math.min(CONFIG.streakMaxMult, 1 + state.streak * CONFIG.streakStep);
    ctx.fillStyle = PALETTE.gateReady;
    ctx.font = '700 12px Inter, system-ui, sans-serif';
    ctx.fillText(`STREAK ×${mult.toFixed(1)}`, 160, 56);
  }

  // shift clock (center)
  const remaining = Math.max(0, state.shiftLength - state.time);
  const inRush = state.finalRushFired;
  ctx.textAlign = 'center';
  ctx.fillStyle = inRush && remaining > 0 ? PALETTE.warn : PALETTE.text;
  ctx.font = '800 22px Inter, system-ui, sans-serif';
  ctx.fillText(fmtTime(remaining), vp.cssW / 2, 34);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  ctx.fillText(state.paused ? 'PAUSED' : inRush ? 'FINAL RUSH' : `${state.aircraft.length} aircraft`, vp.cssW / 2, 50);
  // progress bar
  const bw = 200;
  const bx = vp.cssW / 2 - bw / 2;
  const frac = Math.min(1, state.time / state.shiftLength);
  roundRectPath(ctx, bx, 56, bw, 5, 2.5);
  ctx.fillStyle = 'rgba(74,144,217,0.12)';
  ctx.fill();
  roundRectPath(ctx, bx, 56, bw * frac, 5, 2.5);
  ctx.fillStyle = frac >= (1 - CONFIG.finalRushLead / state.shiftLength) ? PALETTE.warn : PALETTE.blip;
  ctx.fill();
  void nowSec;

  // incident strikes (right)
  ctx.textAlign = 'right';
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.fillText('INCIDENTS', vp.cssW - 24, 28);
  const pipR = 9;
  const gap = 24;
  for (let i = 0; i < CONFIG.crashesToFire; i++) {
    const cx = vp.cssW - 24 - pipR - i * gap;
    const filled = CONFIG.crashesToFire - 1 - i < state.incidents;
    ctx.beginPath();
    ctx.arc(cx, 48, pipR, 0, Math.PI * 2);
    ctx.fillStyle = filled ? PALETTE.danger : 'rgba(232,84,84,0.1)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = filled ? PALETTE.danger : 'rgba(232,84,84,0.3)';
    ctx.stroke();
  }
}

function drawBanner(ctx: CanvasRenderingContext2D, fx: Fx, vp: Viewport, nowSec: number): void {
  const b = fx.banner;
  if (!b) return;
  const k = b.ttl / b.ttl0;
  const slide = Math.min(1, (1 - k) * 6);
  const a = Math.min(1, k * 3);
  const y = 100 - (1 - slide) * 30;
  const pulse = 0.8 + 0.2 * Math.sin(nowSec * 9);
  ctx.save();
  ctx.globalAlpha = a;
  // banner card
  const bw = Math.min(400, vp.cssW - 24);
  const bh = 48;
  roundRectPath(ctx, vp.cssW / 2 - bw / 2, y - 22, bw, bh, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();
  ctx.strokeStyle = b.color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '800 20px Inter, system-ui, sans-serif';
  ctx.fillStyle = b.color;
  ctx.globalAlpha = a * pulse;
  drawWrappedText(ctx, b.text, vp.cssW / 2, y, bw - 24, 20, 'center');
  ctx.globalAlpha = a * 0.85;
  ctx.font = '500 12px Inter, system-ui, sans-serif';
  ctx.fillStyle = PALETTE.textDim;
  drawWrappedText(ctx, b.sub, vp.cssW / 2, y + 18, bw - 24, 14, 'center');
  ctx.restore();
}

function drawInboundStrip(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints): void {
  const maxRows = Math.max(3, Math.floor((vp.cssH - 90 - 80) / 28));
  const rows = [...state.aircraft]
    .filter((a) => a.phase === 'inbound' || a.phase === 'holding' || a.phase === 'approach')
    .sort((a, b) => a.fuelSeconds - b.fuelSeconds)
    .slice(0, Math.min(11, maxRows));
  if (rows.length === 0) return;
  const w = 175;
  const rh = 28;
  const x = vp.cssW - w - 14;
  let y = 82;

  // strip panel
  ctx.shadowColor = PALETTE.panelShadow;
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  roundRectPath(ctx, x - 6, y - 6, w + 12, rows.length * rh + 12, 8);
  ctx.fillStyle = PALETTE.panel;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.font = '600 10px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const ac of rows) {
    const sel = hints.selectedAircraftId === ac.id;
    const corridorStacked =
      ac.phase === 'approach' &&
      ac.assignedRunwayId != null &&
      ac.assignedEnd != null &&
      approachCountOnCorridor(state, ac.assignedRunwayId, ac.assignedEnd, ac.id) >= 1;
    roundRectPath(ctx, x, y, w, rh - 3, 5);
    ctx.fillStyle = sel ? 'rgba(74,144,217,0.1)' : 'rgba(255,255,255,0.5)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = ac.conflict
      ? PALETTE.danger
      : corridorStacked || ac.emergency !== 'none'
        ? PALETTE.warn
        : PALETTE.panelEdge;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(truncateText(ctx, ac.callsign, w * 0.45), x + 8, y + rh / 2 - 1);

    const approachEndName =
      ac.assignedRunwayId != null && ac.assignedEnd != null
        ? state.runways.find((r) => r.id === ac.assignedRunwayId)?.ends[ac.assignedEnd].name ?? ''
        : '';
    const status =
      ac.emergency === 'medical'
        ? 'MAYDAY'
        : ac.phase === 'approach'
          ? `ILS ${approachEndName}`
          : ac.phase === 'holding'
            ? 'HOLD'
            : ac.emergency === 'lowFuel'
              ? 'LOW FUEL'
              : 'INBOUND';
    ctx.textAlign = 'right';
    ctx.fillStyle = ac.emergency !== 'none' || corridorStacked ? PALETTE.warn : PALETTE.textDim;
    ctx.fillText(truncateText(ctx, status, w * 0.45), x + w - 8, y + rh / 2 - 1);

    // fuel bar
    const fk = Math.max(0, Math.min(1, ac.fuelSeconds / CONFIG.fuelSecondsStart));
    roundRectPath(ctx, x + 8, y + rh - 8, (w - 16) * fk, 3, 1.5);
    ctx.fillStyle = fk < 0.18 ? PALETTE.danger : fk < 0.4 ? PALETTE.warn : PALETTE.blip;
    ctx.fill();
    y += rh;
  }
}

function drawHelp(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const rawLines = [
    'Drag a plane to a runway side: land / take off there',
    'One approach per runway side — HOLD extras (right-click or HOLD button)',
    'Landed planes taxi to a gate, turn around, go green = ready',
    'Tap waiting planes to authorize runway crossing · Space: pause',
  ];
  const maxW = vp.cssW - 36;
  const lineH = 16;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '400 11px Inter, system-ui, sans-serif';
  ctx.fillStyle = PALETTE.textDim;
  const allLines: string[] = [];
  for (const l of rawLines) allLines.push(...measureWrappedLines(ctx, l, maxW));
  let y = vp.cssH - 20 - (allLines.length - 1) * lineH;
  for (const ln of allLines) {
    ctx.fillText(ln, 18, y);
    y += lineH;
  }
}

// ----------------------------------------------------------------------------
// overlays / screens
// ----------------------------------------------------------------------------

function panelCard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.shadowColor = 'rgba(0,0,0,0.12)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 6;
  roundRectPath(ctx, x, y, w, h, 14);
  ctx.fillStyle = PALETTE.panel;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 1;
  ctx.strokeStyle = PALETTE.panelEdge;
  ctx.stroke();
}

function drawHint(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const w = Math.min(520, vp.cssW - 24);
  const s = Math.min(1, w / 520);
  const lines = [
    { text: 'TOWER — your shift starts now', font: `700 ${15 * s}px Inter, system-ui, sans-serif`, color: PALETTE.blip },
    { text: 'Drag a plane to a runway side to clear it to land.', font: `400 ${13 * s}px Inter, system-ui, sans-serif`, color: PALETTE.text },
    { text: "Stacking a corridor is risky — you'll get a warning if another plane is on approach.", font: `400 ${13 * s}px Inter, system-ui, sans-serif`, color: PALETTE.text },
    { text: 'HOLD the rest: right-click a plane, or select it and tap HOLD.', font: `400 ${12 * s}px Inter, system-ui, sans-serif`, color: PALETTE.textDim },
    { text: "Keep them apart · watch fuel · Space pauses but commands still work.", font: `400 ${12 * s}px Inter, system-ui, sans-serif`, color: PALETTE.textDim },
  ];
  const lineH = 18 * s;
  const padY = 26;
  const textMaxW = w - 32;
  let contentH = padY;
  for (const ln of lines) {
    ctx.font = ln.font;
    contentH += measureWrappedLines(ctx, ln.text, textMaxW).length * lineH + 2;
  }
  const h = contentH + 16;
  const x = vp.cssW / 2 - w / 2;
  const y = vp.cssH - h - 34;
  panelCard(ctx, x, y, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  let yy = y + padY;
  for (const ln of lines) {
    ctx.font = ln.font;
    ctx.fillStyle = ln.color;
    yy = drawWrappedText(ctx, ln.text, vp.cssW / 2, yy, textMaxW, lineH, 'center');
    yy += 2;
  }
}

function drawPausedBanner(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const w = Math.min(340, vp.cssW - 24);
  const h = 38;
  const x = vp.cssW / 2 - w / 2;
  const y = 78;
  roundRectPath(ctx, x, y, w, h, 8);
  ctx.fillStyle = 'rgba(232,160,48,0.12)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = PALETTE.warn;
  ctx.stroke();
  ctx.fillStyle = PALETTE.warn;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 13px Inter, system-ui, sans-serif';
  drawFittedText(ctx, 'PAUSED — clear / dispatch / hold freely', vp.cssW / 2, y + h / 2 + 1, w - 16, 13, 10);
}

function drawTutorial(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints, nowSec: number): void {
  ctx.fillStyle = 'rgba(232,240,254,0.85)';
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  const cx = vp.cssW / 2;
  const cy = vp.cssH / 2;

  // main card (responsive so it doesn't clip on mobile)
  const cardW = Math.min(600, vp.cssW - 16);
  const cardH = 474;
  const s = Math.min(1, cardW / 600);
  panelCard(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.blip;
  ctx.font = `900 ${48 * s}px Inter, system-ui, sans-serif`;
  ctx.fillText('FINAL APPROACH', cx, cy - 150);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = `700 ${14 * s}px Inter, system-ui, sans-serif`;
  ctx.fillText('HOW TO PLAY', cx, cy - 128);
  ctx.font = `500 ${13 * s}px Inter, system-ui, sans-serif`;
  drawWrappedText(ctx, 'you are the tower. everyone lands, everyone leaves, nobody touches.', cx, cy - 110, cardW - 32, 16 * s, 'center');

  ctx.fillStyle = PALETTE.text;
  ctx.font = '700 18px Inter, system-ui, sans-serif';
  ctx.fillText(`SHIFT ${state.day}`, cx, cy - 80);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = `500 ${12.5 * s}px Inter, system-ui, sans-serif`;
  const clockLine = `${fmtTime(state.shiftLength)} on the clock · target $${dayDifficulty(state.day).gradeTarget} for an A`;
  drawWrappedText(ctx, clockLine, cx, cy - 60, cardW - 32, 15 * s, 'center');
  if (hints.best > 0) {
    ctx.fillStyle = PALETTE.cash;
    drawWrappedText(ctx, `career best $${hints.best}`, cx, cy - 42, cardW - 32, 15 * s, 'center');
  }

  const rows: [string, string][] = [
    ['DRAG a plane to a runway side', 'clears an arrival to land there'],
    ['BUSY corridor warning', 'you can still clear a second plane — but separation is on you'],
    ['RIGHT-CLICK · HOLD button', 'orbit extra arrivals while you sequence one at a time'],
    ['GREEN planes are boarded', 'drag them to a runway to launch'],
    ['TAP a plane holding short', 'to authorize it across a runway'],
    ['CLICK an airborne plane', 'ABORT to go around'],
    ['SPACE', 'pause — you can still give commands'],
    ['TWO crashes ends your shift', 'keep them apart · watch the fuel'],
  ];
  let y = cy - 28;
  const colGap = 10 * s;
  const stacked = cardW < 520;
  const halfW = cardW / 2 - colGap - 16;
  const rowFont = `600 ${12.5 * s}px Inter, system-ui, sans-serif`;
  ctx.font = rowFont;
  const rowLineH = 16 * s;
  for (const [k, v] of rows) {
    if (stacked) {
      const leftX = cx - cardW / 2 + 20;
      ctx.textAlign = 'left';
      ctx.fillStyle = PALETTE.blip;
      drawWrappedText(ctx, k, leftX, y, cardW - 40, rowLineH, 'left');
      const keyLines = measureWrappedLines(ctx, k, cardW - 40);
      const valY = y + keyLines.length * rowLineH + 2;
      ctx.fillStyle = PALETTE.textDim;
      const endY = drawWrappedText(ctx, v, leftX + 12, valY, cardW - 52, rowLineH, 'left');
      const valLines = measureWrappedLines(ctx, v, cardW - 52);
      y = Math.max(endY, valY + valLines.length * rowLineH) + 8;
    } else {
      ctx.textAlign = 'right';
      ctx.fillStyle = PALETTE.blip;
      const keyLines = measureWrappedLines(ctx, k, halfW);
      let ky = y;
      for (const ln of keyLines) {
        ctx.fillText(ln, cx - colGap, ky);
        ky += rowLineH;
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = PALETTE.textDim;
      const valLines = measureWrappedLines(ctx, v, halfW);
      let vy = y;
      for (const ln of valLines) {
        ctx.fillText(ln, cx + colGap, vy);
        vy += rowLineH;
      }
      y += Math.max(keyLines.length, valLines.length) * rowLineH + 6;
    }
  }

  const pulse = 0.55 + 0.45 * Math.sin(nowSec * 3);
  ctx.textAlign = 'center';
  ctx.globalAlpha = pulse;
  ctx.fillStyle = PALETTE.blip;
  ctx.font = `700 ${15 * s}px Inter, system-ui, sans-serif`;
  drawFittedText(ctx, 'CLICK ANYWHERE TO START YOUR SHIFT', cx, y + 30, cardW - 32, 15 * s, 11);
  ctx.globalAlpha = 1;
}

const GRADE_COLOR: Record<string, string> = {
  S: '#4A90D9',
  A: '#5AC06B',
  B: '#8CBF5A',
  C: '#E8A030',
  D: '#E8854A',
  F: '#E85454',
};

function drawStatsRows(ctx: CanvasRenderingContext2D, state: GameState, cx: number, y0: number, panelW = 500): number {
  const rows: [string, string][] = [
    ['landed / departed', `${state.handled} / ${state.departed}`],
    ['best streak', `×${state.bestStreak}`],
    ['near misses / go-arounds', `${state.nearMisses} / ${state.goArounds}`],
    ['diverted / crashed', `${state.diversions} / ${state.incidents}`],
  ];
  const halfW = panelW / 2 - 24;
  ctx.font = '500 13px Inter, system-ui, sans-serif';
  let y = y0;
  for (const [k, v] of rows) {
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.textDim;
    const keyLines = measureWrappedLines(ctx, k, halfW);
    let ky = y;
    for (const ln of keyLines) {
      ctx.fillText(ln, cx - 12, ky);
      ky += 18;
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.text;
    const valLines = measureWrappedLines(ctx, v, halfW);
    let vy = y;
    for (const ln of valLines) {
      ctx.fillText(ln, cx + 12, vy);
      vy += 18;
    }
    y += Math.max(keyLines.length, valLines.length) * 18 + 4;
  }
  return y;
}

function drawDebrief(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints, nowSec: number): void {
  ctx.fillStyle = 'rgba(232,240,254,0.9)';
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  const cx = vp.cssW / 2;
  const cy = vp.cssH / 2;
  const grade = state.grade ?? 'D';
  const gc = GRADE_COLOR[grade] ?? PALETTE.text;
  const pulse = 1 + 0.03 * Math.sin(nowSec * 3);

  panelCard(ctx, cx - 250, cy - 200, 500, 400);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '700 16px Inter, system-ui, sans-serif';
  ctx.fillText(`SHIFT ${state.day} COMPLETE`, cx, cy - 160);

  ctx.save();
  ctx.translate(cx, cy - 88);
  ctx.scale(pulse, pulse);
  ctx.fillStyle = gc;
  ctx.font = '900 88px Inter, system-ui, sans-serif';
  ctx.fillText(grade, 0, 32);
  ctx.restore();

  ctx.fillStyle = PALETTE.text;
  ctx.font = '800 24px Inter, system-ui, sans-serif';
  const isBest = state.cash > 0 && state.cash >= hints.best;
  ctx.fillText(`$${state.cash}`, cx, cy - 14);
  if (isBest) {
    ctx.fillStyle = PALETTE.cash;
    ctx.font = '700 13px Inter, system-ui, sans-serif';
    ctx.fillText('★ NEW CAREER BEST ★', cx, cy + 6);
  } else if (hints.best > 0) {
    ctx.fillStyle = PALETTE.textDim;
    ctx.font = '500 12px Inter, system-ui, sans-serif';
    ctx.fillText(`career best $${hints.best}`, cx, cy + 6);
  }

  drawStatsRows(ctx, state, cx, cy + 34, 500);
}

function drawFired(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints, nowSec: number): void {
  ctx.fillStyle = 'rgba(232,240,254,0.9)';
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  const cx = vp.cssW / 2;
  const cy = vp.cssH / 2;
  void nowSec;

  panelCard(ctx, cx - 260, cy - 180, 520, 380);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.danger;
  ctx.font = '900 46px Inter, system-ui, sans-serif';
  ctx.fillText("YOU'RE FIRED", cx, cy - 100);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 14px Inter, system-ui, sans-serif';
  drawWrappedText(ctx, `two incidents on shift ${state.day} · the FAA would like a word`, cx, cy - 74, 480, 18, 'center');

  ctx.fillStyle = PALETTE.text;
  ctx.font = '700 22px Inter, system-ui, sans-serif';
  ctx.fillText(`$${state.cash} · survived ${fmtTime(state.time)}`, cx, cy - 30);
  if (hints.best > 0) {
    ctx.fillStyle = PALETTE.textDim;
    ctx.font = '500 12px Inter, system-ui, sans-serif';
    ctx.fillText(`career best $${hints.best}`, cx, cy - 8);
  }

  drawStatsRows(ctx, state, cx, cy + 24, 520);
}

// ----------------------------------------------------------------------------
// Upgrade / shop screen — scrollable tiered list
// ----------------------------------------------------------------------------

function drawUpgradeScreen(ctx: CanvasRenderingContext2D, _state: GameState, vp: Viewport, hints: RenderHints, nowSec: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, vp.cssH);
  grad.addColorStop(0, MENU_PALETTE.bgGrad1);
  grad.addColorStop(1, MENU_PALETTE.bgGrad2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);

  const cx = vp.cssW / 2;
  const ups = hints.upgrades;
  const scrollY = hints.shopScrollY ?? 0;
  const headerH = UPGRADE_HEADER_H;
  const bottomBarH = UPGRADE_BOTTOM_BAR_H;

  ctx.save();
  ctx.shadowColor = MENU_PALETTE.cardShadow;
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  roundRectPath(ctx, 0, 0, vp.cssW, headerH, 0);
  ctx.fillStyle = MENU_PALETTE.card;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = MENU_PALETTE.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH);
  ctx.lineTo(vp.cssW, headerH);
  ctx.stroke();
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MENU_PALETTE.text;
  ctx.font = '900 28px Inter, system-ui, sans-serif';
  ctx.fillText('AIRPORT UPGRADES', cx, 42);
  ctx.fillStyle = MENU_PALETTE.accent;
  ctx.font = '800 24px Inter, system-ui, sans-serif';
  drawFittedText(ctx, `Bank: $${ups.bankBalance.toLocaleString()}`, cx, 74, vp.cssW - 48, 24, 14);
  ctx.fillStyle = MENU_PALETTE.textDim;
  ctx.font = '500 12px Inter, system-ui, sans-serif';
  drawWrappedText(ctx, 'Spend your earnings to improve the airport', cx, 96, vp.cssW - 48, 14, 'center');

  const contentTop = headerH;
  const contentBottom = vp.cssH - bottomBarH;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, contentTop, vp.cssW, contentBottom - contentTop);
  ctx.clip();

  const cardW = upgradeCardWidth(vp);
  const cardGap = 10;
  const tierGap = 18;
  const tierHeaderH = 40;
  const rightColW = 100;
  const textLeft = 60;
  const textMaxW = cardW - textLeft - rightColW - 8;
  let yy = contentTop + 20 - scrollY;

  for (let ti = 0; ti < TIER_DEFS.length; ti++) {
    const tier = TIER_DEFS[ti];
    const tierLocked = ti > 0 && TIER_DEFS.slice(0, ti).some((prev) =>
      prev.ids.some((id) => !ups.purchased.has(id)),
    );

    const thY = yy;
    ctx.save();
    if (tierLocked) ctx.globalAlpha = 0.45;
    roundRectPath(ctx, cx - cardW / 2, thY, cardW, tierHeaderH, 8);
    ctx.fillStyle = MENU_PALETTE.tierHeader;
    ctx.fill();
    ctx.strokeStyle = MENU_PALETTE.tierBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = MENU_PALETTE.textSecondary;
    ctx.font = '700 13px Inter, system-ui, sans-serif';
    const tierLabel = tierLocked ? `🔒 ${tier.label}` : tier.label;
    ctx.fillText(truncateText(ctx, tierLabel, cardW - 32), cx - cardW / 2 + 16, thY + tierHeaderH / 2);
    if (tierLocked) ctx.restore();
    yy += tierHeaderH + cardGap;

    for (const id of tier.ids) {
      const def = UPGRADE_DEFS.find((d) => d.id === id);
      if (!def) continue;

      const purchased = ups.purchased.has(def.id);
      const unlocked = isUnlocked(ups, def.id);
      const affordable = canPurchase(ups, def.id);
      const hovered = hints.hoverUpgradeId === def.id;
      const cardH = upgradeCardHeight(ctx, cardW, def.description);
      const cardX = cx - cardW / 2;
      const cardY = yy;

      ctx.save();
      if (tierLocked) ctx.globalAlpha = 0.35;

      if (hovered && !purchased && !tierLocked) {
        ctx.shadowColor = MENU_PALETTE.cardShadowHover;
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 4;
      } else {
        ctx.shadowColor = MENU_PALETTE.cardShadow;
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
      }
      roundRectPath(ctx, cardX, cardY, cardW, cardH, 10);
      ctx.fillStyle = purchased
        ? MENU_PALETTE.successBg
        : hovered && !tierLocked
          ? MENU_PALETTE.cardHover
          : MENU_PALETTE.card;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      ctx.lineWidth = purchased ? 2 : 1;
      ctx.strokeStyle = purchased ? MENU_PALETTE.success : affordable ? MENU_PALETTE.accent : MENU_PALETTE.cardBorder;
      ctx.stroke();

      ctx.font = '28px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.icon, cardX + 32, cardY + cardH / 2);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '700 14px Inter, system-ui, sans-serif';
      ctx.fillStyle = purchased ? MENU_PALETTE.success : !unlocked || tierLocked ? MENU_PALETTE.textDim : MENU_PALETTE.text;
      drawFittedTextLeft(ctx, def.name, cardX + textLeft, cardY + 22, textMaxW, 14, 11);
      ctx.font = '400 11.5px Inter, system-ui, sans-serif';
      ctx.fillStyle = MENU_PALETTE.textDim;
      drawWrappedText(ctx, def.description, cardX + textLeft, cardY + 40, textMaxW, 14, 'left');

      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      if (purchased) {
        ctx.fillStyle = MENU_PALETTE.success;
        ctx.font = '700 14px Inter, system-ui, sans-serif';
        ctx.fillText('✓ OWNED', cardX + cardW - 18, cardY + cardH / 2);
      } else if (!unlocked || tierLocked) {
        ctx.fillStyle = MENU_PALETTE.textDim;
        ctx.font = '500 12px Inter, system-ui, sans-serif';
        ctx.fillText('🔒 LOCKED', cardX + cardW - 18, cardY + cardH / 2);
      } else {
        ctx.fillStyle = affordable ? MENU_PALETTE.success : MENU_PALETTE.danger;
        ctx.font = '800 16px Inter, system-ui, sans-serif';
        ctx.fillText(truncateText(ctx, `$${def.cost.toLocaleString()}`, rightColW - 8), cardX + cardW - 18, cardY + cardH / 2);
      }

      ctx.restore();
      yy += cardH + cardGap;
    }
    yy += tierGap;
  }

  ctx.restore();
  void nowSec;
}

// ----------------------------------------------------------------------------
// Main menu / title screen
// ----------------------------------------------------------------------------

function drawMainMenu(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints, nowSec: number): void {
  // ── full-screen gradient background ──
  const bg = ctx.createLinearGradient(0, 0, 0, vp.cssH);
  bg.addColorStop(0, MENU_PALETTE.bgGrad1);
  bg.addColorStop(1, MENU_PALETTE.bgGrad2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);

  // ── decorative drifting planes ──
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.font = '32px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const planes = ['✈', '🛩', '✈', '🛩', '✈'];
  for (let i = 0; i < planes.length; i++) {
    const speed = 18 + i * 7;
    const yOff = 60 + i * (vp.cssH - 120) / planes.length;
    const xPos = ((nowSec * speed + i * 400) % (vp.cssW + 200)) - 100;
    ctx.save();
    ctx.translate(xPos, yOff);
    ctx.rotate(-0.15 + i * 0.06);
    ctx.fillStyle = MENU_PALETTE.accent;
    ctx.fillText(planes[i], 0, 0);
    ctx.restore();
  }
  ctx.restore();

  // ── subtle dots grid pattern ──
  ctx.save();
  ctx.globalAlpha = 0.04;
  ctx.fillStyle = MENU_PALETTE.accent;
  for (let gx = 30; gx < vp.cssW; gx += 40) {
    for (let gy = 30; gy < vp.cssH; gy += 40) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  const cx = vp.cssW / 2;
  const cy = vp.cssH / 2;

  // ── main card panel (responsive width so it never clips on mobile) ──
  const cardW = Math.min(540, vp.cssW - 16);
  const cardH = 380;
  const cardX = cx - cardW / 2;
  const cardY = cy - cardH / 2 - 10;

  ctx.save();
  ctx.shadowColor = 'rgba(74,144,217,0.12)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 12;
  roundRectPath(ctx, cardX, cardY, cardW, cardH, 20);
  ctx.fillStyle = MENU_PALETTE.card;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 1;
  ctx.strokeStyle = MENU_PALETTE.cardBorder;
  ctx.stroke();
  ctx.restore();

  // ── title (scaled down to fit the card on narrow screens) ──
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MENU_PALETTE.accent;
  const titleMax = cardW - 56;
  let titleSize = 52;
  ctx.font = `900 ${titleSize}px Inter, system-ui, sans-serif`;
  const titleW = ctx.measureText('FINAL APPROACH').width;
  if (titleW > titleMax) {
    titleSize = Math.max(28, Math.floor(titleSize * (titleMax / titleW)));
    ctx.font = `900 ${titleSize}px Inter, system-ui, sans-serif`;
  }
  ctx.fillText('FINAL APPROACH', cx, cardY + 72);

  // ── subtitle ──
  ctx.fillStyle = MENU_PALETTE.textSecondary;
  ctx.font = '500 16px Inter, system-ui, sans-serif';
  drawWrappedText(ctx, 'you are the tower', cx, cardY + 100, cardW - 32, 18, 'center');

  // ── divider line ──
  ctx.strokeStyle = MENU_PALETTE.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 100, cardY + 118);
  ctx.lineTo(cx + 100, cardY + 118);
  ctx.stroke();

  // ── day + bank ──
  const day = state.day ?? 1;
  const bank = hints.upgrades?.bankBalance ?? 0;
  ctx.fillStyle = MENU_PALETTE.textSecondary;
  ctx.font = '600 14px Inter, system-ui, sans-serif';
  drawFittedText(ctx, `Day ${day}  ·  Bank: $${bank.toLocaleString()}`, cx, cardY + 142, cardW - 32, 14, 11);
}

// ----------------------------------------------------------------------------
// Stats screen
// ----------------------------------------------------------------------------

function drawStatsScreen(ctx: CanvasRenderingContext2D, vp: Viewport, hints: RenderHints, nowSec: number): void {
  // background
  const bg = ctx.createLinearGradient(0, 0, 0, vp.cssH);
  bg.addColorStop(0, MENU_PALETTE.bgGrad1);
  bg.addColorStop(1, MENU_PALETTE.bgGrad2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);

  const cx = vp.cssW / 2;
  const stats: CareerStats = (hints as any).careerStats ?? {
    totalShifts: 0, totalLandings: 0, totalDepartures: 0,
    bestCash: 0, bestStreak: 0, totalCrashes: 0,
    lifetimeEarnings: 0, grades: { S: 0, A: 0, B: 0, C: 0, D: 0, F: 0 },
  };

  // title
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MENU_PALETTE.accent;
  ctx.font = '900 36px Inter, system-ui, sans-serif';
  ctx.fillText('CAREER STATISTICS', cx, 56);
  ctx.strokeStyle = MENU_PALETTE.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 120, 72);
  ctx.lineTo(cx + 120, 72);
  ctx.stroke();

  // stat cards: 2 cols × 4 rows
  const gap = 16;
  const cw = Math.min(230, (vp.cssW - gap - 48) / 2);
  const ch = 90;
  const gridW = cw * 2 + gap;
  const sx = cx - gridW / 2;
  let sy = 92;

  const cardItems: { icon: string; label: string; value: string; color?: string }[] = [
    { icon: '✈', label: 'Total Shifts', value: `${stats.totalShifts}` },
    { icon: '🛬', label: 'Total Landings', value: `${stats.totalLandings}` },
    { icon: '🛫', label: 'Total Departures', value: `${stats.totalDepartures}` },
    { icon: '💰', label: 'Lifetime Earnings', value: `$${stats.lifetimeEarnings.toLocaleString()}` },
    { icon: '🏆', label: 'Best Cash', value: `$${stats.bestCash.toLocaleString()}` },
    { icon: '🔥', label: 'Best Streak', value: `×${stats.bestStreak}` },
    { icon: '💥', label: 'Total Crashes', value: `${stats.totalCrashes}`, color: stats.totalCrashes > 0 ? MENU_PALETTE.danger : undefined },
  ];

  for (let i = 0; i < cardItems.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = sx + col * (cw + gap);
    const y = sy + row * (ch + gap);
    const item = cardItems[i];

    // card
    ctx.save();
    ctx.shadowColor = MENU_PALETTE.cardShadow;
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    roundRectPath(ctx, x, y, cw, ch, 12);
    ctx.fillStyle = MENU_PALETTE.card;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = MENU_PALETTE.cardBorder;
    ctx.stroke();
    ctx.restore();

    // icon
    ctx.font = '26px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.icon, x + 14, y + ch / 2 - 4);

    // label
    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = MENU_PALETTE.textDim;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(item.label.toUpperCase(), x + 50, y + 30);

    // value
    ctx.font = '800 24px Inter, system-ui, sans-serif';
    ctx.fillStyle = item.color ?? MENU_PALETTE.text;
    drawFittedTextLeft(ctx, item.value, x + 50, y + 62, cw - 58, 24, 14);
  }

  // grade breakdown card (8th card, col=1 row=3)
  {
    const x = sx + 1 * (cw + gap);
    const y = sy + 3 * (ch + gap);

    ctx.save();
    ctx.shadowColor = MENU_PALETTE.cardShadow;
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    roundRectPath(ctx, x, y, cw, ch, 12);
    ctx.fillStyle = MENU_PALETTE.card;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = MENU_PALETTE.cardBorder;
    ctx.stroke();
    ctx.restore();

    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = MENU_PALETTE.textDim;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('GRADE BREAKDOWN', x + 14, y + 24);

    // grade badges
    const grades: (keyof typeof GRADE_COLOR)[] = ['S', 'A', 'B', 'C', 'D', 'F'];
    const bw = 32;
    const bGap = 4;
    const totalBw = grades.length * bw + (grades.length - 1) * bGap;
    let bx = x + (cw - totalBw) / 2;
    const by = y + 48;
    for (const g of grades) {
      const gc = GRADE_COLOR[g] ?? MENU_PALETTE.textDim;
      const count = stats.grades[g as keyof typeof stats.grades] ?? 0;
      roundRectPath(ctx, bx, by, bw, 28, 6);
      ctx.fillStyle = gc;
      ctx.globalAlpha = count > 0 ? 0.18 : 0.06;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = gc;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 11px Inter, system-ui, sans-serif';
      ctx.fillStyle = gc;
      ctx.fillText(`${g}:${count}`, bx + bw / 2, by + 14);
      bx += bw + bGap;
    }
  }
  void nowSec;
}

// ----------------------------------------------------------------------------
// Settings screen
// ----------------------------------------------------------------------------

function drawSettingsScreen(ctx: CanvasRenderingContext2D, vp: Viewport, hints: RenderHints, nowSec: number): void {
  // background
  const bg = ctx.createLinearGradient(0, 0, 0, vp.cssH);
  bg.addColorStop(0, MENU_PALETTE.bgGrad1);
  bg.addColorStop(1, MENU_PALETTE.bgGrad2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);

  const cx = vp.cssW / 2;
  const volume = (hints as any).volume ?? 1;
  const confirmingReset = (hints as any).confirmingReset ?? false;

  // title
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MENU_PALETTE.accent;
  ctx.font = '900 36px Inter, system-ui, sans-serif';
  ctx.fillText('SETTINGS', cx, 56);
  ctx.strokeStyle = MENU_PALETTE.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 80, 72);
  ctx.lineTo(cx + 80, 72);
  ctx.stroke();

  // ── Volume section card (responsive width; must mirror input.ts sliderGeom) ──
  const volCardW = Math.min(440, vp.cssW - 24);
  const volCardH = 224;
  const volCardX = cx - volCardW / 2;
  const volCardY = vp.cssH / 2 - 230;

  ctx.save();
  ctx.shadowColor = MENU_PALETTE.cardShadow;
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  roundRectPath(ctx, volCardX, volCardY, volCardW, volCardH, 14);
  ctx.fillStyle = MENU_PALETTE.card;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 1;
  ctx.strokeStyle = MENU_PALETTE.cardBorder;
  ctx.stroke();
  ctx.restore();

  // three sliders: master / music / sfx (rows must mirror input.ts sliderGeom)
  const sliders: Array<{ label: string; value: number }> = [
    { label: 'MASTER VOLUME', value: volume },
    { label: 'MUSIC', value: (hints as any).musicVolume ?? 1 },
    { label: 'SOUND EFFECTS', value: (hints as any).sfxVolume ?? 1 },
  ];
  const trackW = Math.min(300, volCardW - 118);
  const trackH = 8;
  const trackX = volCardX + 24;
  for (const [row, s] of sliders.entries()) {
    const trackY = volCardY + 60 + row * 62;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = MENU_PALETTE.textSecondary;
    ctx.font = '700 12px Inter, system-ui, sans-serif';
    ctx.fillText(s.label, volCardX + 24, trackY - 28);

    // track background
    roundRectPath(ctx, trackX, trackY, trackW, trackH, 4);
    ctx.fillStyle = MENU_PALETTE.sliderTrack;
    ctx.fill();

    // filled portion
    const fillW = trackW * Math.max(0, Math.min(1, s.value));
    if (fillW > 0) {
      roundRectPath(ctx, trackX, trackY, fillW, trackH, 4);
      ctx.fillStyle = MENU_PALETTE.sliderFill;
      ctx.fill();
    }

    // thumb
    const thumbX = trackX + fillW;
    const thumbY = trackY + trackH / 2;
    const thumbR = 10;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.arc(thumbX, thumbY, thumbR, 0, Math.PI * 2);
    ctx.fillStyle = MENU_PALETTE.sliderThumb;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = 2;
    ctx.strokeStyle = MENU_PALETTE.sliderFill;
    ctx.stroke();
    ctx.restore();

    // percentage label
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = MENU_PALETTE.text;
    ctx.font = '700 14px Inter, system-ui, sans-serif';
    ctx.fillText(`${Math.round(s.value * 100)}%`, trackX + trackW + 16, trackY + trackH / 2);
  }

  // ── Danger zone section ──
  const dzCardW = Math.min(440, vp.cssW - 24);
  const dzCardH = confirmingReset ? 140 : 100;
  const dzCardX = cx - dzCardW / 2;
  const dzCardY = vp.cssH / 2 + 30;

  ctx.save();
  ctx.shadowColor = MENU_PALETTE.cardShadow;
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  roundRectPath(ctx, dzCardX, dzCardY, dzCardW, dzCardH, 14);
  ctx.fillStyle = MENU_PALETTE.card;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = MENU_PALETTE.danger;
  ctx.globalAlpha = 0.4;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();

  // danger zone header
  ctx.textAlign = 'left';
  ctx.fillStyle = MENU_PALETTE.danger;
  ctx.font = '700 13px Inter, system-ui, sans-serif';
  ctx.fillText('⚠ DANGER ZONE', dzCardX + 24, dzCardY + 30);

  if (confirmingReset) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = MENU_PALETTE.danger;
    ctx.font = '600 14px Inter, system-ui, sans-serif';
    drawWrappedText(ctx, 'Are you sure? This cannot be undone.', cx, dzCardY + 60, dzCardW - 32, 16, 'center');
  }
  void nowSec;
}

function drawButtons(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  vp: Viewport,
  hints: RenderHints,
  alpha: number = 1,
): void {
  const btns = visibleButtons(state, vp, hints, alpha);
  const isMenuScreen = state.status === 'menu' || state.status === 'stats' || state.status === 'settings' || state.status === 'upgrade';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of btns) {
    const hovered = hints.hoverButtonId === b.id;

    if (isMenuScreen) {
      // premium MENU_PALETTE styled buttons
      const isPrimary = b.id === 'menu_play' || b.id === 'shop_done';
      const isDanger = b.id === 'settings_reset' || b.id === 'settings_reset_confirm';

      ctx.save();
      ctx.shadowColor = hovered ? MENU_PALETTE.cardShadowHover : MENU_PALETTE.cardShadow;
      ctx.shadowBlur = hovered ? 14 : 8;
      ctx.shadowOffsetY = hovered ? 5 : 3;
      roundRectPath(ctx, b.x, b.y, b.w, b.h, 12);

      if (isPrimary) {
        ctx.fillStyle = hovered ? MENU_PALETTE.btnPrimaryHover : MENU_PALETTE.btnPrimary;
      } else if (isDanger) {
        ctx.fillStyle = hovered ? '#E53E3E' : MENU_PALETTE.danger;
      } else {
        ctx.fillStyle = hovered ? MENU_PALETTE.btnSecondaryHover : MENU_PALETTE.btnSecondary;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      if (!isPrimary && !isDanger) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = MENU_PALETTE.cardBorder;
        ctx.stroke();
      }

      ctx.fillStyle = isPrimary || isDanger ? MENU_PALETTE.btnPrimaryText : MENU_PALETTE.btnSecondaryText;
      const basePx = b.h >= 50 ? 15 : 13;
      ctx.font = `700 ${basePx}px Inter, system-ui, sans-serif`;
      drawFittedText(ctx, b.label, b.x + b.w / 2, b.y + b.h / 2 + 1, b.w - 24, basePx, 10);
      ctx.restore();
    } else {
      // original in-game button style
      const primary = b.id === 'primary' || b.id === 'shop_done';

      ctx.shadowColor = PALETTE.panelShadow;
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 3;
      roundRectPath(ctx, b.x, b.y, b.w, b.h, 10);
      ctx.fillStyle = primary
        ? hovered
          ? 'rgba(74,144,217,0.25)'
          : 'rgba(74,144,217,0.15)'
        : hovered
          ? 'rgba(255,255,255,0.95)'
          : PALETTE.panel;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.lineWidth = hovered ? 2 : 1.5;
      ctx.strokeStyle = primary ? PALETTE.blip : PALETTE.panelEdge;
      ctx.stroke();
      ctx.fillStyle = primary ? PALETTE.blip : PALETTE.text;
      const basePx = b.h >= 50 ? 15 : 12;
      ctx.font = `700 ${basePx}px Inter, system-ui, sans-serif`;
      drawFittedText(ctx, b.label, b.x + b.w / 2, b.y + b.h / 2 + 1, b.w - 24, basePx, 10);
    }
  }
}
