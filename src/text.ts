// text.ts — canvas text layout helpers (wrap, fit, truncate).

export type TextAlign = 'left' | 'center' | 'right';

function breakLongWord(ctx: CanvasRenderingContext2D, word: string, maxW: number): string[] {
  const lines: string[] = [];
  let chunk = '';
  for (const ch of word) {
    const test = chunk + ch;
    if (ctx.measureText(test).width > maxW && chunk) {
      lines.push(chunk);
      chunk = ch;
    } else {
      chunk = test;
    }
  }
  if (chunk) lines.push(chunk);
  return lines.length ? lines : [''];
}

/** Word-wrap text; returns line strings without drawing. */
export function measureWrappedLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  if (!text || maxW <= 0) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW) {
      if (line) {
        lines.push(line);
        line = '';
      }
      if (ctx.measureText(w).width > maxW) {
        const broken = breakLongWord(ctx, w, maxW);
        lines.push(...broken.slice(0, -1));
        line = broken[broken.length - 1] ?? '';
      } else {
        line = w;
      }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Draw wrapped text; returns the Y after the last line. */
export function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lineH: number,
  align: TextAlign = 'left',
): number {
  const lines = measureWrappedLines(ctx, text, maxW);
  const prevAlign = ctx.textAlign;
  ctx.textAlign = align;
  let yy = y;
  for (const ln of lines) {
    let drawX = x;
    if (align === 'center') drawX = x;
    else if (align === 'right') drawX = x;
    ctx.fillText(ln, drawX, yy);
    yy += lineH;
  }
  ctx.textAlign = prevAlign;
  return lines.length ? yy : y;
}

/** Shrink font size until text fits in maxW; preserves caller font family/weight. */
export function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  basePx: number,
  minPx: number,
): number {
  const template = ctx.font.replace(/\b\d+(?:\.\d+)?px\b/, 'SIZEpx');
  let size = basePx;
  while (size > minPx) {
    ctx.font = template.replace('SIZEpx', `${size}px`);
    if (ctx.measureText(text).width <= maxW) return size;
    size -= 0.5;
  }
  ctx.font = template.replace('SIZEpx', `${minPx}px`);
  return minPx;
}

/** Draw a single centered line, shrinking font to fit maxW. Restores ctx.font to fitted size. */
export function drawFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  maxW: number,
  basePx: number,
  minPx: number,
): void {
  const saved = ctx.font;
  fitFontSize(ctx, text, maxW, basePx, minPx);
  const prevBaseline = ctx.textBaseline;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
  ctx.textBaseline = prevBaseline;
  ctx.textAlign = prevAlign;
  ctx.font = saved;
}

/** Truncate text with ellipsis to fit maxW. */
export function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  ellipsis = '…',
): string {
  if (!text || ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (ctx.measureText(candidate).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : ellipsis;
}

/** Draw left-aligned fitted text (shrink font). */
export function drawFittedTextLeft(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  basePx: number,
  minPx: number,
): void {
  const saved = ctx.font;
  fitFontSize(ctx, text, maxW, basePx, minPx);
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  ctx.fillText(text, x, y);
  ctx.textAlign = prevAlign;
  ctx.font = saved;
}
