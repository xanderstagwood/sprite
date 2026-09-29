import { applyDiff } from '../canvas-model.js';
import { MSG } from './protocol.js';

// Live pixel sync (§ collab plan, phase 2). Reuses the diff format
// canvas-model.js/undo.js already speak: a stroke message just carries a
// pixelEdit command's `after` side (the [position, colorIndex] pairs), so
// applying one remotely is exactly applyDiff, the same function undo/redo
// already use locally.
//
// No merge/conflict logic lives here: session.js's host relay already
// serializes every participant's messages into one arrival order and
// forwards them to everyone else in that order, host included applying its
// own sends in that same order. Replaying the same ops in the same order on
// every copy converges to the same state for free - last write per pixel
// wins because applyDiff always overwrites, not because this module
// resolves anything (`ponytail:` don't build a merge structure, the arrival
// order already is the merge).
//
// Every stroke names its canvas (`fileId`), frame and layer; the caller's
// `resolveTarget` maps those to a model-like {width, stride, pixels, colors}
// or null when that canvas isn't resident here (or a promise of either). A dropped stroke for a
// dormant canvas costs nothing: loading it later fetches the host's state.
// A peer's message is untrusted input (this is the actual trust boundary,
// unlike a local diff which this app always generates itself): reject
// anything malformed rather than let applyDiff write out of bounds or
// leave the model in a self-inconsistent shape. Silently dropping a bad
// message (with a warning) beats crashing the whole session over it.
function isValidDiff(after, pixelCount, colorCount) {
  if (!after || typeof after.length !== 'number' || after.length % 2 !== 0) return false;
  for (let k = 0; k < after.length; k += 2) {
    if (!(after[k] >= 0 && after[k] < pixelCount)) return false;
    // A color index a peer never should've had (past this file's own
    // palette) writes fine into the Uint16 buffer either way - the real
    // risk is downstream, where rendering indexes model.colors with it.
    if (!(after[k + 1] >= 0 && after[k + 1] < colorCount)) return false;
  }
  return true;
}

export function createStrokeSync({ session, resolveTarget, requestRender }) {
  function apply(target, payload) {
    if (!isValidDiff(payload.after, target.pixels.length, target.colors.length)) { console.warn('Dropped a malformed collab stroke message'); return; }
    applyDiff(target, payload.after);
    requestRender?.(target);
  }

  // A target may arrive late (a compressed frame decoding first). Anything
  // behind it queues so strokes still apply in arrival order; with nothing
  // in flight the common case stays synchronous.
  let tail = null;
  session.onMessage(MSG.STROKE, (payload) => {
    const target = payload && resolveTarget({ fileId: payload.fileId, frame: payload.frame, layer: payload.layer });
    if (!target) return;
    if (!tail && !target.then) { apply(target, payload); return; }
    const run = (tail || Promise.resolve())
      .then(() => target)
      .then((t) => t && apply(t, payload))
      .catch((err) => console.warn('Dropped a collab stroke:', err));
    const me = tail = run.then(() => { if (tail === me) tail = null; });
  });

  return {
    // Call with whatever command history.commit just committed locally;
    // only pixel-edit diffs are streamable, anything else (layer/resize
    // snapshots) is silently skipped here.
    sendStroke(command, { fileId, frame, layer }) {
      if (command.type !== 'pixelEdit' || !command.after?.length) return;
      session.send(MSG.STROKE, { fileId, frame, layer, after: command.after });
    },
  };
}
