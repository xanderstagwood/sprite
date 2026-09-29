// The pixel font is only crisp when each glyph starts on a whole device pixel.
// Layout does not promise that: centring, percentages, a scrolled panel or a
// fractional pixel ratio all leave text half a pixel out. This settles it in one
// place instead of every feature rounding its own positions: after layout it
// finds each run of text (and each frame and layer thumbnail), measures where it
// landed and nudges it onto the nearest device pixel with the `translate`
// property (see `--snap-x` and `--snap-y` in style.css). Icons are left alone:
// the browser already draws their boxes on whole device pixels, and a nudge on
// top of that clipped the left column off the new canvas button's icon.

const EPS = 1e-4; // css px: anything smaller is rounding noise

/**
 * `items` are `{ id, parent, x, y }`: where an element sits on screen with no
 * nudges applied, and the id of its nearest nudged ancestor (or null). Returns
 * a Map of id -> { x, y }, the nudge each element needs of its own; elements
 * that need none are left out. A nudge moves everything inside the element, so
 * a child only adds what its parent's nudge has not already covered.
 */
export function alignShifts(items, dpr) {
  const snap = (v) => Math.round(v * dpr) / dpr;
  const total = new Map(items.map((it) => [it.id, { x: snap(it.x) - it.x, y: snap(it.y) - it.y }]));
  const out = new Map();
  for (const it of items) {
    const mine = total.get(it.id), above = (it.parent !== null && total.get(it.parent)) || { x: 0, y: 0 };
    const own = { x: mine.x - above.x, y: mine.y - above.y };
    if (Math.abs(own.x) > EPS || Math.abs(own.y) > EPS) out.set(it.id, own);
  }
  return out;
}

// Pictures nudged along with the text: the frame and layer thumbnails.
const PICTURES = '.frame-tile canvas, .layer-thumb canvas';

// Classes that only recolour or outline: adding or dropping one moves nothing, so a
// playing timeline lighting up a frame each step does not settle the whole panel again.
const VISUAL = new Set(['active', 'selected', 'dragging', 'removing', 'pressed', 'alert-pulse', 'collab-on', 'collab-waiting', 'frame-tile--selected', 'layer-row--selected', 'hidden-indicator', 'kb-focused', 'help-nav-focused']);

/** Whether going from class list `before` to `after` can move anything: false when only the visual states above changed. */
export function classChangeMatters(before, after) {
  if (before === null || after === null) return true;
  const a = new Set(before.split(/\s+/).filter(Boolean)), b = new Set(after.split(/\s+/).filter(Boolean));
  for (const c of a) if (!b.has(c) && !VISUAL.has(c)) return true;
  for (const c of b) if (!a.has(c) && !VISUAL.has(c)) return true;
  return false;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CANVAS', 'SVG', 'NOSCRIPT']);
const shifted = new Set(); // the elements carrying a nudge now
const dirty = new Set(); // the containers to settle again on the next frame
let queued = false;
let observer = null;

// The element a nudge can go on: `translate` does nothing to an inline box, so text in a span moves with the block around it.
function transformable(el) {
  for (; el; el = el.parentElement) {
    const display = getComputedStyle(el).display;
    if (display !== 'inline' && display !== 'contents') return el;
  }
  return null;
}

// A change can move what follows it, so the unit to settle again is the whole
// container around it: the nearest ancestor with an id (a panel, the tool tag),
// or a top-level element such as a menu or modal; only failing those, the page.
function container(node) {
  for (let el = node.nodeType === 1 ? node : node.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el.id || el.parentElement === document.body) return el;
  }
  return document.body;
}

/** Measures every visible text run and icon under `root` and nudges each onto a whole device pixel. */
export function snapText(root = document.body) {
  if (observer) observer.disconnect(); // our own style writes are not changes to react to
  for (const el of shifted) {
    if (el.isConnected && !root.contains(el)) continue;
    el.style.removeProperty('--snap-x'); // a removed element is dropped from the set too
    el.style.removeProperty('--snap-y');
    shifted.delete(el);
  }

  // Everything is measured with the nudges under `root` off, in one pass of reads, then written in one pass.
  const spots = new Map(); // element -> its rect
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue.trim() || SKIP.has(node.parentElement?.tagName.toUpperCase())) continue;
    const el = transformable(node.parentElement);
    if (!el || spots.has(el)) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height) spots.set(el, rect);
  }
  for (const el of root.querySelectorAll(PICTURES)) {
    const rect = el.getBoundingClientRect();
    if (rect.width || rect.height) spots.set(el, rect);
  }

  const ids = new Map([...spots.keys()].map((el, i) => [el, i]));
  const items = [];
  for (const [el, rect] of spots) {
    let above = el.parentElement;
    while (above && above !== root.parentElement && !ids.has(above)) above = above.parentElement;
    items.push({ id: ids.get(el), parent: above && ids.has(above) ? ids.get(above) : null, x: rect.left, y: rect.top });
  }
  const byId = [...spots.keys()];
  for (const [id, shift] of alignShifts(items, window.devicePixelRatio || 1)) {
    const el = byId[id];
    el.style.setProperty('--snap-x', shift.x + 'px');
    el.style.setProperty('--snap-y', shift.y + 'px');
    shifted.add(el);
  }
  if (observer) observe();
}

function observe() {
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'hidden', 'style'] });
}

// One settle per frame, before it is painted, for every container that changed.
function settle() {
  queued = false;
  const roots = [...dirty].filter((a) => ![...dirty].some((b) => b !== a && b.contains(a)));
  dirty.clear();
  for (const root of roots) snapText(root);
}

function schedule(root) {
  dirty.add(root);
  if (queued) return;
  queued = true;
  requestAnimationFrame(settle);
}

/**
 * Keeps all text aligned from now on: after anything is added, removed, changed
 * or moved (a transition ends, a panel scrolls, the window resizes, a font loads).
 */
export function watchTextSnap() {
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.attributeName === 'class' && !classChangeMatters(r.oldValue, r.target.getAttribute('class'))) continue;
      schedule(container(r.target));
    }
  });
  observe();
  window.addEventListener('resize', () => schedule(document.body));
  for (const type of ['transitionend', 'animationend', 'scroll']) {
    document.addEventListener(type, (e) => schedule(e.target instanceof Node && e.target !== document ? container(e.target) : document.body), { capture: true, passive: true });
  }
  document.fonts?.ready.then(() => schedule(document.body));
  schedule(document.body);
}
