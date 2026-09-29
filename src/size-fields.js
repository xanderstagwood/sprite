import { MIN_CANVAS, MAX_CANVAS } from './project.js';

/**
 * A width and a height number field pair. The height mirrors the width until
 * it has been edited by hand, so a square is one number; typing past the
 * ceiling snaps the text down to it, and a value under the minimum snaps up
 * when its field is left (a keystroke check would turn the 1 of "16" into 3).
 * Layout and key handling are the caller's.
 */
export function sizeFields() {
  const field = (title) => {
    const el = document.createElement('input');
    el.type = 'number';
    el.min = MIN_CANVAS;
    el.max = MAX_CANVAS;
    el.title = title;
    el.placeholder = 'px';
    el.addEventListener('input', () => { if (Number(el.value) > MAX_CANVAS) el.value = MAX_CANVAS; });
    el.addEventListener('blur', () => { if (el.value && Number(el.value) < MIN_CANVAS) el.value = MIN_CANVAS; });
    return el;
  };
  const w = field('W'), h = field('H');
  let hEdited = false;
  h.addEventListener('input', () => { hEdited = true; });
  w.addEventListener('input', () => { if (!hEdited) h.value = w.value; });
  return {
    w, h,
    /** Fills both fields (from a preset or the current size); the height follows the width again until it is next typed in. */
    set(width, height) { w.value = width; h.value = height; hEdited = false; },
  };
}
