// Sprite-sheet grid for the quick exports: cells run left to right in one
// row and wrap only when a row would pass the browser's canvas size limit
// (about 16384px a side), so a short animation is a plain strip.
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 67108864; // 8192 x 8192: 256MB as RGBA, what one export image may hold

/** Whether a `w` x `h` raster is one the browser can be trusted to build. */
export function fits(w, h, maxSide = MAX_SIDE) {
  return w <= maxSide && h <= maxSide && w * h <= MAX_PIXELS;
}

/**
 * `sizes` is `[{ w, h }]`, one per image. Every cell is as large as the
 * largest image; smaller ones are centred across and sit on the cell's
 * bottom edge, like the on-screen collection grid. Throws a RangeError when
 * even the wrapped sheet is too large to build.
 */
export function sheetLayout(sizes, gap = 0, maxSide = MAX_SIDE) {
  if (!sizes.length) return { cols: 0, rows: 0, w: 0, h: 0, cells: [] };
  const cellW = Math.max(...sizes.map((s) => s.w));
  const cellH = Math.max(...sizes.map((s) => s.h));
  const cols = Math.min(sizes.length, Math.max(1, Math.floor((maxSide + gap) / (cellW + gap))));
  const rows = Math.ceil(sizes.length / cols);
  const w = cols * (cellW + gap) - gap, h = rows * (cellH + gap) - gap;
  if (!fits(w, h, maxSide)) throw new RangeError(`Sheet of ${w}x${h} is too large`);
  const cells = sizes.map((s, i) => ({
    x: (i % cols) * (cellW + gap) + Math.floor((cellW - s.w) / 2),
    y: Math.floor(i / cols) * (cellH + gap) + (cellH - s.h),
  }));
  return { cols, rows, w, h, cells };
}
