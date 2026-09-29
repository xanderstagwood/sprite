import { renameFile, NEW_FILE_SIZES, clampCanvasSize, projectOrder, projectLoad, projectLoadBreakdown, formatBytes } from './project.js';
import { visibleOrder } from './ordering.js';
import { openSlideOut, openCustomSlideOut, closeSlideOut } from './slide-out.js';
import { overText } from './text-hit.js';
import { button, setIcon, hoverTip, makeReorderable, startInlineEdit } from './ui.js';
import { iconElement } from './icons.js';
import { sizeFields } from './size-fields.js';

// Collab: the whole interface is one full-width button. Idle it says "Collab";
// once a session is up that text fades out and three user icons (host, then the
// two guest slots) fade in, evenly spaced, each with its person's name beside
// it, cut to fit with "...". Clicking starts a session, or joins one if a link
// is on the clipboard, or leaves the one you are in. A slot lights in its
// person's colour when filled and hover names them; on the host, Ctrl-click on
// a guest's icon kicks them. The button pulses while a session waits for
// someone to join and goes solid accent once two or more people are in it (see
// .collab-waiting in style.css).
// The button outlives the panel's redraws so that switching on or off can fade:
// a fresh element would just appear in its final state.
let collabBtn = null;
function collabButton(callbacks) {
  const state = callbacks.collabState || 'idle';
  const people = callbacks.collabParticipants?.() || [];
  if (!collabBtn) {
    collabBtn = button({
      fill: true, className: 'collab-btn',
      onClick: (e) => {
        const slot = e.target.closest('.collab-slot');
        const cb = collabBtn.callbacks;
        if (e.ctrlKey) { if (slot?.dataset.id && cb.onKick) cb.onKick(slot.dataset.id); return; } // a Ctrl-click never leaves the session
        cb.onGoLive();
      },
    });
    const label = document.createElement('span');
    label.className = 'collab-label';
    label.textContent = 'Collab';
    const slots = document.createElement('div');
    slots.className = 'collab-slots';
    collabBtn.append(label, slots);
    hoverTip(collabBtn, 'Collab');
    // Where Ctrl-click means right-click (macOS) the browser sends contextmenu instead.
    collabBtn.addEventListener('contextmenu', (e) => {
      const slot = e.target.closest('.collab-slot');
      const cb = collabBtn.callbacks;
      if (e.ctrlKey && slot?.dataset.id && cb.onKick) { e.preventDefault(); cb.onKick(slot.dataset.id); }
    });
  }
  const btn = collabBtn;
  btn.callbacks = callbacks;
  btn.classList.toggle('active', state === 'live');
  btn.classList.toggle('collab-waiting', state === 'waiting');
  const names = [];
  const slots = [(p) => p.role === 'host', (p) => p.slot === 1, (p) => p.slot === 2].map((want) => {
    const p = people.find(want);
    const slot = document.createElement('span');
    slot.className = 'collab-slot' + (p ? ' present' : '');
    slot.append(iconElement('users'));
    if (p) {
      slot.dataset.id = p.isSelf ? '' : p.id; // yourself is never a kick target
      slot.style.setProperty('--collab-color', p.color);
      hoverTip(slot, p.isSelf ? `${p.name} (you)` : p.name);
      const name = document.createElement('span');
      name.className = 'collab-name';
      slot.append(name);
      names.push([name, p.name]);
    }
    return slot;
  });
  btn.querySelector('.collab-slots').replaceChildren(...slots);
  return {
    btn,
    // Once the button is back in the page: cut each name to its room, then move to the icons or the word. The
    // reflow in between commits the state it was last drawn in, so the change is a transition.
    reveal() {
      for (const [el, text] of names) {
        el.textContent = text;
        for (let n = text.length; n > 1 && el.scrollWidth > el.clientWidth; n--) el.textContent = text.slice(0, n - 1) + '...';
      }
      void btn.offsetWidth;
      btn.classList.toggle('collab-on', state !== 'idle');
    },
  };
}

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

  const collab = collabButton(callbacks);

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
    row.className = 'file-row tile reveal-on-hover' + (file.groupId != null ? ' file-row--nested' : '') + (selected ? ' selected' : '');
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

    makeReorderable(row, pos, {
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

    row.append(nameEl);
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
      if (e.target.closest('.fold-arrow, button') || overText(nameEl, e)) return;
      collection.collapsed = !collection.collapsed;
      callbacks.onChange();
    });

    makeReorderable(row, pos, {
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

    row.append(nameEl, arrow);
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

  // The Collab button is pinned at the top of the panel, above the scrolling file list.
  // `addRow` is a sibling of the scrollable `fileList`, not a child of its
  // stack, so it stays anchored above the panel footer instead of scrolling
  // away with a long file list.
  container.append(fileList, addRow, collab.btn, buildCapacityMeter(project, callbacks), header);
  collab.reveal();
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
// `onCollection` and `onImport`, when given, add a "Collection" and a last "Import" row.
export function openSizePopup(anchor, onPick, { onDismiss, onCollection, onImport } = {}) {
  return openCustomSlideOut(anchor, (bar, close) => {
    for (const preset of [...NEW_FILE_SIZES].reverse()) {
      bar.append(button({ label: preset.label, fill: true, onClick: () => { onPick(preset.w, preset.h, preset); close(); } }));
    }
    bar.append(customSizeRow((w, h) => { onPick(w, h, null); close(); }));
    if (onCollection) bar.append(button({ label: 'Collection', fill: true, onClick: () => { close(); onCollection(); } }));
    if (onImport) bar.append(button({ label: 'Import', fill: true, title: 'Spritesheet or .sprite', onClick: () => { close(); onImport(); } }));
  }, { className: 'size-popup', onDismiss });
}

// Two number fields (Tab between them) and Enter to commit.
function customSizeRow(onSubmit) {
  const row = document.createElement('div');
  row.className = 'size-row';
  const { w, h } = sizeFields();
  const submit = (e) => {
    if (e.key !== 'Enter') return;
    onSubmit(clampCanvasSize(w.value), clampCanvasSize(h.value || w.value));
  };
  w.addEventListener('keydown', submit);
  h.addEventListener('keydown', submit);
  row.append(w, h);
  return row;
}
