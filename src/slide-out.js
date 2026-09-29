// Shared "Slide-Out Context Bar" mechanism (per CONTEXT.md's vocabulary):
// every secondary/contextual control surface slides out flush against the
// element that triggered it, with a chevron pointing back at that element,
// as a stack of buttons: not a floating text dropdown with dead space
// around it. One implementation, reused by every context interaction.
import { button } from './ui.js';

// Keeps `bar` fully inside the viewport along its cross axis (vertical for
// a 'left'/'right' bar, horizontal for 'up'/'down') by sliding its start
// point back from the anchor's own position when it would otherwise run
// off-screen: a project-picker menu opened from a button near the bottom
// of a tall list would otherwise render mostly below the viewport with no
// way to reach its lower items. `chevron`'s position is then computed from
// wherever the bar actually landed, not from the anchor directly, so it
// still points at the true anchor even when the bar had to slide.
//
// CSS anchor positioning (`position-anchor`/`position-try`) or the
// Popover API would do this natively, but both are Chromium-only today:
// this needs to work in every browser the app runs in, so it's plain
// measure-and-clamp instead.
//
// No margin: every docked panel/edge in this app sits flush at 0, and a
// clamped bar has to match that: an arbitrary few-px gap here read as the
// menu floating loose instead of belonging to the grid.
// The bar runs from `low` (a docked panel's edge, or 0) to `viewportSize` (the
// far limit): it is kept inside them, and a bar within a few device pixels of
// either edge is pulled flush to it, since a sliver of gap reads as a mistake.
// The chevron is placed from the bar's padding edge, so the bar's own border is
// taken off to keep it centred on the anchor.
function clampCross(bar, chevron, axis, anchorStart, anchorSize, barSize, viewportSize, low = 0) {
  const near = 3 / (window.devicePixelRatio || 1);
  let start = Math.max(anchorStart, low);
  if (start + barSize > viewportSize - near) start = Math.max(low, viewportSize - barSize);
  else if (start - low < near) start = low;
  start = snapPx(start);
  bar.style[axis] = start + 'px';
  const border = axis === 'left' ? bar.clientLeft : bar.clientTop;
  chevron.style[axis] = snapPx(anchorStart + anchorSize / 2 - start - border) + 'px';
}

// Whole device pixels: a menu (or the corner tags it shoves) that comes to rest
// between two pixels is resampled and blurs. Only for positions with no edge to
// match: the side a menu touches its anchor or panel on stays exactly on that
// edge, or rounding it would leave a gap.
export function snapPx(px) {
  const dpr = window.devicePixelRatio || 1;
  return Math.round(px * dpr) / dpr;
}

// Where a menu opening up or down has to start on the left: the edge of an open
// panel on that side (the project panel is 0 wide, and so at 0, while closed).
function leftLimit() {
  const panel = document.querySelector('.panel-overlay-left');
  return panel ? panel.getBoundingClientRect().right : 0;
}

// Where a menu opening up or down has to stop on the right: the viewport's edge, or the
// edge of an open panel on that side, so it sits flush against it instead of under it.
function rightLimit() {
  const panel = document.querySelector('.panel-overlay-right');
  return panel ? Math.min(window.innerWidth, panel.getBoundingClientRect().left) : window.innerWidth;
}

// Positions `bar` on the given side, adds a chevron pointing at the anchor,
// and returns the transform to animate in from. For 'left'/'right' (a row
// menu inside a docked side panel: Project, Layers), the bar itself snaps
// to that panel's own outer edge rather than the individual row's edge, so
// it reads as "the panel's submenu" regardless of which row down a
// scrolled list opened it. 'up'/'down' (footer add-menus, size pickers)
// stay anchor-relative on their primary axis: those triggers already sit
// flush at their panel's own edge, so there's no separate "outer edge" to
// snap to. Every side is viewport-clamped on its cross axis (see
// clampCross above); `bar` must already be in the document (and, for
// 'right'/'left', already snapped to its final width) so its size is
// measurable.
// Exported so other slide-out surfaces (color picker, palette presets,
// export bar) that aren't a simple button list can still get the same
// flush-position + chevron treatment.
export function positionSlideOut(bar, anchor, side) {
  const rect = anchor.getBoundingClientRect();
  const panelRect = (anchor.closest('.panel-overlay') || anchor).getBoundingClientRect();
  bar.dataset.side = side;

  const chevron = document.createElement('div');
  chevron.className = 'slide-out-chevron';
  bar.append(chevron);

  let fromTransform;
  if (side === 'right') {
    bar.style.left = panelRect.right + 'px';
    clampCross(bar, chevron, 'top', rect.top, rect.height, bar.getBoundingClientRect().height, window.innerHeight);
    fromTransform = 'translateX(-12px)';
  } else if (side === 'left') {
    // From the panel's edge and the bar's own width, not from the window's right edge: the window
    // width in device pixels is usually fractional, which put the bar between two pixels and blurred it.
    bar.style.left = snapPx(panelRect.left - bar.getBoundingClientRect().width) + 'px';
    clampCross(bar, chevron, 'top', rect.top, rect.height, bar.getBoundingClientRect().height, window.innerHeight);
    fromTransform = 'translateX(12px)';
  } else if (side === 'up') {
    bar.style.top = snapPx(rect.top - bar.getBoundingClientRect().height) + 'px'; // from the anchor, not the window bottom: see 'left'
    clampCross(bar, chevron, 'left', rect.left, rect.width, bar.getBoundingClientRect().width, rightLimit(), leftLimit());
    fromTransform = 'translateY(12px)';
  } else {
    bar.style.top = rect.bottom + 'px';
    clampCross(bar, chevron, 'left', rect.left, rect.width, bar.getBoundingClientRect().width, rightLimit(), leftLimit());
    fromTransform = 'translateY(-12px)';
  }
  return fromTransform;
}

// Pins `bar`'s width to its widest item: text plus the same padding on the
// left and the right (`.slide-out-bar .btn`), rounded up to a whole device
// pixel. Every button in the list is `fill` (100% of the bar), so they all come
// out the width of the longest label, left-aligned, with no spare room on the
// right. Must run after `bar` (and its buttons) are actually in the document:
// a detached element has no layout size to measure.
function pinToContentWidth(bar) {
  const dpr = window.devicePixelRatio || 1;
  bar.style.width = Math.round(bar.getBoundingClientRect().width * dpr) / dpr + 'px'; // round, not ceil: a float error of 0.000001 would add a whole pixel
}

// Whichever row owns a currently-open slide-out gets the same red
// `.active` highlight a selected row already uses: the whole file,
// collection, layer or group row, not just its small "⋯" menu
// button, so it reads as "this is what the menu is for" at a glance.
// Tracked here (not just inside one openSlideOut() call's own closure) so
// the force-close below, when a second menu opens before the first was
// dismissed normally, still clears the first row's highlight too.
let activeAnchor = null;
// The reveal panel (panel-reveal.js) a currently-open menu belongs to, so
// its hide-on-mouseleave grace timer knows to hold off: a menu is a
// separate <body>-level node, floating outside the panel's own bounds, so
// the panel can't otherwise tell the difference between "the mouse left
// for good" and "the mouse is just over the menu I opened."
let activeOwnerPanel = null;
// Only a row lights up. A standalone button (the palettes menu, the add buttons,
// the project header's menu) keeps its normal look while its menu is open.
function anchorRow(anchor) {
  return anchor.closest('.tile');
}
function clearActiveSlideOut() {
  if (activeAnchor) activeAnchor.classList.remove('active');
  activeAnchor = null;
  if (activeOwnerPanel) activeOwnerPanel.dispatchEvent(new CustomEvent('slideout-close'));
  activeOwnerPanel = null;
  announceBounds(null);
}

// Lets anything else that lives in the same screen space (the tool tag) get
// out of an open menu's way without slide-out.js knowing what it is. Layout
// offsets, not getBoundingClientRect, so the slide-in transform doesn't skew
// the box being announced.
function announceBounds(bar) {
  const detail = bar && { left: bar.offsetLeft, top: bar.offsetTop, right: bar.offsetLeft + bar.offsetWidth, bottom: bar.offsetTop + bar.offsetHeight };
  document.dispatchEvent(new CustomEvent('slideout-bounds', { detail }));
}

// Dismisses whatever slide-out is currently open, if any: e.g.
// double-clicking a trigger button that also opens one on a single click
// (§ project-panel.js's New File button) needs to close it back down again
// rather than leave it open over the double-click's own result.
// Which trigger element the currently open bar belongs to, if any: lets a
// second click on that same trigger just close its own menu (a plain
// toggle) instead of flickering it closed and immediately back open.
let openAnchorEl = null;

export function closeSlideOut() {
  document.querySelectorAll('.slide-out-bar').forEach((el) => el.remove());
  clearActiveSlideOut();
  openAnchorEl = null;
}

// Shared tail every slide-out popup needs once its own content is already
// built and appended to `bar`: the focused-row highlight, the panel-reveal
// grace-timer handshake, positioning + slide/fade-in, and outside-click
// dismiss. `openSlideOut` (plain button list, below) and `openCustomSlideOut`
// (arbitrary content: color picker, palette preset menu) both build `bar`
// their own way, then hand it here. `onDismiss` fires only on an outside
// click, not on a deliberate close: for menus representing a
// multi-selection (file/layer § main.js), where clicking away without
// choosing anything should also collapse that selection back down.
function finishOpen(bar, anchor, side, { onDismiss, snapWidth } = {}) {
  openAnchorEl = anchor;
  activeAnchor = anchorRow(anchor);
  activeAnchor?.classList.add('active');
  activeOwnerPanel = anchor.closest('.panel-overlay');
  activeOwnerPanel?.dispatchEvent(new CustomEvent('slideout-open'));

  // In the document (off-screen/invisible via the position+opacity set
  // right after) before measuring: pinToContentWidth and positionSlideOut
  // both need real layout geometry, which a detached element doesn't have.
  document.body.append(bar);
  if (snapWidth) pinToContentWidth(bar);
  const fromTransform = positionSlideOut(bar, anchor, side);
  announceBounds(bar);
  bar.style.transform = fromTransform;
  bar.style.opacity = '0';
  requestAnimationFrame(() => {
    bar.style.transform = 'translate(0, 0)';
    bar.style.opacity = '1';
  });

  function close() {
    bar.remove();
    clearActiveSlideOut();
    openAnchorEl = null;
    cleanup();
  }
  function onOutside(e) {
    if (!bar.contains(e.target) && e.target !== anchor) { onDismiss?.(); close(); }
  }
  function cleanup() {
    window.removeEventListener('pointerdown', onOutside);
  }
  setTimeout(() => window.addEventListener('pointerdown', onOutside), 0);

  return close;
}

// Menu items sit in a fixed order, nearest the button that opened the menu
// first: Open, New, Import, Export, then everything else in the order it was
// given, and Remove farthest away. Array#sort is stable, so the rest keep their
// order. A menu opened from the lower half of the screen (or upward) hangs above
// its button, so it is listed in reverse to keep the nearest item closest.
const NEAREST_FIRST = ['Open', 'New', 'Import', 'Export'];
const distanceRank = ({ label }) => {
  const i = NEAREST_FIRST.indexOf(label);
  return i >= 0 ? i : /^Remove/.test(label) ? NEAREST_FIRST.length + 1 : NEAREST_FIRST.length;
};

export function openSlideOut(anchor, buttons, { side = 'right', onDismiss } = {}) {
  if (openAnchorEl === anchor) { closeSlideOut(); return null; }
  closeSlideOut();

  const bar = document.createElement('div');
  bar.className = 'slide-out-bar panel';

  let close;
  const items = [...buttons].sort((a, b) => distanceRank(a) - distanceRank(b));
  if (side === 'up' || anchor.getBoundingClientRect().top > window.innerHeight / 2) items.reverse();
  for (const { label, onClick, accent, keys, className } of items) {
    // Close first: an item that opens a follow-up menu from the same anchor
    // (Columns) would otherwise hit the anchor-toggle above and close itself.
    const btn = button({ label, title: keys, fill: true, selected: accent, className, onClick: () => { close(); onClick(); } });
    bar.append(btn);
  }

  close = finishOpen(bar, anchor, side, { onDismiss, snapWidth: true });
  return bar;
}

// Same toggle/highlight/position/animate/dismiss plumbing as openSlideOut,
// but for a popup with arbitrary content instead of a plain button list
// (the color picker's square+slider+hex field, the palette's
// left-justified/accent-styled preset list): callers that need their own
// markup and their own button styling, not the generic fill-button stack.
// `populate(bar, close)` builds and appends whatever content it wants;
// `close` is safe to call immediately (e.g. from a button's own onClick)
// even though the real close function isn't assigned until after
// `populate` returns: it's a thunk that forwards to whatever `close`
// resolves to by the time anything actually calls it.
export function openCustomSlideOut(anchor, populate, { side = 'right', className = '', onDismiss } = {}) {
  if (openAnchorEl === anchor) { closeSlideOut(); return null; }
  closeSlideOut();

  const bar = document.createElement('div');
  bar.className = ['slide-out-bar', 'panel', className].filter(Boolean).join(' ');

  let close;
  populate(bar, (...args) => close(...args));

  close = finishOpen(bar, anchor, side, { onDismiss });
  return { el: bar, close };
}
