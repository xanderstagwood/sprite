// Keeps only a "hot window" of frames (the active frame, its onion-skin
// neighbors, and the full frame-selection range) as raw, synchronously
// readable Uint16Array pixel buffers; every other frame of an open file is
// deflated and its buffers discarded, so a canvas can hold far more frames
// than fit in memory raw. Mirrors persistence.js's ensureLoaded/becomeStub
// pattern (there: whole Files lazily loaded/unloaded; here: individual
// frames within one open File).
import { bufferId } from './canvas-model.js';
import { compositeFrameAt } from './sprite-file.js';
import { deflate, inflate } from './compression.js';
import { chunkId } from './sprite-format.js';

// Fixed range: matches main.js's onion-skin ONION_RANGE. Always kept hot
// regardless of whether onion-skin is switched on, so toggling it never
// needs its own hot-window sync: simpler and safer than tracking that state
// here too, at the cost of a few frames' worth of buffers always staying
// raw either side of the active one.
const ONION_RANGE = 2;

// Frame -> cached composite (sprite-file.js's own compositeCache output,
// reused as-is rather than copied): the last full-resolution render taken
// right before its buffers were discarded, so the timeline can keep
// painting an unchanging thumbnail for a compressed frame without ever
// touching its (gone) pixels again.
const thumbnails = new WeakMap();

export function getCachedThumbnail(frame) {
  return thumbnails.get(frame) || null;
}

function hotIndices(file, selectionRange) {
  const n = file.frames.length;
  const hot = new Set();
  const add = (i) => { if (i >= 0 && i < n) hot.add(i); };
  add(file.activeFrameIndex);
  for (let d = 1; d <= ONION_RANGE; d++) { add(file.activeFrameIndex - d); add(file.activeFrameIndex + d); }
  if (selectionRange) for (let i = selectionRange.lo; i <= selectionRange.hi; i++) add(i);
  return hot;
}

async function decompressFrame(frame) {
  const buffers = await Promise.all(frame._compressed.map(async (c) => {
    const bytes = await inflate(c.bytes);
    const buf = new Uint16Array(bytes.slice().buffer);
    buf.id = c.id;
    if (c.cid !== undefined) buf.cid = c.cid;
    return buf;
  }));
  Object.defineProperty(frame, 'layerPixels', { configurable: true, writable: true, enumerable: true, value: buffers });
  delete frame._compressed;
}

// Resolves once `frame`'s pixels are raw and readable (immediately if they
// already are).
export function ensureFrameLoaded(file, frameIndex) {
  const frame = file.frames[frameIndex];
  if (!frame || !frame._compressed) return Promise.resolve();
  return frame._loading ||= decompressFrame(frame).finally(() => { delete frame._loading; });
}

export function ensureAllFramesLoaded(file) {
  return Promise.all(file.frames.map((_, i) => ensureFrameLoaded(file, i)));
}

// Deflates `frame`'s buffers and discards them, but only if nothing else
// started loading or compressing it in the meantime (the stamp guard: the
// same shape as persistence.js's becomeStub "left alone if anything changed
// while the write ran"). Composites and caches a thumbnail first, since
// this is the last moment the raw pixels are available.
export async function compressFrame(file, frameIndex) {
  const frame = file.frames[frameIndex];
  if (!frame || frame._compressed || frame._loading || frame._compressing) return;
  const stamp = frame._compressing = {};
  thumbnails.set(frame, compositeFrameAt(file, frameIndex));
  const buffers = frame.layerPixels;
  const compressed = await Promise.all(buffers.map(async (buf) => ({
    id: bufferId(buf),
    cid: chunkId(buf),
    v: buf.v | 0,
    bytes: await deflate(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)),
  })));
  if (frame._compressing !== stamp) return; // re-entered the hot window mid-compress
  delete frame._compressing;
  Object.defineProperty(frame, 'layerPixels', {
    configurable: true,
    get() { throw new Error(`Frame ${frame.id ?? ''}'s pixels are compressed; call ensureFrameLoaded first`); },
  });
  frame._compressed = compressed;
}

// Call after any change to `file.activeFrameIndex`, the frame order, or the
// frame-selection range: decompresses whatever just entered the hot window
// (awaited: this is the accepted decode hitch on a far frame jump) and
// starts compressing whatever just left it (fire-and-forget: never blocks
// the caller).
export async function syncHotWindow(file, selectionRange) {
  const hot = hotIndices(file, selectionRange);
  await Promise.all([...hot].map((i) => ensureFrameLoaded(file, i)));
  file.frames.forEach((frame, i) => {
    if (!hot.has(i)) compressFrame(file, i);
  });
}
