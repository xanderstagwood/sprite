// HSL-square + hue-slider + hex-field slide-out (design-doc §7.2,
// ui-design-system §1: 0px corners, flat, dark chrome). Opened on Alt+click
// of a chip. Per CONTEXT.md's "Slide-Out Context Bar" vocabulary: every
// secondary control surface slides out from the element that triggered it,
// not a floating dropdown: this slides up from the chip rather than
// appearing as a fixed popup.
import { openCustomSlideOut } from './slide-out.js';
import { normalizeHex } from './canvas-model.js';

const SIZE = 120;


function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = 60 * (((g - b) / d) % 6); break;
      case g: h = 60 * ((b - r) / d + 2); break;
      case b: h = 60 * ((r - g) / d + 4); break;
    }
  }
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to255 = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to255(r) + to255(g) + to255(b);
}

export function openColorPicker(anchorEl, initialHex, onChange) {
  let { h, s, l } = hexToHsl(initialHex);

  const square = document.createElement('canvas');
  square.width = SIZE;
  square.height = SIZE;
  square.className = 'picker-square';

  const hue = document.createElement('input');
  hue.type = 'range';
  hue.min = 0;
  hue.max = 360;
  hue.value = h;
  hue.className = 'picker-hue';

  const hexField = document.createElement('input');
  hexField.type = 'text';
  hexField.className = 'picker-hex';
  hexField.value = initialHex;

  // Slides out flush above the chip (the palette bar docks to the bottom
  // edge), centered horizontally on it with the chevron pointing down at it
  //: openCustomSlideOut's own positioning (anchor-relative on the primary
  // axis, viewport-clamped on the cross axis) doesn't center on the anchor,
  // so that's overridden right after appending.
  const result = openCustomSlideOut(anchorEl, (popup) => {
    popup.className += ' color-picker-popup';
    popup.append(square, hue, hexField);
  }, { side: 'up', onDismiss: () => window.removeEventListener('keydown', onKeyDown, true) });
  if (!result) return null; // toggled closed (second click on the same chip)
  const { el: popup, close } = result;

  const anchorRect = anchorEl.getBoundingClientRect();
  const popupWidth = popup.offsetWidth;
  const left = anchorRect.left + anchorRect.width / 2 - popupWidth / 2;
  popup.style.left = left + 'px';
  const chevron = popup.querySelector('.slide-out-chevron');
  if (chevron) chevron.style.left = popupWidth / 2 + 'px';

  const sctx = square.getContext('2d');

  function paintSquare() {
    for (let y = 0; y < SIZE; y++) {
      const lightness = 1 - y / SIZE;
      const grad = sctx.createLinearGradient(0, 0, SIZE, 0);
      grad.addColorStop(0, hslToHex(h, 0, lightness));
      grad.addColorStop(1, hslToHex(h, 1, lightness));
      sctx.fillStyle = grad;
      sctx.fillRect(0, y, SIZE, 1);
    }
  }

  let lastHex = initialHex;
  // `fromField`: the hex came from the field itself, so leave its text alone
  // (rewriting what someone is mid-typing would fight them).
  function commit(hex, fromField = false) {
    lastHex = hex;
    if (!fromField) hexField.value = hex;
    onChange(hex);
  }

  paintSquare();

  square.addEventListener('pointerdown', (e) => {
    square.setPointerCapture(e.pointerId);
    const drag = (ev) => {
      const r = square.getBoundingClientRect();
      s = Math.max(0, Math.min(1, (ev.clientX - r.left) / SIZE));
      l = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / SIZE));
      commit(hslToHex(h, s, l));
    };
    drag(e);
    const move = (ev) => drag(ev);
    const up = () => {
      square.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    square.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  hue.addEventListener('input', () => {
    h = Number(hue.value);
    paintSquare();
    commit(hslToHex(h, s, l));
  });

  // Sets the picker and the chip from a complete hex code.
  function applyHex(hex, fromField) {
    ({ h, s, l } = hexToHsl(hex));
    hue.value = h;
    paintSquare();
    commit(hex, fromField);
  }

  // Live: every keystroke or paste that completes a code recolors the chip.
  hexField.addEventListener('input', () => {
    const hex = normalizeHex(hexField.value);
    if (hex) applyHex(hex, true);
  });

  // On leaving the field, accept shorthand and tidy the text, or put back the last good color.
  hexField.addEventListener('change', () => {
    const hex = normalizeHex(hexField.value, true);
    if (hex) applyHex(hex, false);
    else hexField.value = lastHex;
  });

  // Colors-panel keyboard scheme: arrows nudge s/l, Alt+Left/Right nudge
  // hue, Enter/Escape close: reuses the same `s`/`l`/`h`/`commit`/
  // `paintSquare` state the pointer-drag path above already maintains.
  // openCustomSlideOut's outside-click dismiss doesn't know about this
  // extra listener, so `onDismiss` (fired only on that path, not on a
  // deliberate close) removes it too: otherwise it'd keep intercepting
  // arrow keys after the popup's already gone.
  const STEP = 0.03;
  function onKeyDown(e) {
    const inField = e.target === hexField;
    // In the hex field the arrows move the caret; they only nudge the color elsewhere.
    if (inField && e.key.startsWith('Arrow')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation(); // capture phase: keep main.js's canvas-cursor arrow handling from also firing
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        h = (h + (e.key === 'ArrowRight' ? 6 : -6) + 360) % 360;
        hue.value = h;
        paintSquare();
      } else {
        if (e.key === 'ArrowLeft') s = Math.max(0, s - STEP);
        if (e.key === 'ArrowRight') s = Math.min(1, s + STEP);
        if (e.key === 'ArrowUp') l = Math.min(1, l + STEP);
        if (e.key === 'ArrowDown') l = Math.max(0, l - STEP);
      }
      commit(hslToHex(h, s, l));
    } else if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (inField && e.key === 'Enter') {
        const hex = normalizeHex(hexField.value, true); // Enter closes before `change` would fire, so apply shorthand here
        if (hex) applyHex(hex, false);
      }
      window.removeEventListener('keydown', onKeyDown, true);
      close();
    }
  }
  window.addEventListener('keydown', onKeyDown, true);

  return popup;
}
