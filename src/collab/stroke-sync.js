import { applyDiff, colorIndex } from '../canvas-model.js';
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
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_STROKE_COLORS = 256; // a brush stroke never legitimately touches more; caps table growth per message

// Color indexes are per-file and append-only, so two participants' tables
// diverge as soon as each adds a color. A stroke therefore ships the hex of
// every index it uses, and the receiver re-interns those into its own table.
// Returns the diff in the receiver's indexes, or null if anything is off.
function remapDiff(after, colors, pixelCount, table) {
  if (!after || typeof after.length !== 'number' || after.length % 2 !== 0) return null;
  if (!colors || typeof colors !== 'object') return null;
  const keys = Object.keys(colors);
  if (keys.length > MAX_STROKE_COLORS) return null;
  for (const k of keys) if (typeof colors[k] !== 'string' || !HEX.test(colors[k])) return null;
  // Validate everything before interning anything, so a rejected stroke
  // never leaves entries in the receiver's table.
  for (let k = 0; k < after.length; k += 2) {
    const c = after[k + 1];
    if (!(after[k] >= 0 && after[k] < pixelCount)) return null;
    if (c !== 0 && !(Number.isInteger(c) && c > 0 && Object.hasOwn(colors, c))) return null;
  }
  const out = new Uint32Array(after);
  const local = new Map(); // sender index -> receiver index
  for (let k = 1; k < after.length; k += 2) {
    const c = after[k];
    if (!c) continue;
    if (!local.has(c)) local.set(c, colorIndex(table, colors[c]));
    out[k] = local.get(c);
  }
  return out;
}

export function createStrokeSync({ session, resolveTarget, requestRender }) {
  function apply(target, payload) {
    const diff = remapDiff(payload.after, payload.colors, target.pixels.length, target.colors);
    if (!diff) { console.warn('Dropped a malformed collab stroke message'); return; }
    applyDiff(target, diff);
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
    sendStroke(command, { fileId, frame, layer, colors }) {
      if (command.type !== 'pixelEdit' || !command.after?.length) return;
      const used = {};
      for (let k = 1; k < command.after.length; k += 2) {
        const c = command.after[k];
        if (c) used[c] = colors[c];
      }
      session.send(MSG.STROKE, { fileId, frame, layer, after: command.after, colors: used });
    },
  };
}
