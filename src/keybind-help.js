// "?" toggles a keybind reference modal; Esc also closes it while open.
// Mirrors the focus-based control scheme (CONTEXT.md, todo/control.md):
// one group per panel, plus Global and Canvas.
import { keyIcon } from './icons.js';
import { hoverTip } from './ui.js';

const GROUPS = [
  ['Global', [
    ['?', 'Show/hide this modal'],
    ['Shift+Tab', 'Cycle focus through panels (Timeline > Layers > Colors > Projects)'],
    ['Tab', 'Pin/unpin every panel at once'],
    ['`', 'Pin/unpin the corner tags'],
    ['~', 'Hold + Left/Right to select a help tag button, Return or Space to launch'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
    ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copy / Cut / Paste'],
    ['Ctrl+A', 'Select all'],
    ['Ctrl+Space', 'Play/pause timeline'],
    ['e / E', 'Quick / full export of the focused panel'],
    ['Ctrl(left)+Arrow', 'Focus Timeline/Layers/Colors/Projects (Up/Right/Down/Left)'],
    ['Ctrl(left)', 'Return focus to the canvas'],
  ]],
  ['Canvas', [
    ['Arrows', 'Move the cursor (stepped by brush size)'],
    ['Ctrl+Space+Arrows', 'Pan the viewport'],
    ['Shift+Arrows', 'Rectangle-select, commits on release'],
    ['Shift+Alt+Arrows', 'Move the selection boundary'],
    ['Shift+Ctrl+Arrows', 'Move the selected content'],
    ['Shift+Space', 'Magic wand at cursor'],
    ['Shift+C', 'Select every pixel of the color under the cursor'],
    ['1-9, 0', 'Set prime color to palette chip 1-10'],
    ['Space', 'Place at cursor (hold Alt too: Paint, antialiased)'],
    ['Backspace/Delete', 'Erase under cursor, or clear the selection'],
    ['Z+Arrows', 'Erase while moving'],
    ['Alt+Arrows', 'Paint while moving'],
    ['Ctrl+Enter', 'Flood fill at cursor, or fill the whole selection'],
    ['Hold Q/W/A/S', 'Rectangle/triangle/circle/line shape (Shift constrains)'],
    ['[ / ]', 'Decrease / increase brush size'],
    ['{ / }', 'Halve / double brush size'],
    ['I', 'Invert color: of the selection, or just the pixel under the cursor'],
    ['Shift+I', 'Dropper: tap samples at cursor, hold + click samples anywhere'],
    ['F / Shift+F', 'Flip horizontal / vertical'],
    ['Hold R / Shift+R + Left/Right', 'Rotate 1° / 15° per step (accelerating hold)'],
    ['+', 'Zoom in'],
    ['-', 'Zoom to 100%'],
    ['=', 'Zoom to fit (selection if any)'],
    ['_', 'Zoom out'],
    ['G / Shift+G', 'Toggle grid / ruler'],
    ['D', 'Toggle dither (Paint and fill only)'],
    [':', 'Reference image: fit to canvas / full size'],
    ['M', 'Cycle mirror drawing: off, horizontal, vertical, both'],
    ['u', 'Cycle canvas background'],
    ['Shift+U', 'Cycle app background (dark/mid/light, bounces off mid)'],
  ]],
  ['Timeline', [
    ['Left/Right', 'Navigate frames'],
    ['Up/Down', 'Adjust framerate (accelerating hold)'],
    ['Shift+Left/Right', 'Select multiple frames'],
    ['Alt+Left/Right', 'Move the selected frame(s)'],
    ['+', 'New frame'],
    ['=', 'Duplicate frame'],
    ['Backspace/Delete', 'Remove frame(s)'],
    ['\\', 'Toggle onion skin'],
    ['Space', 'Play/pause'],
  ]],
  ['Layers', [
    ['Up/Down', 'Navigate layers/groups'],
    ['Right-Shift+Up/Down', 'Navigate groups only'],
    ['Shift+Up/Down', 'Select multiple layers/groups'],
    ['Alt+Up/Down', 'Move the selected layer(s)/group(s)'],
    ['Left/Right', 'Adjust layer/group opacity'],
    ['Shift+Left/Right', 'Adjust opacity by 10'],
    ['Backspace/Delete', 'Remove selected layer(s)/group(s)'],
    ['+', 'New layer'],
    ['=', 'New group'],
    ['Space', 'Expand/collapse focused group'],
    ['Enter', 'Rename focused layer/group'],
    ['\\', 'Toggle layer visibility'],
  ]],
  ['Colors', [
    ['Left/Right', 'Cycle prime color'],
    ['+', 'Add chip'],
    ['-', 'Remove current chip'],
    ['\\', 'Open the palette preset menu (Up/Down navigate, Enter commits)'],
    ['Enter', 'Edit the primary color'],
    ['Shift+Enter', 'Rename (and save) the palette'],
  ]],
  ['Projects', [
    ['Up/Down', 'Navigate canvases and collections'],
    ['Space', 'Fold/unfold the focused collection'],
    ['+', 'New canvas'],
    ['Alt++', 'New project'],
    ['_', 'Remove selected canvas or collection'],
    ['=', 'New collection'],
    ['Enter', 'Rename focused canvas/collection'],
    ['Shift+Enter', 'Rename project'],
    ['\\', 'Open project picker'],
  ]],
];

const TRANSITION_MS = 180;

// Key names drawn as their icon; everything else in a key label stays text.
// A name followed by `-` (Right-Shift) is a different key, so it stays text.
const KEY_ICONS = { Ctrl: 'ctrl', Alt: 'alt', Shift: 'shift', Tab: 'tab', Backspace: 'backspace', Enter: 'return', Space: 'space', Up: 'up', Down: 'down', Left: 'left', Right: 'right' };
const KEY_NAME = /\b(Ctrl|Alt|Shift|Tab|Backspace|Enter|Space|Up|Down|Left|Right)\b(?!-)/;
const keyLabel = (text) => text.split(new RegExp(KEY_NAME.source, 'g')).map((part, i) => (i % 2 ? keyIcon(KEY_ICONS[part]) : part));

export function createKeybindHelp() {
  let overlay = null;
  let closeTimer = null;

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'keybind-help-overlay';

    const panel = document.createElement('div');
    panel.className = 'keybind-help-panel panel';

    const title = document.createElement('div');
    title.className = 'keybind-help-title';
    title.textContent = 'CONTROLS';
    panel.append(title);

    for (const [group, rows] of GROUPS) {
      const h = document.createElement('div');
      h.className = 'keybind-help-group';
      h.textContent = group;
      panel.append(h);
      for (const [key, desc] of rows) {
        const row = document.createElement('div');
        row.className = 'keybind-help-row';
        const k = document.createElement('span');
        k.className = 'keybind-help-key';
        k.append(...keyLabel(key));
        hoverTip(k, key); // the icons are pictures: spell the combo out in the tool tag
        const d = document.createElement('span');
        d.textContent = desc;
        row.append(k, d);
        panel.append(row);
      }
    }

    overlay.append(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.append(overlay);

    // Fade the dark filter layer in, slide the panel up into place.
    requestAnimationFrame(() => overlay.classList.add('visible'));
  }

  function open() {
    clearTimeout(closeTimer);
    if (overlay) return;
    build();
  }

  function close() {
    if (!overlay) return;
    const el = overlay;
    overlay = null;
    el.classList.remove('visible'); // fade out, slide back down
    closeTimer = setTimeout(() => el.remove(), TRANSITION_MS);
  }

  return {
    toggle() { overlay ? close() : open(); },
    isOpen: () => !!overlay,
    close,
  };
}
