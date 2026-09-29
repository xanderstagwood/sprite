import { paintAt, linePixels, snapshotPixels, diffFromSnapshot } from './canvas-model.js';
import { computeViewport, screenToPixel } from './viewport.js';
import { setCanvasCursor } from './inverted-cursor.js';
import { paintOptions } from './paint-options.js';

// Mouse-only interaction (CONTEXT.md: keyboard-first control scheme rebuild
//: the keyboard side owns tool/brush-size selection now). Two distinct
// placement tools, same Alt convention the design doc already uses for
// fill (Ctrl=fill, Ctrl+Alt=antialiased fill): plain left click/drag is
// Place (a hard-edged square stamp: precision, predetermined size),
// Alt+left click/drag is Paint (a soft antialiased circular brush: fluid
// strokes). Held once a shape key or Shift is already down, the drag
// drives that tool instead (see `dragTools`). Right click/drag always
// erases (hard-edged, unaffected by Alt). Fill and pan stay keyboard-only.
export function createInputController(canvas, model, colors, onPlace, history, getBrushSize, getSelectionMask, dragTools = {}, getReadOnly) {
  let drawingButton = null; // 0 = left/place-or-paint, 2 = right/erase
  let lastPixel = null;
  let strokeSnapshot = null;
  let dragIntent = 'place'; // 'place' | 'erase' | 'shape' | 'select': decided once, on pointerdown
  let strokeAntialiased = false; // Place vs Paint for the active drag: frozen at pointerdown, like dragIntent
  let hoverSelecting = false; // live Shift state while hovering: the selection tool is armed
  let hoverAntialiased = false; // live Alt state while just hovering (not dragging): drives the cursor preview

  function currentMode() {
    if (drawingButton === 2) return 'erase';
    if (drawingButton === 0 ? dragIntent === 'select' : hoverSelecting) return 'selectRect';
    const held = dragTools.heldTool && dragTools.heldTool();
    if (held) return held;
    return (drawingButton === 0 ? strokeAntialiased : hoverAntialiased) ? 'paint' : 'place';
  }

  function updateCursor() {
    // The group grid is read-only: no tool applies there, and main.js sets its cursor.
    if (!(getReadOnly && getReadOnly())) setCanvasCursor(currentMode());
  }

  function pointerPixel(e) {
    const rect = canvas.getBoundingClientRect();
    const viewport = computeViewport(model, rect.width, rect.height);
    return screenToPixel(viewport, e.clientX - rect.left, e.clientY - rect.top);
  }

  function placeAt(x, y, antialiased) {
    paintAt(model, x, y, { ...paintOptions, size: getBrushSize(), antialiased, color: colors.primary(), mask: getSelectionMask() });
  }

  function eraseAt(x, y) {
    paintAt(model, x, y, { symmetry: paintOptions.symmetry, size: getBrushSize(), erase: true, mask: getSelectionMask() });
  }

  function onPointerDown(e) {
    // Read-only group grid (§ project panel group select): the canvas isn't
    // showing this model's own pixel space at all here, so painting would
    // both violate "not editable" and land at a meaningless coordinate.
    if (getReadOnly && getReadOnly()) return;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    const { x, y } = pointerPixel(e);
    drawingButton = e.button;
    strokeAntialiased = e.altKey;
    // Left button defers to whatever keyboard tool is currently held (a
    // shape key, or Shift for a selection rect) before falling back to
    // placing/painting: right button always erases, regardless of held
    // modifiers.
    if (drawingButton === 0 && dragTools.shapeActive && dragTools.shapeActive()) {
      dragIntent = 'shape';
      dragTools.shapeStart(x, y);
    } else if (drawingButton === 0 && dragTools.selectActive && dragTools.selectActive(e)) {
      dragIntent = 'select';
      dragTools.selectStart(x, y);
    } else {
      dragIntent = drawingButton === 2 ? 'erase' : 'place';
      strokeSnapshot = snapshotPixels(model);
      if (dragIntent === 'erase') eraseAt(x, y);
      else placeAt(x, y, strokeAntialiased);
    }
    lastPixel = { x, y };
    updateCursor();
    onPlace();
  }

  // Bresenham-fills between samples so a fast drag doesn't leave gaps.
  // The tool follows Alt and Shift, so anything carrying their state (a pointer
  // move, or a key press with the pointer still) re-reads them and redraws the cursor.
  function syncModifiers(e) {
    if (drawingButton === null) { hoverAntialiased = e.altKey; hoverSelecting = !!(dragTools.selectActive && dragTools.selectActive(e)); }
    updateCursor();
  }

  function onPointerMove(e) {
    const hoverNow = pointerPixel(e);
    syncModifiers(e);
    if (drawingButton === null) return;
    const { x, y } = hoverNow;
    if (lastPixel && (lastPixel.x !== x || lastPixel.y !== y)) {
      if (dragIntent === 'shape') {
        dragTools.shapeDrag(x, y);
      } else if (dragIntent === 'select') {
        dragTools.selectDrag(x, y);
      } else {
        for (const [px, py] of linePixels(lastPixel.x, lastPixel.y, x, y)) {
          if (dragIntent === 'erase') eraseAt(px, py);
          else placeAt(px, py, strokeAntialiased);
        }
      }
      lastPixel = { x, y };
      onPlace();
    }
  }

  function onPointerUp(e) {
    canvas.releasePointerCapture(e.pointerId);
    if (dragIntent === 'shape') {
      dragTools.shapeEnd();
    } else if (dragIntent === 'select') {
      dragTools.selectEnd();
    } else if (strokeSnapshot) {
      const { before, after } = diffFromSnapshot(model, strokeSnapshot);
      if (before.length) history.commit({ type: 'pixelEdit', before, after });
      strokeSnapshot = null;
    }
    dragIntent = 'place';
    drawingButton = null;
    lastPixel = null;
    updateCursor();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  updateCursor();
  return { getMode: currentMode, updateCursor, syncModifiers };
}
