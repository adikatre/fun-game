// render.ts — draws a GameState as a radar scope. No game logic, no mutation.
// Aircraft motion is interpolated between sim ticks via `alpha`.

import { CONFIG, PALETTE } from './config';
import type { Aircraft, GameState, RenderHints, Runway, Vec, Viewport } from './types';

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

// ----------------------------------------------------------------------------

export function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  alpha: number,
  vp: Viewport,
  hints: RenderHints,
  pointerScreen: Vec | null,
): void {
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  drawVignette(ctx, vp);

  ctx.save();
  ctx.translate(vp.offsetX, vp.offsetY);
  ctx.scale(vp.scale, vp.scale);

  drawRangeRings(ctx, state);
  drawSweep(ctx, state);
  for (const rw of state.runways) drawRunway(ctx, rw, state, hints);
  drawSelectedPath(ctx, state, hints);
  drawDragPreview(ctx, state, hints);
  for (const ac of state.aircraft) drawTrailAndVector(ctx, ac, alpha);
  for (const ac of state.aircraft) drawAircraft(ctx, ac, alpha, state, hints);
  drawConflicts(ctx, state, alpha);
  drawCrashFx(ctx, state);

  ctx.restore();

  // screen-space HUD
  drawHud(ctx, state, vp);
  drawInboundStrip(ctx, state, vp, hints);
  drawHelp(ctx, vp);

  if (state.status === 'gameover') drawGameOver(ctx, state, vp);
  else if (state.showHint) drawHint(ctx, vp);
  else if (state.paused) drawPausedBanner(ctx, vp);

  void pointerScreen;
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

function drawRangeRings(ctx: CanvasRenderingContext2D, state: GameState): void {
  void state;
  ctx.strokeStyle = PALETTE.ring;
  ctx.lineWidth = 1.5;
  for (const r of [120, 240, 360, 480]) {
    ctx.beginPath();
    ctx.arc(CONFIG.airportX, CONFIG.airportY, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // crosshair
  ctx.beginPath();
  ctx.moveTo(CONFIG.airportX - 8, CONFIG.airportY);
  ctx.lineTo(CONFIG.airportX + 8, CONFIG.airportY);
  ctx.moveTo(CONFIG.airportX, CONFIG.airportY - 8);
  ctx.lineTo(CONFIG.airportX, CONFIG.airportY + 8);
  ctx.stroke();
}

function drawSweep(ctx: CanvasRenderingContext2D, state: GameState): void {
  const ang = (state.time * 0.55) % (Math.PI * 2);
  const R = 520;
  const g = ctx.createRadialGradient(CONFIG.airportX, CONFIG.airportY, 0, CONFIG.airportX, CONFIG.airportY, R);
  g.addColorStop(0, 'rgba(95,224,138,0.0)');
  g.addColorStop(1, PALETTE.sweep);
  ctx.save();
  ctx.translate(CONFIG.airportX, CONFIG.airportY);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, R, -0.38, 0);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

function drawRunway(ctx: CanvasRenderingContext2D, rw: Runway, state: GameState, hints: RenderHints): void {
  const busy = state.time < rw.occupiedUntil;
  const highlight = hints.hoverRunwayId === rw.id || hints.drag?.snapRunwayId === rw.id;

  // approach corridor (dashed) from approachEnd back to finalEntry
  ctx.save();
  ctx.setLineDash([4, 9]);
  ctx.lineWidth = highlight ? 3 : 2;
  ctx.strokeStyle = highlight ? PALETTE.selected : busy ? PALETTE.corridorBusy : PALETTE.corridorFree;
  ctx.beginPath();
  ctx.moveTo(rw.approachEnd.x, rw.approachEnd.y);
  ctx.lineTo(rw.finalEntry.x, rw.finalEntry.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // runway strip
  ctx.save();
  ctx.translate(rw.cx, rw.cy);
  ctx.rotate(rw.dir);
  roundRectPath(ctx, -rw.length / 2, -rw.width / 2, rw.length, rw.width, 3);
  ctx.fillStyle = PALETTE.runway;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = busy ? PALETTE.corridorBusy : PALETTE.runwayEdge;
  ctx.stroke();
  // centerline dashes
  ctx.setLineDash([8, 7]);
  ctx.strokeStyle = 'rgba(220,243,230,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-rw.length / 2 + 6, 0);
  ctx.lineTo(rw.length / 2 - 6, 0);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // label near the approach end
  ctx.fillStyle = busy ? PALETTE.warn : PALETTE.ringText;
  ctx.font = '700 13px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(rw.name, rw.approachEnd.x + 18, rw.approachEnd.y - 14);
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
  if (!drag || drag.points.length === 0) return;
  const ac = state.aircraft.find((a) => a.id === drag.fromAircraftId);
  if (!ac) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = drag.snapRunwayId != null ? PALETTE.blip : 'rgba(233,247,238,0.75)';
  ctx.lineWidth = drag.snapRunwayId != null ? 3 : 2.5;
  ctx.beginPath();
  ctx.moveTo(ac.x, ac.y);
  for (const p of drag.points) ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.restore();
}

function drawTrailAndVector(ctx: CanvasRenderingContext2D, ac: Aircraft, alpha: number): void {
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

function drawAircraft(
  ctx: CanvasRenderingContext2D,
  ac: Aircraft,
  alpha: number,
  state: GameState,
  hints: RenderHints,
): void {
  const x = lerp(ac.ppx, ac.px, alpha);
  const y = lerp(ac.ppy, ac.py, alpha);
  const selected = hints.selectedAircraftId === ac.id;
  const hover = hints.hoverAircraftId === ac.id;
  const emerg = ac.emergency !== 'none';
  const pulse = 0.5 + 0.5 * Math.sin(state.time * 6);

  let color: string = PALETTE.blip;
  if (ac.conflict) color = PALETTE.danger;
  else if (ac.emergency === 'medical') color = PALETTE.danger;
  else if (ac.emergency === 'lowFuel') color = PALETTE.warn;
  else if (ac.phase === 'landing') color = PALETTE.blipDim;

  // selection / emergency ring
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
  const showFull = selected || hover || emerg || ac.conflict;
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
    ctx.fillStyle = ac.conflict ? PALETTE.danger : emerg ? PALETTE.warn : PALETTE.text;
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

function drawConflicts(ctx: CanvasRenderingContext2D, state: GameState, alpha: number): void {
  const pulse = 0.45 + 0.55 * Math.abs(Math.sin(state.time * 7));
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
    ctx.globalAlpha = 1;
  }
}

// ----------------------------------------------------------------------------
// HUD (screen space)
// ----------------------------------------------------------------------------

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function drawHud(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport): void {
  const g = ctx.createLinearGradient(0, 0, 0, 66);
  g.addColorStop(0, 'rgba(5,8,6,0.66)');
  g.addColorStop(1, 'rgba(5,8,6,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, vp.cssW, 66);

  // cash + handled (left)
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.fillText('SALARY', 18, 22);
  ctx.fillStyle = state.cash < 0 ? PALETTE.danger : PALETTE.blip;
  ctx.font = '700 28px ui-monospace, monospace';
  ctx.fillText(`$${state.cash}`, 18, 50);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 12px ui-monospace, monospace';
  ctx.fillText(`${state.handled} landed`, 150, 50);

  // clock (center)
  ctx.textAlign = 'center';
  ctx.fillStyle = PALETTE.text;
  ctx.font = '600 22px ui-monospace, monospace';
  ctx.fillText(fmtTime(state.time), vp.cssW / 2, 34);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.fillText(state.paused ? 'PAUSED' : `${state.aircraft.length} aircraft`, vp.cssW / 2, 50);

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

function drawInboundStrip(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport, hints: RenderHints): void {
  const rows = [...state.aircraft]
    .filter((a) => a.phase !== 'landing')
    .sort((a, b) => a.fuelSeconds - b.fuelSeconds)
    .slice(0, 11);
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
    const status =
      ac.emergency === 'medical'
        ? 'MAYDAY'
        : ac.phase === 'approach'
          ? `ILS ${state.runways.find((r) => r.id === ac.assignedRunwayId)?.name ?? ''}`
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
    'Click plane → click runway: land',
    'Drag from plane: vector it',
    'Right-click plane: hold',
    'Space: pause/replan   ·   R: new shift',
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
// overlays
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
  ctx.fillText('Click a plane, then click a runway to clear it to land.', vp.cssW / 2, y + 50);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 12px -apple-system, sans-serif';
  ctx.fillText('Drag from a plane to steer it · keep planes apart · don’t run them out of fuel.', vp.cssW / 2, y + 70);
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
  ctx.fillText('PAUSED — vector / clear / hold freely', vp.cssW / 2, y + h / 2 + 1);
}

function drawGameOver(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport): void {
  ctx.fillStyle = 'rgba(5,8,6,0.84)';
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.danger;
  ctx.font = '800 46px -apple-system, sans-serif';
  ctx.fillText("YOU'RE FIRED", vp.cssW / 2, vp.cssH / 2 - 58);

  ctx.fillStyle = PALETTE.text;
  ctx.font = '700 22px ui-monospace, monospace';
  ctx.fillText(`${state.handled} landed   ·   $${state.cash}`, vp.cssW / 2, vp.cssH / 2 - 14);

  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 14px ui-monospace, monospace';
  ctx.fillText(
    `shift ${fmtTime(state.time)}  ·  ${state.nearMisses} near-miss  ·  ${state.goArounds} go-around  ·  ${state.diversions} diverted`,
    vp.cssW / 2,
    vp.cssH / 2 + 14,
  );

  ctx.fillStyle = PALETTE.warn;
  ctx.font = '600 16px -apple-system, sans-serif';
  ctx.fillText('Press R to start a new shift', vp.cssW / 2, vp.cssH / 2 + 56);
}
