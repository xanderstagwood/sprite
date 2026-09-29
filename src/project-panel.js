import { renameFile, NEW_FILE_SIZES, MIN_CANVAS, MAX_CANVAS, clampCanvasSize, projectOrder, projectLoad, projectLoadBreakdown, formatBytes } from './project.js';
import { visibleOrder } from './ordering.js';
import { openSlideOut, openCustomSlideOut, closeSlideOut } from './slide-out.js';
import { overText } from './text-hit.js';
import { button, setIcon, hoverTip, makeReorderable, startInlineEdit } from './ui.js';
import { iconElement } from './icons.js';

// Project panel (ui-design-system §7, design-doc §13). `state` is the
// { project } holder in main.js; callbacks mutate it and call onChange to
// re-render + re-bind the active file. File/collection order and grouping
// are drag-and-drop only now: a file becomes a collection's member by
// being positioned directly beneath its header (§ ordering.js), the same
// way dragging it back out above the header (or past the collection's last
// member) ungroups it. No separate "move to collection" control.
export function renderProjectPanel(container, project, callbacks, focusedCollectionId, activeGroupId, fileSelection) {
  // The rebuild would otherwise snap the list back to the top: folding or unfolding a
  // collection leaves it where it was, and the rows open downward from the header.
  const scrollTop = container.querySelector('.file-list')?.scrollTop ?? 0;
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'project-header tile-bar reveal-on-hover';

  const nameEl = document.createElement('div');
  nameEl.className = 'project-name';
  nameEl.textContent = project.name;
  nameEl.addEventListener('click', () => startInlineEdit(nameEl, project.name, (v) => {
    if (!v) return;
    project.name = v;
    // A single-file project reads as one thing to the user: its one
    // .sprite file should track the project's own name.
    if (project.files.length === 1) renameFile(project, project.files[0], v);
    callbacks.onChange();
  }));

  // The project icon says where projects are stored: a button that picks the
  // working directory where the browser can, otherwise a label warning that
  // storage is temporary. The menu button looks the same as every other row's
  // menu button (canvas, collection), and like them is always showing.
  const workDirTip = callbacks.workDirName || 'Choose working directory';
  const projectIcon = callbacks.onPickWorkDir
    ? button({ glyph: 'project', icon: true, className: 'project-icon', title: workDirTip, onClick: callbacks.onPickWorkDir })
    : document.createElement('div');
  if (!callbacks.onPickWorkDir) {
    projectIcon.className = 'project-icon';
    setIcon(projectIcon, 'project');
    hoverTip(projectIcon, 'Temporary storage, recommend regular backups.');
    // Long enough to have read the tip counts as having seen the warning.
    let readTimer;
    projectIcon.addEventListener('mouseenter', () => { readTimer = setTimeout(callbacks.onReadBackupWarning, 1500); });
    projectIcon.addEventListener('mouseleave', () => clearTimeout(readTimer));
  }
  const openBtn = button({ glyph: 'menu', icon: true, className: 'project-menu', title: 'Select project (\\)', onClick: () => callbacks.onOpenProject(openBtn) });

  header.append(projectIcon, nameEl, openBtn);

  // Collab (§ collab plan, phase 1): one full-width button. A join code on
  // the clipboard means someone shared a link, so clicking joins their
  // session; nothing there means starting a new one, host role, link copied
  // back to the clipboard to share. The button reflects the live state: pulsing while a session waits for someone to join, solid
  // accent once two or more people are in it (see .collab-waiting in style.css).
  const collabState = callbacks.collabState || 'idle';
  const goLiveBtn = button({ label: 'Collab', fill: true, active: collabState === 'live', className: 'collab-btn' + (collabState === 'waiting' ? ' collab-waiting' : ''), onClick: callbacks.onGoLive });

  const fileList = document.createElement('div');
  fileList.className = 'file-list';

  // Anchored to the bottom of the list area, same as the layers panel's
  // stack: a short file list sits at the floor instead of floating at top.
  const fileStack = document.createElement('div');
  fileStack.className = 'file-stack';

  function buildFileRow(file, fileIndex, pos) {
    const row = document.createElement('div');
    const multiSelected = !!(fileSelection && fileSelection.has(fileIndex));
    const selected = !activeGroupId && (multiSelected || fileIndex === project.activeFileIndex);
    row.className = 'file-row tile reveal-on-hover' + (selected ? ' selected' : '');
    row.dataset.fileIndex = fileIndex; // § multi-select menu anchor lookup
    row.addEventListener('click', (e) => {
      // Shift/Alt-click build a multi-file selection instead of switching
      // the active file: see onShiftSelectFile/onAltSelectFile.
      if (e.shiftKey) { callbacks.onShiftSelectFile(fileIndex); return; }
      if (e.altKey) { callbacks.onAltSelectFile(fileIndex); return; }
      // No-op guard: onChange fully re-renders this panel (innerHTML=''),
      // which was destroying nameEl mid-gesture: re-selecting the file
      // that's already active isn't a real change, and rebuilding on
      // every click of a double-click was exactly what broke rename.
      if (fileIndex === project.activeFileIndex && !activeGroupId && !fileSelection) return;
      callbacks.onSelectFile(fileIndex);
    });

    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    setIcon(handle, '⋮');
    makeReorderable(handle, row, pos, {
      listEl: fileStack,
      boundsEl: container,
      onReorder: (from, to) => callbacks.onReorder(from, to),
      onRemove: () => callbacks.onRemoveFile(fileIndex),
    });

    const nameEl = document.createElement('div');
    nameEl.className = 'file-row-name';
    nameEl.textContent = file.name;
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineEdit(nameEl, file.name, (v) => { if (v) { renameFile(project, file, v); callbacks.onChange({ scrollToFileIndex: fileIndex }); } });
    });

    // Every per-file action folds into one menu instead of its own
    // always-reserved button slot.
    const menuBtn = button({
      glyph: '⋯', icon: true, className: 'row-menu', title: 'Canvas menu',
      onClick: (e) => {
        e.stopPropagation();
        const items = [
          { label: 'Resize', onClick: () => openSizePopup(menuBtn, (w, h, _preset, where) => callbacks.onResizeFile(file, w, h, where), { anchored: true, onTrim: () => callbacks.onTrimFile(file) }) },
        ];
        // The last file can't be removed (project.js: deleteFile is a no-op
        // then anyway): a project always has at least one file.
        if (project.files.length > 1) items.push({ label: 'Remove', keys: '_', onClick: () => callbacks.onRemoveFile(fileIndex) });
        items.push({ label: 'Export', keys: 'e', onClick: () => callbacks.onExportFile && callbacks.onExportFile(file, fileIndex) });
        openSlideOut(menuBtn, items);
      },
    });

    row.append(handle, nameEl, menuBtn);
    return row;
  }

  function buildCollectionHeader(collection, pos) {
    const row = document.createElement('div');
    const selected = collection.id === focusedCollectionId || collection.id === activeGroupId;
    row.className = 'collection-header tile reveal-on-hover' + (selected ? ' selected' : '');
    row.dataset.collectionId = collection.id;
    // A click selects the collection. A double click on empty space in the row folds
    // or unfolds it; on the name's text it renames instead (below).
    row.addEventListener('click', () => { if (!selected) callbacks.onSelectGroup(collection.id); });
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.drag-handle, .fold-arrow, button') || overText(nameEl, e)) return;
      collection.collapsed = !collection.collapsed;
      callbacks.onChange();
    });

    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    setIcon(handle, '⋮');
    makeReorderable(handle, row, pos, {
      listEl: fileStack,
      boundsEl: container,
      onReorder: (from, to) => callbacks.onReorder(from, to),
    });

    const arrow = document.createElement('span');
    arrow.className = 'fold-arrow';
    setIcon(arrow, collection.collapsed ? '▸' : '▾');
    arrow.addEventListener('click', (e) => {
      e.stopPropagation();
      collection.collapsed = !collection.collapsed;
      callbacks.onChange();
    });

    const nameEl = document.createElement('div');
    nameEl.className = 'file-row-name';
    nameEl.textContent = collection.name;
    nameEl.addEventListener('dblclick', (e) => {
      if (!overText(nameEl, e)) return; // empty space beside the name: the row folds
      e.stopPropagation();
      startInlineEdit(nameEl, collection.name, (v) => { if (v) { collection.name = v; callbacks.onChange({ scrollToCollectionId: collection.id }); } });
    });

    // Every per-collection action folds into one menu instead of its own
    // always-reserved button slot.
    const menuItems = [];
    // The last collection can't be deleted (project.js: deleteCollection is
    // a no-op then anyway): there's nowhere left for its files to go. A
    // project always starts with exactly one, so this is the common case,
    // not an edge case: the menu button itself disables rather than
    // opening onto nothing.
    menuItems.push({ label: 'Export', onClick: () => callbacks.onExportCollection(collection) });
    if (project.collections.length > 1) menuItems.push({ label: 'Remove', keys: '_', onClick: () => callbacks.onDeleteCollection(collection.id) });
    const menuBtn = button({
      glyph: '⋯', icon: true, className: 'row-menu', title: 'Collection menu',
      disabled: menuItems.length === 0,
      onClick: (e) => { e.stopPropagation(); openSlideOut(menuBtn, menuItems); },
    });

    row.append(handle, nameEl, arrow, menuBtn);
    return row;
  }

  // `pos` is the item's index into the *full* combined order (matching
  // what onReorder/moveProjectItem expect): collapsed members are simply
  // not rendered, not renumbered, so drag positions stay meaningful even
  // with hidden gaps.
  for (const entry of visibleOrder(projectOrder(project))) {
    if (entry.isHeader) {
      fileStack.append(buildCollectionHeader(entry.item, entry.pos));
    } else {
      const fileIndex = project.files.indexOf(entry.item);
      fileStack.append(buildFileRow(entry.item, fileIndex, entry.pos));
    }
  }

  const addRow = document.createElement('div');
  addRow.className = 'tile-bar project-add-row';
  // Left click: new file (opens the size picker). Double click: match
  // whatever's most recently been worked on nearby (§ onAddFileCurrent).
  // Right click: new collection, straight away: single-purpose gestures on
  // one button instead of a menu in between.
  const addFileBtn = button({
    glyph: '+', fill: true, className: 'panel-add-btn', title: 'New canvas (+)',
    onClick: () => openSizePopup(addFileBtn, (w, h, preset) => callbacks.onAddFile(w, h, preset), { onCollection: () => callbacks.onAddCollection(), onImport: () => callbacks.onImport(addFileBtn) }),
    onContextMenu: (e) => { e.preventDefault(); callbacks.onAddCollection(); },
  });
  addFileBtn.addEventListener('dblclick', () => { closeSlideOut(); callbacks.onAddFileCurrent(); });
  addRow.append(addFileBtn);
  fileList.append(fileStack);

  // One tile under the Collab button, a slot per collaborator (users icon in
  // their color, then name). The local name click-renames; on the host,
  // Ctrl-click on anyone else's icon or name kicks them.
  const people = callbacks.collabParticipants?.() || [];
  const presenceTile = people.length && document.createElement('div');
  if (presenceTile) {
    presenceTile.className = 'tile presence-tile';
    for (const p of people) {
      const slot = document.createElement('div');
      slot.className = 'presence-slot';
      slot.style.setProperty('--collab-color', p.color);
      const nameEl = document.createElement('span');
      nameEl.className = 'presence-name';
      nameEl.textContent = p.name;
      slot.append(iconElement('users'), nameEl);
      if (p.isSelf) nameEl.addEventListener('click', () => startInlineEdit(nameEl, p.name, (v) => { if (v) callbacks.onRenameSelf(v); }));
      else if (callbacks.onKick) {
        slot.addEventListener('click', (e) => { if (e.ctrlKey) callbacks.onKick(p.id); });
        // Where Ctrl-click means right-click (macOS) the browser sends contextmenu instead.
        slot.addEventListener('contextmenu', (e) => { if (e.ctrlKey) { e.preventDefault(); callbacks.onKick(p.id); } });
      }
      presenceTile.append(slot);
    }
  }
  // Collab and its presence tile are pinned at the top of the panel, above the scrolling file list.
  // `addRow` is a sibling of the scrollable `fileList`, not a child of its
  // stack, so it stays anchored above the panel footer instead of scrolling
  // away with a long file list.
  container.append(goLiveBtn, ...(presenceTile ? [presenceTile] : []), fileList, addRow, buildCapacityMeter(project, callbacks), header);
  fileList.scrollTop = scrollTop;
}

// Filled bar showing how close the Project is to what a low-end machine
// handles comfortably (project.js's projectLoad). Advisory: it never
// blocks anything; the bar filling *is* the warning.
function buildCapacityMeter(project, callbacks) {
  const load = projectLoad(project);
  const meter = document.createElement('div');
  meter.className = 'capacity-meter';
  const { pixelBytes, referenceBytes } = projectLoadBreakdown(project);
  hoverTip(meter, `Capacity ${Math.round(load * 100)}% · ${formatBytes(pixelBytes + referenceBytes)}`);
  const fill = document.createElement('div');
  fill.className = 'capacity-fill';
  fill.style.width = Math.min(100, load * 100) + '%';
  meter.append(fill);
  // At 100% the bar offers a way out instead of refusing anything.
  if (load >= 1 && project.collections.length) {
    meter.classList.add('full');
    meter.addEventListener('click', () => openSlideOut(meter, [{ label: 'Split by collection', onClick: callbacks.onSplitProject }], { side: 'right' }));
  }
  return meter;
}

// Slide-out button stack (§13.2's "non-modal popup": the rest of the UI
// stays interactive around it), one button per size preset: largest at
// the top down to smallest at the bottom (reverse of NEW_FILE_SIZES' own
// ascending order), so the picker's bottom-to-top reading is small-to-large
// working up from the anchor it slides out of. The bottom row is a custom
// W x H pair. `onPick(w, h, preset)`: `preset` is null for a custom size.
// `onCollection` and `onImport`, when given, add a "Collection" and a last "Import" row (new canvas only).
// `anchored` (resize only) adds an anchor picker under the custom size and passes the chosen anchor as `onPick`'s fourth argument.
// `onTrim` (resize only) adds a "Trim" row, between the presets and the custom size, that fits the canvas to its pixels.
export function openSizePopup(anchor, onPick, { onDismiss, onCollection, onImport, anchored = false, onTrim } = {}) {
  return openCustomSlideOut(anchor, (bar, close) => {
    let where = 'bl';
    for (const preset of [...NEW_FILE_SIZES].reverse()) {
      bar.append(button({ label: preset.label, fill: true, onClick: () => { onPick(preset.w, preset.h, preset, where); close(); } }));
    }
    if (onTrim) bar.append(button({ label: 'Trim', fill: true, title: 'Fit to pixels', onClick: () => { close(); onTrim(); } }));
    bar.append(customSizeRow((w, h) => { onPick(w, h, null, where); close(); }));
    if (anchored) bar.append(anchorPicker((key) => { where = key; }));
    if (onCollection) bar.append(button({ label: 'Collection', fill: true, onClick: () => { close(); onCollection(); } }));
    if (onImport) bar.append(button({ label: 'Import', fill: true, title: 'Spritesheet or .sprite', onClick: () => { close(); onImport(); } }));
  }, { className: 'size-popup', onDismiss });
}

// The anchors icon as a control: five squares on a 3x3 grid, one per corner plus
// the centre, of which the selected one (bottom left to start) is coloured. Says
// where a resize keeps the existing pixels. `onChange(key)` receives a
// `RESIZE_ANCHORS` key.
const ANCHOR_CELLS = [['tl', 'Top left'], null, ['tr', 'Top right'], null, ['c', 'Center'], null, ['bl', 'Bottom left'], null, ['br', 'Bottom right']];
function anchorPicker(onChange) {
  const grid = document.createElement('div');
  grid.className = 'anchor-grid';
  const cells = new Map();
  for (const cell of ANCHOR_CELLS) {
    if (!cell) { grid.append(document.createElement('div')); continue; }
    const [key, title] = cell;
    const el = button({ label: '', title, className: 'anchor-cell', selected: key === 'bl', onClick: () => {
      cells.forEach((other, k) => other.classList.toggle('selected', k === key));
      onChange(key);
    } });
    cells.set(key, el);
    grid.append(el);
  }
  return grid;
}

// Two number fields (Tab between them) and Enter to commit. H mirrors W
// until it's been edited by hand, so a square stays one keystroke.
function customSizeRow(onSubmit) {
  const row = document.createElement('div');
  row.className = 'size-row';
  const field = (title) => {
    const el = document.createElement('input');
    el.type = 'number';
    el.min = MIN_CANVAS;
    el.max = MAX_CANVAS;
    el.title = title;
    el.placeholder = 'px';
    return el;
  };
  const w = field('W'), h = field('H');
  let hEdited = false;
  // Typing past the ceiling snaps the text itself down to it.
  for (const el of [w, h]) el.addEventListener('input', () => { if (Number(el.value) > MAX_CANVAS) el.value = MAX_CANVAS; });
  // Below the minimum only snaps once the field is left: a keystroke check would turn the 1 of "16" into 3.
  for (const el of [w, h]) el.addEventListener('blur', () => { if (el.value && Number(el.value) < MIN_CANVAS) el.value = MIN_CANVAS; });
  h.addEventListener('input', () => { hEdited = true; });
  w.addEventListener('input', () => { if (!hEdited) h.value = w.value; });
  const submit = (e) => {
    if (e.key !== 'Enter') return;
    onSubmit(clampCanvasSize(w.value), clampCanvasSize(h.value || w.value));
  };
  w.addEventListener('keydown', submit);
  h.addEventListener('keydown', submit);
  row.append(w, h);
  return row;
}

