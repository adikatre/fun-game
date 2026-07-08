// upgrade-layout.ts — shared geometry for the tiered upgrade shop (render + input).

import type { Viewport } from './types';
import { UPGRADE_DEFS, type UpgradeId, type UpgradeState } from './upgrades';
import { measureWrappedLines } from './text';

export const TIER_DEFS: { label: string; ids: UpgradeId[] }[] = [
  { label: 'TIER 1 — STARTER UPGRADES', ids: ['runway_2', 'gates_1', 'radar_range_1', 'fuel_reserves', 'fast_turnaround_1'] },
  { label: 'TIER 2 — ADVANCED', ids: ['gates_2', 'radar_range_2', 'fast_turnaround_2', 'weather_radar'] },
  { label: 'TIER 3 — EXPANSION', ids: ['runway_4', 'gates_3'] },
  { label: 'TIER 4 — ULTIMATE', ids: ['runway_5'] },
];

export const UPGRADE_HEADER_H = 110;
export const UPGRADE_BOTTOM_BAR_H = 90;
const BASE_CARD_H = 68;
const CARD_GAP = 10;
const TIER_GAP = 18;
const TIER_HEADER_H = 40;
const TEXT_LEFT = 60;
const RIGHT_COL_W = 100;
const DESC_LINE_H = 14;
const CONTENT_PAD_TOP = 20;

export function upgradeCardWidth(vp: Viewport): number {
  return Math.min(560, vp.cssW - 60);
}

function textMaxWidth(cardW: number): number {
  return cardW - TEXT_LEFT - RIGHT_COL_W - 8;
}

export function upgradeCardHeight(
  ctx: CanvasRenderingContext2D,
  cardW: number,
  description: string,
): number {
  ctx.font = '400 11.5px Inter, system-ui, sans-serif';
  const descLines = measureWrappedLines(ctx, description, textMaxWidth(cardW));
  const extra = Math.max(0, descLines.length - 1) * DESC_LINE_H;
  return BASE_CARD_H + extra;
}

export interface UpgradeCardRect {
  id: UpgradeId;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** All upgrade card hit/draw rects (screen coords, scroll applied). */
export function upgradeCardRects(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  scrollY: number,
  _ups: UpgradeState,
): UpgradeCardRect[] {
  const cx = vp.cssW / 2;
  const cardW = upgradeCardWidth(vp);
  const contentTop = UPGRADE_HEADER_H;
  let yy = contentTop + CONTENT_PAD_TOP - scrollY;
  const rects: UpgradeCardRect[] = [];

  for (const tier of TIER_DEFS) {
    yy += TIER_HEADER_H + CARD_GAP;
    for (const id of tier.ids) {
      const def = UPGRADE_DEFS.find((d) => d.id === id);
      if (!def) continue;
      const h = upgradeCardHeight(ctx, cardW, def.description);
      rects.push({
        id,
        x: cx - cardW / 2,
        y: yy,
        w: cardW,
        h,
      });
      yy += h + CARD_GAP;
    }
    yy += TIER_GAP;
  }
  return rects;
}

/** Total scrollable content height (unscrolled). */
export function upgradeContentHeight(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  ups: UpgradeState,
): number {
  const cardW = upgradeCardWidth(vp);
  let h = CONTENT_PAD_TOP;
  for (let ti = 0; ti < TIER_DEFS.length; ti++) {
    h += TIER_HEADER_H + CARD_GAP;
    for (const id of TIER_DEFS[ti].ids) {
      const def = UPGRADE_DEFS.find((d) => d.id === id);
      if (!def) continue;
      h += upgradeCardHeight(ctx, cardW, def.description) + CARD_GAP;
    }
    h += TIER_GAP;
  }
  void ups;
  return h;
}

export function upgradeScrollMax(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  ups: UpgradeState,
): number {
  const visible = vp.cssH - UPGRADE_HEADER_H - UPGRADE_BOTTOM_BAR_H;
  const content = upgradeContentHeight(ctx, vp, ups);
  return Math.max(0, content - visible + CONTENT_PAD_TOP);
}

export function upgradeAtPoint(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  scrollY: number,
  ups: UpgradeState,
  sx: number,
  sy: number,
): UpgradeId | null {
  const contentTop = UPGRADE_HEADER_H;
  const contentBottom = vp.cssH - UPGRADE_BOTTOM_BAR_H;
  if (sy < contentTop || sy > contentBottom) return null;
  for (const r of upgradeCardRects(ctx, vp, scrollY, ups)) {
    if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return r.id;
  }
  return null;
}
