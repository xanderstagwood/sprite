import { PRESETS, DEFAULT_PRESET, MAX_CHIPS } from './palettes-presets.js';
import { openColorPicker } from './color-picker.js';
import { openCustomSlideOut } from './slide-out.js';
import { button, attachDragReorder, flashTip, showTip, pickFile } from './ui.js';
import { parsePalette, paletteNameFromFile } from './palette-parse.js';
import { extractPalette } from './quantize.js';
import { decodeImage, bitmapPixels, isImageFile } from './image-import.js';
import { loadLibrary, addPalette, removePalette, renamePalette, MAX_SAVED } from './palette-library.js';

const BUILTIN_NAMES = Object.values(PRESETS).map((p) => p.name);

// Slides up from the hamburger (palette docks to the bottom edge): one
// list: the built-in presets, then (below a hairline) the user's saved
// palettes, each with a hover-revealed ✕ like a layer row, then a
// "+ New Palette" to start a blank one. Uses
// openCustomSlideOut (not the plain openSlideOut button-list) only for the
// left-justified/accent-text button styling below, scoped via its own
// `className`: toggle-on-second-click, outside-click dismiss, and the
// slide/fade-in are all shared with every other slide-out popup.
function openPresetPanel(anchor, onLoad, onNewPalette, onDelete, onImport) {
  const result = openCustomSlideOut(anchor, (panel, close) => {
    Object.values(PRESETS).forEach((preset) => {
      panel.append(button({ label: preset.name, fill: true, onClick: () => { onLoad(preset); close(); } }));
    });
    const saved = loadLibrary();
    if (saved.length) {
      const rule = document.createElement('div');
      rule.className = 'palette-rule';
      panel.append(rule);
    }
    for (const entry of saved) {
      const row = document.createElement('div');
      row.className = 'palette-row reveal-on-hover';
      row.append(
        button({ label: entry.name, fill: true, onClick: () => { onLoad(entry); close(); } }),
        button({ glyph: '✕', icon: true, className: 'btn--reveal', title: 'Delete palette', onClick: () => { onDelete(entry.name); close(); } }),
      );
      panel.append(row);
    }
    panel.append(button({ label: 'Import', fill: true, onClick: () => { onImport(); close(); } }));
    panel.append(button({ label: 'New', fill: true, onClick: () => { onNewPalette(); close(); } }));
  }, { side: 'up', className: 'palette-preset-panel' });
  return result && result.el;
}

// Up to this many chips, the row stretches them to fill the bar. Beyond it
// the row switches to a fixed-size scrollable window instead: 16 full
// chips visible plus at least a quarter-chip peek on each edge, as a
// "there's more this way" affordance, scrolled with the wheel.
const INLINE_CHIPS = 32;
const PAGE_CHIPS = 16;
const PEEK_FRACTION = 0.25; // per side

// Palette belongs to the Project (§4, §7.2). `initial` seeds it from a
// loaded/created Project's own palette object; the returned `state` is that
// same live object (mutated in place) so main.js can persist it directly.
export function createPalette(container, initial, onChange, onSelectColor, getProjectName) {
  const preset = PRESETS[DEFAULT_PRESET];
  let state = initial && initial.chips && initial.chips.length ? initial : {
    name: preset.name,
    chips: [...preset.chips],
    primary: preset.chips[0],
  };
  nameLegacyPalette(state);
  let scrollPx = 0; // pixel offset into the chip track, only used above INLINE_CHIPS
  let chipWidthPx = 0; // 0 while every chip is inline (nothing scrolls)

  // True when the working palette differs from the saved/built-in entry it
  // came from: the only time switching away saves anything, which is what
  // keeps the library from filling up with untouched presets. An unnamed
  // palette (its entry was deleted, or a legacy custom one) never counts.
  function hasUnsavedEdits() {
    if (!state.name) return false;
    const source = loadLibrary().find((p) => p.name === state.name) || Object.values(PRESETS).find((p) => p.name === state.name);
    const same = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);
    return source ? !same(source.chips, state.chips) : !same(state.chips, ['#FFFFFF']);
  }

  // Every way of replacing the working palette (preset, saved entry, new,
  // import) goes through here, so the cap and the save-outgoing rule
  // can't diverge between them.
  function switchTo(next) {
    if (hasUnsavedEdits() && addPalette(getProjectName(), state.chips, BUILTIN_NAMES) === null) {
      flashTip(`Palette library is full (${MAX_SAVED}): your edits to this palette weren't saved`);
    }
    state.name = next.name;
    state.chips = next.chips.slice(0, MAX_CHIPS);
    state.primary = state.chips[0];
    render();
    onChange(state);
  }

  const loadPreset = (key) => switchTo(PRESETS[key]);
  const newPalette = () => switchTo({ name: 'New Palette', chips: ['#FFFFFF'] });
  const deleteSaved = (name) => {
    removePalette(name);
    if (state.name === name) { state.name = null; onChange(state); }
  };
  // A .gpl/.hex/.pal file, or an image to extract up to 32 colors from,
  // becomes a new library palette named after the file, and is switched to.
  // Nothing is destroyed, so no undo entry.
  async function importFile(file) {
    let chips;
    if (isImageFile(file)) {
      // Small sources are scanned exactly (pixel art round-trips); big
      // photos are downscaled during decode so the scan stays cheap.
      const bitmap = await decodeImage(file, { longEdge: 512, abovePixels: 1_000_000 });
      chips = extractPalette(bitmapPixels(bitmap).data);
      bitmap.close();
    } else {
      chips = parsePalette(new TextDecoder().decode(await file.arrayBuffer()));
    }
    if (!chips.length) { flashTip(`No colors found in ${file.name}`); return; }
    const name = paletteNameFromFile(file.name);
    switchTo({ name, chips });
    const saved = addPalette(name, chips, BUILTIN_NAMES);
    if (saved === null) flashTip(`Palette library is full (${MAX_SAVED}): imported palette wasn't saved`);
    else if (saved !== name) { state.name = saved; onChange(state); }
  }

  const pickPaletteFile = () => pickFile('.gpl,.hex,.pal,image/*', (file) => {
    importFile(file).catch((err) => { console.error('Palette import failed:', err); flashTip(err.message); });
  });

  const openMenu = (anchor) => openPresetPanel(anchor, switchTo, newPalette, deleteSaved, pickPaletteFile);

  // Names the palette after the built-in preset it matches, for projects
  // saved before palettes had names.
  function nameLegacyPalette(s) {
    if (s.name !== undefined) return;
    const match = Object.values(PRESETS).find((p) => p.chips.length === s.chips.length && p.chips.every((c, i) => c === s.chips[i]));
    s.name = match ? match.name : null;
  }

  // Shift+Enter: a small text field in a slide-out. Saving to the library
  // is the point of naming, so a rename writes the entry (or renames the
  // one this palette came from).
  function rename(anchor) {
    return openCustomSlideOut(anchor, (panel, close) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'picker-hex';
      input.value = state.name || '';
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
        if (e.key !== 'Enter') return;
        const wanted = input.value.trim();
        if (wanted) {
          const renamed = renamePalette(state.name, wanted, BUILTIN_NAMES) ?? addPalette(wanted, state.chips, BUILTIN_NAMES);
          if (renamed === null) flashTip(`Palette library is full (${MAX_SAVED})`);
          else { state.name = renamed; onChange(state); }
        }
        close();
      });
      panel.append(input);
      requestAnimationFrame(() => input.focus());
    }, { side: 'up' });
  }

  function render() {
    container.innerHTML = '';

    // At the start: the new-color button (dimmed once the palette is full, so the chips do not shift left by its slot).
    container.append(button({
      glyph: '+', icon: true, className: 'chip-add', title: 'Add color (+)', disabled: state.chips.length >= MAX_CHIPS,
      onClick: () => {
        state.chips.push('#FFFFFF');
        scrollPx = Infinity; // clamped to the new max in layoutChips: scrolls the new chip into view
        render();
        onChange(state);
      },
    }));

    const viewport = document.createElement('div');
    viewport.className = 'chip-viewport';
    const row = document.createElement('div');
    row.className = 'chip-row';
    viewport.append(row);

    state.chips.forEach((hex, i) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.style.setProperty('--chip-color', hex);

      // Right-click, or the hex code that reveals above the chip on hover,
      // opens the color picker.
      const hexLabel = document.createElement('button');
      hexLabel.className = 'chip-hex-label';
      hexLabel.textContent = hex;
      const editColor = () => openColorPicker(chip, state.chips[i], (newHex) => {
        if (state.chips[i] === state.primary) state.primary = newHex;
        state.chips[i] = newHex;
        chip.style.setProperty('--chip-color', newHex);
        hexLabel.textContent = newHex;
        onChange(state);
      });
      hexLabel.addEventListener('click', (e) => { e.stopPropagation(); editColor(); });
      chip.addEventListener('contextmenu', (e) => { e.preventDefault(); editColor(); });
      chip.append(hexLabel);

      // The tool tag names the colour and, for the first ten, the number key that picks it.
      const numberKey = i < 9 ? String(i + 1) : i === 9 ? '0' : null;
      chip.addEventListener('mouseenter', () => showTip(numberKey ? `${state.chips[i]} (${numberKey})` : state.chips[i]));
      chip.addEventListener('mouseleave', () => showTip(null));

      chip.addEventListener('mousedown', () => chip.classList.add('pressed'));
      chip.addEventListener('mouseup', () => chip.classList.remove('pressed'));
      chip.addEventListener('mouseleave', () => chip.classList.remove('pressed'));

      // Click = primary. Shift+click = select every pixel of this color on
      // the active layer.
      chip.addEventListener('click', (e) => {
        if (e.shiftKey) {
          onSelectColor(hex);
          return;
        }
        state.primary = hex;
        render();
        onChange(state);
      });

      attachDragReorder(chip, i, {
        getItems: () => Array.from(row.querySelectorAll('.chip')),
        axis: 'x',
        containerEl: viewport,
        onReorder: (from, to) => {
          const [moved] = state.chips.splice(from, 1);
          state.chips.splice(to, 0, moved);
          render();
          onChange(state);
        },
        // Drag a chip off the palette entirely to remove it: never down to
        // zero chips.
        onRemove: (removedIndex) => {
          if (state.chips.length <= 1) return;
          const [removed] = state.chips.splice(removedIndex, 1);
          if (state.primary === removed) state.primary = state.chips[0];
          render();
          onChange(state);
        },
      });

      row.append(chip);
    });

    container.append(viewport);

    // At the end: the palette menu.
    const hamburger = button({
      glyph: '☰', icon: true, className: 'palette-hamburger', title: 'Palettes (\\)',
      onClick: () => openMenu(hamburger),
    });
    container.append(hamburger);

    layoutChips(viewport, row);
  }

  // <=16 chips: stretch evenly to fill the bar (no scrolling needed at all).
  // >16 chips: fixed-width slots sized for 16 full + 2 half-peeks (17
  // chip-widths across the viewport), scrolled by wheel: never native
  // overflow/scrollbars, and chips never spill past the bar's own edge.
  function layoutChips(viewport, row) {
    const count = state.chips.length;
    if (count <= INLINE_CHIPS) {
      chipWidthPx = 0;
      row.style.width = '100%';
      row.querySelectorAll('.chip').forEach((chip) => { chip.style.flex = '1 1 0'; });
      row.style.transform = 'none';
      viewport.onwheel = null;
      return;
    }

    const viewportWidth = viewport.clientWidth;
    const chipWidth = viewportWidth / (PAGE_CHIPS + 2 * PEEK_FRACTION);
    chipWidthPx = chipWidth;
    const trackWidth = chipWidth * count;
    row.style.width = trackWidth + 'px';
    row.querySelectorAll('.chip').forEach((chip) => { chip.style.flex = `0 0 ${chipWidth}px`; });

    const maxScroll = Math.max(0, trackWidth - viewportWidth);
    scrollPx = Math.max(0, Math.min(scrollPx, maxScroll));
    row.style.transform = `translateX(${-scrollPx}px)`;

    viewport.onwheel = (e) => {
      e.preventDefault();
      scrollPx = Math.max(0, Math.min(maxScroll, scrollPx + (e.deltaY || e.deltaX)));
      row.style.transform = `translateX(${-scrollPx}px)`;
    };
  }

  render();

  function primaryIndex() {
    const i = state.chips.indexOf(state.primary);
    return i < 0 ? 0 : i;
  }

  return {
    getPrimary: () => state.primary,
    // Swaps in a different project's palette object wholesale (project
    // switching, §ProjectSwitching): replaces the live reference rather
    // than copying fields, so main.js's `project.palette` stays the same
    // object this module reads/mutates.
    setState(newState) { state = newState; nameLegacyPalette(state); render(); },
    // `i` counts from the first chip currently scrolled into view, so the
    // digit keys always address what's on screen.
    setPrimaryByIndex(i) {
      const chip = state.chips[i + (chipWidthPx ? Math.round(scrollPx / chipWidthPx) : 0)];
      if (chip) { state.primary = chip; render(); onChange(state); }
    },
    loadPreset,
    // Colors-panel keyboard scheme: cycle/add/remove the primary chip
    // without a mouse.
    cyclePrimary(dir) {
      const i = (primaryIndex() + dir + state.chips.length) % state.chips.length;
      state.primary = state.chips[i];
      render(); onChange(state);
    },
    addChip() {
      if (state.chips.length >= MAX_CHIPS) return;
      state.chips.push('#FFFFFF');
      state.primary = '#FFFFFF';
      render(); onChange(state);
    },
    removePrimary() {
      if (state.chips.length <= 1) return;
      const i = primaryIndex();
      state.chips.splice(i, 1);
      state.primary = state.chips[Math.max(0, i - 1)];
      render(); onChange(state);
    },
    // Eyedropper (§8, "I" hold): sets primary from a sampled color, adding
    // it as a new chip first if the palette doesn't have it.
    pickColor(hex) {
      const upper = hex.toUpperCase();
      if (!state.chips.some((c) => c.toUpperCase() === upper) && state.chips.length < MAX_CHIPS) {
        state.chips.push(upper);
      }
      state.primary = upper;
      render();
      onChange(state);
    },
    // Colors-panel keyboard scheme: `\` opens the same preset picker as the
    // hamburger button; `Return` opens the same hex/HSL editor as clicking a
    // chip's hex label: both just replay the existing click handlers rather
    // than duplicating them.
    openPresetMenu: openMenu,
    importFile,
    pickAndImport: pickPaletteFile,
    renamePalette() { return rename(container.querySelector('.palette-hamburger')); },
    editPrimaryChip() {
      const chipEl = container.querySelectorAll('.chip')[primaryIndex()];
      const hexLabel = chipEl && chipEl.querySelector('.chip-hex-label');
      if (hexLabel) hexLabel.click();
    },
  };
}
