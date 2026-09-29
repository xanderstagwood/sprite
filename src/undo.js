import { applyDiff } from './canvas-model.js';

const CAP = 50; // §10: 50-step undo stack, persisted as part of the SpriteFile itself.

// Operates directly on file.undoStack/file.redoStack (§5) rather than owning
// separate closure state, so the arrays are exactly what Phase 8 persists to
// the .sprite file with no extra translation step.
//
// Most commands are pixel diffs ({ before, after }: see canvas-model.js's
// diffFromSnapshot for the typed-array shape). Layer structural changes (add/delete/reorder) aren't pixel
// diffs: they change the shape of file.layers/file.frames itself: so
// those carry a before/after layer-stack snapshot instead, tagged
// `type: 'layers'`: see snapshotLayers for why that's cheap.
export function commitCommand(file, command) {
  if (command.type === 'layers' || command.type === 'resize') {
    if (!command.before || !command.after) return;
  } else if (!command.before.length) {
    return;
  }
  file.undoStack.push(command);
  if (file.undoStack.length > CAP) file.undoStack.shift();
  file.redoStack = []; // new command invalidates redo history
  file.updatedAt = Date.now(); // § project.js's mostRecentFileIn
}

// Layer add/delete/reorder only ever add, remove or reorder *references* to
// pixel buffers: no buffer is edited or copied by them: so the snapshot
// holds the buffers by reference and clones only the small layer metadata.
// (Deep-cloning every buffer here cost layers x frames x canvas area per
// edit, times the 50-step stack.) Later pixel edits mutate those shared
// buffers in place, but the linear undo stack unwinds them first.
// Layer add/delete/reorder only ever add, remove or reorder *references* to
// pixel buffers: no buffer is edited or copied by them: so the snapshot
// holds the buffers by reference and clones only the small layer metadata.
// (Deep-cloning every buffer here cost layers x frames x canvas area per
// edit, times the 50-step stack.) Later pixel edits mutate those shared
// buffers in place, but the linear undo stack unwinds them first.
//
// This still holds even with frames outside the active hot window
// deflated in memory (§ frame-cache.js): a frame is only ever compressed
// while it isn't the active frame, so it's never edited while compressed,
// and decompressing it losslessly rebuilds the exact content it had when
// compressed. A snapshot taken here (always after commitLayerChange's
// ensureAllFramesLoaded, so every buffer is raw at snapshot time) stays
// content-correct no matter how many compress/decompress cycles a frame
// goes through before this entry is undone: only pixel edits change a
// frame's content, and those are always separate, position-based undo
// commands layered on top, never something a structural snapshot needs to
// track buffer identity across.
export function snapshotLayers(file) {
  return {
    layers: structuredClone(file.layers),
    frames: file.frames.map((frame) => ({ frame, layerPixels: frame.layerPixels.slice() })),
    activeLayerIndex: file.activeLayerIndex,
  };
}

function applyLayerSnapshot(file, snapshot) {
  file.layers = structuredClone(snapshot.layers);
  file.frames = snapshot.frames.map(({ frame, layerPixels }) => {
    frame.layerPixels = layerPixels.slice();
    return frame;
  });
  file.activeLayerIndex = snapshot.activeLayerIndex;
}

// A resize builds new buffers and leaves the old ones untouched, so like the
// layer snapshot this holds buffers by reference: nothing is copied.
export function snapshotResize(file) {
  const { visibleWidth, visibleHeight, canvasWidth, canvasHeight } = file;
  return { visibleWidth, visibleHeight, canvasWidth, canvasHeight, frames: file.frames.map((frame) => ({ frame, layerPixels: frame.layerPixels.slice() })) };
}

function applyResizeSnapshot(file, snapshot) {
  const { visibleWidth, visibleHeight, canvasWidth, canvasHeight } = snapshot;
  Object.assign(file, { visibleWidth, visibleHeight, canvasWidth, canvasHeight });
  for (const { frame, layerPixels } of snapshot.frames) frame.layerPixels = layerPixels.slice();
}

// Applies one side of a command: a layer or resize snapshot, or a pixel diff.
function apply(file, model, command, side) {
  if (command.type === 'layers') applyLayerSnapshot(file, side);
  else if (command.type === 'resize') applyResizeSnapshot(file, side);
  else applyDiff(model, side);
}

export function undo(file, model) {
  const command = file.undoStack.pop();
  if (!command) return false;
  apply(file, model, command, command.before);
  file.redoStack.push(command);
  return true;
}

export function redo(file, model) {
  const command = file.redoStack.pop();
  if (!command) return false;
  apply(file, model, command, command.after);
  file.undoStack.push(command);
  return true;
}
