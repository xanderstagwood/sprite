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
// `fileId`/`frameId`/`layerId` ride along on every message but are ignored
// for now - phase 2 is scoped to the one canvas host and guest both have
// open; phase 3's RemoteHostBackend is what makes routing by id matter.
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

// ponytail: the pixel values themselves aren't checked against the color
// table the way isValidDiff checks a stroke's colorIndex - only the host
// ever sends a bootstrap (its own local state, phase 2's star topology),
// so this isn't a hole yet. Revisit if a later phase lets anything but the
// host originate one.
function isValidBootstrap({ width, height, stride, pixels } = {}) {
  if (!(width > 0) || !(height > 0)) return false;
  const s = stride || width;
  if (width > s) return false; // the visible width can never exceed the buffer's stride
  return !!pixels && pixels.length === s * height;
}

export function createStrokeSync({ session, model, requestRender }) {
  session.onMessage(MSG.STROKE, (payload) => {
    if (!isValidDiff(payload?.after, model.pixels.length, model.colors.length)) { console.warn('Dropped a malformed collab stroke message'); return; }
    applyDiff(model, payload.after);
    requestRender?.();
  });

  session.onMessage(MSG.BOOTSTRAP, (payload) => {
    if (!isValidBootstrap(payload)) { console.warn('Dropped a malformed collab bootstrap message'); return; }
    model.width = payload.width;
    model.height = payload.height;
    model.stride = payload.stride;
    model.pixels = payload.pixels;
    requestRender?.();
  });

  // Only ever fires on the host's own session (session.js only emits it
  // where a guest's connection opens, which is the host-side code path):
  // a fresh joiner needs the canvas's current pixels before strokes mean
  // anything to them.
  session.onMessage('participant-joined', () => {
    session.send(MSG.BOOTSTRAP, { width: model.width, height: model.height, stride: model.stride, pixels: model.pixels });
  });

  return {
    // Call with whatever command history.commit just committed locally;
    // only pixel-edit diffs are streamable, anything else (layer/resize
    // snapshots) is silently skipped here.
    sendStroke(command, fileId) {
      if (command.type !== 'pixelEdit' || !command.after?.length) return;
      session.send(MSG.STROKE, { fileId, after: command.after });
    },
  };
}
