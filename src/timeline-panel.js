import { paintThumbnail } from './thumbnail.js';
import { compositeFrameAt } from './sprite-file.js';
import { BLOCK } from './grid.js';
import { button, hoverTip, startInlineEdit, attachDragReorder } from './ui.js';

const THUMB_H = BLOCK * 2; // frame tiles are 2 blocks tall

// Thumbnails already painted, per frame (a WeakMap, so a deleted frame's
// entry goes with it). `out`/`rev` identify the composite the canvas shows:
// `out` changes identity when the layer structure or size changes, `rev` on
// every edit to it. A rebuild reuses the canvas and repaints only when they moved.
const painted = new WeakMap(); // frame -> { canvasEl, out, rev }
const FPS_DRAG_PX = 6; // pixels of vertical drag per frame-per-second

// `frameSelectionRange` is `{lo, hi}` or null (frame-selection.js's
// getRange()). `getCachedThumbnail(frame)` resolves a compressed frame's
// last composite (frame-cache.js): a compressed frame's `layerPixels` is
// unreachable, so painting it must never fall through to compositeFrameAt.
export function renderTimelinePanel(container, file, playback, callbacks, frameSelectionRange, getCachedThumbnail) {
  container._thumbObserver?.disconnect();
  const scrollLeft = container.querySelector('.frame-strip')?.scrollLeft ?? 0; // a rebuild would otherwise snap the strip back to the start
  container.innerHTML = '';
  const selLo = frameSelectionRange ? frameSelectionRange.lo : -1;
  const selHi = frameSelectionRange ? frameSelectionRange.hi : -1;
  // A compressed frame can't change (only the active frame is ever
  // edited), so its cached composite is permanently fresh: never worth
  // recompositing, and compositeFrameAt would throw anyway (its pixels are
  // gone). Falls back to compositeFrameAt only for a frame that's raw.
  const compositeOf = (i) => {
    const frame = file.frames[i];
    return frame._compressed ? getCachedThumbnail(frame) : compositeFrameAt(file, i);
  };

  // A div, not an <input>: an input's text is not placed on whole device pixels and
  // renders soft, where ordinary text (and the inline rename fields) stays sharp.
  const fpsField = document.createElement('div');
  fpsField.className = 'fps-field';
  fpsField.textContent = playback.fps;
  hoverTip(fpsField, 'FPS - Drag or type to change.');
  const setFps = (fps) => { fpsField.textContent = fps; callbacks.onSetFps(fps); };
  // Dragging up or down on the number changes it, one step per few pixels; a click without
  // a drag edits it in place.
  fpsField.addEventListener('pointerdown', (e) => {
    if (fpsField.isContentEditable) return;
    const startY = e.clientY, startFps = Number(fpsField.textContent) || 1;
    let dragged = false;
    const move = (ev) => {
      const fps = Math.max(1, Math.min(60, startFps + Math.round((startY - ev.clientY) / FPS_DRAG_PX)));
      if (fps === Number(fpsField.textContent)) return;
      dragged = true;
      setFps(fps);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (dragged) return;
      startInlineEdit(fpsField, String(startFps), (v) => setFps(Math.max(1, Math.min(60, Math.round(Number(v)) || startFps))));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const onionBtn = button({
    glyph: '◈', icon: true, className: 'onion-toggle', active: playback.onionSkin, // diamond glyph, per the brand's rotated-square motif
    title: 'Onion skin (right-click: toggle full-composite vs active-layer-only ghost source)',
    onClick: () => callbacks.onToggleOnion(),
    onContextMenu: (e) => { e.preventDefault(); callbacks.onToggleOnionSource(); },
  });

  const strip = document.createElement('div');
  strip.className = 'frame-strip';

  // A long animation has hundreds of tiles, but only a screenful is ever
  // visible (the strip scrolls, and a hidden panel shows none). Compositing
  // and painting a thumbnail per frame on every edit is what would make
  // that slow, so each tile's thumbnail is painted only once it scrolls
  // into view. The canvas is pre-sized so tiles don't shift when painted.
  const tileWidth = Math.max(1, Math.round(THUMB_H * file.visibleWidth / file.visibleHeight));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const index = Number(entry.target.dataset.frame);
      const out = compositeOf(index);
      paintThumbnail(entry.target, file, out, THUMB_H);
      painted.set(file.frames[index], { canvasEl: entry.target, out, rev: out.rev });
    }
  });
  container._thumbObserver = observer;

  file.frames.forEach((frame, i) => {
    const gap = document.createElement('div');
    gap.className = 'frame-insert-gap';
    const insertBtn = button({ glyph: '+', className: 'frame-insert-btn', onClick: () => callbacks.onInsertFrame(i) });
    gap.append(insertBtn);
    strip.append(gap);

    const tile = document.createElement('div');
    tile.className = 'frame-tile'
      + (i === file.activeFrameIndex ? ' active' : '')
      + (i >= selLo && i <= selHi ? ' frame-tile--selected' : ''); // T+Shift multi-frame select

    let canvasEl;
    const known = painted.get(frame);
    if (known) {
      canvasEl = known.canvasEl;
      const out = compositeOf(i);
      if (known.out !== out || known.rev !== out.rev) {
        paintThumbnail(canvasEl, file, out, THUMB_H);
        known.out = out;
        known.rev = out.rev;
      }
    } else {
      canvasEl = document.createElement('canvas');
      canvasEl.width = tileWidth;
      canvasEl.height = THUMB_H;
      canvasEl.dataset.frame = i;
      observer.observe(canvasEl);
    }

    tile.append(canvasEl);
    tile.addEventListener('click', (e) => {
      if (e.shiftKey) { callbacks.onShiftSelect(i); return; }
      callbacks.onSelect(i);
    });
    attachDragReorder(tile, i, {
      getItems: () => Array.from(strip.querySelectorAll('.frame-tile')),
      axis: 'x',
      containerEl: container,
      onReorder: (from, to) => callbacks.onReorder(from, to),
      onRemove: (i) => callbacks.onDelete(i),
    });

    strip.append(tile);
  });

  const addBtn = button({ glyph: '+', icon: true, title: 'Add frame (+)', onClick: () => callbacks.onAddFrame() });

  // Onion skin and add-frame stack 1 block each, to the right of the FPS
  // field, filling the same 2-block panel height between them.
  const stack = document.createElement('div');
  stack.className = 'timeline-stack';
  stack.append(onionBtn, addBtn);

  container.append(fpsField, stack, strip);
  strip.scrollLeft = scrollLeft;
}
