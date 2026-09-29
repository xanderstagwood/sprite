// Layers panel (design-doc §11, ui-design-system §4).
import { paintThumbnail } from './thumbnail.js';
import { BLOCK } from './grid.js';
import { overText } from './text-hit.js';
import { button, setIcon, hoverTip, showTip, makeReorderable, startInlineEdit } from './ui.js';
import { layerOrder, compositeLayerAt } from './sprite-file.js';
import { visibleOrder } from './ordering.js';
import { referencesOf, isResolved } from './references.js';
import { openSlideOut, closeSlideOut } from './slide-out.js';

const THUMB_H = BLOCK * 2; // layer tiles are 2 blocks tall

// Layer grouping is drag-and-drop only: a layer becomes a group's member
// by being positioned directly beneath its header (§ ordering.js), same as
// file collections. No separate "move to group" control.
// Painted thumbnail canvases from the last render, keyed by layer buffer and
// reused while the buffer's version, visibility and size are unchanged: the
// panel rebuilds its rows on every edit, but only the edited layer's pixels
// need repainting. Rebuilt each render from just the rows shown, so it can't
// outgrow the layer count.
let thumbCache = new Map(); // buffer -> { key, canvasEl }

export function renderLayersPanel(container, file, callbacks, focusedGroupId, layerSelection, multiSelection, activeReferenceId) {
  const scrollTop = container.scrollTop; // a rebuild would otherwise snap the panel back to the top
  const nextThumbs = new Map();
  container.innerHTML = '';
  const selLo = layerSelection ? Math.min(layerSelection.anchor, layerSelection.to) : -1;
  const selHi = layerSelection ? Math.max(layerSelection.anchor, layerSelection.to) : -1;

  // Anchored to the bottom of the panel, not the top: a stack of layers
  // reads more naturally sitting at the floor than floating at the ceiling.
  const stack = document.createElement('div');
  stack.className = 'layer-stack';

  // One "+" at the foot of the stack. Click opens a menu of everything you can
  // add; right-click adds a group and Alt+click a reference straight away.
  const addBtn = button({
    glyph: '+', fill: true, className: 'panel-add-btn', title: 'New layer, group or reference (+)',
    onClick: (e) => {
      if (e.altKey) { callbacks.onImportReference(); return; }
      openSlideOut(addBtn, [
        { label: 'Layer', keys: '+', onClick: () => callbacks.onAddLayer() },
        { label: 'Group', keys: '=', onClick: () => callbacks.onAddGroup() },
        { label: 'Reference', onClick: () => callbacks.onImportReference() },
      ], { side: 'left' });
    },
    onContextMenu: (e) => { e.preventDefault(); callbacks.onAddGroup(); },
  });
  // Double click: a new layer straight away, like the project panel's new canvas.
  addBtn.addEventListener('dblclick', () => { closeSlideOut(); callbacks.onAddLayer(); });

  function buildLayerRow(layer, i, pos, nested) {
    const row = document.createElement('div');
    const multiSelected = !!(multiSelection && multiSelection.has(i));
    row.className = 'layer-row tile tile--tall reveal-on-hover' + (nested ? ' layer-row--nested' : '') + ((multiSelected || i === file.activeLayerIndex) ? ' selected' : '') + (pos >= selLo && pos <= selHi ? ' layer-row--selected' : '');
    row.dataset.layerIndex = i; // § multi-select menu anchor lookup

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'layer-thumb';
    const buf = file.frames[file.activeFrameIndex].layerPixels[i];
    const thumbKey = `${buf.v | 0}|${layer.visible}|${file.visibleWidth}x${file.visibleHeight}x${file.canvasWidth}`;
    let thumb = thumbCache.get(buf);
    if (!thumb || thumb.key !== thumbKey) {
      const canvasEl = thumb ? thumb.canvasEl : document.createElement('canvas');
      paintThumbnail(canvasEl, file, compositeLayerAt(file, i, file.activeFrameIndex), THUMB_H, { dim: !layer.visible });
      thumb = { key: thumbKey, canvasEl };
    }
    nextThumbs.set(buf, thumb);
    const canvasEl = thumb.canvasEl;
    const eyeOverlay = document.createElement('div');
    eyeOverlay.className = 'thumb-eye' + (layer.visible ? '' : ' hidden-indicator');
    setIcon(eyeOverlay, 'visibility');
    thumbWrap.append(canvasEl, eyeOverlay);
    const thumbTip = 'Hide/show layer';
    hoverTip(thumbWrap, thumbTip);
    thumbWrap.addEventListener('click', (e) => {
      e.stopPropagation();
      // Clicking the thumbnail of a layer that's part of the current
      // multi-selection toggles every selected layer together, not just
      // this one.
      if (multiSelected) callbacks.onToggleVisibleSelection();
      else callbacks.onToggleVisible(i);
    });

    // Hover-revealed handle on the thumbnail's right edge: drag it up/down to
    // change opacity, no right-click/menu needed. The tool tag shows the
    // transparency, live while dragging.
    const handleTip = () => `Transparency ${Math.round((1 - layer.opacity) * 100)}%`;
    const opacityPip = document.createElement('div');
    opacityPip.className = 'opacity-pip';
    const placePip = () => opacityPip.style.setProperty('--t', 1 - layer.opacity);
    placePip();
    opacityPip.addEventListener('mouseenter', () => showTip(handleTip()));
    opacityPip.addEventListener('mouseleave', () => showTip(thumbTip));
    opacityPip.addEventListener('click', (e) => e.stopPropagation());
    opacityPip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      opacityPip.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = thumbWrap.getBoundingClientRect();
        const travel = r.height - opacityPip.offsetHeight;
        const value = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top - opacityPip.offsetHeight / 2) / travel));
        callbacks.onOpacityChange(i, value);
        placePip();
        showTip(handleTip());
      };
      const up = () => {
        opacityPip.removeEventListener('pointermove', move);
        opacityPip.removeEventListener('pointerup', up);
        callbacks.onOpacityCommit();
      };
      opacityPip.addEventListener('pointermove', move);
      opacityPip.addEventListener('pointerup', up);
    });
    thumbWrap.append(opacityPip);

    const label = document.createElement('div');
    label.className = 'layer-label';
    label.textContent = layer.name;
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineEdit(label, layer.name, (v) => { if (v) { layer.name = v; callbacks.onRename(); } });
    });

    row.append(thumbWrap, label);
    row.addEventListener('click', (e) => {
      // Shift/Alt-click build a multi-layer selection instead of switching
      // the active layer: same pattern as the file list's rows.
      if (e.shiftKey) { callbacks.onShiftSelectLayer(i); return; }
      if (e.altKey) { callbacks.onAltSelectLayer(i); return; }
      // Same no-op guard as the file list: onSelect re-renders this
      // panel, which was destroying `label` mid-double-click.
      if (i === file.activeLayerIndex && !multiSelection) return;
      callbacks.onSelect(i);
    });
    makeReorderable(row, pos, {
      listEl: stack,
      boundsEl: container,
      onReorder: (from, to) => callbacks.onReorder(from, to),
      onRemove: () => callbacks.onDelete(i),
    });

    return row;
  }

  function buildGroupHeader(group, pos) {
    const row = document.createElement('div');
    row.className = 'layer-group-header tile reveal-on-hover' + (group.id === focusedGroupId ? ' selected' : '') + (pos >= selLo && pos <= selHi ? ' layer-row--selected' : '');
    row.dataset.groupId = group.id;

    makeReorderable(row, pos, {
      listEl: stack,
      boundsEl: container,
      onReorder: (from, to) => callbacks.onReorder(from, to),
      onRemove: () => callbacks.onDeleteGroup(group.id), // its layers move to the first group
    });

    const eyePip = document.createElement('div');
    eyePip.className = 'eye-pip' + (group.visible ? '' : ' hidden-indicator');
    setIcon(eyePip, 'visibility');
    hoverTip(eyePip, 'Hide/show group');
    eyePip.addEventListener('click', (e) => { e.stopPropagation(); callbacks.onToggleGroupVisible(group.id); });

    const arrow = document.createElement('span');
    arrow.className = 'fold-arrow';
    setIcon(arrow, group.collapsed ? '▸' : '▾');
    arrow.addEventListener('click', (e) => {
      e.stopPropagation();
      group.collapsed = !group.collapsed;
      callbacks.onChange();
    });

    const label = document.createElement('div');
    label.className = 'layer-label';
    label.textContent = group.name;
    label.addEventListener('dblclick', (e) => {
      if (!overText(label, e)) return; // empty space beside the name: the row folds
      e.stopPropagation();
      startInlineEdit(label, group.name, (v) => { if (v) { group.name = v; callbacks.onRename(); } });
    });

    // The fold arrow sits at the right edge, after the visibility pip.
    row.append(label, eyePip, arrow);
    // A click selects the group. A double click on empty space in the row folds or
    // unfolds it; on the name's text it renames instead (above).
    row.addEventListener('click', () => { if (group.id !== focusedGroupId) callbacks.onSelectGroup(group.id); });
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.fold-arrow, .eye-pip, button') || overText(label, e)) return;
      group.collapsed = !group.collapsed;
      callbacks.onChange();
    });
    return row;
  }

  // Ascending order = top-to-bottom in the panel (§ ordering.js): the
  // reverse of `file.layers`' own bottom-to-top compositing order, so this
  // reads front-to-back same as before, just off the derived combined view
  // instead of iterating the raw array backwards.
  for (const entry of visibleOrder(layerOrder(file))) {
    if (entry.isHeader) {
      stack.append(buildGroupHeader(entry.item, entry.pos));
    } else {
      const i = file.layers.indexOf(entry.item);
      stack.append(buildLayerRow(entry.item, i, entry.pos, entry.item.groupId != null));
    }
  }

  stack.append(addBtn);
  const references = buildReferenceSection();
  if (references) container.append(references);
  container.append(stack);
  container.scrollTop = scrollTop;
  thumbCache = nextThumbs;

  // Reference images (references.js) sit apart from the layer stack: they
  // aren't layers, so they can't be selected, painted on, or exported:
  // there's simply nothing here to select. A row's ⤢ (or `:`) flips it
  // between fit-to-canvas and full size off to the right.
  function buildReferenceSection() {
    if (!referencesOf(file).length) return null;
    const section = document.createElement('div');
    section.className = 'reference-section';
    const header = document.createElement('div');
    header.className = 'layer-group-header tile';
    const title = document.createElement('div');
    title.className = 'layer-label';
    title.textContent = 'Reference';
    header.append(title);

    section.append(header);
    referencesOf(file).forEach((ref, refIndex) => {
      const row = document.createElement('div');
      row.className = 'layer-row tile reveal-on-hover' + (ref.id === activeReferenceId ? ' selected' : '');
      const label = document.createElement('div');
      label.className = 'layer-label';
      label.textContent = isResolved(ref) ? ref.name : `${ref.name} (click to relink)`;
      makeReorderable(row, refIndex, {
        listEl: section,
        boundsEl: container,
        onReorder: (from, to) => callbacks.onReorderReference(from, to),
        onRemove: () => callbacks.onRemoveReference(ref.id),
      });
      row.append(
        label,
        button({ glyph: '⤢', icon: true, className: 'btn--reveal', title: 'Fit to canvas / full size (:)', onClick: (e) => { e.stopPropagation(); callbacks.onToggleReferenceMode(ref.id); } }),
      );
      row.addEventListener('click', () => callbacks.onSelectReference(ref.id));
      section.append(row);
    });
    return section;
  }
}
