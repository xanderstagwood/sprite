// Bounding boxes of the pixels that are in use, for trimming a canvas and for
// exporting a selection. Packed pixels are RGBA words (canvas-model.js hexToPacked),
// alpha in the top byte.

/** `{ x0, y0, x1, y1 }` (x1/y1 exclusive) of the non-empty cells of a layer buffer of colour-table indices (0 = empty) read from a `stride`-wide array, or null if there are none. */
export function indexedBounds(pixels, stride, w, h) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!pixels[y * stride + x]) continue;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      y1 = y + 1;
    }
  }
  return x1 ? { x0, y0, x1, y1 } : null;
}

/** Smallest box holding both; either may be null (nothing visible). */
export function unionBounds(a, b) {
  if (!a || !b) return a || b;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/**
 * Exporting a selection: the bounding box of the `mask`ed pixels of a `w` x `h`
 * image, with everything the mask does not cover inside it made transparent.
 * Null when the mask is empty.
 */
export function cropToMask(pixels, w, h, mask) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      y1 = y + 1;
    }
  }
  if (!x1) return null;
  const bw = x1 - x0, bh = y1 - y0;
  const out = new Uint32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const from = (y0 + y) * w + x0 + x;
      if (mask[from]) out[y * bw + x] = pixels[from];
    }
  }
  return { pixels: out, w: bw, h: bh };
}
