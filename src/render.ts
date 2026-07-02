// render.ts — draws a GameState as a radar scope. No game logic, no mutation.
// Aircraft motion is interpolated between sim ticks via `alpha`. `nowSec` is
// wall-clock time for cosmetic animation (pulses/sweep keep moving while paused
// or on menu screens).

import { CONFIG, PALETTE, dayDifficulty } from './config';
import type { Fx } from './fx';
import { AIRBORNE_PHASES } from './types';
import type { Aircraft, GameState, RenderHints, Runway, Viewport } from './types';
import { endButtons, hudButtons, type UiButton, type UiContext } from './ui';

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
  return t === 'heavy' ? 11 : t === 'medium' ? 8.5 : 7;
}

function uiContext(state: GameState, hints: RenderHints): UiContext {
  const sel = hints.selectedAircraftId != null ? state.aircraft.find((a) => a.id === hints.selectedAircraftId) : undefined;
  const selAirborne = !!sel && (sel.phase === 'inbound' || sel.phase === 'holding' || sel.phase === 'approach');
  return {
    paused: state.paused,
    muted: hints.muted,
    status: state.status,
    selectedAirborne: selAirborne,
    selectedHolding: !!sel && sel.phase === 'holding',
  };
}

/** All buttons currently on screen (render + input share this). */
export function visibleButtons(state: GameState, vp: Viewport, hints: RenderHints): UiButton[] {
  return [...hudButtons(vp, uiContext(state, hints)), ...endButtons(vp, state.status)];
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
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  drawVignette(ctx, vp);

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

  drawRangeRingsAndSweep(ctx, nowSec);
  for (const rw of state.runways) drawRunway(ctx, rw, state, hints);
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
    ctx.fillStyle = `rgba(255,60,40,${(fx.flash * 0.5).toFixed(3)})`;
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

  if (state.status === 'briefing') drawBriefing(ctx, state, vp, hints, nowSec);
  else if (state.status === 'debrief') drawDebrief(ctx, state, vp, hints, nowSec);
  else if (state.status === 'fired') drawFired(ctx, state, vp, hints, nowSec);

  drawButtons(ctx, state, vp, hints);
}

// ----------------------------------------------------------------------------
// world layers
// ----------------------------------------------------------------------------

function drawVignette(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const g = ctx.createRadialGradient(
    vp.cssW / 2,
    vp.cssH / 2,
    Math.min(vp.cssW, vp.cssH) * 0.28,
    vp.cssW / 2,
    vp.cssH / 2,
    Math.max(vp.cssW, vp.cssH) * 0.72,
  );
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, PALETTE.bgVignette);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
}

function drawRangeRingsAndSweep(ctx: CanvasRenderingContext2D, nowSec: number): void {
  const cx = CONFIG.airportX;
  const cy = CONFIG.airportY;
  ctx.save();
  ctx.strokeStyle = PALETTE.ring;
  ctx.lineWidth = 1;
  for (const r of [140, 280, 420, 560]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // rotating sweep wedge
  const a = (nowSec * 0.55) % (Math.PI * 2);
  const R = 580;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, a - 0.5, a);
  ctx.closePath();
  const grad = ctx.createLinearGradient(
    cx + Math.cos(a - 0.5) * R * 0.6,
    cy + Math.sin(a - 0.5) * R * 0.6,
    cx + Math.cos(a) * R * 0.6,
    cy + Math.sin(a) * R * 0.6,
  );
  grad.addColorStop(0, 'rgba(95,224,138,0)');
  grad.addColorStop(1, PALETTE.sweep);
  ctx.fillStyle = grad;
  ctx.fill();
  // leading edge line
  ctx.strokeStyle = 'rgba(95,224,138,0.14)';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
  ctx.stroke();
  ctx.restore();
}

function drawRunway(ctx: CanvasRenderingContext2D, rw: Runway, state: GameState, hints: RenderHints): void {
  const busy = state.time < rw.occupiedUntil;

  // both approach corridors (dashed), each from its threshold out to its finalEntry
  for (let e = 0; e < 2; e++) {
    const end = rw.ends[e];
    const targeted =
      (hints.hoverRunwayId === rw.id && hints.hoverEnd === e) ||
      (hints.drag?.targetRunwayId === rw.id && hints.drag?.targetEnd === e);
    ctx.save();
    ctx.setLineDash([4, 9]);
    ctx.lineWidth = targeted ? 3.5 : 2;
    ctx.strokeStyle = targeted ? PALETTE.selected : busy ? PALETTE.corridorBusy : PALETTE.corridorFree;
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
      ctx.lineTo(end.threshold.x - Math.cos(a - 0.4) * 12, end.threshold.y - Math.sin(a - 0.4) * 12);
      ctx.moveTo(end.threshold.x, end.threshold.y);
      ctx.lineTo(end.threshold.x - Math.cos(a + 0.4) * 12, end.threshold.y - Math.sin(a + 0.4) * 12);
      ctx.strokeStyle = PALETTE.selected;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  // runway strip
  ctx.save();
  ctx.translate(rw.cx, rw.cy);
  ctx.rotate(rw.ends[0].dir);
  roundRectPath(ctx, -rw.length / 2, -rw.width / 2, rw.length, rw.width, 3);
  ctx.fillStyle = PALETTE.runway;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = busy ? PALETTE.corridorBusy : PALETTE.runwayEdge;
  ctx.stroke();
  ctx.setLineDash([8, 7]);
  ctx.strokeStyle = 'rgba(220,243,230,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-rw.length / 2 + 6, 0);
  ctx.lineTo(rw.length / 2 - 6, 0);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // a label at each end (offset outward, beside its threshold)
  ctx.font = '700 12px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const end of rw.ends) {
    ctx.fillStyle = busy ? PALETTE.warn : PALETTE.ringText;
    ctx.fillText(end.name, end.threshold.x + Math.cos(end.dir + Math.PI) * 16, end.threshold.y - 14);
  }
}

function drawSelectedPath(ctx: CanvasRenderingContext2D, state: GameState, hints: RenderHints): void {
  const id = hints.selectedAircraftId;
  if (id == null) return;
  const ac = state.aircraft.find((a) => a.id === id);
  if (!ac || ac.waypoints.length === 0) return;
  ctx.save();
  ctx.setLineDash([2, 8]);
  ctx.strokeStyle = 'rgba(233,247,238,0.55)';
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
  ctx.save();
  ctx.lineCap = 'round';
  ctx.setLineDash([2, 7]);
  ctx.strokeStyle = onTarget ? PALETTE.blip : 'rgba(233,247,238,0.6)';
  ctx.lineWidth = onTarget ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(ac.x, ac.y);
  ctx.lineTo(drag.toX, drag.toY);
  ctx.stroke();
  ctx.setLineDash([]);
  // label which end it will land on, near the cursor
  if (onTarget && drag.endName) {
    const verb = ac.phase === 'readyDep' || ac.phase === 'taxiOut' || ac.phase === 'holdShort' ? 'TAKE OFF' : 'LAND';
    ctx.fillStyle = PALETTE.blip;
    ctx.font = '700 13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${verb} ${drag.endName}`, drag.toX + 12, drag.toY - 12);
  }
  ctx.restore();
}

function drawGates(ctx: CanvasRenderingContext2D, state: GameState): void {
  // terminal backdrop
  const gs = state.gates;
  if (gs.length) {
    const minX = Math.min(...gs.map((g) => g.x)) - 16;
    const maxX = Math.max(...gs.map((g) => g.x)) + 16;
    const gy = gs[0].y;
    roundRectPath(ctx, minX, gy - 13, maxX - minX, 26, 5);
    ctx.fillStyle = 'rgba(40,50,46,0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(103,232,160,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  for (const g of state.gates) {
    const occ = g.occupantId != null ? state.aircraft.find((a) => a.id === g.occupantId) : undefined;
    const ready = occ?.phase === 'readyDep';
    ctx.beginPath();
    ctx.rect(g.x - 6, g.y - 6, 12, 12);
    ctx.fillStyle = ready ? PALETTE.gateReady : occ ? PALETTE.gateBusy : PALETTE.gateFree;
    ctx.globalAlpha = occ ? 0.5 : 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = ready ? PALETTE.gateReady : occ ? PALETTE.gateBusy : 'rgba(103,232,160,0.3)';
    ctx.stroke();
    // turnaround progress arc
    if (occ && occ.phase === 'atGate') {
      const frac = 1 - occ.turnaround / CONFIG.turnaroundSeconds;
      ctx.beginPath();
      ctx.arc(g.x, g.y, 11, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.strokeStyle = PALETTE.gateBusy;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function drawTrailAndVector(ctx: CanvasRenderingContext2D, ac: Aircraft, alpha: number): void {
  if (!AIRBORNE_PHASES.includes(ac.phase)) return; // no trail/vector for ground traffic
  // trail
  for (let i = 0; i < ac.trail.length; i++) {
    const a = (i / ac.trail.length) * 0.5;
    ctx.fillStyle = `rgba(103,232,160,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(ac.trail[i].x, ac.trail[i].y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // heading / prediction vector
  const x = lerp(ac.ppx, ac.px, alpha);
  const y = lerp(ac.ppy, ac.py, alpha);
  const L = ac.speed * 1.7;
  ctx.strokeStyle = 'rgba(103,232,160,0.30)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(ac.heading) * L, y + Math.sin(ac.heading) * L);
  ctx.stroke();
}

/** AMBER predicted-conflict layer: where two closures will lose separation. */
function drawPredicted(ctx: CanvasRenderingContext2D, state: GameState, alpha: number, nowSec: number): void {
  if (state.predicted.length === 0) return;
  const pulse = 0.55 + 0.45 * Math.sin(nowSec * 4);
  ctx.save();
  for (const pc of state.predicted) {
    const a = state.aircraft.find((p) => p.id === pc.aId);
    const b = state.aircraft.find((p) => p.id === pc.bId);
    if (!a || !b) continue;
    // dashed projections from both planes to the predicted conflict point
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = `rgba(232,181,74,${(0.4 * pulse).toFixed(3)})`;
    ctx.lineWidth = 1.3;
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.moveTo(lerp(p.ppx, p.px, alpha), lerp(p.ppy, p.py, alpha));
      ctx.lineTo(pc.x, pc.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // X marker + time-to-conflict
    ctx.strokeStyle = PALETTE.warn;
    ctx.globalAlpha = 0.5 + 0.5 * pulse;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pc.x - 6, pc.y - 6);
    ctx.lineTo(pc.x + 6, pc.y + 6);
    ctx.moveTo(pc.x + 6, pc.y - 6);
    ctx.lineTo(pc.x - 6, pc.y + 6);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = PALETTE.warn;
    ctx.font = '700 11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${pc.t.toFixed(0)}s`, pc.x + 10, pc.y - 10);
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
  let color: string = PALETTE.blip;
  if (ac.conflict) color = PALETTE.danger;
  else if (ac.emergency === 'medical') color = PALETTE.danger;
  else if (ac.emergency === 'lowFuel') color = PALETTE.warn;
  else if (ac.warn) color = PALETTE.warn;
  else if (isDep) color = PALETTE.departure;
  else if (isGroundArrival) color = PALETTE.blipDim;

  // selection / emergency / ready-to-depart ring
  if (selected || hover) {
    ctx.strokeStyle = PALETTE.selected;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (emerg) {
    ctx.strokeStyle = ac.emergency === 'medical' ? PALETTE.danger : PALETTE.warn;
    ctx.globalAlpha = 0.4 + 0.6 * pulse;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (ac.phase === 'readyDep') {
    // pulse to signal "dispatch me"
    ctx.strokeStyle = PALETTE.gateReady;
    ctx.globalAlpha = 0.35 + 0.55 * pulse;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (ac.warn && !ac.conflict) {
    ctx.strokeStyle = PALETTE.warn;
    ctx.globalAlpha = 0.25 + 0.35 * pulse;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // blip icon
  const s = typeHalfSize(ac.type);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ac.heading);
  ctx.beginPath();
  ctx.moveTo(s, 0);
  ctx.lineTo(-s * 0.72, s * 0.62);
  ctx.lineTo(-s * 0.72, -s * 0.62);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  // data block
  const showFull = selected || hover || emerg || ac.conflict || ac.warn;
  const tx = x + 13;
  const ty = y - 13;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (showFull) {
    ctx.strokeStyle = 'rgba(223,243,230,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + s, y - s);
    ctx.lineTo(tx - 2, ty + 2);
    ctx.stroke();
    ctx.font = '700 11px ui-monospace, Menlo, monospace';
    ctx.fillStyle = ac.conflict ? PALETTE.danger : emerg || ac.warn ? PALETTE.warn : PALETTE.text;
    ctx.fillText(ac.callsign, tx, ty);
    ctx.font = '600 10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = PALETTE.textDim;
    const tag = ac.emergency === 'medical' ? 'MAYDAY' : ac.emergency === 'lowFuel' ? 'FUEL' : CONFIG.types[ac.type].label;
    ctx.fillText(`${Math.round(ac.altitude / 100)}·${Math.round(ac.fuelSeconds)}s·${tag}`, tx, ty + 11);
  } else {
    ctx.font = '600 9.5px ui-monospace, Menlo, monospace';
    ctx.fillStyle = PALETTE.blipDim;
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
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // countdown arc + seconds-to-impact: make the reaction window visible
    const frac = Math.max(0, Math.min(1, ac.conflictTimeLeft / CONFIG.conflictToCrash));
    ctx.strokeStyle = PALETTE.danger;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 29, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = PALETTE.danger;
    ctx.font = '700 11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ac.conflictTimeLeft.toFixed(1), x, y + 42);
    if (ac.conflictPartner != null) {
      const p = state.aircraft.find((a) => a.id === ac.conflictPartner);
      if (p && p.id > ac.id) {
        ctx.strokeStyle = `rgba(255,90,72,${(0.5 * pulse).toFixed(3)})`;
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
    ctx.arc(fx.x, fx.y, (1 - k) * 34 + 6, 0, Math.PI * 2);
    ctx.fill();
    // shockwave ring
    ctx.strokeStyle = PALETTE.danger;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, (1 - k) * 90 + 10, 0, Math.PI * 2);
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
    ctx.font = `800 ${p.size}px ui-monospace, monospace`;
    ctx.strokeStyle = 'rgba(5,8,6,0.8)';
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
  const g = ctx.createLinearGradient(0, 0, 0, 66);
  g.addColorStop(0, 'rgba(5,8,6,0.66)');
  g.addColorStop(1, 'rgba(5,8,6,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, vp.cssW, 66);

  // cash + streak (left)
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.fillText(`SHIFT ${state.day} — SALARY`, 18, 22);
  const shownCash = Math.round(fx.displayCash);
  ctx.fillStyle = shownCash < 0 ? PALETTE.danger : PALETTE.blip;
  ctx.font = '700 28px ui-monospace, monospace';
  ctx.fillText(`$${shownCash}`, 18, 50);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 12px ui-monospace, monospace';
  ctx.fillText(`${state.handled} landed · ${state.departed} out`, 170, 36);
  if (state.streak >= 2) {
    const mult = Math.min(CONFIG.streakMaxMult, 1 + state.streak * CONFIG.streakStep);
    ctx.fillStyle = PALETTE.gateReady;
    ctx.font = '700 13px ui-monospace, monospace';
    ctx.fillText(`STREAK ×${mult.toFixed(1)}`, 170, 54);
  }

  // shift clock + progress bar (center)
  const remaining = Math.max(0, state.shiftLength - state.time);
  const inRush = state.finalRushFired;
  ctx.textAlign = 'center';
  ctx.fillStyle = inRush && remaining > 0 ? PALETTE.warn : PALETTE.text;
  ctx.font = '700 22px ui-monospace, monospace';
  ctx.fillText(fmtTime(remaining), vp.cssW / 2, 30);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.fillText(state.paused ? 'PAUSED' : inRush ? 'FINAL RUSH' : `${state.aircraft.length} aircraft`, vp.cssW / 2, 46);
  // progress bar with a final-rush marker
  const bw = 220;
  const bx = vp.cssW / 2 - bw / 2;
  const frac = Math.min(1, state.time / state.shiftLength);
  ctx.fillStyle = 'rgba(103,232,160,0.14)';
  ctx.fillRect(bx, 54, bw, 4);
  const rushFrac = 1 - CONFIG.finalRushLead / state.shiftLength;
  ctx.fillStyle = frac >= rushFrac ? PALETTE.warn : PALETTE.blip;
  ctx.fillRect(bx, 54, bw * frac, 4);
  ctx.fillStyle = PALETTE.warn;
  ctx.fillRect(bx + bw * rushFrac - 1, 52, 2, 8);
  void nowSec;

  // incident strikes (right)
  ctx.textAlign = 'right';
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.fillText('INCIDENTS', vp.cssW - 18, 22);
  const pipR = 8;
  const gap = 22;
  for (let i = 0; i < CONFIG.crashesToFire; i++) {
    const cx = vp.cssW - 18 - pipR - i * gap;
    const filled = CONFIG.crashesToFire - 1 - i < state.incidents;
    ctx.beginPath();
    ctx.arc(cx, 44, pipR, 0, Math.PI * 2);
    ctx.fillStyle = filled ? PALETTE.danger : 'rgba(255,90,72,0.12)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = filled ? PALETTE.danger : 'rgba(255,90,72,0.4)';
    ctx.stroke();
  }
}

function drawBanner(ctx: CanvasRenderingContext2D, fx: Fx, vp: Viewport, nowSec: number): void {
  const b = fx.banner;
  if (!b) return;
  const k = b.ttl / b.ttl0;
  const slide = Math.min(1, (1 - k) * 6); // slide in fast
  const a = Math.min(1, k * 3); // fade out at the end
  const y = 96 - (1 - slide) * 30;
  const pulse = 0.8 + 0.2 * Math.sin(nowSec * 9);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '800 26px ui-monospace, monospace';
  ctx.strokeStyle = 'rgba(5,8,6,0.85)';
  ctx.lineWidth = 5;
  ctx.strokeText(b.text, vp.cssW / 2, y);
  ctx.fillStyle = b.color;
  ctx.globalAlpha = a * pulse;
  ctx.fillText(b.text, vp.cssW / 2, y);
  ctx.globalAlpha = a * 0.85;
  ctx.font = '600 13px ui-monospace, monospace';
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(b.sub, vp.cssW / 2, y + 22);
  ctx.restore();
}

function drawInboundStrip(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints): void {
  const maxRows = Math.max(3, Math.floor((vp.cssH - 74 - 70) / 26));
  const rows = [...state.aircraft]
    .filter((a) => a.phase === 'inbound' || a.phase === 'holding' || a.phase === 'approach')
    .sort((a, b) => a.fuelSeconds - b.fuelSeconds)
    .slice(0, Math.min(11, maxRows));
  if (rows.length === 0) return;
  const w = 168;
  const rh = 26;
  const x = vp.cssW - w - 12;
  let y = 74;
  ctx.font = '600 10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (const ac of rows) {
    const sel = hints.selectedAircraftId === ac.id;
    roundRectPath(ctx, x, y, w, rh - 3, 5);
    ctx.fillStyle = sel ? 'rgba(103,232,160,0.14)' : PALETTE.panel;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = ac.conflict ? PALETTE.danger : ac.emergency !== 'none' ? PALETTE.warn : PALETTE.panelEdge;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(ac.callsign, x + 8, y + rh / 2 - 1);

    // status
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
    ctx.fillStyle = ac.emergency !== 'none' ? PALETTE.warn : PALETTE.textDim;
    ctx.fillText(status, x + w - 8, y + rh / 2 - 1);

    // fuel bar
    const fk = Math.max(0, Math.min(1, ac.fuelSeconds / CONFIG.fuelSecondsStart));
    ctx.fillStyle = fk < 0.18 ? PALETTE.danger : fk < 0.4 ? PALETTE.warn : PALETTE.blip;
    ctx.fillRect(x + 8, y + rh - 8, (w - 16) * fk, 2.5);
    y += rh;
  }
}

function drawHelp(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const lines = [
    'Drag a plane to a runway side: land / take off there',
    'Landed planes taxi to a gate, turn around, go cyan = ready',
    'Right-click or double-tap: hold  ·  Space: pause  ·  M: sound  ·  R: restart',
  ];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '500 11px ui-monospace, monospace';
  ctx.fillStyle = PALETTE.textDim;
  let y = vp.cssH - 18 - (lines.length - 1) * 15;
  for (const l of lines) {
    ctx.fillText(l, 16, y);
    y += 15;
  }
}

// ----------------------------------------------------------------------------
// overlays / screens
// ----------------------------------------------------------------------------

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  roundRectPath(ctx, x, y, w, h, 10);
  ctx.fillStyle = PALETTE.panel;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = PALETTE.panelEdge;
  ctx.stroke();
}

function drawHint(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const w = 460;
  const h = 92;
  const x = vp.cssW / 2 - w / 2;
  const y = vp.cssH - h - 30;
  panel(ctx, x, y, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.blip;
  ctx.font = '700 15px ui-monospace, monospace';
  ctx.fillText('TOWER — your shift starts now', vp.cssW / 2, y + 26);
  ctx.fillStyle = PALETTE.text;
  ctx.font = '500 13px -apple-system, sans-serif';
  ctx.fillText('Drag a plane to the side of a runway you want it to land on.', vp.cssW / 2, y + 50);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 12px -apple-system, sans-serif';
  ctx.fillText('Each runway takes traffic from both ends · keep planes apart · don’t run them out of fuel.', vp.cssW / 2, y + 70);
}

function drawPausedBanner(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const w = 320;
  const h = 34;
  const x = vp.cssW / 2 - w / 2;
  const y = 72;
  roundRectPath(ctx, x, y, w, h, 8);
  ctx.fillStyle = 'rgba(232,181,74,0.16)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = PALETTE.warn;
  ctx.stroke();
  ctx.fillStyle = PALETTE.warn;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 13px ui-monospace, monospace';
  ctx.fillText('PAUSED — clear / dispatch / hold freely', vp.cssW / 2, y + h / 2 + 1);
}

function drawBriefing(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints, nowSec: number): void {
  ctx.fillStyle = 'rgba(5,8,6,0.72)';
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  const cx = vp.cssW / 2;
  const cy = vp.cssH / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = PALETTE.blip;
  ctx.font = '800 54px ui-monospace, monospace';
  ctx.fillText('FINAL APPROACH', cx, cy - 120);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 14px ui-monospace, monospace';
  ctx.fillText('you are the tower. everyone lands, everyone leaves, nobody touches.', cx, cy - 92);

  ctx.fillStyle = PALETTE.text;
  ctx.font = '700 18px ui-monospace, monospace';
  ctx.fillText(`SHIFT ${state.day}`, cx, cy - 44);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 13px ui-monospace, monospace';
  ctx.fillText(`${fmtTime(state.shiftLength)} on the clock · target $${dayDifficulty(state.day).gradeTarget} for an A`, cx, cy - 22);
  if (hints.best > 0) {
    ctx.fillStyle = PALETTE.gateReady;
    ctx.fillText(`career best $${hints.best}`, cx, cy);
  }

  const rows: [string, string][] = [
    ['DRAG a plane to a runway side', 'clears it to land from that end'],
    ['CYAN planes at gates are boarded', 'drag them to a runway to launch'],
    ['RIGHT-CLICK / DOUBLE-TAP', 'holding pattern'],
    ['SPACE', 'pause — you can still give commands'],
  ];
  let y = cy + 40;
  ctx.font = '600 13px ui-monospace, monospace';
  for (const [k, v] of rows) {
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.blip;
    ctx.fillText(k, cx - 10, y);
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.textDim;
    ctx.fillText(v, cx + 10, y);
    y += 22;
  }

  const pulse = 0.55 + 0.45 * Math.sin(nowSec * 3);
  ctx.textAlign = 'center';
  ctx.globalAlpha = pulse;
  ctx.fillStyle = PALETTE.selected;
  ctx.font = '700 18px ui-monospace, monospace';
  ctx.fillText('CLICK ANYWHERE TO START YOUR SHIFT', cx, y + 34);
  ctx.globalAlpha = 1;
}

const GRADE_COLOR: Record<string, string> = {
  S: '#5bd6e8',
  A: '#67e8a0',
  B: '#a7e867',
  C: '#e8b54a',
  D: '#e8854a',
  F: '#ff5a48',
};

function drawStatsRows(ctx: CanvasRenderingContext2D, state: GameState, cx: number, y0: number): number {
  const rows: [string, string][] = [
    ['landed / departed', `${state.handled} / ${state.departed}`],
    ['best streak', `×${state.bestStreak}`],
    ['near misses / go-arounds', `${state.nearMisses} / ${state.goArounds}`],
    ['diverted / crashed', `${state.diversions} / ${state.incidents}`],
  ];
  ctx.font = '600 13px ui-monospace, monospace';
  let y = y0;
  for (const [k, v] of rows) {
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.textDim;
    ctx.fillText(k, cx - 12, y);
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(v, cx + 12, y);
    y += 21;
  }
  return y;
}

function drawDebrief(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints, nowSec: number): void {
  ctx.fillStyle = 'rgba(5,8,6,0.86)';
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  const cx = vp.cssW / 2;
  const cy = vp.cssH / 2;
  const grade = state.grade ?? 'D';
  const gc = GRADE_COLOR[grade] ?? PALETTE.text;
  const pulse = 1 + 0.03 * Math.sin(nowSec * 3);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '700 16px ui-monospace, monospace';
  ctx.fillText(`SHIFT ${state.day} COMPLETE`, cx, cy - 168);

  ctx.save();
  ctx.translate(cx, cy - 92);
  ctx.scale(pulse, pulse);
  ctx.fillStyle = gc;
  ctx.font = '800 96px ui-monospace, monospace';
  ctx.fillText(grade, 0, 32);
  ctx.restore();

  ctx.fillStyle = PALETTE.text;
  ctx.font = '700 26px ui-monospace, monospace';
  const isBest = state.cash > 0 && state.cash >= hints.best;
  ctx.fillText(`$${state.cash}`, cx, cy - 18);
  if (isBest) {
    ctx.fillStyle = PALETTE.gateReady;
    ctx.font = '700 14px ui-monospace, monospace';
    ctx.fillText('★ NEW CAREER BEST ★', cx, cy + 4);
  } else if (hints.best > 0) {
    ctx.fillStyle = PALETTE.textDim;
    ctx.font = '600 12px ui-monospace, monospace';
    ctx.fillText(`career best $${hints.best}`, cx, cy + 4);
  }

  drawStatsRows(ctx, state, cx, cy + 32);
}

function drawFired(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints, nowSec: number): void {
  ctx.fillStyle = 'rgba(5,8,6,0.86)';
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  const cx = vp.cssW / 2;
  const cy = vp.cssH / 2;
  void nowSec;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.danger;
  ctx.font = '800 52px ui-monospace, monospace';
  ctx.fillText("YOU'RE FIRED", cx, cy - 110);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 14px ui-monospace, monospace';
  ctx.fillText(`two incidents on shift ${state.day} · the FAA would like a word`, cx, cy - 82);

  ctx.fillStyle = PALETTE.text;
  ctx.font = '700 24px ui-monospace, monospace';
  ctx.fillText(`$${state.cash} · survived ${fmtTime(state.time)}`, cx, cy - 34);
  if (hints.best > 0) {
    ctx.fillStyle = PALETTE.textDim;
    ctx.font = '600 12px ui-monospace, monospace';
    ctx.fillText(`career best $${hints.best}`, cx, cy - 12);
  }

  drawStatsRows(ctx, state, cx, cy + 20);
}

function drawButtons(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints): void {
  const buttons = visibleButtons(state, vp, hints);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of buttons) {
    const hovered = hints.hoverButtonId === b.id;
    const primary = b.id === 'primary';
    roundRectPath(ctx, b.x, b.y, b.w, b.h, 8);
    ctx.fillStyle = primary
      ? hovered
        ? 'rgba(103,232,160,0.32)'
        : 'rgba(103,232,160,0.18)'
      : hovered
        ? 'rgba(103,232,160,0.16)'
        : PALETTE.panel;
    ctx.fill();
    ctx.lineWidth = hovered ? 2 : 1.5;
    ctx.strokeStyle = primary ? PALETTE.blip : PALETTE.panelEdge;
    ctx.stroke();
    ctx.fillStyle = primary ? PALETTE.blip : PALETTE.text;
    ctx.font = `700 ${b.h >= 50 ? 16 : 12}px ui-monospace, monospace`;
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
  }
}
