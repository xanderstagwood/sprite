// Pure pixel-buffer math shared by every {width, height, pixels, stride,
// colors} view: main.js binds this shape to whichever layer+frame is
// currently active. `pixels` is a Uint16Array of indices into `colors`, the
// owning File's color table (index 0 = transparent). The public API stays
// hex-based; indices never leak past this module except through the raw
// snapshot/`pixels` copies main.js takes for undo diffs.
// `stride` (row length in the backing array) defaults to `width`;
// it differs after a canvas shrink, where the visible window (width/height)
// is a top-left crop of a wider logical buffer (§13.4) rather than a
// same-size copy: this lets that crop stay a view, not a copy.
export function inBounds(model, x, y) {
  return x >= 0 && y >= 0 && x < model.width && y < model.height;
}

const MAX_COLORS = 65535; // Uint16 index space, minus the transparent slot
const internMaps = new WeakMap(); // colors array -> Map<HEX, index>, rebuilt if the array changed underneath
const packedTables = new WeakMap(); // colors array -> { length, table: Uint32Array }

export function createColorTable() {
  return [null];
}

function internMap(colors) {
  let map = internMaps.get(colors);
  if (!map || map.size !== colors.length - 1) {
    map = new Map();
    for (let i = 1; i < colors.length; i++) map.set(colors[i], i);
    internMaps.set(colors, map);
  }
  return map;
}

// Hex -> table index, appending on first sight. A blended (off-palette)
// color goes through the same path, which is the whole reason the table
// exists instead of palette indices. Past 65,535 distinct colors the
// nearest existing entry wins rather than losing the stroke.
export function colorIndex(colors, hex) {
  if (!hex) return 0;
  const key = hex.toUpperCase();
  const map = internMap(colors);
  let i = map.get(key);
  if (i !== undefined) return i;
  if (colors.length > MAX_COLORS) return nearestColorIndex(colors, key);
  i = colors.length;
  colors.push(key);
  map.set(key, i);
  return i;
}

function nearestColorIndex(colors, hex) {
  const t = hexToRgb(hex);
  let best = 1, bestD = Infinity;
  for (let i = 1; i < colors.length; i++) {
    const c = hexToRgb(colors[i]);
    const d = (c.r - t.r) ** 2 + (c.g - t.g) ** 2 + (c.b - t.b) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Table as packed RGBA words (see hexToPacked), cached until it grows.
export function packedTable(colors) {
  let cached = packedTables.get(colors);
  if (!cached || cached.length !== colors.length) {
    const table = new Uint32Array(colors.length);
    for (let i = 1; i < colors.length; i++) table[i] = hexToPacked(colors[i]);
    cached = { length: colors.length, table };
    packedTables.set(colors, cached);
  }
  return cached.table;
}

// One pixel as a single 32-bit word laid out R,G,B,A in memory (a
// little-endian Uint32 over ImageData bytes), 0 = transparent. Composites
// are built in this form so the renderer can copy them straight into an
// ImageData with no per-pixel parsing.
export function hexToPacked(hex) {
  const { r, g, b } = hexToRgb(hex);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function packedToHex(p) {
  return rgbToHex(p & 255, (p >> 8) & 255, (p >> 16) & 255);
}

export function getPixel(model, x, y) {
  if (!inBounds(model, x, y)) return null;
  return model.colors[model.pixels[y * (model.stride || model.width) + x]];
}

// `mask` (optional, full-canvas boolean array) restricts the write to inside
// an active selection: every user-facing place/paint/erase tool passes it;
// internal selection transforms (move/flip/rotate) omit it since they must
// write outside the mask's old position.
export function setPixel(model, x, y, colorHex, mask) {
  // Checked before resolving so a rejected write never interns a colour.
  if (!inBounds(model, x, y) || (mask && !mask[y * model.width + x])) return;
  setPixelIndex(model, x, y, colorIndex(model.colors, colorHex), mask);
}

// setPixel for a caller that already resolved the colour: a stamp or fill
// resolves once instead of hashing an uppercased string per cell.
export function setPixelIndex(model, x, y, idx, mask) {
  if (!inBounds(model, x, y)) return;
  if (mask && !mask[y * model.width + x]) return;
  model.pixels[y * (model.stride || model.width) + x] = idx;
  touch(model.pixels, x, y);
}

let nextBufferId = 1;

// Stable identity for a layer buffer (an expando, like `v` and `dirty`
// below): lets the composite cache and the persistence layer recognise
// "the same buffer" across structural edits without holding references.
export function bufferId(pixels) {
  return pixels.id ??= nextBufferId++;
}

// Change tracking for sprite-file.js's composite cache. Every write to a
// layer buffer bumps its `v` and grows its dirty rectangle (`dirty` =
// [x0, y0, x1, y1], or 'all' when the extent is unknown), so a cached
// composite can tell what, if anything, it must redo. A caller that writes
// `pixels[i]` directly (bypassing setPixel) must call touch(pixels) itself.
export function touch(pixels, x, y) {
  pixels.v = (pixels.v | 0) + 1;
  const d = pixels.dirty;
  if (d === 'all') return;
  if (x === undefined) pixels.dirty = 'all';
  else if (!d) pixels.dirty = [x, y, x, y];
  else {
    if (x < d[0]) d[0] = x;
    if (y < d[1]) d[1] = y;
    if (x > d[2]) d[2] = x;
    if (y > d[3]) d[3] = y;
  }
}

// Whole-array snapshot/diff, used to build one undo EditCommand per committed
// action (a drag-stroke, a fill, a delete) rather than per pixel. Diffs are
// emitted in hex, not indices, so a command stays valid even if the color
// table later changes shape.
export function snapshotPixels(model) {
  return model.pixels.slice();
}

// A diff side is a flat Uint32Array of [bufferPosition, colorIndex] pairs
// (8 bytes per changed pixel): a per-pixel [x, y, hex] array would cost
// ~50MB per full-canvas edit at 512x512. Indices refer to the file's
// color table, which only ever appends, so they stay valid for the life of
// the file. Positions are raw buffer offsets, independent of stride.
export function diffFromSnapshot(model, snapshot) {
  const pixels = model.pixels;
  let n = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== snapshot[i]) n++;
  const before = new Uint32Array(n * 2), after = new Uint32Array(n * 2);
  let k = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] === snapshot[i]) continue;
    before[k] = after[k] = i;
    before[k + 1] = snapshot[i];
    after[k + 1] = pixels[i];
    k += 2;
  }
  return { before, after };
}

export function applyDiff(model, side) {
  const stride = model.stride || model.width;
  for (let k = 0; k < side.length; k += 2) {
    const i = side[k];
    model.pixels[i] = side[k + 1];
    touch(model.pixels, i % stride, (i / stride) | 0);
  }
}

// A typed or pasted hex code as `#RRGGBB`, or null while it isn't a complete
// one. `#` is optional. 3-digit shorthand is accepted only on request, so a
// live-updating field doesn't flash #AABBCC on the way to typing #AABBCD.
export function normalizeHex(text, allowShorthand = false) {
  if (typeof text !== 'string') return null;
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(text.trim());
  if (!m || (m[1].length === 3 && !allowShorthand)) return null;
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return '#' + digits.toUpperCase();
}

// The hex field shows six digits after a fixed "#". `prev` is its text before
// an edit and `next` after: whatever the edit inserted is kept and old digits
// give way to make room (after the insertion from the end, then before it from
// the beginning); only a paste longer than six digits loses its own tail.
export function fitHex(prev, next, size = 6) {
  const room = Math.min(prev.length, next.length);
  let a = 0;
  while (a < room && prev[a] === next[a]) a++;
  let z = 0;
  while (z < room - a && prev[prev.length - 1 - z] === next[next.length - 1 - z]) z++;
  let head = next.slice(0, a);
  let ins = next.slice(a, next.length - z).replace(/[#\s]/g, '');
  let tail = next.slice(next.length - z);
  let over = head.length + ins.length + tail.length - size;
  const cut = Math.max(0, Math.min(over, tail.length));
  tail = tail.slice(0, tail.length - cut);
  over -= cut;
  const drop = Math.max(0, Math.min(over, head.length));
  head = head.slice(drop);
  over -= drop;
  if (over > 0) ins = ins.slice(0, ins.length - over);
  return { value: head + ins + tail, caret: head.length + ins.length };
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// Source-over of packed `top` at `alpha` onto packed `base` (0 = transparent),
// rounding each channel. Shared by display compositing (sprite-file.js) and
// painted blending here, so the two can never drift apart.
export function blendPacked(base, top, alpha) {
  if (alpha >= 1 || !base) return top;
  if (alpha <= 0) return base;
  const r = Math.round((base & 255) + ((top & 255) - (base & 255)) * alpha);
  const g = Math.round(((base >> 8) & 255) + (((top >> 8) & 255) - ((base >> 8) & 255)) * alpha);
  const b = Math.round(((base >> 16) & 255) + (((top >> 16) & 255) - ((base >> 16) & 255)) * alpha);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

// Blends in packed-integer space instead of hex strings. `blender(colors,
// topHex)` resolves the top colour once; each blendAt call then reads the
// pixel's index, blends, and maps the result back to an index through a
// per-blender memo: a soft brush yields only a handful of distinct results,
// so the hex round-trip happens once per result, not once per pixel.
// Baking the blend into a resolved color (rather than storing alpha per
// pixel) keeps the model a flat grid of solid-or-transparent colors, so
// repeated re-renders never re-blend against the same pixel twice.
function blender(colors, topHex) {
  const top = hexToPacked(topHex);
  const table = packedTable(colors);
  const memo = new Map();
  return (model, x, y, alpha, mask) => {
    if (!inBounds(model, x, y)) return;
    const at = y * (model.stride || model.width) + x;
    const from = model.pixels[at];
    // A colour interned earlier in this same operation isn't in `table` yet.
    const base = !from ? 0 : from < table.length ? table[from] : hexToPacked(colors[from]);
    const blended = blendPacked(base, top, alpha);
    let idx = memo.get(blended);
    if (idx === undefined) memo.set(blended, idx = colorIndex(colors, packedToHex(blended)));
    setPixelIndex(model, x, y, idx, mask);
  };
}

export function blendPixel(model, x, y, colorHex, alpha, mask) {
  blender(model.colors, colorHex)(model, x, y, alpha, mask);
}

// Antialiased stamp: soft circular brush, alpha falling off from center.
// `size` is the same NxN unit the plain square brush uses (§8): radius is
// derived from it so both tools share one brush-size value.
// `dither` paints only cells where (x + y) is even: a 50% checkerboard
// anchored to the canvas origin, so separate strokes line up. Off cells are
// skipped, not erased.
export function stampBrush(model, cx, cy, size, colorHex, mask, dither = false) {
  const r = Math.max(0.5, size / 2);
  const blendAt = blender(model.colors, colorHex);
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r || (dither && (x + y) % 2)) continue;
      const alpha = r <= 0.5 ? 1 : Math.max(0, Math.min(1, 1 - d / r));
      blendAt(model, x, y, alpha, mask);
    }
  }
}

// Plain (hard-edged) square brush stamp: 1x1, 2x2, 3x3, and so on.
export function stampSquare(model, cx, cy, size, colorHex, mask) {
  const half = Math.floor(size / 2);
  const idx = colorIndex(model.colors, colorHex);
  for (let y = cy - half; y < cy - half + size; y++) {
    for (let x = cx - half; x < cx - half + size; x++) {
      setPixelIndex(model, x, y, idx, mask);
    }
  }
}

// The cells a stroke at (x, y) also lands on under `symmetry`, the axis
// through the canvas centre: x -> width - 1 - x, y -> height - 1 - y. Exact
// for odd and even sizes alike. Includes (x, y) itself.
export function mirroredPoints(model, x, y, symmetry) {
  const pts = [[x, y]];
  const mx = symmetry === 'h' || symmetry === 'both', my = symmetry === 'v' || symmetry === 'both';
  if (mx) pts.push([model.width - 1 - x, y]);
  if (my) pts.push([x, model.height - 1 - y]);
  if (mx && my) pts.push([model.width - 1 - x, model.height - 1 - y]);
  return pts;
}

// The one place a brush stamp is decided, shared by the mouse (input.js)
// and keyboard (main.js) paint paths so anything that changes how a cell
// gets painted (symmetry, dither) is written once. Erase is always a hard
// square; Paint (`antialiased`) is the soft circular brush, the only one
// `dither` applies to; otherwise Place, a hard-edged square. `color` null/erase both write transparent.
// `symmetry` repeats the stamp across the canvas centre; goes through the
// stamps' setPixel, never raw buffer offsets (a shrunk canvas has
// stride != width).
export function paintAt(model, x, y, { size, antialiased = false, erase = false, color, mask, dither = false, symmetry = 'off' }) {
  const soft = antialiased && !erase;
  const stamp = (cx, cy) => {
    if (erase) stampSquare(model, cx, cy, size, null, mask);
    else if (antialiased) stampBrush(model, cx, cy, size, color, mask, dither);
    else stampSquare(model, cx, cy, size, color, mask);
  };
  stamp(x, y);
  if (symmetry === 'off') return;
  // A square stamp of even size isn't centred on a cell, so its mirrored
  // centre shifts by one; the soft brush is always centred on a cell.
  const half = Math.floor(size / 2);
  const flip = (c, extent) => (soft ? extent - 1 - c : extent - size - c + 2 * half);
  const mx = symmetry === 'h' || symmetry === 'both', my = symmetry === 'v' || symmetry === 'both';
  if (mx) stamp(flip(x, model.width), y);
  if (my) stamp(x, flip(y, model.height));
  if (mx && my) stamp(flip(x, model.width), flip(y, model.height));
}

// Plain (non-antialiased) flood fill: all 4-connected pixels matching the
// clicked pixel's color are replaced outright. `mask` (active selection)
// also bounds the fill's spread, not just which pixels get written: a
// selection is a hard wall the flood can't leak through.
export function floodFill(model, startX, startY, colorHex, antialiased = false, mask, dither = false) {
  if (!inBounds(model, startX, startY)) return;
  const stride = model.stride || model.width;
  const target = model.pixels[startY * stride + startX];
  const fillIdx = colorIndex(model.colors, colorHex);
  if (target === fillIdx) return;
  const w = model.width, h = model.height;

  // Flat typed visited/stack of cell indices, not per-cell arrays: at 512x512
  // a fill can touch 262k cells. A cell is marked when pushed, so it is
  // pushed at most once and a stack of w*h can never overflow. `visited`
  // ends up as exactly the filled region, which the antialias pass reuses.
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0, minX = w, minY = h, maxX = -1, maxY = -1;
  const push = (x, y) => {
    const i = y * w + x;
    if (visited[i] || model.pixels[y * stride + x] !== target || (mask && !mask[i])) return;
    visited[i] = 1;
    stack[sp++] = i;
  };
  push(startX, startY);
  while (sp) {
    const i = stack[--sp], x = i % w, y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x + 1 < w) push(x + 1, y);
    if (x > 0) push(x - 1, y);
    if (y + 1 < h) push(x, y + 1);
    if (y > 0) push(x, y - 1);
  }
  if (maxX < 0) return;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!visited[y * w + x] || (dither && (x + y) % 2)) continue;
      setPixelIndex(model, x, y, fillIdx, mask);
    }
  }

  if (antialiased) {
    // Soften the fill's outer boundary: any filled pixel touching a
    // non-matching neighbor gets a partial blend toward that neighbor's
    // original color, approximating an antialiased fill edge.
    const blendAt = blender(model.colors, colorHex);
    const outside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !visited[y * w + x];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!visited[y * w + x]) continue;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (outside(nx, ny)) blendAt(model, x, y, 0.6);
        }
      }
    }
  }
}

// Bresenham: every grid cell on the line from (x0,y0) to (x1,y1), inclusive.
// Used to fill gaps when the pointer moves fast during a drag stroke.
export function linePixels(x0, y0, x1, y1) {
  const pts = [];
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0, y = y0;
  while (true) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return pts;
}
