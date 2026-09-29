import { hexToRgb } from './canvas-model.js';
import { computeViewport } from './viewport.js';
import { snapFontSize } from './pixel-snap.js';
import { snapLength } from './viewport.js';

// Shared solid-color set for every backdrop in the app: the app-wide
// chrome background (Shift+U/Ctrl+U), the sprite's own backdrop (`u`,
// alongside its 4th "checker" option), and the group grid's own: same
// three colors and keys (main.js's BG_STEPS/GROUP_APP_BG_STEPS) everywhere,
// so "the canvas and app backdrop are the same color" is a plain string
// comparison, not two separate vocabularies mapped onto each other.
// Pinned to the official Sprite UI palette (style.css's --gray-0..13 ramp,
// spec/ui-colors.png) rather than pure black/white: darkest step (gray-13)
// and second-brightest (gray-1, one step in from pure white gray-0).
const SHADE_BLACK = '#1B1A19'; // --gray-13
const SHADE_GREY = '#808080';
const SHADE_WHITE = '#F3F2F1'; // --gray-1
const BG_SOLID = { black: SHADE_BLACK, grey: SHADE_GREY, white: SHADE_WHITE };
const CHECKER_LIGHT = '#DEDEDE';
const CHECKER_DARK = '#CFCFCF';
const CHECKER_CELL = 4; // canvas pixels per checker square: an 8x8 sprite reads as a 2x2 checkerboard
const GROUP_CHECKER_CELL = 24; // screen px per square: big and chunky, legible at any zoom (not tied to sprite size)
const GRID_ALPHA = 0.35;
const GRID_MIN_SPACING_PX = 6; // never draw grid lines closer together than this on screen
const GRID_MIN_CELL_PX = 5; // a canvas pixel smaller than this many device pixels (the zoom readout's 100% = 1) has no room for a grid: it is hidden
const RULER_THICKNESS = 16;
const RULER_BG = '#1A1A1D';
const RULER_TICK = '#444441';
const RULER_HIGHLIGHT = '#F2F2F0';
const CROSSHAIR_COLOR = '#FFFFFF';
const ONION_BEFORE_TINT = '#BE1425';
const ONION_AFTER_TINT = '#3366FF';

// Returns whether the selection ants are marching, i.e. whether the caller
// must keep rendering to animate them.
export function render(ctx, model, viewW, viewH, { showGrid, showRuler, symmetry = 'off', references, selection, onionFrames, brushCursor, cursorPos, canvasBg = 'checker', appBg = 'black' }) {
  const { scale, ox, oy } = computeViewport(model, viewW, viewH);
  const w = model.width * scale;
  const h = model.height * scale;

  // The transparency checkerboard is a base layer for the whole scene,
  // pixel-aligned to the canvas's own grid (not just drawn within the
  // sprite's bounds): Shift+U's "checker" backdrop and `u`'s "checker"
  // canvas backdrop are then just "leave this alone" instead of each
  // computing their own separately-aligned pattern, so the two can never
  // drift out of sync with each other or with the sprite itself.
  fillCheckerboard(ctx, scale, ox, oy, 0, 0, viewW, viewH);

  if (appBg !== 'checker') {
    ctx.fillStyle = BG_SOLID[appBg] || SHADE_BLACK;
    ctx.fillRect(0, 0, viewW, viewH);
  }

  // [U] cycles the sprite's own backdrop: checker (shows transparency: the
  // base layer above, re-exposed here if the app backdrop just covered it),
  // or a solid white/grey/black matte to preview against a flat background.
  if (canvasBg === 'checker') {
    if (appBg !== 'checker') fillCheckerboard(ctx, scale, ox, oy, ox, oy, w, h);
  } else {
    ctx.fillStyle = BG_SOLID[canvasBg];
    ctx.fillRect(ox, oy, w, h);
  }

  if (onionFrames || ghostCache.size) {
    const nextCache = new Map();
    for (const ghost of onionFrames || []) drawGhost(ctx, model, ghost, scale, ox, oy, nextCache);
    ghostCache = nextCache;
  }

  if (references) drawReferences(ctx, references, scale, ox, oy, w, h);

  drawPixels(ctx, model, scale, ox, oy, w, h);

  if (symmetry !== 'off') drawSymmetryAxes(ctx, symmetry, ox, oy, w, h);

  if (showGrid && scale * (window.devicePixelRatio || 1) >= GRID_MIN_CELL_PX) {
    // A reference, not a measurement: zoomed out until a canvas pixel is
    // under GRID_MIN_CELL_PX device pixels (500% on the zoom readout), lines would be most of the picture,
    // so there is no grid. Above that the step goes 1px -> 4px -> 16px -> ...
    // (gridStep) until on-screen line spacing clears a minimum, so it's 1x1
    // when pixels are big enough to see individually, and coarser as the
    // canvas shrinks.
    const step = gridStep(scale);

    // 'difference' composite inverts whatever is under each line segment:
    // no single fixed color read against every cell, unlike a single
    // whole-canvas-average color that goes invisible on any cell matching
    // that average (e.g. white lines over white background).
    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.globalAlpha = GRID_ALPHA;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= model.width; x += step) {
      ctx.moveTo(ox + x * scale + 0.5, oy);
      ctx.lineTo(ox + x * scale + 0.5, oy + h);
    }
    for (let y = 0; y <= model.height; y += step) {
      ctx.moveTo(ox, oy + y * scale + 0.5);
      ctx.lineTo(ox + w, oy + y * scale + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  if (showRuler) {
    const alpha = rulerAlpha(w, h);
    if (alpha > 0) {
      ctx.save();
      ctx.globalAlpha = alpha;
      // Follows the same eased trail as the brush cursor (main.js's
      // animateCursor), not the raw hover position: a tiny, deliberate
      // lag/follow on the highlight for character, not just an instant snap.
      const anchor = rulerAnchor(scale, ox, oy, viewW, viewH);
      const trailPixel = cursorPos && { x: Math.round(cursorPos.x), y: Math.round(cursorPos.y) };
      if (cursorPos) drawCrosshair(ctx, cursorPos, anchor, scale, ox, oy, w, h);
      drawRuler(ctx, model, scale, ox, oy, w, h, viewW, viewH, anchor, trailPixel);
      ctx.restore();
    }
  }

  const marching = !!selection && drawSelection(ctx, selection, scale, ox, oy);

  if (brushCursor && cursorPos) {
    // `cursorPos` is the eased trail, not the raw hover pixel: it can lag
    // outside the sprite bounds near an edge before it catches up, so clip
    // rather than trust it to stay in range on its own. Only ever shows
    // within the sprite itself, never over the app background margin.
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, w, h);
    ctx.clip();
    drawBrushCursor(ctx, cursorPos, brushCursor, scale, ox, oy, cursorLuma(model, cursorPos, canvasBg));
    ctx.restore();
  }
  return marching;
}

// Read-only overview of every File in a Collection (§ project panel group
// select), tiled into a grid of small artboards instead of one editable
// canvas: no grid lines, ruler, selection, brush cursor, or onion-skinning,
// since nothing here is editable. Cell size and gap are in *world* units
// (model pixels), laid out once by computeArtboardLayout; render applies one
// shared scale/pan across every cell: a camera over the whole board, not
// each artboard fit independently to its own slot.
const ARTBOARD_GAP = 4; // world px between cells: same value both axes, so the grid reads even

// The column count is the square-ish one rounded up to an even number (never
// more than there are artboards), so a grid never has an odd column.
export function computeArtboardLayout(artboards, gap = ARTBOARD_GAP) {
  if (!artboards.length) return { cols: 0, rows: 0, cellW: 0, cellH: 0, stepX: 0, stepY: 0, totalW: 0, totalH: 0 };
  const cellW = Math.max(...artboards.map((b) => b.width));
  const cellH = Math.max(...artboards.map((b) => b.height));
  const cols = Math.min(artboards.length, Math.ceil(Math.ceil(Math.sqrt(artboards.length)) / 2) * 2);
  const rows = Math.ceil(artboards.length / cols);
  const stepX = cellW + gap;
  const stepY = cellH + gap;
  return { cols, rows, cellW, cellH, stepX, stepY, totalW: cols * stepX - gap, totalH: rows * stepY - gap };
}

// `lift`, while a canvas is being dragged: `{ index, x, y }`. Its own cell shows it faded,
// and it is drawn again, centred on (x, y), following the pointer.
export function renderArtboardGrid(ctx, viewW, viewH, artboards, { appBg = 'black', scale = 1, panX = 0, panY = 0, lift = null } = {}) {
  // The group grid has no single shared pixel grid spanning the whole
  // viewport (every artboard has its own) to pin a checker to, so this one
  // tiles in plain screen pixels (scale 1, origin 0,0) instead of the
  // model-pixel-aligned tiling fillCheckerboard's other call site uses.
  if (appBg === 'checker') fillCheckerboard(ctx, 1, 0, 0, 0, 0, viewW, viewH, GROUP_CHECKER_CELL);
  else { ctx.fillStyle = BG_SOLID[appBg] || SHADE_BLACK; ctx.fillRect(0, 0, viewW, viewH); }
  if (!artboards.length) return;

  const layout = computeArtboardLayout(artboards);
  const originX = viewW / 2 - (layout.totalW * scale) / 2 + panX;
  const originY = viewH / 2 - (layout.totalH * scale) / 2 + panY;

  artboards.forEach((board, i) => {
    const col = i % layout.cols, row = Math.floor(i / layout.cols);
    const cellX = originX + col * layout.stepX * scale;
    const cellY = originY + row * layout.stepY * scale;
    const w = board.width * scale, h = board.height * scale;
    const ox = cellX + ((layout.cellW - board.width) / 2) * scale;
    const oy = cellY + (layout.cellH - board.height) * scale; // bottom-aligned in its cell

    // No per-artboard fill: every artboard is transparent, showing the one
    // shared backdrop (`appBg`, filled once above) straight through.
    if (lift && lift.index === i) ctx.globalAlpha = 0.3;
    drawBoard(ctx, board, ox, oy, w, h);
    ctx.globalAlpha = 1;
  });

  if (lift) {
    const board = artboards[lift.index];
    ctx.globalAlpha = 0.85;
    drawBoard(ctx, board, lift.x - (board.width * scale) / 2, lift.y - (board.height * scale) / 2, board.width * scale, board.height * scale);
    ctx.globalAlpha = 1;
  }
}

// The grid slot (an index into `artboards`) nearest screen point (x, y): the cell it
// falls in, clamped to the grid. Unlike hitTestArtboardGrid it also answers for the gaps
// and margins, so a dragged canvas always has somewhere to land.
export function slotAtPoint(viewW, viewH, artboards, { scale = 1, panX = 0, panY = 0 } = {}, x, y) {
  const layout = computeArtboardLayout(artboards);
  const originX = viewW / 2 - (layout.totalW * scale) / 2 + panX;
  const originY = viewH / 2 - (layout.totalH * scale) / 2 + panY;
  const col = Math.max(0, Math.min(layout.cols - 1, Math.floor((x - originX) / (layout.stepX * scale))));
  const row = Math.max(0, Math.min(layout.rows - 1, Math.floor((y - originY) / (layout.stepY * scale))));
  return Math.min(artboards.length - 1, row * layout.cols + col);
}

// Screen-space hit test for renderArtboardGrid's own layout: which
// artboard index (if any) contains (x, y): computed with the identical
// geometry the render itself uses, so a click always lands on what it
// visually looks like it's over (double-click-to-open, § main.js). -1 if
// none. Options must match whatever the grid was actually rendered with.
export function hitTestArtboardGrid(viewW, viewH, artboards, { scale = 1, panX = 0, panY = 0 } = {}, x, y) {
  if (!artboards.length) return -1;
  const layout = computeArtboardLayout(artboards);
  const originX = viewW / 2 - (layout.totalW * scale) / 2 + panX;
  const originY = viewH / 2 - (layout.totalH * scale) / 2 + panY;

  for (let i = 0; i < artboards.length; i++) {
    const board = artboards[i];
    const col = i % layout.cols, row = Math.floor(i / layout.cols);
    const cellX = originX + col * layout.stepX * scale;
    const cellY = originY + row * layout.stepY * scale;
    const w = board.width * scale, h = board.height * scale;
    const ox = cellX + ((layout.cellW - board.width) / 2) * scale;
    const oy = cellY + (layout.cellH - board.height) * scale; // bottom-aligned in its cell
    if (x >= ox && x < ox + w && y >= oy && y < oy + h) return i;
  }
  return -1;
}

// Difference-blend against a mid-gray background produces a result that's
// itself mid-gray (|255-128| = 127 ≈ 128): barely distinguishable from what
// it's sitting on. Only a narrow band around 128 is actually a problem
// (extremes invert cleanly), so it's cheaper to special-case that band than
// to replace the blend everywhere.
const CURSOR_MID_LO = 96;
const CURSOR_MID_HI = 160;

const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const hexLuma = (hex) => { const { r, g, b } = hexToRgb(hex); return lumaOf(r, g, b); };
// Two checker shades average to a single constant: close enough for a
// contrast decision, and the cursor only cares about the midrange band.
const BACKDROP_LUMA = {
  checker: (hexLuma(CHECKER_LIGHT) + hexLuma(CHECKER_DARK)) / 2,
  ...Object.fromEntries(Object.entries(BG_SOLID).map(([key, hex]) => [key, hexLuma(hex)])),
};

// Brightness under the cursor, from the composite in memory rather than a
// getImageData readback (which stalls the GPU pipeline every frame). The
// eased trail can sit outside the sprite, hence the bounds check.
function cursorLuma(model, pos, canvasBg) {
  const backdrop = BACKDROP_LUMA[canvasBg];
  const x = Math.round(pos.x), y = Math.round(pos.y);
  if (x < 0 || y < 0 || x >= model.width || y >= model.height) return backdrop;
  const p = model.pixels[y * model.width + x];
  const alpha = (p >>> 24) / 255;
  return lumaOf(p & 255, (p >> 8) & 255, (p >> 16) & 255) * alpha + backdrop * (1 - alpha);
}

// Always-visible brush cursor: painted with a "difference" blend so it
// inverts whatever color is beneath it, rather than a fixed color that
// could vanish against a similar background. `pos` is fractional (the
// eased/trailing display position, not necessarily the exact hovered
// pixel): main.js's animation loop owns that easing, this just draws
// wherever it's told.
// The paint brush's shape on the canvas: a pixel-art circle drawn on a 6x6 grid, stretched over the brush's
// size (one canvas pixel at size 1). The place brush is the plain square, the same drawing filled solid.
const PAINT_SHAPE = ['..XX..', '.XXXX.', 'XXXXXX', 'XXXXXX', '.XXXX.', '..XX..'];
let paintShapePaths = null;
function getPaintShapePaths() {
  if (paintShapePaths) return paintShapePaths;
  const fill = new Path2D(), edge = new Path2D();
  const ink = (x, y) => PAINT_SHAPE[y] !== undefined && PAINT_SHAPE[y][x] === 'X';
  PAINT_SHAPE.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!ink(x, y)) continue;
      fill.rect(x, y, 1, 1);
      // Only the edges that face an empty cell, so the outline has no lines across the inside.
      if (!ink(x, y - 1)) { edge.moveTo(x, y); edge.lineTo(x + 1, y); }
      if (!ink(x, y + 1)) { edge.moveTo(x, y + 1); edge.lineTo(x + 1, y + 1); }
      if (!ink(x - 1, y)) { edge.moveTo(x, y); edge.lineTo(x, y + 1); }
      if (!ink(x + 1, y)) { edge.moveTo(x + 1, y); edge.lineTo(x + 1, y + 1); }
    }
  });
  return (paintShapePaths = { fill, edge });
}

function drawBrushCursor(ctx, pos, { mode, size }, scale, ox, oy, luma) {
  if (mode !== 'place' && mode !== 'paint') return;
  // The brush's square in screen px: centred on the hovered pixel for paint, offset the way the stamp is for place.
  const side = size * scale;
  const left = mode === 'paint' ? ox + (pos.x + 0.5) * scale - side / 2 : ox + (pos.x - Math.floor(size / 2)) * scale;
  const top = mode === 'paint' ? oy + (pos.y + 0.5) * scale - side / 2 : oy + (pos.y - Math.floor(size / 2)) * scale;
  const drawShape = (stroke) => {
    if (mode === 'paint') {
      const { fill, edge } = getPaintShapePaths();
      const cell = side / PAINT_SHAPE.length;
      ctx.translate(left, top);
      ctx.scale(cell, cell);
      if (stroke) { ctx.lineWidth = 1 / cell; ctx.stroke(edge); } else ctx.fill(fill);
    } else if (stroke) {
      ctx.strokeRect(left, top, side, side);
    } else {
      ctx.fillRect(left, top, side, side);
    }
  };

  ctx.save();
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#FFFFFF';
  drawShape(false);
  ctx.restore();

  if (luma >= CURSOR_MID_LO && luma <= CURSOR_MID_HI) {
    // Midrange boost: an unblended outline, pushed toward whichever extreme
    // contrasts more against this specific background, layered on top of
    // the (here, weak) difference fill.
    ctx.save();
    ctx.strokeStyle = luma > 128 ? '#000000' : '#FFFFFF';
    ctx.lineWidth = 1;
    drawShape(true);
    ctx.restore();
  }
}

// Repeating 2x2-cell tile (light/dark/dark/light), built once as a
// CanvasPattern. `cellPx` defaults to the single-file canvas's density
// (CHECKER_CELL); the group grid's screen-space backdrop passes a bigger
// value: "big and chunky", legible at any zoom since it's not tied to any
// one sprite's resolution: via its own cached pattern instead of reusing
// this one at the wrong size. Caching the pattern, not just the tile,
// spares a createPattern allocation per fill, up to twice per render.
const checkerPatterns = new Map(); // cellPx -> CanvasPattern
function getCheckerPattern(ctx, cellPx = CHECKER_CELL) {
  if (!checkerPatterns.has(cellPx)) {
    const tile = document.createElement('canvas');
    tile.width = cellPx * 2;
    tile.height = cellPx * 2;
    const tctx = tile.getContext('2d');
    tctx.fillStyle = CHECKER_LIGHT;
    tctx.fillRect(0, 0, cellPx * 2, cellPx * 2);
    tctx.fillStyle = CHECKER_DARK;
    tctx.fillRect(cellPx, 0, cellPx, cellPx);
    tctx.fillRect(0, cellPx, cellPx, cellPx);
    checkerPatterns.set(cellPx, ctx.createPattern(tile, 'repeat'));
  }
  return checkerPatterns.get(cellPx);
}

// Fills `(destX, destY, destW, destH)` (screen px) with the checker pattern,
// pinned to the canvas's own pixel grid: translating/scaling the context by
// the same (ox, oy, scale) the sprite itself is drawn with before filling
// means the pattern's cell boundaries land exactly on canvas-pixel
// boundaries, at any destination rect: the whole viewport (the app
// backdrop) or just the canvas's own bounds (the canvas backdrop) tile
// identically and seamlessly, because it's literally the same fill.
function fillCheckerboard(ctx, scale, ox, oy, destX, destY, destW, destH, cellPx) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  ctx.fillStyle = getCheckerPattern(ctx, cellPx);
  ctx.fillRect((destX - ox) / scale, (destY - oy) / scale, destW / scale, destH / scale);
  ctx.restore();
}

// Onion skinning (§12.3): ghost frames tint toward red (before) or blue
// (after) with opacity falling off by distance, fixed range 2 in each
// direction: no range control exists in the UI.
// The tinted canvas is cached per source (`ghost.key`) until its `rev`, side
// or the model size changes, so a ghost costs a blit per frame and a rebuild
// per edit. Distance only sets the blit's alpha, so it isn't part of the
// stamp. The map is rebuilt every render from just the ghosts on screen, so
// a long timeline can't grow it without bound.
let ghostCache = new Map(); // ghost.key -> { stamp, canvas }
function drawGhost(ctx, model, ghost, scale, ox, oy, nextCache) {
  const stamp = `${ghost.rev}|${ghost.side}|${model.width}x${model.height}`;
  let entry = ghostCache.get(ghost.key);
  if (!entry || entry.stamp !== stamp) {
    const tint = hexToRgb(ghost.side === 'before' ? ONION_BEFORE_TINT : ONION_AFTER_TINT);
    // Tint every pixel halfway toward the ghost color in one bulk pass over
    // an ImageData, then one scaled blit: not a fillRect per pixel, which
    // at 512x512 was a quarter-million draw calls per frame.
    const source = ghost.pixels();
    const img = new ImageData(model.width, model.height);
    const out = new Uint32Array(img.data.buffer);
    for (let i = 0; i < out.length; i++) {
      const p = source[i];
      if (!p) continue;
      const r = ((p & 255) + tint.r) >> 1, g = (((p >> 8) & 255) + tint.g) >> 1, b = (((p >> 16) & 255) + tint.b) >> 1;
      out[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    const canvas = entry ? entry.canvas : document.createElement('canvas');
    if (canvas.width !== model.width || canvas.height !== model.height) {
      canvas.width = model.width;
      canvas.height = model.height;
    }
    canvas.getContext('2d').putImageData(img, 0, 0);
    entry = { stamp, canvas };
  }
  nextCache.set(ghost.key, entry);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = ghost.distance === 1 ? 0.35 : 0.18;
  ctx.drawImage(entry.canvas, ox, oy, model.width * scale, model.height * scale);
  ctx.restore();
}

// Marching ants. Two dash passes exactly one dash-length out of phase:
// black filling one set of gaps, white the other: so the boundary reads
// against any background, same reasoning as the brush cursor/grid having no
// single fixed color that's safe everywhere. `antsPhase` advances once per
// render call (main.js's loop renders every frame while ants are
// visible, see render()'s return value), giving the classic marching animation.
const SELECTION_DASH = 4; // screen px per dash segment: constant across zoom, see below
const SELECTION_DASH_SPEED = 0.5; // screen px of march per frame
// Dash coordinates here are already screen pixels (scale is baked into
// every point, not applied via ctx.scale), so a fixed dash size holds
// steady on screen at any zoom: until the sprite itself is so small on
// screen that a fixed-size dash would swamp it more than outline it, where
// it fades out instead of blocking the view.
const ANTS_FULL_SCALE = 4; // model-px -> screen-px scale at/above which ants are fully opaque
const ANTS_MIN_SCALE = 1; // at/below this scale, ants are fully transparent
let antsPhase = 0;

function selectionAlpha(scale) {
  if (scale >= ANTS_FULL_SCALE) return 1;
  if (scale <= ANTS_MIN_SCALE) return 0;
  return (scale - ANTS_MIN_SCALE) / (ANTS_FULL_SCALE - ANTS_MIN_SCALE);
}

// Outline every selected pixel's exposed edges (magic wand / rect-select
// both resolve to a mask) as one continuous path, so the dash pattern flows
// around the whole boundary instead of restarting at every 1-pixel edge.
// Built once per selection, in model coordinates, and cached on the wrapper
// (a new mask always gets a new wrapper): pan and zoom only change the
// transform it is stroked under, so only the dash offset moves per frame.
function selectionOutlinePath(selection) {
  if (selection.path) return selection.path;
  const path = new Path2D();
  const { width, height, mask } = selection;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (!mask[(y - 1) * width + x]) { path.moveTo(x, y); path.lineTo(x + 1, y); }
      if (!mask[(y + 1) * width + x]) { path.moveTo(x, y + 1); path.lineTo(x + 1, y + 1); }
      if (!mask[y * width + (x - 1)]) { path.moveTo(x, y); path.lineTo(x, y + 1); }
      if (!mask[y * width + (x + 1)]) { path.moveTo(x + 1, y); path.lineTo(x + 1, y + 1); }
    }
  }
  return selection.path = path;
}

function drawSelection(ctx, selection, scale, ox, oy) {
  const alpha = selectionAlpha(scale);
  if (alpha <= 0) return false;
  const path = selectionOutlinePath(selection);
  antsPhase = (antsPhase + SELECTION_DASH_SPEED) % (SELECTION_DASH * 2);

  // Difference blend (same trick as the hover crosshair): a white stroke
  // always fully inverts whatever's underneath, so the boundary reads on
  // any background without needing separate black/white dash passes.
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'difference';
  // Under the model->screen transform, so line width and dashes are divided
  // by scale to keep their fixed on-screen size.
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  ctx.lineWidth = 1 / scale;
  ctx.setLineDash([SELECTION_DASH / scale, SELECTION_DASH / scale]);
  ctx.lineDashOffset = -antsPhase / scale;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke(path);
  ctx.restore();
  return true;
}

// Same step progression the grid uses (§6): 1 -> 4 -> 16 -> ...: ticks/
// gridlines agree on where lines fall, and ruler number labels use a
// second, coarser threshold so the text itself never overlaps.
function gridStep(scale, minSpacing = GRID_MIN_SPACING_PX) {
  let step = 1;
  while (step * scale < minSpacing) step *= 4;
  return step;
}

// Keyed off the canvas's own on-screen footprint (screen px), not `scale`
// (model-px -> screen-px ratio): minZoomScale never lets `scale` drop
// below 1, so a scale-based fade never triggered at all, but a *small
// sprite* still renders a tiny on-screen footprint even at that closest
// allowed zoom-out. Below ~3 ruler-thicknesses of footprint the bars start
// crowding the sprite; below one thickness the ruler is outright bigger
// than the canvas it's measuring, which is the actual "too small" this
// fades ahead of.
const RULER_FULL_FOOTPRINT_PX = RULER_THICKNESS * 3;
const RULER_MIN_FOOTPRINT_PX = RULER_THICKNESS;
function rulerAlpha(w, h) {
  const footprint = Math.min(w, h);
  if (footprint >= RULER_FULL_FOOTPRINT_PX) return 1;
  if (footprint <= RULER_MIN_FOOTPRINT_PX) return 0;
  return (footprint - RULER_MIN_FOOTPRINT_PX) / (RULER_FULL_FOOTPRINT_PX - RULER_MIN_FOOTPRINT_PX);
}

// Where the ruler bars sit: attached to the sprite's own edge normally,
// clamped to the viewport edge once zoom has scrolled that edge off-screen.
function rulerAnchor(scale, ox, oy, viewW, viewH) {
  return {
    topY: Math.max(0, Math.min(oy - RULER_THICKNESS, viewH - RULER_THICKNESS)),
    leftX: Math.max(0, Math.min(ox - RULER_THICKNESS, viewW - RULER_THICKNESS)),
  };
}

// Highlight bar through the hovered pixel's row and column: a difference
// blend so it stays visible no matter what color sits underneath (same
// trick as the brush cursor). `hoverPixel` here is the eased cursor trail
// (main.js's displayCursorPos), which can briefly sit just outside the
// sprite's bounds near an edge before it catches up: each axis only draws
// once its own coordinate is actually within the canvas, so that overshoot
// never paints a highlight stripe into the ruler/app-background margin
// beyond where the canvas ends.
// Reference images (references.js), behind the pixels. 'fit' shows the
// whole image contained inside the canvas; 'full' shows it at 1 image pixel
// per canvas pixel, off to the right of the canvas (stacked left to right).
// Both ride the same pan/zoom as the sprite, and neither is clipped to it.
const REFERENCE_GAP = 2; // canvas px between full-size references
function drawReferences(ctx, references, scale, ox, oy, w, h) {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  let nextX = ox + w + REFERENCE_GAP * scale;
  for (const { mode, bitmap } of references) {
    if (mode === 'full') {
      const dw = bitmap.width * scale;
      ctx.drawImage(bitmap, nextX, oy, dw, bitmap.height * scale);
      nextX += dw + REFERENCE_GAP * scale;
    } else {
      const k = Math.min(w / bitmap.width, h / bitmap.height);
      const dw = bitmap.width * k, dh = bitmap.height * k;
      ctx.drawImage(bitmap, ox + (w - dw) / 2, oy + (h - dh) / 2, dw, dh);
    }
  }
  ctx.restore();
}

// Hairline through the canvas centre for each active mirror axis. Same
// 'difference' convention as the grid and crosshair, so it inverts whatever
// is beneath instead of vanishing against a matching color.
function drawSymmetryAxes(ctx, symmetry, ox, oy, w, h) {
  ctx.save();
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = CROSSHAIR_COLOR;
  if (symmetry === 'h' || symmetry === 'both') ctx.fillRect(Math.floor(ox + w / 2), oy, 1, h);
  if (symmetry === 'v' || symmetry === 'both') ctx.fillRect(ox, Math.floor(oy + h / 2), w, 1);
  ctx.restore();
}

function drawCrosshair(ctx, hoverPixel, { topY, leftX }, scale, ox, oy, w, h) {
  const vx = ox + hoverPixel.x * scale;
  const hy = oy + hoverPixel.y * scale;
  const insideX = vx >= ox && vx < ox + w;
  const insideY = hy >= oy && hy < oy + h;
  if (!insideX && !insideY) return;

  ctx.save();
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = CROSSHAIR_COLOR;
  if (insideX) {
    ctx.fillRect(vx, topY, scale, RULER_THICKNESS); // through the top ruler
    ctx.fillRect(vx, oy, scale, h); // through the canvas
  }
  if (insideY) {
    ctx.fillRect(leftX, hy, RULER_THICKNESS, scale); // through the left ruler
    ctx.fillRect(ox, hy, w, scale); // through the canvas
  }
  ctx.restore();
}

// Top (columns) and left (rows) coordinate rulers (§6), hidden by default,
// toggled with Shift+G. Normally attached directly to the sprite's own
// edge (tracks pan/zoom with it); once the canvas is zoomed in far enough
// that its edge has scrolled past the viewport edge, the ruler clamps to
// the viewport edge instead so it's always reachable rather than
// scrolling off-screen with the canvas. Tick/label spacing scales with
// zoom the same way the grid does, so it never becomes an unreadable
// smear of numbers at low zoom.
function drawRuler(ctx, model, scale, ox, oy, w, h, viewW, viewH, { topY, leftX }, hoverPixel) {
  ctx.font = snapFontSize(16, window.devicePixelRatio || 1) + 'px "Stagwood Sprite 64", monospace'; // 16 device px multiples only: see pixel-snap.js
  ctx.textBaseline = 'top';

  // Bar length matches the visible portion of the sprite: which is just
  // its own width/height when the sprite fits in the viewport ("attached
  // to the canvas"), and clamps to the full viewport span once the sprite
  // is bigger than the viewport in that direction ("floats independently").
  const barLeft = Math.max(0, ox), barRight = Math.min(viewW, ox + w);
  const barTop = Math.max(0, oy), barBottom = Math.min(viewH, oy + h);
  ctx.fillStyle = RULER_BG;
  ctx.fillRect(barLeft, topY, barRight - barLeft, RULER_THICKNESS);
  ctx.fillRect(leftX, barTop, RULER_THICKNESS, barBottom - barTop);

  const tickStep = gridStep(scale);
  const labelStep = gridStep(scale, 28);

  const colStart = Math.max(0, Math.floor(-ox / scale / tickStep) * tickStep);
  const colEnd = Math.min(model.width - 1, Math.ceil((viewW - ox) / scale));
  for (let x = colStart; x <= colEnd; x += tickStep) {
    const isHover = hoverPixel && Math.floor(hoverPixel.x / tickStep) === Math.floor(x / tickStep);
    ctx.fillStyle = isHover ? RULER_HIGHLIGHT : RULER_TICK;
    ctx.fillRect(ox + x * scale, topY, 1, RULER_THICKNESS);
    if (x % labelStep === 0) ctx.fillText(String(x), ox + x * scale + 2, topY + 2);
  }

  const rowStart = Math.max(0, Math.floor(-oy / scale / tickStep) * tickStep);
  const rowEnd = Math.min(model.height - 1, Math.ceil((viewH - oy) / scale));
  for (let y = rowStart; y <= rowEnd; y += tickStep) {
    const isHover = hoverPixel && Math.floor(hoverPixel.y / tickStep) === Math.floor(y / tickStep);
    ctx.fillStyle = isHover ? RULER_HIGHLIGHT : RULER_TICK;
    ctx.fillRect(leftX, oy + y * scale, RULER_THICKNESS, 1);
    if (y % labelStep === 0) ctx.fillText(String(y), leftX + 2, oy + y * scale + 2);
  }

  // The corner where the two bars meet.
  ctx.fillStyle = RULER_BG;
  ctx.fillRect(leftX, topY, RULER_THICKNESS, RULER_THICKNESS);
}

// Reused 1:1 offscreen buffer for the sprite's pixel content. A single
// drawImage() blit (nearest-neighbor, imageSmoothingEnabled off) has no
// seams between pixels at any zoom: tiling one fillRect per pixel does:
// adjacent same-color rects can leave hairline gaps between them from
// sub-pixel rasterization once devicePixelRatio scaling isn't a clean
// integer, which read as a phantom grid even with the real grid off.
let pixelBuffer = null;
let pixelBufferCtx = null;
let pixelBufferSource = null; // { pixels, rev } the buffer currently holds, so an unchanged composite isn't re-uploaded every frame

// Rebuilds the shared offscreen buffer with `model`'s own pixels: split out
// from the blit below so a caller (the artboard grid's glow effect) can blit
// the same built buffer twice in one pass (once blurred, once sharp)
// without re-walking the pixel grid twice.
function buildPixelBuffer(model) {
  if (!pixelBuffer || pixelBuffer.width !== model.width || pixelBuffer.height !== model.height) {
    pixelBuffer = document.createElement('canvas');
    pixelBuffer.width = model.width;
    pixelBuffer.height = model.height;
    pixelBufferCtx = pixelBuffer.getContext('2d');
    pixelBufferSource = null;
  }
  // `model.pixels` is already packed RGBA words (canvas-model.js
  // hexToPacked), so this is one bulk copy over the ImageData's own buffer.
  if (pixelBufferSource && pixelBufferSource.pixels === model.pixels && pixelBufferSource.rev === model.pixels.rev) {
    return { width: model.width, height: model.height };
  }
  const imageData = pixelBufferCtx.createImageData(model.width, model.height);
  new Uint32Array(imageData.data.buffer).set(model.pixels);
  pixelBufferCtx.putImageData(imageData, 0, 0);
  pixelBufferSource = { pixels: model.pixels, rev: model.pixels.rev };
  return { width: model.width, height: model.height };
}

function blitPixelBuffer(ctx, srcSize, ox, oy, w, h) {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pixelBuffer, 0, 0, srcSize.width, srcSize.height, ox, oy, w, h);
}

function drawPixels(ctx, model, scale, ox, oy, w, h) {
  const srcSize = buildPixelBuffer(model);
  blitPixelBuffer(ctx, srcSize, ox, oy, w, h);
}

// The artboard grid draws many boards per frame, so the single shared buffer
// above would be rebuilt for every one of them on every pan and zoom step. Each
// board keeps its own canvas instead, keyed by its pixel array and repainted
// only when that array's `rev` moves; a frame is then one drawImage per board.
const boardCanvases = new WeakMap(); // pixels -> { rev, canvas }
function drawBoard(ctx, model, ox, oy, w, h) {
  let entry = boardCanvases.get(model.pixels);
  if (!entry || entry.rev !== model.pixels.rev || entry.canvas.width !== model.width || entry.canvas.height !== model.height) {
    const canvas = entry ? entry.canvas : document.createElement('canvas');
    canvas.width = model.width;
    canvas.height = model.height;
    const imageData = new ImageData(model.width, model.height);
    new Uint32Array(imageData.data.buffer).set(model.pixels);
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    entry = { rev: model.pixels.rev, canvas };
    boardCanvases.set(model.pixels, entry);
  }
  ctx.imageSmoothingEnabled = false;
  // Only the origin needs snapping: at a snapped zoom the size is already whole device pixels.
  ctx.drawImage(entry.canvas, 0, 0, model.width, model.height, snapLength(ox), snapLength(oy), w, h);
}

