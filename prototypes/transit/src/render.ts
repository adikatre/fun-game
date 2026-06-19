// render.ts — draws a GameState to the canvas. No game logic, no mutation.
// Train motion is interpolated between sim ticks via `alpha`.

import { CONFIG, PALETTE } from './config';
import type {
  GameState,
  Rect,
  RenderHints,
  ShapeType,
  Station,
  Viewport,
} from './types';

const STATION_R = 16;
const TRAIN_LEN = 26;
const TRAIN_W = 15;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ----------------------------------------------------------------------------
// shape paths
// ----------------------------------------------------------------------------

function shapePath(ctx: CanvasRenderingContext2D, shape: ShapeType, x: number, y: number, r: number): void {
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else if (shape === 'square') {
    const s = r * 0.88;
    ctx.rect(x - s, y - s, s * 2, s * 2);
  } else {
    // triangle, pointing up
    const a = -Math.PI / 2;
    for (let i = 0; i < 3; i++) {
      const ang = a + (i * 2 * Math.PI) / 3;
      const px = x + Math.cos(ang) * r * 1.12;
      const py = y + Math.sin(ang) * r * 1.12;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
}

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

// ----------------------------------------------------------------------------
// HUD layout (single-sourced so input can hit-test the same rects)
// ----------------------------------------------------------------------------

export function lineChipRects(vp: Viewport, count: number): Rect[] {
  const w = 118;
  const h = 30;
  const gap = 8;
  const y = vp.cssH - 16 - h;
  const rects: Rect[] = [];
  for (let i = 0; i < count; i++) {
    rects.push({ x: 16 + i * (w + gap), y, w, h });
  }
  return rects;
}

export function draftCardRects(vp: Viewport, n: number): Rect[] {
  const w = 210;
  const h = 156;
  const gap = 20;
  const total = n * w + (n - 1) * gap;
  const startX = (vp.cssW - total) / 2;
  const y = vp.cssH / 2 - h / 2 + 14;
  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) rects.push({ x: startX + i * (w + gap), y, w, h });
  return rects;
}

function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

// ----------------------------------------------------------------------------
// main entry
// ----------------------------------------------------------------------------

export function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  alpha: number,
  vp: Viewport,
  hints: RenderHints,
  pointerScreen: { x: number; y: number } | null,
): void {
  const byId = new Map<number, Station>();
  for (const s of state.stations) byId.set(s.id, s);

  // background (screen space)
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
  drawVignette(ctx, vp);

  // ---- world space ----
  ctx.save();
  ctx.translate(vp.offsetX, vp.offsetY);
  ctx.scale(vp.scale, vp.scale);

  drawWorldBounds(ctx);
  drawLines(ctx, state, byId);
  drawDragPreview(ctx, state, byId, hints);
  drawStations(ctx, state, hints);
  drawTrains(ctx, state, alpha);

  ctx.restore();

  // ---- screen space HUD ----
  drawHud(ctx, state, vp);
  drawLineChips(ctx, state, vp);
  drawHelp(ctx, vp);

  if (state.status === 'gameover') {
    drawGameOver(ctx, state, vp);
  } else if (state.draft) {
    drawDraft(ctx, state, vp, pointerScreen);
  } else if (state.paused) {
    drawPausedBanner(ctx, vp);
  }
}

// ----------------------------------------------------------------------------
// world drawing
// ----------------------------------------------------------------------------

function drawVignette(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const g = ctx.createRadialGradient(
    vp.cssW / 2,
    vp.cssH / 2,
    Math.min(vp.cssW, vp.cssH) * 0.3,
    vp.cssW / 2,
    vp.cssH / 2,
    Math.max(vp.cssW, vp.cssH) * 0.75,
  );
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, PALETTE.bgVignette);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);
}

function drawWorldBounds(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 2;
  roundRectPath(ctx, 8, 8, CONFIG.worldW - 16, CONFIG.worldH - 16, 18);
  ctx.stroke();
}

function drawLines(ctx: CanvasRenderingContext2D, state: GameState, byId: Map<number, Station>): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const line of state.lines) {
    ctx.strokeStyle = line.color;
    ctx.globalAlpha = 0.92;
    ctx.lineWidth = 7;
    ctx.beginPath();
    line.stationIds.forEach((id, i) => {
      const s = byId.get(id)!;
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawDragPreview(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  byId: Map<number, Station>,
  hints: RenderHints,
): void {
  const drag = hints.drag;
  if (!drag) return;
  const from = byId.get(drag.fromStationId);
  if (!from) return;
  const snap = drag.snapStationId != null ? byId.get(drag.snapStationId) : undefined;
  const ex = snap ? snap.x : drag.toX;
  const ey = snap ? snap.y : drag.toY;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = drag.action === 'invalid' ? PALETTE.textDim : drag.color;
  ctx.globalAlpha = snap ? 0.95 : 0.6;
  ctx.lineWidth = snap ? 7 : 5;
  if (!snap) ctx.setLineDash([3, 12]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.setLineDash([]);

  if (snap) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = drag.action === 'invalid' ? PALETTE.textDim : drag.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(snap.x, snap.y, STATION_R + 9, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawStations(ctx: CanvasRenderingContext2D, state: GameState, hints: RenderHints): void {
  for (const st of state.stations) {
    // hover ring
    if (hints.hoverStationId === st.id && !hints.drag) {
      ctx.strokeStyle = 'rgba(240,230,210,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(st.x, st.y, STATION_R + 8, 0, Math.PI * 2);
      ctx.stroke();
    }

    // body
    shapePath(ctx, st.shape, st.x, st.y, STATION_R);
    ctx.fillStyle = PALETTE.stationFill;
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = PALETTE.stationStroke;
    ctx.stroke();

    drawOverflowRing(ctx, st);
    drawQueue(ctx, st);
  }
}

function drawOverflowRing(ctx: CanvasRenderingContext2D, st: Station): void {
  if (st.overflowTimer <= 0.01) return;
  const frac = Math.min(1, st.overflowTimer / CONFIG.overflowToFail);
  // warn -> danger as it fills
  ctx.strokeStyle = frac > 0.66 ? PALETTE.danger : PALETTE.warn;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  const start = -Math.PI / 2;
  ctx.arc(st.x, st.y, STATION_R + 7, start, start + frac * Math.PI * 2);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawQueue(ctx: CanvasRenderingContext2D, st: Station): void {
  const q = st.queue;
  if (q.length === 0) return;
  const perRow = 4;
  const gap = 11;
  const baseX = st.x + STATION_R * 0.7 + 9;
  const baseY = st.y - STATION_R * 0.7 - 8;
  const shown = Math.min(q.length, 16);
  for (let i = 0; i < shown; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const dx = baseX + col * gap;
    const dy = baseY - row * gap;
    const overCap = i >= CONFIG.stationCapacity;
    shapePath(ctx, q[i].destShape, dx, dy, 4.4);
    ctx.fillStyle = overCap ? PALETTE.danger : PALETTE.paper;
    ctx.fill();
  }
  if (q.length > shown) {
    ctx.fillStyle = PALETTE.danger;
    ctx.font = '600 12px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${q.length - shown}`, baseX + perRow * gap, baseY - Math.floor(shown / perRow) * gap);
  }
}

function drawTrains(ctx: CanvasRenderingContext2D, state: GameState, alpha: number): void {
  for (const line of state.lines) {
    for (const tr of line.trains) {
      const x = lerp(tr.ppx, tr.px, alpha);
      const y = lerp(tr.ppy, tr.py, alpha);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(tr.angle);

      roundRectPath(ctx, -TRAIN_LEN / 2, -TRAIN_W / 2, TRAIN_LEN, TRAIN_W, 5);
      ctx.fillStyle = line.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.stroke();

      // occupancy pips (fullness read)
      const cap = tr.capacity;
      const cols = Math.min(cap, 6);
      const cellW = (TRAIN_LEN - 8) / cols;
      for (let i = 0; i < cap; i++) {
        const col = i % cols;
        const rowN = Math.floor(i / cols);
        const cx = -TRAIN_LEN / 2 + 4 + cellW * (col + 0.5);
        const cy = rowN === 0 && cap <= cols ? 0 : (rowN === 0 ? -3.2 : 3.2);
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fillStyle = i < tr.passengers.length ? 'rgba(20,16,12,0.85)' : 'rgba(20,16,12,0.18)';
        ctx.fill();
      }
      ctx.restore();
    }
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
  // top gradient strip for legibility
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(20,16,12,0.55)');
  g.addColorStop(1, 'rgba(20,16,12,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, vp.cssW, 64);

  // delivered (left)
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 12px -apple-system, sans-serif';
  ctx.fillText('DELIVERED', 18, 24);
  ctx.fillStyle = PALETTE.text;
  ctx.font = '700 30px -apple-system, sans-serif';
  ctx.fillText(`${state.delivered}`, 18, 52);

  // clock (center)
  ctx.textAlign = 'center';
  ctx.fillStyle = PALETTE.text;
  ctx.font = '600 22px ui-monospace, Menlo, monospace';
  ctx.fillText(fmtTime(state.time), vp.cssW / 2, 34);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 11px -apple-system, sans-serif';
  ctx.fillText(state.paused && !state.draft ? 'PAUSED' : `${Math.round(state.totalSpawned)} spawned`, vp.cssW / 2, 50);

  // strain pips (right)
  ctx.textAlign = 'right';
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '600 12px -apple-system, sans-serif';
  ctx.fillText('STRAIN', vp.cssW - 18, 24);
  const pipR = 8;
  const pipGap = 22;
  for (let i = 0; i < state.maxStrain; i++) {
    const cx = vp.cssW - 18 - pipR - i * pipGap;
    const cy = 44;
    ctx.beginPath();
    ctx.arc(cx, cy, pipR, 0, Math.PI * 2);
    const filled = state.maxStrain - 1 - i < state.strain;
    ctx.fillStyle = filled ? PALETTE.danger : 'rgba(240,230,210,0.12)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = filled ? PALETTE.danger : 'rgba(240,230,210,0.35)';
    ctx.stroke();
  }
}

function drawLineChips(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport): void {
  const rects = lineChipRects(vp, state.availableLineSlots);
  ctx.textBaseline = 'middle';
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const line = state.lines[i];
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 7);
    if (line) {
      ctx.fillStyle = 'rgba(20,16,12,0.5)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = line.color;
      ctx.stroke();
      // color swatch
      ctx.fillStyle = line.color;
      ctx.beginPath();
      ctx.arc(r.x + 16, r.y + r.h / 2, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = PALETTE.text;
      ctx.textAlign = 'left';
      ctx.font = '600 12px -apple-system, sans-serif';
      ctx.fillText(`${line.stationIds.length} stops · ${line.trains.length}T`, r.x + 30, r.y + r.h / 2 + 1);
    } else {
      ctx.fillStyle = 'rgba(20,16,12,0.3)';
      ctx.fill();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(240,230,210,0.3)';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = PALETTE.textDim;
      ctx.textAlign = 'center';
      ctx.font = '600 11px -apple-system, sans-serif';
      ctx.fillText('free line', r.x + r.w / 2, r.y + r.h / 2 + 1);
    }
  }
}

function drawHelp(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const lines = [
    'Drag station → station: new line',
    'Drag from a line end: extend',
    'Right-click a line: delete',
    'Space: pause/replan   ·   R: restart',
  ];
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '500 11px -apple-system, sans-serif';
  ctx.fillStyle = PALETTE.textDim;
  let y = vp.cssH - 18 - (lines.length - 1) * 15;
  for (const l of lines) {
    ctx.fillText(l, vp.cssW - 16, y);
    y += 15;
  }
}

// ----------------------------------------------------------------------------
// overlays
// ----------------------------------------------------------------------------

function drawPausedBanner(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  const w = 300;
  const h = 34;
  const x = vp.cssW / 2 - w / 2;
  const y = 70;
  roundRectPath(ctx, x, y, w, h, 8);
  ctx.fillStyle = 'rgba(232,163,61,0.16)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = PALETTE.warn;
  ctx.stroke();
  ctx.fillStyle = PALETTE.warn;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 13px -apple-system, sans-serif';
  ctx.fillText('PAUSED — draw / extend / delete freely', vp.cssW / 2, y + h / 2 + 1);
}

function drawDraft(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  vp: Viewport,
  pointerScreen: { x: number; y: number } | null,
): void {
  if (!state.draft) return;
  ctx.fillStyle = 'rgba(15,12,9,0.74)';
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.warn;
  ctx.font = '700 26px -apple-system, sans-serif';
  ctx.fillText('RUSH HOUR', vp.cssW / 2, vp.cssH / 2 - 110);
  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 14px -apple-system, sans-serif';
  ctx.fillText('Pick one upgrade — click or press 1 / 2 / 3', vp.cssW / 2, vp.cssH / 2 - 86);

  const opts = state.draft.options;
  const rects = draftCardRects(vp, opts.length);
  for (let i = 0; i < opts.length; i++) {
    const r = rects[i];
    const hover = pointerScreen ? pointInRect(pointerScreen.x, pointerScreen.y, r) : false;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 12);
    ctx.fillStyle = hover ? PALETTE.panelEdge : PALETTE.panel;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hover ? PALETTE.warn : 'rgba(240,230,210,0.25)';
    ctx.stroke();

    ctx.fillStyle = PALETTE.textDim;
    ctx.font = '700 13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`[${i + 1}]`, r.x + 16, r.y + 28);

    ctx.fillStyle = PALETTE.text;
    ctx.font = '700 20px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts[i].title, r.x + r.w / 2, r.y + 78);

    ctx.fillStyle = PALETTE.textDim;
    ctx.font = '500 13px -apple-system, sans-serif';
    wrapText(ctx, opts[i].desc, r.x + r.w / 2, r.y + 104, r.w - 28, 17);
  }
}

function drawGameOver(ctx: CanvasRenderingContext2D, state: GameState, vp: Viewport): void {
  ctx.fillStyle = 'rgba(15,12,9,0.82)';
  ctx.fillRect(0, 0, vp.cssW, vp.cssH);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = PALETTE.danger;
  ctx.font = '800 44px -apple-system, sans-serif';
  ctx.fillText('RUN OVER', vp.cssW / 2, vp.cssH / 2 - 56);

  ctx.fillStyle = PALETTE.text;
  ctx.font = '700 22px -apple-system, sans-serif';
  ctx.fillText(`${state.delivered} delivered`, vp.cssW / 2, vp.cssH / 2 - 14);

  ctx.fillStyle = PALETTE.textDim;
  ctx.font = '500 15px -apple-system, sans-serif';
  ctx.fillText(
    `survived ${fmtTime(state.time)}   ·   ${state.stations.length} stations   ·   ${state.totalSpawned} riders`,
    vp.cssW / 2,
    vp.cssH / 2 + 16,
  );

  ctx.fillStyle = PALETTE.warn;
  ctx.font = '600 16px -apple-system, sans-serif';
  ctx.fillText('Press R to start a new run', vp.cssW / 2, vp.cssH / 2 + 56);
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxW: number,
  lineH: number,
): void {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, cx, yy);
      line = w;
      yy += lineH;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, cx, yy);
}
