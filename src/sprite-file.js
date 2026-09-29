import { createColorTable, packedTable, bufferId, blendPacked } from './canvas-model.js';
import { computeMembership, moveBlock, nextOrder } from './ordering.js';
import { indexedBounds, unionBounds } from './trim.js';
import { nextName } from './names.js';

// SpriteFile / Layer / Frame data model (design-doc §5).
export function createLayer(name = 'Layer 1', order = 1000) {
  return { name, visible: true, opacity: 1, order };
}

// A group is purely organizational: a label member layers can be nested
// under in the panel by position (§ ordering.js). It composites nothing of
// its own; its `visible` flag just gates whether its members render at all.
export function createLayerGroup(name, order) {
  return { id: crypto.randomUUID(), name, visible: true, collapsed: false, order };
}

// A layer's pixels are a Uint16Array of indices into `file.colors`
// (canvas-model.js); index 0 is transparent, so a fresh buffer is empty.
export function createFrame(layerCount, pixelCount) {
  return { layerPixels: Array.from({ length: layerCount }, () => new Uint16Array(pixelCount)) };
}

// Every Layer must belong to a Group: there's no "ungrouped" state: so
// the very first Layer also creates the very first Group. Ascending
// `.order` is top-to-bottom in the panel (§ layerOrder below), so the
// group (order 1000) sits above its one member (order 2000).
export function createSpriteFile(name, width, height) {
  return {
    name,
    layers: [createLayer('Layer 1', 2000)],
    layerGroups: [createLayerGroup('Group 1', 1000)],
    colors: createColorTable(),
    frames: [createFrame(1, width * height)],
    activeLayerIndex: 0,
    activeFrameIndex: 0,
    canvasWidth: width,
    canvasHeight: height,
    visibleWidth: width,
    visibleHeight: height,
    undoStack: [],
    redoStack: [],
    // Stamped fresh on creation, then again on every commit (undo.js's
    // commitCommand): a never-edited file still has a valid timestamp to
    // compare against (§ project.js's mostRecentFileIn).
    updatedAt: Date.now(),
  };
}

// The combined, order-sorted [groups + layers] view: the one source of
// truth for both panel display order and layer→group membership
// (§ ordering.js), same pattern as project.js's `projectOrder`.
export function layerOrder(file) {
  return computeMembership(file.layerGroups, file.layers);
}

// The pixel array currently being drawn on: active layer, active frame.
export function activePixels(file) {
  return file.frames[file.activeFrameIndex].layerPixels[file.activeLayerIndex];
}

// All visible layers of the active frame, flattened bottom-to-top into one
// buffer for display (§11): drawing still targets the single active
// layer's own array via activePixels(), this is display-only. Output is a
// packed-RGBA Uint32Array (canvas-model.js's hexToPacked), 0 = transparent.
export function compositeFrame(file) {
  return compositeFrameAt(file, file.activeFrameIndex);
}

// Per-frame composite cache. A WeakMap keyed by the frame object, so it
// never reaches serialization and dies with the frame. A hit needs the same
// structure (dimensions, each layer's visibility/opacity/buffer identity)
// and the same buffer versions (canvas-model.js touch()): so pan, zoom,
// idle redraws and edits to *other* frames all cost one key comparison.
//
// The key is derived from real state on every call, not a revision counter:
// the app mutates layer.visible/.opacity/.order directly in several places
// and a counter would miss them. To keep a hit allocation-free the key is a
// flat Float64Array: three header slots (w, h, canvasWidth), then per layer
// [shown ? 1 + opacity : 0, bufferId, buffer version]: filled into a shared
// scratch and compared element-wise, so no strings, no collisions.
const compositeCache = new WeakMap(); // frame -> { key, out }
const HEADER = 3, STRIDE = 3;
let keyScratch = new Float64Array(HEADER + STRIDE * 32);
const groupShown = new Map(); // scratch: group id -> visible

// `layer.groupId` is derived by layerOrder() (a sort plus two arrays), which
// only needs to run when an order or membership actually changed: this
// remembers the .order of every layer and group, and the objects themselves
// (an undo can swap in different objects with the same orders).
const membershipCache = new WeakMap(); // file -> { orders, items }
function refreshMembership(file) {
  const { layers, layerGroups } = file;
  const n = layers.length + layerGroups.length;
  let entry = membershipCache.get(file);
  let fresh = !entry || entry.orders.length !== n;
  if (!fresh) {
    let i = 0;
    for (const items of [layerGroups, layers]) {
      for (const item of items) {
        if (entry.items[i] !== item || entry.orders[i] !== item.order) { fresh = true; break; }
        i++;
      }
      if (fresh) break;
    }
  }
  if (!fresh) return;
  layerOrder(file);
  membershipCache.set(file, { orders: Float64Array.from([...layerGroups, ...layers], (item) => item.order), items: [...layerGroups, ...layers] });
}

export function compositeFrameAt(file, frameIndex) {
  const w = file.visibleWidth, h = file.visibleHeight;
  const frame = file.frames[frameIndex];
  refreshMembership(file);
  groupShown.clear();
  for (const g of file.layerGroups) groupShown.set(g.id, g.visible);
  const bufs = frame.layerPixels;
  const n = file.layers.length;
  const len = HEADER + STRIDE * n;
  if (keyScratch.length < len) keyScratch = new Float64Array(len * 2);
  const key = keyScratch;
  key[0] = w; key[1] = h; key[2] = file.canvasWidth;
  for (let li = 0; li < n; li++) {
    const layer = file.layers[li], k = HEADER + STRIDE * li;
    key[k] = layer.visible && groupShown.get(layer.groupId) !== false ? 1 + layer.opacity : 0;
    key[k + 1] = bufferId(bufs[li]);
    key[k + 2] = bufs[li].v | 0;
  }

  const cached = compositeCache.get(frame);
  // Structure = every key slot except the buffer versions.
  let sameStructure = !!cached && cached.key.length === len, sameVersions = sameStructure;
  if (sameStructure) {
    for (let k = 0; k < len; k++) {
      if (cached.key[k] === key[k]) continue;
      if (k >= HEADER && (k - HEADER) % STRIDE === 2) sameVersions = false;
      else { sameStructure = sameVersions = false; break; }
    }
  }
  if (sameStructure && sameVersions) return cached.out;

  // Same structure, different buffer contents: only the union of the changed
  // buffers' dirty rectangles needs re-walking. Each buffer belongs to one
  // frame, so this cache entry is the sole consumer of its dirty state.
  let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1, out = new Uint32Array(w * h);
  if (sameStructure) {
    const rects = bufs.filter((buf, i) => (buf.v | 0) !== cached.key[HEADER + STRIDE * i + 2]).map((buf) => buf.dirty);
    if (rects.every(Array.isArray)) {
      out = cached.out;
      x0 = Math.max(0, Math.min(...rects.map((d) => d[0])));
      y0 = Math.max(0, Math.min(...rects.map((d) => d[1])));
      x1 = Math.min(w - 1, Math.max(...rects.map((d) => d[2])));
      y1 = Math.min(h - 1, Math.max(...rects.map((d) => d[3])));
      for (let y = y0; y <= y1; y++) out.fill(0, y * w + x0, y * w + x1 + 1);
    }
  }
  const table = packedTable(file.colors);
  file.layers.forEach((layer, li) => {
    if (!key[HEADER + STRIDE * li]) return;
    const src = bufs[li];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const idx = src[y * file.canvasWidth + x];
        if (!idx) continue;
        const i = y * w + x;
        out[i] = blendPacked(out[i], table[idx], layer.opacity);
      }
    }
  });
  out.rev = (out.rev | 0) + 1; // lets the renderer skip re-uploading an unchanged composite
  for (const buf of bufs) buf.dirty = null;
  compositeCache.set(frame, { key: key.slice(0, len), out });
  return out;
}

// One layer's own pixels at one frame, at its own opacity: everything
// else ignored (§ export.js's per-layer breakdown export). This app's
// pixel model has no true alpha channel (a cell is one solid color or
// nothing), so a partially-opaque layer exported alone paints solid,
// exactly as it already would if it were the only visible layer on-canvas
//: hence no opacity term here at all.
export function compositeLayerAt(file, layerIndex, frameIndex) {
  return cropToVisible(file, file.frames[frameIndex].layerPixels[layerIndex]);
}

// Crops a full-stride (canvasWidth x canvasHeight) index buffer down to the
// visible window as packed pixels, matching compositeFrame's output shape.
function cropToVisible(file, fullPixels, out = new Uint32Array(file.visibleWidth * file.visibleHeight)) {
  const w = file.visibleWidth, h = file.visibleHeight;
  const table = packedTable(file.colors);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = table[fullPixels[y * file.canvasWidth + x]];
  }
  return out;
}

// Onion-skin ghost source for one frame (§12.3): either the full composite
// or just the active layer, toggleable. Returns an identity (`key`) and a
// change counter (`rev`) so the renderer can keep the tinted result between
// frames, plus `pixels()`, which only runs on a cache miss: layer-only mode
// crops into one shared scratch buffer the caller must consume immediately.
let cropScratch = null;
export function ghostSource(file, frameIndex, activeLayerOnly) {
  if (activeLayerOnly) {
    const buf = file.frames[frameIndex].layerPixels[file.activeLayerIndex];
    const size = file.visibleWidth * file.visibleHeight;
    return {
      key: buf,
      // A resize changes the crop without touching the buffer's version.
      rev: `${buf.v | 0}:${file.visibleWidth}x${file.visibleHeight}x${file.canvasWidth}`,
      pixels() {
        if (!cropScratch || cropScratch.length !== size) cropScratch = new Uint32Array(size);
        return cropToVisible(file, buf, cropScratch);
      },
    };
  }
  const out = compositeFrameAt(file, frameIndex);
  return { key: out, rev: out.rev, pixels: () => out };
}

// A new layer must land INSIDE some group (every Layer belongs to a Group
//: no ungrouped state), so its order sits between that group's header and
// its current first member. Defaults to the topmost group when no groupId
// is given (e.g. no group currently focused in the Layers panel).
function orderInGroup(file, groupId) {
  const group = (groupId && file.layerGroups.find((g) => g.id === groupId))
    || file.layerGroups.reduce((a, b) => (a.order < b.order ? a : b));
  const combined = layerOrder(file);
  const headerPos = combined.findIndex((e) => e.isHeader && e.item === group);
  const next = combined[headerPos + 1];
  return next ? (group.order + next.item.order) / 2 : group.order + 1;
}

export function addLayer(file, name, groupId) {
  if (!file.layerGroups.length) addLayerGroup(file);
  file.layers.push(createLayer(name || nextName('Layer', file.layers.map((l) => l.name)), orderInGroup(file, groupId)));
  for (const frame of file.frames) {
    frame.layerPixels.push(new Uint16Array(file.canvasWidth * file.canvasHeight));
  }
  file.activeLayerIndex = file.layers.length - 1;
}

export function deleteLayer(file, index) {
  if (file.layers.length <= 1) return; // always at least one layer
  file.layers.splice(index, 1);
  for (const frame of file.frames) frame.layerPixels.splice(index, 1);
  file.activeLayerIndex = Math.min(file.activeLayerIndex, file.layers.length - 1);
}

export function addLayerGroup(file, name) {
  file.layerGroups.push(createLayerGroup(name || nextName('Group', file.layerGroups.map((g) => g.name)), nextOrder(file.layerGroups, file.layers)));
}

// Every Layer must always belong to *some* Group, so the last one can't be
// deleted, and deleting any other one re-homes its member layers under the
// (new) first Group rather than leaving them stranded (§ project.js's
// deleteCollection, same pattern).
export function deleteLayerGroup(file, groupId) {
  if (file.layerGroups.length <= 1) return;
  const combined = layerOrder(file);
  const headerPos = combined.findIndex((e) => e.isHeader && e.item.id === groupId);
  if (headerPos < 0) return;
  const orphans = [];
  for (let i = headerPos + 1; i < combined.length && !combined[i].isHeader; i++) orphans.push(combined[i].item);
  file.layerGroups = file.layerGroups.filter((g) => g.id !== groupId);
  if (orphans.length) {
    const target = file.layerGroups[0];
    orphans.forEach((layer, i) => { layer.order = target.order + (i + 1) * 0.01; });
  }
}

// Moves whatever sits at `fromPos` in `layerOrder(file)` to `toPos`: a
// layer, or a group header (which brings its member layers with it):
// then re-syncs `file.layers`/`frame.layerPixels`/`activeLayerIndex` to
// match, since (unlike files) a layer's array position *is* its
// compositing order, not just a display detail.
// Ascending `.order` = top-to-bottom in the panel, but `file.layers`
// array order is bottom-to-top (index 0 composites first/at the back,
// last index on top): so the derived array is the reverse of order.
export function moveLayerItem(file, fromPos, toPos) {
  const combined = layerOrder(file);
  moveBlock(combined, fromPos, toPos);
  const oldLayers = file.layers;
  const activeLayer = oldLayers[file.activeLayerIndex];
  const newLayers = combined.filter((e) => !e.isHeader).map((e) => e.item).reverse();
  for (const frame of file.frames) {
    frame.layerPixels = newLayers.map((layer) => frame.layerPixels[oldLayers.indexOf(layer)]);
  }
  file.layers = newLayers;
  file.activeLayerIndex = Math.max(0, newLayers.indexOf(activeLayer));
}

// Frame operations (§12.1). Every frame shares the file's layer stack, so a
// new frame gets one empty pixel buffer per existing layer.
export function addFrame(file, atIndex = file.frames.length) {
  file.frames.splice(atIndex, 0, createFrame(file.layers.length, file.canvasWidth * file.canvasHeight));
  file.activeFrameIndex = atIndex;
}

export function duplicateFrame(file, index) {
  const source = file.frames[index];
  const copy = { layerPixels: source.layerPixels.map((p) => p.slice()) };
  file.frames.splice(index + 1, 0, copy);
  file.activeFrameIndex = index + 1;
}

export function deleteFrame(file, index) {
  if (file.frames.length <= 1) return; // a File always has at least one Frame
  file.frames.splice(index, 1);
  file.activeFrameIndex = Math.min(file.activeFrameIndex, file.frames.length - 1);
}

export function reorderFrame(file, from, to) {
  if (to < 0 || to >= file.frames.length) return;
  const [frame] = file.frames.splice(from, 1);
  file.frames.splice(to, 0, frame);
  if (file.activeFrameIndex === from) file.activeFrameIndex = to;
}

// Where the existing pixels sit in the resized canvas, and which sides a trim
// keeps its margin on, as [horizontal, vertical] fractions of the free space
// (0 = start edge, 1 = end edge): the four corners, the four edge midpoints and
// the centre.
export const RESIZE_ANCHORS = {
  tl: [0, 0], t: [0.5, 0], tr: [1, 0],
  l: [0, 0.5], c: [0.5, 0.5], r: [1, 0.5],
  bl: [0, 1], b: [0.5, 1], br: [1, 1],
};

// Rebuilds every buffer at exactly the new size, with the visible pixels placed
// at `anchor` and whatever falls outside cropped. Pixels outside the old visible
// window (left by earlier versions, which kept them hidden) are dropped here.
export function resizeCanvas(file, newW, newH, anchor = 'bl') {
  const [fx, fy] = RESIZE_ANCHORS[anchor];
  rebuildCanvas(file, newW, newH, Math.floor((newW - file.visibleWidth) * fx), Math.floor((newH - file.visibleHeight) * fy));
}

// Resizes to the box holding every placed pixel of every layer and frame, hidden
// layers included, but never below `min` on a side. `anchor` picks the sides
// that keep their empty margin: a side is trimmed only when it faces away from
// the anchor (the centre trims all four; an edge anchor trims the other axis
// from both ends). Returns false, changing nothing, when the canvas is empty
// or already fits.
export function trimCanvas(file, min, anchor = 'c') {
  const w = file.visibleWidth, h = file.visibleHeight;
  let box = null;
  for (const frame of file.frames) {
    for (const pixels of frame.layerPixels) box = unionBounds(box, indexedBounds(pixels, file.canvasWidth, w, h));
  }
  if (!box) return false;
  const [fx, fy] = RESIZE_ANCHORS[anchor];
  // The span kept on one axis. A span under the minimum grows toward the far edge, or back from it at the border.
  const span = (lo, hi, len, f) => {
    const start = Math.max(0, Math.min(f === 0 ? 0 : lo, len - min));
    return [start, Math.max(min, (f === 1 ? len : hi) - start)];
  };
  const [x0, newW] = span(box.x0, box.x1, w, fx);
  const [y0, newH] = span(box.y0, box.y1, h, fy);
  if (newW === w && newH === h) return false;
  rebuildCanvas(file, newW, newH, -x0, -y0);
  return true;
}

// Rebuilds every buffer at `newW` x `newH`, the old pixels shifted by (ox, oy).
function rebuildCanvas(file, newW, newH, ox, oy) {
  const oldW = file.visibleWidth, oldH = file.visibleHeight, stride = file.canvasWidth;
  const x0 = Math.max(0, ox), x1 = Math.min(newW, ox + oldW);
  const y0 = Math.max(0, oy), y1 = Math.min(newH, oy + oldH);

  for (const frame of file.frames) {
    frame.layerPixels = frame.layerPixels.map((oldPixels) => {
      const next = new Uint16Array(newW * newH);
      for (let y = y0; y < y1; y++) {
        const from = (y - oy) * stride + (x0 - ox);
        next.set(oldPixels.subarray(from, from + x1 - x0), y * newW + x0);
      }
      return next;
    });
  }

  file.canvasWidth = file.visibleWidth = newW;
  file.canvasHeight = file.visibleHeight = newH;
}
