import { compositeFrame, compositeFrameAt, compositeLayerAt } from './sprite-file.js';
import { encodeFile } from './sprite-format.js';
import { ensureLoaded, loadTemporarily } from './persistence.js';
import { ensureAllFramesLoaded } from './frame-cache.js';
import { computeArtboardLayout } from './renderer.js';
import { zipSync } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
import { GIFEncoder, quantize, applyPalette } from 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';
import { encodeGifStream } from './gif-index.js';
import { pushRects } from './svg-rects.js';
import { pushOutlines } from './svg-outlines.js';
import { contentBounds, unionBounds, cropPixels } from './trim.js';

// Export (§14): PNG, GIF, SVG per File/Collection, plus a whole-Project
// .sprite archive. Scale is an integer upscale, nearest-neighbor: no
// smoothing, so pixel edges stay hard.

// --- progress + retry/error handling, shared by every export entry point --

// main.js's tool tag subscribes here to show a progress bar while an
// export runs, and a quiet "(export error)" marker if one ultimately
// fails: see runExport below for the full lifecycle.
let progressListener = null;
export function onExportProgress(fn) { progressListener = fn; }
function reportProgress(status) { if (progressListener) progressListener(status); }

const MAX_ATTEMPTS = 4; // 1 initial try + 3 silent retries

// A transient hiccup (a GC pause, a momentarily-busy disk cache) most
// often just works on a second try, so failures retry silently: no
// interruption, the progress bar just keeps running. Only once every
// attempt has failed does this decide whether the user can actually do
// anything about it: a message worth prompting for (free up space, lower
// the scale) versus an unexpected internal error with no useful next
// step, where interrupting with a dialog that says nothing actionable
// would be worse than just flagging it quietly.
function fixableMessage(err) {
  if (err && err.name === 'QuotaExceededError') return { short: 'storage full', detail: 'Export failed: not enough free storage space. Free up space and try again.' };
  if (err instanceof RangeError) return { short: 'too large', detail: 'Export failed: the result was too large to build. Try a smaller scale.' };
  return null;
}

async function runExport(work) {
  reportProgress({ active: true, fraction: 0, error: null });
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await work((fraction) => reportProgress({ active: true, fraction }));
      reportProgress({ active: false });
      return;
    } catch (err) {
      lastErr = err;
      console.error(`Export failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, err);
    }
  }
  const fixable = fixableMessage(lastErr);
  reportProgress({
    active: false,
    error: fixable
      ? { short: fixable.short, detail: fixable.detail, actionable: true }
      : { short: 'export error', detail: `Export failed: ${lastErr?.message || lastErr}`, actionable: false },
  });
}

// --- low-level rasterization, shared by every raster export path -------

function pixelsToCanvas(pixels, w, h, scale, bgColor) {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = w * scale;
  canvasEl.height = h * scale;
  const ctx = canvasEl.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
  }
  const src = document.createElement('canvas');
  src.width = w;
  src.height = h;
  const img = new ImageData(w, h);
  new Uint32Array(img.data.buffer).set(pixels); // packed RGBA words, see canvas-model.js hexToPacked
  src.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(src, 0, 0, w * scale, h * scale);
  return canvasEl;
}

function canvasToBlob(canvasEl, mime) {
  return new Promise((resolve) => canvasEl.toBlob(resolve, mime));
}

// Hand-rolled: no library needed at this pixel-grid scale.
// `outlines`: merged contour paths instead of one rect per run (svg-outlines.js).
function pixelsToSvgString(pixels, w, h, scale, outlines) {
  const parts = [];
  (outlines ? pushOutlines : pushRects)(parts, pixels, w, h, 0, 0, scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w * scale} ${h * scale}">${parts.join('')}</svg>`;
}

// --- download plumbing ---------------------------------------------------

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A file name that already exists in the app (a layer's, a file's) isn't
// guaranteed clean for a filesystem: strip path separators and other
// characters most filesystems (and zip readers) choke on.
function sanitizeName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled';
}

// Anything past this is large enough it's worth a "are you sure" beat
// before committing the browser to holding it all in memory and writing it
// out: a plain, blocking confirm is enough for a rare warning gate like
// this, no need for a bespoke modal. Declining isn't a failure: it just
// returns, same as any other "nothing to do" no-op elsewhere in the app,
// so runExport's retry loop never touches this path.
const LARGE_EXPORT_BYTES = 25 * 1024 * 1024;
function confirmIfLarge(totalBytes, itemDesc) {
  if (totalBytes <= LARGE_EXPORT_BYTES) return true;
  const mb = (totalBytes / (1024 * 1024)).toFixed(1);
  return window.confirm(`This export (${itemDesc}) is about ${mb}MB. Continue?`);
}

// Single-file result: just download it (after the size check). Multi-file
// result: zip it first (fflate, no existing zip writer in this codebase to
// reuse: see the audit that led here), *then* size-check the zip itself
// (compression can land either side of the raw total), then download.
async function downloadSingle(blob, filename) {
  if (!confirmIfLarge(blob.size, filename)) return;
  downloadBlob(blob, filename);
}

async function downloadZip(entries, zipFilename) {
  const files = {};
  for (const { path, blob } of entries) {
    files[path] = new Uint8Array(await blob.arrayBuffer());
  }
  const zipped = zipSync(files, { level: 6 });
  const blob = new Blob([zipped], { type: 'application/zip' });
  if (!confirmIfLarge(blob.size, zipFilename)) return;
  downloadBlob(blob, zipFilename);
}

// One or many blobs in: exactly one download out, zipped when there's more
// than one: the one rule every export target (File/Collection/Project)
// below follows, so none of them need to special-case "did this produce
// one file or several."
async function downloadResults(entries, zipFilename) {
  if (entries.length === 1) return downloadSingle(entries[0].blob, entries[0].path);
  return downloadZip(entries, zipFilename);
}

// --- GIF -------------------------------------------------------------

// One shared palette across every frame, so a color already used doesn't
// shift or flicker between frames the way separately-quantized per-frame
// palettes could. `frames` are packed composites; see gif-index.js.
const gifenc = { GIFEncoder, quantize, applyPalette };
const encodeGif = (frames, w, h, scale, delayMs, onFrame) => encodeGifStream({
  frameCount: frames.length, wordsAt: (i) => frames[i], w, h, scale, delayMs, onFrame, gifenc,
});

// `trim`: crop away the empty margin. One box covers every image an export
// produces from a source (all frames, all layers), so an animation or a layer
// stack stays aligned instead of each image being cropped on its own. Returns
// the source unchanged when trim is off or nothing is visible (an empty canvas
// keeps its size rather than shrinking to nothing). `pixelsAt(i)` composites
// image i on demand; only one is held at a time.
function trimmed(trim, count, pixelsAt, w, h) {
  if (!trim) return { pixelsAt, w, h };
  let box = null;
  for (let i = 0; i < count; i++) box = unionBounds(box, contentBounds(pixelsAt(i), w, h));
  if (!box) return { pixelsAt, w, h };
  return { pixelsAt: (i) => cropPixels(pixelsAt(i), w, box), w: box.x1 - box.x0, h: box.y1 - box.y0 };
}

// A File's own GIF: one plain image if it has just the one Frame, an
// animated loop (at `fps`) if it has more: no separate mode/picker for
// this, unlike PNG/SVG's canvas/layers/frames choice below, since a GIF is
// inherently a sequence-or-not already.
async function exportFileGif(file, scale, fps, trim, onProgress) {
  // Frames are composited on demand and dropped after each write, so memory
  // holds one frame however long the animation is.
  const frames = trimmed(trim, file.frames.length, (i) => compositeFrameAt(file, i), file.visibleWidth, file.visibleHeight);
  const bytes = encodeGifStream({
    frameCount: file.frames.length, wordsAt: frames.pixelsAt, w: frames.w, h: frames.h,
    scale, delayMs: Math.round(1000 / fps), onFrame: (f) => onProgress(f * 0.9), gifenc,
  });
  await downloadResults([{ path: `${file.name}.gif`, blob: new Blob([bytes], { type: 'image/gif' }) }], `${file.name}.gif`);
}

// --- File export ----------------------------------------------------------

// `mode`: 'canvas' (today's single flattened image, the active Frame) |
// 'layers' (every Layer of the active Frame, each its own file, in a
// subfolder named after the File: named by the Layer) | 'frames' (every
// Frame's full composite, same shape as 'layers'). PNG/SVG only: GIF has
// its own all-frames-or-one behavior above instead.
export function exportFile(file, opts) {
  return runExport((onProgress) => exportFileImpl(file, opts, onProgress));
}

async function exportFileImpl(file, { format, scale = 1, mode = 'canvas', fps = 8, trim = false, outlines = false } = {}, onProgress) {
  await ensureLoaded(file);
  await ensureAllFramesLoaded(file); // every frame gets composited below, cold or not
  if (format === 'gif') return exportFileGif(file, scale, fps, trim, onProgress);

  const toBlob = async (pixels, w, h) => {
    if (format === 'svg') return new Blob([pixelsToSvgString(pixels, w, h, scale, outlines)], { type: 'image/svg+xml' });
    const canvasEl = pixelsToCanvas(pixels, w, h, scale, null);
    return canvasToBlob(canvasEl, 'image/png');
  };
  const ext = format === 'svg' ? 'svg' : 'png';
  const fullW = file.visibleWidth, fullH = file.visibleHeight;

  if (mode === 'canvas') {
    const { pixelsAt, w, h } = trimmed(trim, 1, () => compositeFrame(file), fullW, fullH);
    const blob = await toBlob(pixelsAt(0), w, h);
    onProgress(0.9);
    return downloadResults([{ path: `${file.name}.${ext}`, blob }], `${file.name}.${ext}`);
  }

  const dir = sanitizeName(file.name);
  const items = mode === 'layers' ? file.layers : file.frames;
  const { pixelsAt, w, h } = trimmed(trim, items.length, (i) => (mode === 'layers' ? compositeLayerAt(file, i, file.activeFrameIndex) : compositeFrameAt(file, i)), fullW, fullH);
  const entries = [];
  for (let i = 0; i < items.length; i++) {
    const blob = await toBlob(pixelsAt(i), w, h);
    const name = mode === 'layers' ? sanitizeName(file.layers[i].name) : `frame-${i + 1}`;
    entries.push({ path: `${dir}/${name}.${ext}`, blob });
    onProgress((i + 1) / items.length * 0.9);
  }
  return downloadResults(entries, `${dir}.zip`);
}

// --- Collection export -----------------------------------------------------

// `artboards`: [{ name, width, height, pixels }]: the same shape
// main.js's groupArtboards() already builds for the on-screen group grid
// (one entry per member File, its own current composite). `mode`: 'sheet'
// (one combined raster laid out in the same grid the collection view
// shows, 2px gap: fixed, independent of `scale`) | 'files' (each artboard
// as its own file, zipped). SVG has no `mode` at all: always one combined
// sheet, vector, since a "files" SVG export would just be File export's
// canvas mode repeated per member, already covered there.
const SHEET_GAP = 2; // export px, independent of scale: not the live view's ARTBOARD_GAP

export function exportCollection(collectionName, artboards, opts) {
  return runExport((onProgress) => exportCollectionImpl(collectionName, artboards, opts, onProgress));
}

async function exportCollectionImpl(collectionName, artboards, { format, scale = 1, mode = 'sheet', trim = false, outlines = false } = {}, onProgress) {
  // An empty Collection has nothing to lay out: computeArtboardLayout
  // degrades to a 0x0 sheet for zero artboards, and canvas.toBlob() on a
  // 0x0 canvas resolves with a null Blob rather than throwing, which would
  // otherwise crash downstream in downloadResults with nothing to show for
  // why. Nothing to export, so nothing happens.
  if (!artboards.length) { onProgress(1); return; }
  if (trim) artboards = artboards.map(trimBoard);
  if (format === 'svg') { exportCollectionSheetSvg(collectionName, artboards, scale, outlines); onProgress(1); return; }
  if (mode === 'files') return exportCollectionFiles(collectionName, artboards, format, scale, onProgress);
  return exportCollectionSheet(collectionName, artboards, format, scale, onProgress);
}

// One artboard cropped to its own content (each member trims independently:
// unlike animation frames, they are separate images that do not line up). A
// blank one keeps its size.
function trimBoard(board) {
  const box = contentBounds(board.pixels, board.width, board.height);
  if (!box) return board;
  return { ...board, pixels: cropPixels(board.pixels, board.width, box), width: box.x1 - box.x0, height: box.y1 - box.y0 };
}

// Same column/row math the on-screen group grid uses (computeArtboardLayout,
// § renderer.js) but with a fixed 2px export gap instead of the live view's
// own: see SHEET_GAP's comment.
function layoutSheetCells(artboards) {
  const layout = computeArtboardLayout(artboards, SHEET_GAP);
  const cells = artboards.map((board, i) => {
    const col = i % layout.cols, row = Math.floor(i / layout.cols);
    return {
      board,
      x: col * layout.stepX + Math.floor((layout.cellW - board.width) / 2),
      y: row * layout.stepY + (layout.cellH - board.height), // bottom-aligned, as on screen
    };
  });
  return { cells, layout };
}

// One blit per board instead of a fillRect per pixel, like the live renderer.
export function drawSheetCells(ctx, cells, scale, onProgress) {
  ctx.imageSmoothingEnabled = false;
  cells.forEach(({ board, x, y }, i) => {
    ctx.drawImage(pixelsToCanvas(board.pixels, board.width, board.height, 1, null), x * scale, y * scale, board.width * scale, board.height * scale);
    onProgress((i + 1) / cells.length * 0.6);
  });
}

async function exportCollectionSheet(collectionName, artboards, format, scale, onProgress) {
  const { cells, layout } = layoutSheetCells(artboards);
  const w = layout.totalW, h = layout.totalH;
  const canvasEl = document.createElement('canvas');
  canvasEl.width = w * scale;
  canvasEl.height = h * scale;
  const ctx = canvasEl.getContext('2d');
  drawSheetCells(ctx, cells, scale, onProgress);
  if (format === 'gif') {
    const words = new Uint32Array(ctx.getImageData(0, 0, w * scale, h * scale).data.buffer);
    const bytes = encodeGif([words], w * scale, h * scale, 1, 0, (f) => onProgress(0.6 + f * 0.3));
    return downloadResults([{ path: `${collectionName}.gif`, blob: new Blob([bytes], { type: 'image/gif' }) }], `${collectionName}.gif`);
  }
  const blob = await canvasToBlob(canvasEl, 'image/png');
  onProgress(0.9);
  return downloadResults([{ path: `${collectionName}.png`, blob }], `${collectionName}.png`);
}

function exportCollectionSheetSvg(collectionName, artboards, scale, outlines) {
  const { cells, layout } = layoutSheetCells(artboards);
  const w = layout.totalW * scale, h = layout.totalH * scale;
  const parts = [];
  for (const { board, x, y } of cells) (outlines ? pushOutlines : pushRects)(parts, board.pixels, board.width, board.height, x, y, scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
  return downloadResults([{ path: `${collectionName}.svg`, blob: new Blob([svg], { type: 'image/svg+xml' }) }], `${collectionName}.svg`);
}

async function exportCollectionFiles(collectionName, artboards, format, scale, onProgress) {
  const dir = sanitizeName(collectionName);
  const entries = [];
  for (let i = 0; i < artboards.length; i++) {
    const board = artboards[i];
    const blob = format === 'gif'
      ? new Blob([encodeGif([board.pixels], board.width, board.height, scale, 0)], { type: 'image/gif' })
      : await canvasToBlob(pixelsToCanvas(board.pixels, board.width, board.height, scale, null), 'image/png');
    entries.push({ path: `${dir}/${sanitizeName(board.name)}.${format === 'gif' ? 'gif' : 'png'}`, blob });
    onProgress((i + 1) / artboards.length * 0.9);
  }
  return downloadResults(entries, `${dir}.zip`);
}

// --- Project export ---------------------------------------------------

// The whole Project as one portable .sprite archive (a zip, same shape
// persistence.js already writes to storage: project.json plus one
// <name>.sprite per File: bundled into a single downloadable file instead
// of storage-backend records). The Project's palette (this app has exactly
// one shared palette per Project: see project.js's createProject: so
// "every palette used" is just that one object) rides along inside
// project.json, same as it already does in storage.
export function exportProjectSprite(project) {
  return runExport((onProgress) => exportProjectSpriteImpl(project, onProgress));
}

async function exportProjectSpriteImpl(project, onProgress) {
  // `<name>.sprite` paths deliberately unsanitized here: same convention
  // persistence.js's own storage already uses for these exact files
  // (`fileName + '.sprite'`, storage.js), so `fileNames` in project.json
  // and each entry's own path always agree on import, byte for byte.
  const files = {
    'project.json': new TextEncoder().encode(JSON.stringify({
      name: project.name, palette: project.palette, activeFileIndex: project.activeFileIndex,
      collections: project.collections, fileNames: project.files.map((f) => f.name),
    })),
  };
  const encoder = new TextEncoder();
  for (const [i, file] of project.files.entries()) {
    const release = await loadTemporarily(file);
    const { meta, chunks } = encodeFile(file);
    delete meta.references; // reference images never leave the app
    files[`${file.name}.sprite`] = encoder.encode(JSON.stringify(meta));
    for (const chunk of chunks) files[`${file.name}.sprite.${chunk.name}`] = chunk.bytes();
    release();
    onProgress((i + 1) / project.files.length * 0.5);
  }
  onProgress(0.7);
  const zipped = zipSync(files, { level: 6 });
  const blob = new Blob([zipped], { type: 'application/octet-stream' });
  onProgress(0.9);
  if (!confirmIfLarge(blob.size, `${project.name}.sprite`)) return;
  downloadBlob(blob, `${project.name}.sprite`);
}
