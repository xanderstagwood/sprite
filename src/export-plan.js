import { compositeFrame, compositeFrameAt, compositeLayerAt } from './sprite-file.js';
import { cropToMask } from './trim.js';
import { sheetLayout, fits } from './sheet-layout.js';
import { formatGpl, formatHex, formatPal, paletteRow } from './palette-format.js';
import { svgDocument } from './svg-rects.js';

// What each quick export ([e], and [E] for the fuller set) produces, by the
// part of the app that has focus. Pure: a plan is `{ name, entries }`, where
// `name` titles the zip when there is more than one entry and each entry is
//   { type: 'png',    path, image: () => { pixels, w, h }, scale }
//   { type: 'text',   path, text: () => string, mime }
//   { type: 'gif',    path, frameCount, wordsAt, w, h, fps }
//   { type: 'sprite', path, project }
// Images are thunks so only the entry being written is held in memory.
// Callers load whatever files a plan will read before asking for it.

const SCALES = [1, 4, 8];
const SVG = 'image/svg+xml';

// A name from inside the app is not guaranteed clean for a filesystem or a zip reader.
export function sanitizeName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled';
}

// Sanitized names that stay distinct within one export: "a", "a (2)", ...
function uniqueNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const clean = sanitizeName(name);
    const n = (seen.get(clean) || 0) + 1;
    seen.set(clean, n);
    return n === 1 ? clean : `${clean} (${n})`;
  });
}

const png = (path, image, scale = 1) => ({ type: 'png', path, image, scale });
const svg = (path, image) => ({ type: 'text', path, mime: SVG, text: () => { const { pixels, w, h } = image(); return svgDocument(pixels, w, h); } });
const text = (path, body, mime = 'text/plain') => ({ type: 'text', path, mime, text: () => body });

// One image made of the given ones laid out as a sheet (sheet-layout.js).
function sheet(images) {
  const layout = sheetLayout(images);
  const pixels = new Uint32Array(layout.w * layout.h);
  images.forEach((img, i) => {
    const { x, y } = layout.cells[i];
    for (let row = 0; row < img.h; row++) pixels.set(img.pixels.subarray(row * img.w, (row + 1) * img.w), (y + row) * layout.w + x);
  });
  return { pixels, w: layout.w, h: layout.h };
}

const frameImage = (file, i) => ({ pixels: compositeFrameAt(file, i), w: file.visibleWidth, h: file.visibleHeight });
const layerImage = (file, i) => ({ pixels: compositeLayerAt(file, i, file.activeFrameIndex), w: file.visibleWidth, h: file.visibleHeight });

/** Canvas focus. `mask`: the pixel selection (over the visible canvas), if any. */
export function planCanvas(file, mask, full) {
  let base = { pixels: compositeFrame(file), w: file.visibleWidth, h: file.visibleHeight };
  if (mask) base = cropToMask(base.pixels, base.w, base.h, mask) || base;
  const image = () => base;
  const name = sanitizeName(file.name);
  const entries = SCALES.filter((s) => fits(base.w * s, base.h * s)).map((s) => png(`${name}-${s}x.png`, image, s));
  if (full) entries.push(svg(`${name}.svg`, image));
  return { name, entries };
}

/** Timeline focus. `frames`: selected frame indices, or null for all. */
export function planTimeline(file, frames, fps, full) {
  const picked = frames || file.frames.map((_, i) => i);
  const name = sanitizeName(file.name);
  const entries = [png(`${name}-frames.png`, () => sheet(picked.map((i) => frameImage(file, i))))];
  if (full) {
    entries.push({ type: 'gif', path: `${name}.gif`, frameCount: picked.length, wordsAt: (k) => compositeFrameAt(file, picked[k]), w: file.visibleWidth, h: file.visibleHeight, fps });
  }
  return { name: `${name}-timeline`, entries };
}

/** Layers focus, on the current frame. `layers`: selected layer indices, or null for all. */
export function planLayers(file, layers, full) {
  const picked = layers || file.layers.map((_, i) => i);
  const name = sanitizeName(file.name);
  const entries = [png(`${name}-layers.png`, () => sheet(picked.map((i) => layerImage(file, i))))];
  if (full) {
    const names = uniqueNames(picked.map((i) => file.layers[i].name));
    picked.forEach((i, k) => entries.push(png(`layers/${names[k]}.png`, () => layerImage(file, i))));
  }
  return { name: `${name}-layers`, entries };
}

/** Colors focus. */
export function planColors(paletteName, chips, full) {
  const name = sanitizeName(paletteName);
  const entries = [png(`${name}.png`, () => paletteRow(chips))];
  if (full) {
    entries.push(
      text(`${name}.gpl`, formatGpl(paletteName, chips)),
      text(`${name}.hex`, formatHex(chips)),
      text(`${name}.pal`, formatPal(chips)),
    );
  }
  return { name, entries };
}

/**
 * Projects focus. [E] is always the project file. [e] is one sheet per
 * collection for `selected` (`[{ name, files }]`), else an SVG of each canvas
 * in the focused `collection`, else an SVG of the current `file`.
 */
export function planProject({ project, file, collection, selected }, full) {
  if (full) return { name: sanitizeName(project.name), entries: [{ type: 'sprite', path: `${project.name}.sprite`, project }] };
  const current = (f) => ({ pixels: compositeFrame(f), w: f.visibleWidth, h: f.visibleHeight });
  if (selected) {
    const names = uniqueNames(selected.map((c) => c.name));
    return { name: sanitizeName(project?.name ?? 'sheets'), entries: selected.map((c, i) => png(`${names[i]}.png`, () => sheet(c.files.map(current)))) };
  }
  if (collection) {
    const dir = sanitizeName(collection.name);
    const names = uniqueNames(collection.files.map((f) => f.name));
    return { name: dir, entries: collection.files.map((f, i) => svg(`${dir}/${names[i]}.svg`, () => current(f))) };
  }
  const name = sanitizeName(file.name);
  return { name, entries: [svg(`${name}.svg`, () => current(file))] };
}
