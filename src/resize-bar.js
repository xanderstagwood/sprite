import { NEW_FILE_SIZES, clampCanvasSize } from './project.js';
import { sizeFields } from './size-fields.js';
import { button } from './ui.js';

/**
 * The resize control that takes over the tool tag's tool section:
 * "resize: W: [ ] px | H: [ ] px", with the preset sizes as a stack of
 * buttons above it, as wide as the largest of them. Returns `{ el, stack, open,
 * close, isOpen }`; `el` goes in the tool tag, `stack` anywhere in the page.
 * Keys in either field: Enter commits, Escape cancels, Tab swaps fields, Up
 * and Down walk the presets (each fills the fields; clicking one commits it).
 * `onCommit(w, h)` and `onCancel()` are the caller's; both fire after `close`.
 */
export function createResizeBar({ onCommit, onCancel }) {
  const el = document.createElement('div');
  el.className = 'tool-tag-label resize-bar';
  el.hidden = true;
  const stack = document.createElement('div');
  stack.className = 'resize-presets';
  stack.hidden = true;

  const fields = sizeFields();
  const word = (text) => { const s = document.createElement('span'); s.textContent = text; return s; };
  el.append(word('resize: W:'), fields.w, word('px | H:'), fields.h, word('px'));

  // Largest at the top, like the new canvas menu; `selected` indexes the shown order.
  const presets = [...NEW_FILE_SIZES].reverse();
  let selected = -1;
  const buttons = presets.map((preset, i) => {
    const b = button({ label: preset.label, fill: true, onClick: () => { close(); onCommit(preset.w, preset.h); } });
    b.addEventListener('mouseenter', () => choose(i));
    return b;
  });
  stack.append(...buttons);

  function choose(i) {
    selected = i;
    buttons.forEach((b, k) => b.classList.toggle('selected', k === i));
    if (i >= 0) fields.set(presets[i].w, presets[i].h);
  }

  function commit() {
    const w = clampCanvasSize(fields.w.value);
    const h = clampCanvasSize(fields.h.value || fields.w.value);
    close();
    onCommit(w, h);
  }

  function cancel() { close(); onCancel(); }

  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const other = e.target === fields.w ? fields.h : fields.w;
      other.focus({ preventScroll: true });
      other.select();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const from = selected < 0 ? (e.key === 'ArrowUp' ? presets.length : -1) : selected;
      choose(Math.max(0, Math.min(presets.length - 1, from + (e.key === 'ArrowUp' ? -1 : 1))));
    }
    e.stopPropagation(); // the fields own the keyboard while open
  }
  fields.w.addEventListener('keydown', onKey);
  fields.h.addEventListener('keydown', onKey);

  // Sits directly above the tool tag, its left edge in line with the section it replaces and as wide as its largest option.
  function placeStack() {
    const box = el.getBoundingClientRect(), tag = el.parentElement.getBoundingClientRect();
    stack.style.left = box.left + 'px';
    stack.style.bottom = window.innerHeight - tag.top + 'px';
  }
  window.addEventListener('resize', () => { if (!el.hidden) placeStack(); });

  function close() {
    el.hidden = stack.hidden = true;
  }

  return {
    el, stack,
    isOpen: () => !el.hidden,
    /** Shows the bar filled with the current size and focuses the width. */
    open(width, height) {
      fields.set(width, height);
      const match = presets.findIndex((p) => p.w === width && p.h === height);
      selected = match;
      buttons.forEach((b, k) => b.classList.toggle('selected', k === match));
      el.hidden = stack.hidden = false;
      // The tag slides to its new width over a moment; once it has, the stack is placed against it.
      placeStack();
      setTimeout(placeStack, 250);
      fields.w.focus({ preventScroll: true }); // the tag is still sliding open: a scroll to reveal the field would leave its content shifted
      fields.w.select();
    },
    close,
  };
}
