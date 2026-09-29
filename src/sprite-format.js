import { createColorTable, colorIndex, bufferId } from './canvas-model.js';

// .sprite v5 (meta shape unchanged since v4): the File's JSON `meta`
// (everything except pixels) plus binary chunks, each written independently
// so an autosave rewrites only what changed:
//   one chunk per layer buffer: canvasWidth*canvasHeight Uint16 indices
//     into `meta.colors`: named `frame-<frameId>-<bufferChunkId>`, both ids
//     stable across saves; `meta.frames` lists each frame's id and its
//     buffers' chunk ids in layer order.
// Undo history is session-only and never saved (`undoStack` is written
// empty; the undo chunk older builds kept is ignored).
// Binary rather than base64-in-JSON: base64 is a third larger, and
// JSON.stringify over a huge string blocks the main thread on every autosave.
// v5 chunk bytes are deflate-raw compressed (persistence.js, around the
// backend read/write, not here: this module only ever sees already-resolved
// bytes). v4 chunks are the same shape, uncompressed; still loadable, and
// rewritten as v5 on next save. v3 packed every layer of a Frame into one
// chunk (`read('frame', id)`), v2 kept every Frame in one sidecar
// (`read('bin')`); a file with no `version` is v1 (pixels as plain arrays of
// hex/null). All still load, and are rewritten as v5 by persistence.js.
export const FORMAT_VERSION = 5;

let frameIdCounter = 0;
const frameId = (frame) => frame.id ??= `f${Date.now().toString(36)}${(frameIdCounter++).toString(36)}`;
// Unlike bufferId (a per-session counter), this names the buffer's chunk on
// disk, so it is generated once, saved in the meta and restored on load.
const chunkId = (buf) => buf.cid ??= `b${Date.now().toString(36)}${(frameIdCounter++).toString(36)}`;
export const chunkName = (frameId, cid) => `frame-${frameId}-${cid}`;

// In-memory File -> { meta, chunks }. Each `chunks[i]` is one layer buffer:
// its stored `name`, a cheap change signature and a `bytes()` thunk, so a
// caller that already knows a chunk is unchanged never pays to encode it.
// Undo and redo are session-only (§10); session-only references (no file
// handle to relink by) aren't saved.
// The JSON half of a File, shared by a loaded File and a stub (below) so
// their saved shape can never drift apart. Strips the in-memory-only fields.
function buildMeta(file, frames) {
  const { frames: _frames, undoStack, _stub, _load, _loading, _release, ...rest } = file;
  const references = (file.references || []).filter((r) => r.linked);
  return { ...rest, references, version: FORMAT_VERSION, frames, undoStack: [], redoStack: [] };
}

// Meta for a File whose pixels aren't loaded (see stubFile): its frames
// already know their buffers' chunk ids.
export const encodeStubMeta = (file) => buildMeta(file, file.frames.map(({ id, buffers }) => ({ id, buffers })));

export function encodeFile(file) {
  const cells = file.canvasWidth * file.canvasHeight;
  const chunks = [];
  const frames = file.frames.map((frame) => {
    const id = frameId(frame);
    const buffers = frame.layerPixels.map((buf) => {
      const cid = chunkId(buf);
      chunks.push({
        name: chunkName(id, cid),
        sig: `${bufferId(buf)}.${buf.v | 0}`,
        bytes() {
          const bytes = new Uint8Array(cells * 2);
          new Uint16Array(bytes.buffer).set(buf);
          return bytes;
        },
      });
      return cid;
    });
    return { id, buffers };
  });
  return { meta: buildMeta(file, frames), chunks };
}

// Older versions kept pixels outside the visible window hidden in a bigger
// buffer; a canvas is now exactly what it shows. Readable from the meta alone,
// so a lazy load can tell without reading any pixels.
export const needsTidy = ({ canvasWidth, canvasHeight, visibleWidth, visibleHeight }) => canvasWidth !== visibleWidth || canvasHeight !== visibleHeight;

// Crops a loaded File to its visible window, dropping the hidden pixels. Each
// buffer keeps its chunk id, so rewriting the File replaces its chunks in place.
export function tidyFile(file) {
  const { visibleWidth: w, visibleHeight: h, canvasWidth: stride } = file;
  for (const frame of file.frames) {
    frame.layerPixels = frame.layerPixels.map((old) => {
      const next = new Uint16Array(w * h);
      for (let y = 0; y < h; y++) next.set(old.subarray(y * stride, y * stride + w), y * w);
      if (old.cid) next.cid = old.cid;
      return next;
    });
  }
  file.canvasWidth = w;
  file.canvasHeight = h;
}

// Persisted meta (or a bare v1 file object) -> the in-memory File.
// `read(kind, id)` returns a chunk's bytes or null: ('chunk', name) for v4,
// ('frame', id) for v3, or ('bin') for a v2 file's single sidecar. Older
// files come back in the current shape with an empty undo stack.
export function parseFile(meta, read = () => null) {
  if (meta.version === FORMAT_VERSION || meta.version === 4) return decodeV4(meta, read);
  if (meta.version === 3) return decodeV3(meta, read);
  if (meta.version === 2) return decodeV2(meta, read('bin'));
  return migrateV1(meta);
}

// Reads consecutive typed values out of `bytes`. slice() copies into a
// fresh, aligned ArrayBuffer, so each view owns its memory and offsets in
// `bytes` needn't be aligned.
function reader(bytes) {
  let offset = 0;
  return (Type, count) => {
    const size = count * Type.BYTES_PER_ELEMENT;
    const out = new Type(bytes.slice(offset, offset + size).buffer);
    offset += size;
    return out;
  };
}

// A File that has its metadata (layers, size, order, palette-free fields)
// but not its pixels, for lazy loading. Frames are
// placeholders that know their id and *throw* if their pixels are touched,
// so a code path that forgot to load the File fails loudly and by name
// instead of reading garbage. `load()` (set by the caller) fills it in
// place, keeping the object's identity.
export function stubFile(meta) {
  const { frames: saved, ...rest } = meta;
  const file = { ...rest, undoStack: [], _stub: true };
  delete file.version;
  file.frames = saved.map(({ id, buffers }) => ({
    id,
    buffers,
    get layerPixels() { throw new Error(`File "${file.name}" isn't loaded yet`); },
  }));
  return file;
}

function decodeV4({ frames: saved, ...meta }, read) {
  const cells = meta.canvasWidth * meta.canvasHeight;
  const frames = saved.map(({ id, buffers }) => ({
    id,
    layerPixels: buffers.map((cid) => {
      const bytes = read('chunk', chunkName(id, cid));
      // A missing chunk reads as blank, not a failed load
      const buf = bytes ? new Uint16Array(bytes.slice().buffer) : new Uint16Array(cells);
      buf.cid = cid;
      return buf;
    }),
  }));
  delete meta.version;
  return { ...meta, frames, undoStack: [] };
}

function decodeV3({ frames: ids, ...meta }, read) {
  const cells = meta.canvasWidth * meta.canvasHeight;
  const frames = ids.map((id) => {
    const bytes = read('frame', id) || new Uint8Array(meta.layers.length * cells * 2); // a missing chunk reads as blank, not a failed load
    const take = reader(bytes);
    return { id, layerPixels: meta.layers.map(() => take(Uint16Array, cells)) };
  });
  delete meta.version;
  return { ...meta, frames, undoStack: [] };
}

function decodeV2({ frameCount, ...meta }, bytes) {
  const cells = meta.canvasWidth * meta.canvasHeight;
  const take = reader(bytes);
  const frames = Array.from({ length: frameCount }, () => ({
    layerPixels: meta.layers.map(() => take(Uint16Array, cells)),
  }));
  delete meta.version;
  return { ...meta, frames, undoStack: [] };
}

function migrateV1(file) {
  const colors = createColorTable();
  const frames = file.frames.map((frame) => ({
    layerPixels: frame.layerPixels.map((hexes) => {
      const buf = new Uint16Array(hexes.length);
      for (let i = 0; i < hexes.length; i++) if (hexes[i]) buf[i] = colorIndex(colors, hexes[i]);
      return buf;
    }),
  }));
  return { ...file, colors, frames, undoStack: [] };
}
