import { cursorIcon } from './cursors.js';
import { overText } from './text-hit.js';

// A CSS `cursor` can't blend with what's under it, so the OS cursor is hidden
// everywhere (style.css, `.custom-cursor`) and this icon follows the pointer
// instead, drawn with `mix-blend-mode: difference` (white in, inverse of the
// backdrop out). Only a compositor transform changes per move, so the cost stays
// flat however big the canvas or project is.
//
// What it shows: the `--cursor` custom property of the element under the pointer
// (style.css), the tool mode over the canvas, or a forced cursor while a drag or
// held key owns the pointer.
const img = document.createElement('img');
img.className = 'inverted-cursor';
img.alt = '';
img.hidden = true;

let canvas = null;
let overArtwork = () => true; // whether a point on the canvas surface is on the drawing itself
let canvasName = 'draw'; // what the canvas shows: the current tool mode, or 'click' or 'arrow' over the group grid
let forced = null;
let hotspot = { x: 0, y: 0 };
let last = null; // the last pointer event, to redraw when only the icon changes
let lastTarget = null;
let targetName = 'arrow';
let parentName = 'arrow'; // what a 'text-on-text' element shows off its text

const readName = (el) => getComputedStyle(el).getPropertyValue('--cursor').trim() || 'arrow';

function render() {
  if (!last) return;
  // A drag on the canvas captures the pointer, so `e.target` stays the canvas
  // even after the pointer slides over a panel; hit-test then instead.
  const captured = canvas.hasPointerCapture(last.pointerId);
  const target = captured && last.target === canvas ? document.elementFromPoint(last.clientX, last.clientY) : last.target;
  if (target !== lastTarget) {
    lastTarget = target;
    targetName = target ? readName(target) : 'arrow';
    if (targetName === 'text-on-text') parentName = readName(target.parentElement);
  }
  // A name is only editable where its text is: elsewhere in its box it acts like the row around it.
  const name = targetName === 'text-on-text' ? (overText(target, last) ? 'text' : parentName) : targetName;
  // Tool cursors belong to the drawing: the empty space around it is plain app background, unless a drag started on the canvas.
  const onTool = target === canvas && (captured || overArtwork(last));
  const icon = cursorIcon(forced || (onTool ? canvasName : name));
  if (img.src !== icon.src) img.src = icon.src;
  hotspot = icon.hotspot;
  // Whole device pixels, or the art resamples.
  const dpr = window.devicePixelRatio || 1;
  img.style.transform = `translate(${Math.round((last.clientX - hotspot.x) * dpr) / dpr}px, ${Math.round((last.clientY - hotspot.y) * dpr) / dpr}px)`;
  img.hidden = false;
}

/** Starts showing the cursor everywhere; `drawingCanvas` is the surface whose cursor is set by tool, and `isOverArtwork(event)` says whether a point on it is on the drawing. */
export function installCursor(drawingCanvas, isOverArtwork) {
  canvas = drawingCanvas;
  overArtwork = isOverArtwork;
  document.body.append(img);
  document.documentElement.classList.add('custom-cursor');
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    last = e;
    render();
  });
  // A click can change what the element under a still pointer is (a rename field
  // becomes editable), so its cursor is read again.
  const invalidate = () => { lastTarget = null; };
  document.addEventListener('pointerdown', invalidate);
  document.addEventListener('pointerup', invalidate);
  document.documentElement.addEventListener('pointerleave', () => { img.hidden = true; });
}

/** The cursor over the canvas: a tool mode name, or a plain cursor name over the group grid. */
export function setCanvasCursor(name) {
  canvasName = name;
  render();
}

/** Shows `name` wherever the pointer is until called with null: for a drag or held key that owns the pointer. */
export function forceCursor(name) {
  forced = name;
  render();
}
