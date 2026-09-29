// Frame-range selection ({anchor, to}, inclusive), built by the timeline's
// Shift+Left/Right and Shift+click. Its own module rather than a bare
// main.js variable (like layerSelection/frameSelection used to be) so
// onion-skin, selection-scoped playback and the in-memory frame cache's hot
// window can each read it directly without main.js wiring them together.
let anchor = null, to = null;

export function setAnchor(i) { anchor = to = i; }

// Extends from whatever anchor is already set, or starts a new one at `i`
// if nothing was selected yet: matches shiftSelectLayer's "extend from the
// last anchor" behavior.
export function extendTo(i) {
  if (anchor === null) anchor = i;
  to = i;
}

export function clear() { anchor = to = null; }

// The moving edge (as opposed to getRange()'s direction-independent lo/hi):
// what Shift+Left/Right advances one frame at a time.
export function getTo() { return to; }

export function getRange() {
  return anchor === null ? null : { lo: Math.min(anchor, to), hi: Math.max(anchor, to) };
}

export function isSelected(i) {
  const r = getRange();
  return !!r && i >= r.lo && i <= r.hi;
}

// Both edges move together: used after a bulk reorder shifts the whole
// selected block by one position.
export function shift(dir) {
  if (anchor === null) return;
  anchor += dir;
  to += dir;
}
