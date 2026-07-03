// render.ts — draws a GameState with a clean pastel/soft aesthetic.
// No game logic, no mutation. Aircraft motion is interpolated between sim ticks
// via `alpha`. `nowSec` is wall-clock time for cosmetic animation.

import { CONFIG, PALETTE, dayDifficulty } from './config';
import type { Fx } from './fx';
import { AIRBORNE_PHASES } from './types';
import type { Aircraft, GameState, RenderHints, Runway, Viewport } from './types';
import { UPGRADE_DEFS, isUnlocked, canPurchase } from './upgrades';
import { endButtons, hudButtons, upgradeButtons, type UiButton, type UiContext } from './ui';

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

function uiContext(state: GameState, hints: RenderHints): UiContext {
  const sel = hints.selectedAircraftId != null ? state.aircraft.find((a) => a.id === hints.selectedAircraftId) : undefined;
  const selAirborne = !!sel && (sel.phase === 'inbound' || sel.phase === 'holding' || sel.phase === 'approach');
  return {
    paused: state.paused,
    muted: hints.muted,
    status: state.status,
    selectedAirborne: selAirborne,
    selectedHolding: !!sel && sel.phase === 'holding',
    selectedWaitCross: !!sel && sel.phase === 'waitCross',
  };
}

/** All buttons currently on screen (render + input share this). */
export function visibleButtons(state: GameState, vp: Viewport, hints: RenderHints): UiButton[] {
  if (state.status === 'upgrade') return upgradeButtons(vp);
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
  drawRangeRings(ctx, nowSec);
  drawWeather(ctx, state, nowSec);
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

  if (state.status === 'briefing') drawBriefing(ctx, state, vp, hints, nowSec);
  else if (state.status === 'debrief') drawDebrief(ctx, state, vp, hints, nowSec);
  else if (state.status === 'fired') drawFired(ctx, state, vp, hints, nowSec);
  else if (state.status === 'upgrade') drawUpgradeScreen(ctx, state, vp, hints, nowSec);

  drawButtons(ctx, state, vp, hints);
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

function drawRangeRings(ctx: CanvasRenderingContext2D, nowSec: number): void {
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
  // subtle rotating sweep
  const a = (nowSec * 0.45) % (Math.PI * 2);
  const R = 680;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, a - 0.4, a);
  ctx.closePath();
  const grad = ctx.createLinearGradient(
    cx + Math.cos(a - 0.4) * R * 0.6,
    cy + Math.sin(a - 0.4) * R * 0.6,
    cx + Math.cos(a) * R * 0.6,
    cy + Math.sin(a) * R * 0.6,
  );
  grad.addColorStop(0, 'rgba(74,144,217,0)');
  grad.addColorStop(1, PALETTE.sweep);
  ctx.fillStyle = grad;
  ctx.fill();
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

function drawRunway(ctx: CanvasRenderingContext2D, rw: Runway, state: GameState, hints: RenderHints): void {
  const busy = state.time < rw.occupiedUntil;

  // both approach corridors (dashed), each from its threshold out to its finalEntry
  for (let e = 0; e < 2; e++) {
    const end = rw.ends[e];
    const targeted =
      (hints.hoverRunwayId === rw.id && hints.hoverEnd === e) ||
      (hints.drag?.targetRunwayId === rw.id && hints.drag?.targetEnd === e);
    ctx.save();
    ctx.setLineDash([5, 10]);
    ctx.lineWidth = targeted ? 3.5 : 2;
    ctx.strokeStyle = targeted ? PALETTE.blip : busy ? PALETTE.corridorBusy : PALETTE.corridorFree;
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
    ctx.fillStyle = busy ? PALETTE.warn : PALETTE.ringText;
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
  ctx.save();
  ctx.lineCap = 'round';
  ctx.setLineDash([3, 8]);
  ctx.strokeStyle = onTarget ? PALETTE.blip : 'rgba(74,144,217,0.5)';
  ctx.lineWidth = onTarget ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(ac.x, ac.y);
  ctx.lineTo(drag.toX, drag.toY);
  ctx.stroke();
  ctx.setLineDash([]);
  if (onTarget && drag.endName) {
    const verb = ac.phase === 'readyDep' || ac.phase === 'taxiOut' || ac.phase === 'holdShort' ? 'TAKE OFF' : 'LAND';
    ctx.fillStyle = PALETTE.text;
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
    ctx.fillText(ac.callsign, tx, ty);
    ctx.font = '500 9.5px Inter, system-ui, sans-serif';
    ctx.fillStyle = PALETTE.textDim;
    const tag = ac.emergency === 'medical' ? 'MAYDAY' : ac.emergency === 'lowFuel' ? 'FUEL' : CONFIG.types[ac.type].label;
    ctx.fillText(`${Math.round(ac.altitude / 100)}·${Math.round(ac.fuelSeconds)}s·${tag}`, tx, ty + 11);
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
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.fillText(`SHIFT ${state.day}`, 24, 28);
  const shownCash = Math.round(fx.displayCash);
  ctx.fillStyle = shownCash < 0 ? PALETTE.danger : PALETTE.cash;
  ctx.font = '800 26px Inter, system-ui, sans-serif';
  ctx.fillText(`$${shownCash}`, 24, 54);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  ctx.fillText(`${state.handled} landed · ${state.departed} out`, 160, 38);
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
  const bw = 400;
  roundRectPath(ctx, vp.cssW / 2 - bw / 2, y - 22, bw, 48, 8);
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
  ctx.fillText(b.text, vp.cssW / 2, y);
  ctx.globalAlpha = a * 0.85;
  ctx.font = '500 12px Inter, system-ui, sans-serif';
  ctx.fillStyle = PALETTE.textDim;
  ctx.fillText(b.sub, vp.cssW / 2, y + 18);
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
    roundRectPath(ctx, x, y, w, rh - 3, 5);
    ctx.fillStyle = sel ? 'rgba(74,144,217,0.1)' : 'rgba(255,255,255,0.5)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = ac.conflict ? PALETTE.danger : ac.emergency !== 'none' ? PALETTE.warn : PALETTE.panelEdge;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(ac.callsign, x + 8, y + rh / 2 - 1);

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
    roundRectPath(ctx, x + 8, y + rh - 8, (w - 16) * fk, 3, 1.5);
    ctx.fillStyle = fk < 0.18 ? PALETTE.danger : fk < 0.4 ? PALETTE.warn : PALETTE.blip;
    ctx.fill();
    y += rh;
  }
}

function drawHelp(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const lines = [
    'Drag a plane to a runway side: land / take off there',
    'Landed planes taxi to a gate, turn around, go green = ready',
    'Tap waiting planes to authorize runway crossing · Space: pause',
  ];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '400 11px Inter, system-ui, sans-serif';
  ctx.fillStyle = PALETTE.textDim;
  let y = vp.cssH - 20 - (lines.length - 1) * 16;
  for (const l of lines) {
    ctx.fillText(l, 18, y);
    y += 16;
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
  const w = 480;
  const h = 100;
  const x = vp.cssW / 2 - w / 2;
  const y = vp.cssH - h - 34;
  panelCard(ctx, x, y, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.blip;
  ctx.font = '700 15px Inter, system-ui, sans-serif';
  ctx.fillText('TOWER — your shift starts now', vp.cssW / 2, y + 28);
  ctx.fillStyle = PALETTE.text;
  ctx.font = '400 13px Inter, system-ui, sans-serif';
  ctx.fillText('Drag a plane to the side of a runway you want it to land on.', vp.cssW / 2, y + 52);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '400 12px Inter, system-ui, sans-serif';
  ctx.fillText("Each runway takes traffic from both ends · keep planes apart · don't run them out of fuel.", vp.cssW / 2, y + 74);
}

function drawPausedBanner(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const w = 340;
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
  ctx.fillText('PAUSED — clear / dispatch / hold freely', vp.cssW / 2, y + h / 2 + 1);
}

function drawBriefing(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints, nowSec: number): void {
  ctx.fillStyle = 'rgba(232,240,254,0.85)';
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  const cx = vp.cssW / 2;
  const cy = vp.cssH / 2;

  // main card
  panelCard(ctx, cx - 300, cy - 200, 600, 400);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.blip;
  ctx.font = '900 48px Inter, system-ui, sans-serif';
  ctx.fillText('FINAL APPROACH', cx, cy - 120);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 14px Inter, system-ui, sans-serif';
  ctx.fillText('you are the tower. everyone lands, everyone leaves, nobody touches.', cx, cy - 90);

  ctx.fillStyle = PALETTE.text;
  ctx.font = '700 18px Inter, system-ui, sans-serif';
  ctx.fillText(`SHIFT ${state.day}`, cx, cy - 44);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 13px Inter, system-ui, sans-serif';
  ctx.fillText(`${fmtTime(state.shiftLength)} on the clock · target $${dayDifficulty(state.day).gradeTarget} for an A`, cx, cy - 22);
  if (hints.best > 0) {
    ctx.fillStyle = PALETTE.cash;
    ctx.fillText(`career best $${hints.best}`, cx, cy);
  }

  const rows: [string, string][] = [
    ['DRAG a plane to a runway side', 'clears it to land from that end'],
    ['GREEN planes at gates are boarded', 'drag them to a runway to launch'],
    ['TAP waiting ground planes', 'to authorize runway crossing'],
    ['SPACE', 'pause — you can still give commands'],
  ];
  let y = cy + 40;
  ctx.font = '600 13px Inter, system-ui, sans-serif';
  for (const [k, v] of rows) {
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.blip;
    ctx.fillText(k, cx - 10, y);
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.textDim;
    ctx.fillText(v, cx + 10, y);
    y += 24;
  }

  const pulse = 0.55 + 0.45 * Math.sin(nowSec * 3);
  ctx.textAlign = 'center';
  ctx.globalAlpha = pulse;
  ctx.fillStyle = PALETTE.blip;
  ctx.font = '700 16px Inter, system-ui, sans-serif';
  ctx.fillText('CLICK ANYWHERE TO START YOUR SHIFT', cx, y + 34);
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

function drawStatsRows(ctx: CanvasRenderingContext2D, state: GameState, cx: number, y0: number): number {
  const rows: [string, string][] = [
    ['landed / departed', `${state.handled} / ${state.departed}`],
    ['best streak', `×${state.bestStreak}`],
    ['near misses / go-arounds', `${state.nearMisses} / ${state.goArounds}`],
    ['diverted / crashed', `${state.diversions} / ${state.incidents}`],
  ];
  ctx.font = '500 13px Inter, system-ui, sans-serif';
  let y = y0;
  for (const [k, v] of rows) {
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.textDim;
    ctx.fillText(k, cx - 12, y);
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(v, cx + 12, y);
    y += 22;
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

  drawStatsRows(ctx, state, cx, cy + 34);
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
  ctx.fillText(`two incidents on shift ${state.day} · the FAA would like a word`, cx, cy - 74);

  ctx.fillStyle = PALETTE.text;
  ctx.font = '700 22px Inter, system-ui, sans-serif';
  ctx.fillText(`$${state.cash} · survived ${fmtTime(state.time)}`, cx, cy - 30);
  if (hints.best > 0) {
    ctx.fillStyle = PALETTE.textDim;
    ctx.font = '500 12px Inter, system-ui, sans-serif';
    ctx.fillText(`career best $${hints.best}`, cx, cy - 8);
  }

  drawStatsRows(ctx, state, cx, cy + 24);
}

// ----------------------------------------------------------------------------
// Upgrade / shop screen
// ----------------------------------------------------------------------------

function drawUpgradeScreen(ctx: CanvasRenderingContext2D, _state: GameState, vp: Viewport, hints: RenderHints, nowSec: number): void {
  ctx.fillStyle = PALETTE.bgAlt;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);

  const cx = vp.cssW / 2;
  const ups = hints.upgrades;

  // title
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.text;
  ctx.font = '900 32px Inter, system-ui, sans-serif';
  ctx.fillText('AIRPORT UPGRADES', cx, 50);

  // bank balance
  ctx.fillStyle = PALETTE.cash;
  ctx.font = '800 22px Inter, system-ui, sans-serif';
  ctx.fillText(`Bank: $${ups.bankBalance}`, cx, 82);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 12px Inter, system-ui, sans-serif';
  ctx.fillText('Spend your earnings to improve the airport', cx, 100);

  // upgrade cards in a grid
  const cardW = 200;
  const cardH = 110;
  const gap = 16;
  const cols = Math.min(4, Math.floor((vp.cssW - 40) / (cardW + gap)));
  const totalW = cols * cardW + (cols - 1) * gap;
  const startX = cx - totalW / 2;
  let gridY = 120;

  // Group by category
  const categories = ['runway', 'gates', 'weather', 'radar', 'fuel', 'turnaround'] as const;
  const catNames: Record<string, string> = {
    runway: '✈ RUNWAYS', gates: '🏢 GATES', weather: '🌧 WEATHER',
    radar: '📡 RADAR', fuel: '⛽ FUEL', turnaround: '⚡ SPEED',
  };

  let col = 0;

  for (const cat of categories) {
    const catDefs = UPGRADE_DEFS.filter((d) => d.category === cat);
    if (catDefs.length === 0) continue;

    for (const def of catDefs) {
      const purchased = ups.purchased.has(def.id);
      const unlocked = isUnlocked(ups, def.id);
      const affordable = canPurchase(ups, def.id);
      const hovered = hints.hoverUpgradeId === def.id;

      const cardX = startX + col * (cardW + gap);
      const cardY = gridY;

      // card background
      ctx.save();
      if (hovered && !purchased) {
        ctx.shadowColor = 'rgba(74,144,217,0.3)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 4;
      } else {
        ctx.shadowColor = PALETTE.panelShadow;
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 3;
      }
      roundRectPath(ctx, cardX, cardY, cardW, cardH, 10);
      ctx.fillStyle = purchased ? 'rgba(90,192,107,0.12)' : !unlocked ? 'rgba(200,210,220,0.5)' : 'rgba(255,255,255,0.92)';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      ctx.lineWidth = purchased ? 2 : 1;
      ctx.strokeStyle = purchased ? PALETTE.gateReady : affordable ? PALETTE.blip : PALETTE.panelEdge;
      ctx.stroke();
      ctx.restore();

      // icon
      ctx.font = '28px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.icon, cardX + 12, cardY + 28);

      // name
      ctx.font = '700 13px Inter, system-ui, sans-serif';
      ctx.fillStyle = purchased ? PALETTE.gateReady : !unlocked ? PALETTE.textDim : PALETTE.text;
      ctx.fillText(def.name, cardX + 48, cardY + 24);

      // description
      ctx.font = '400 10.5px Inter, system-ui, sans-serif';
      ctx.fillStyle = PALETTE.textDim;
      // wrap text
      const words = def.description.split(' ');
      let line = '';
      let ly = cardY + 44;
      for (const word of words) {
        const test = line + (line ? ' ' : '') + word;
        if (ctx.measureText(test).width > cardW - 56) {
          ctx.fillText(line, cardX + 48, ly);
          line = word;
          ly += 13;
        } else {
          line = test;
        }
      }
      if (line) ctx.fillText(line, cardX + 48, ly);

      // price / status
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      if (purchased) {
        ctx.fillStyle = PALETTE.gateReady;
        ctx.font = '700 12px Inter, system-ui, sans-serif';
        ctx.fillText('✓ OWNED', cardX + cardW - 12, cardY + cardH - 10);
      } else if (!unlocked) {
        ctx.fillStyle = PALETTE.textDim;
        ctx.font = '500 11px Inter, system-ui, sans-serif';
        ctx.fillText('🔒 LOCKED', cardX + cardW - 12, cardY + cardH - 10);
      } else {
        ctx.fillStyle = affordable ? PALETTE.cash : PALETTE.danger;
        ctx.font = '800 14px Inter, system-ui, sans-serif';
        ctx.fillText(`$${def.cost}`, cardX + cardW - 12, cardY + cardH - 10);
      }

      col++;
      if (col >= cols) {
        col = 0;
        gridY += cardH + gap;
      }
    }
  }
  void catNames;
  void nowSec;
}

function drawButtons(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints): void {
  const buttons = visibleButtons(state, vp, hints);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of buttons) {
    const hovered = hints.hoverButtonId === b.id;
    const primary = b.id === 'primary' || b.id === 'shop_done';

    // shadow
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
    ctx.font = `700 ${b.h >= 50 ? 15 : 12}px Inter, system-ui, sans-serif`;
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
  }
}
