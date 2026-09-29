import { snapLength } from './viewport.js';

// Anchor pips: nine squares on a canvas's corners, edge midpoints and
// centre, for choosing which point a trim or resize holds still. They fade in
// when shown, but only on a canvas zoomed large enough to keep them apart; the
// selected one is the accent colour, and the pip nearest the pointer grows.
// Every edge and size is snapped to whole device pixels so the squares stay crisp.

const GRID = [['tl', 't', 'tr'], ['l', 'c', 'r'], ['bl', 'b', 'br']];
const NAMES = {
  tl: 'top left', t: 'top', tr: 'top right', l: 'left', c: 'center', r: 'right', bl: 'bottom left', b: 'bottom', br: 'bottom right',
};

/** The words for an anchor key: "top left", "center", ... */
export const anchorName = (key) => NAMES[key];

/**
 * `onPick(key)` is called when a pip is clicked. Returns
 * `{ el, show(rect, selected), hide(), select(key), step(dx, dy) }`;
 * `rect` is the canvas's on-screen `{ left, top, width, height }`.
 */
const SPACING = 1.25; // neighbouring pips sit at least this many pip-widths apart, or none are shown
const GROW = 0.75; // a pip under the pointer is this much bigger than at rest
const REACH = 2; // in pip widths: how close the pointer has to be for a pip to start growing
export function createAnchorPips(onPick) {
  const el = document.createElement('div');
  el.className = 'anchor-pips';
  const pips = new Map();
  const centers = new Map(); // key -> { x, y } on screen
  let base = 0; // a pip's resting width, in CSS px
  let selected = 'c';
  for (const row of GRID) {
    for (const key of row) {
      const pip = document.createElement('button');
      pip.className = 'anchor-pip';
      pip.tabIndex = -1; // keys belong to the canvas and the tool tag, not to focus traversal
      pip.title = NAMES[key];
      pip.addEventListener('click', () => { select(key); onPick(key); });
      pips.set(key, pip);
      el.append(pip);
    }
  }

  // Sizes each pip from its distance to the pointer: full size at `REACH` pip widths or more, `GROW` bigger on top of it.
  function grow(e) {
    pips.forEach((pip, key) => {
      const c = centers.get(key);
      const near = Math.max(0, 1 - Math.hypot(e.clientX - c.x, e.clientY - c.y) / (base * REACH));
      if (!near) { pip.style.width = pip.style.height = pip.style.margin = ''; return; } // at rest the stylesheet's size applies
      const size = snapLength(base * (1 + GROW * near));
      pip.style.width = pip.style.height = size + 'px';
      pip.style.margin = `${-snapLength(size / 2)}px 0 0 ${-snapLength(size / 2)}px`;
    });
  }

  function select(key) {
    selected = key;
    pips.forEach((pip, k) => pip.classList.toggle('selected', k === key));
  }

  return {
    el,
    /** Places the pips and fades them in if the canvas is big enough for them; returns whether they are showing. */
    show(rect, key) {
      // The resting size, read with the size transition off so a pip still easing back from grown isn't measured.
      el.classList.add('measuring');
      pips.forEach((pip) => { pip.style.width = pip.style.height = pip.style.margin = ''; });
      base = pips.get('c').getBoundingClientRect().width;
      el.classList.remove('measuring');
      GRID.forEach((row, r) => row.forEach((k, c) => {
        const pip = pips.get(k);
        const x = snapLength(rect.left + (c / 2) * rect.width), y = snapLength(rect.top + (r / 2) * rect.height);
        centers.set(k, { x, y });
        pip.style.left = x + 'px';
        pip.style.top = y + 'px';
      }));
      select(key);
      const fits = Math.min(rect.width, rect.height) / 2 >= base * SPACING;
      el.classList.toggle('visible', fits);
      window.removeEventListener('pointermove', grow);
      if (fits) window.addEventListener('pointermove', grow);
      return fits;
    },
    hide() {
      el.classList.remove('visible');
      window.removeEventListener('pointermove', grow);
    },
    select,
    /** Moves the selection one pip left/right/up/down (each -1, 0 or 1), stopping at the edge; returns the new key. */
    step(dx, dy) {
      const row = GRID.findIndex((r) => r.includes(selected));
      const col = GRID[row].indexOf(selected);
      const next = GRID[Math.max(0, Math.min(2, row + dy))][Math.max(0, Math.min(2, col + dx))];
      select(next);
      return next;
    },
  };
}
