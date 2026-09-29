import { setPixel, setPixelIndex, colorIndex, getPixel, touch, paintAt, floodFill, mirroredPoints, snapshotPixels, diffFromSnapshot, hexToRgb, rgbToHex, packedToHex } from './canvas-model.js';
import { parseFile } from './sprite-format.js';
import { paintOptions, SYMMETRY_CYCLE } from './paint-options.js';
import { render, renderArtboardGrid, computeArtboardLayout, hitTestArtboardGrid, slotAtPoint } from './renderer.js';
import { createInputController } from './input.js';
import { computeViewport, screenToPixel, maxZoomScale, minZoomScale, fitScale, regionView, snapScale, stepScale, trueScale, zoomPercent } from './viewport.js';
import { viewState, resetView, groupViewState, resetGroupView } from './view-state.js';
import { createPalette } from './palette.js';
import { maskFromRect, maskFromWand, maskFromColor, fullMask, toRenderSelection } from './selection.js';
import { extract, stamp, flip, rotate, shiftMask, moveContent, maskBounds } from './selection-ops.js';
import { commitCommand, undo as undoCmd, redo as redoCmd, snapshotLayers, snapshotResize } from './undo.js';
import {
  createProject, DEFAULT_CANVAS_SIZE, MIN_CANVAS, activeFile as getActiveFile, addFile, deleteFile,
  addCollection, deleteCollection, NEW_FILE_SIZES, projectOrder, moveProjectItem,
  lastCollection, mostRecentFileIn, splitByCollection, addExistingFile, uniqueFileName, renameFile,
} from './project.js';
import { nextName } from './names.js';
import {
  activePixels, compositeFrame, resizeCanvas, trimCanvas, addLayer, deleteLayer,
  addFrame, deleteFrame, duplicateFrame, reorderFrame, ghostSource,
  addLayerGroup, deleteLayerGroup, layerOrder, moveLayerItem,
} from './sprite-file.js';
import { renderProjectPanel, openSizePopup } from './project-panel.js';
import { renderLayersPanel } from './layers-panel.js';
import { renderTimelinePanel } from './timeline-panel.js';
import { connectFolder } from './storage.js';
import { chooseBackend, loadProject, saveProject, listProjects, deleteProject, deleteStoredFile, ensureLoaded, markUsed, unloadIdle, debounce, autosaveDelay } from './persistence.js';
import { ensureAllFramesLoaded, ensureFrameLoaded, syncHotWindow, getCachedThumbnail } from './frame-cache.js';
import * as frameSelection from './frame-selection.js';
import { createSession } from './collab/session.js';
import { makeJoinLink, parseJoinCode, MSG } from './collab/protocol.js';
import { presenceColor } from './collab/presence.js';
import { targetFps } from './collab/throttle.js';
import { createStrokeSync } from './collab/stroke-sync.js';
import { createRemoteHostBackend, serveReads } from './collab/remote-host-backend.js';
import { createRevealablePanel } from './panel-reveal.js';
import { createKeybindHelp } from './keybind-help.js';
import { renderExportPanel } from './export-panel.js';
import { renderOpenProjectPanel } from './open-project-panel.js';
import { VERSION, GITHUB_ISSUES_URL, ITCH_IO_URL, DISCORD_URL, KOFI_URL } from './version.js';
import { loadUiPrefs, saveUiPrefs } from './ui-prefs.js';
import { setIcon, startInlineEdit, onHoverTip, showTip, button, flashTip, pickFile } from './ui.js';
import { decodeImage, bitmapPixels } from './image-import.js';
import { detectGrid, buildSheetFile } from './spritesheet.js';
import { askSheetGrid } from './spritesheet-panel.js';
import { paletteNameFromFile } from './palette-parse.js';
import { isImageFile } from './image-import.js';
import { addReference, removeReference, reorderReference, resolveReference, drawableReferences, referencesOf } from './references.js';
import { exportFile, exportCollection, exportProjectSprite, onExportProgress } from './export.js';
import { unzipSync } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
import { SHAPE_OUTLINES, constrainSquare } from './shapes.js';
import { openSlideOut, snapPx } from './slide-out.js';
import { visibleOrder } from './ordering.js';
import { watchPixelSnap } from './pixel-snap.js';
import { watchCursorScale } from './cursors.js';
import { installCursor, forceCursor, setCanvasCursor } from './inverted-cursor.js';

watchPixelSnap(); // before anything measures the layout: font sizes set the grid
await watchCursorScale(); // before the first cursor is shown
const canvas = document.getElementById('sprite-canvas');
installCursor(canvas);
const ctx = canvas.getContext('2d');
const paletteBar = document.getElementById('palette-bar');
const projectPanel = document.getElementById('project-panel');
const exportPanel = document.getElementById('export-panel');
const openProjectPanel = document.getElementById('open-project-panel');
const layersPanel = document.getElementById('layers-panel');
const timelineBar = document.getElementById('timeline-bar');
document.title = `Sprite v${VERSION} (ALPHA)`;
const helpTag = document.getElementById('help-tag');
const toolTag = document.getElementById('tool-tag');
helpTag.classList.add('panel');
toolTag.classList.add('panel');

// The backend is picked before any UI is built because preferences can live in
// it (a `.prefs` file in a connected folder, see ui-prefs.js), and the panels
// below are constructed from them.
let backend;
try {
  backend = await chooseBackend();
} catch (err) {
  console.error('Storage backend unavailable, autosave disabled:', err);
  backend = { write: async () => {}, read: async () => null, delete: async () => {}, list: async () => [] };
}
const uiPrefs = await loadUiPrefs(backend);

// First-run hints: one control at a time pulses, chosen by body[data-hint] (style.css). Steps only
// move forward, and jump ahead if the user gets there first (Alt++ before ever opening the menu).
const HINT_STEPS = ['folder', 'menu', 'new', 'colors', 'kofi', 'done'];
function setHint(step) {
  if (HINT_STEPS.indexOf(step) <= HINT_STEPS.indexOf(uiPrefs.hint)) return;
  uiPrefs.hint = step;
  document.body.dataset.hint = step;
  saveUiPrefs(uiPrefs);
}
document.body.dataset.hint = uiPrefs.hint;
if (backend.kind === 'fsa') setHint('menu'); // a folder is already connected
let activeReferenceId = null; // the reference `:` acts on: the one last added or clicked

// Floats above the palette's right edge; slides left with it when the
// layers panel pushes the palette over.
// Buttons, not <a href>: the browser's status bubble showing a hovered link's URL
// covers the tool tag, which is where these buttons' tips appear.
const openLink = (glyph, title, url, className) => button({ glyph, icon: true, title, className, onClick: () => window.open(url, '_blank', 'noopener') });
const landingBtn = openLink('sprite', `Sprite v${VERSION}`, ITCH_IO_URL);
const bugBtn = openLink('bug', 'Report an issue.', GITHUB_ISSUES_URL);
const discordBtn = openLink('discord', 'App Support (Discord)', DISCORD_URL);
const kofiBtn = openLink('heart', 'Become a supporter. (Kofi)', KOFI_URL, 'kofi-btn');
kofiBtn.addEventListener('click', () => { if (uiPrefs.hint === 'kofi') setHint('done'); });

// Toggles the same Controls modal as "?".
const helpBtn = button({ glyph: 'help', icon: true, title: 'Controls', onClick: () => keybindHelp.toggle() });

helpTag.append(landingBtn, bugBtn, discordBtn, kofiBtn, helpBtn);

// Hold-`+Left/Right selects a help-tag button, Return activates it:
// "everything keyboard-accessible". `~` (Global) separately pins/unpins the
// corner tags.
const helpNavItems = [landingBtn, bugBtn, discordBtn, kofiBtn, helpBtn];
let helpNavIndex = 0;
let helpNavHeld = false;
function updateHelpNavHighlight() {
  helpNavItems.forEach((el, i) => el.classList.toggle('help-nav-focused', helpNavHeld && i === helpNavIndex));
}

// Tool reference tag: mirrors help-tag on the opposite corner. Left
// side: current tool + brush size. Right: zoom %, then the primary swatch.
// Content refreshed from renderCanvas() (cheap: a handful of
// textContent/background writes).
const toolLabel = document.createElement('div');
toolLabel.className = 'tool-tag-label';
const zoomIcon = document.createElement('div');
zoomIcon.className = 'tag-icon';
setIcon(zoomIcon, '⌕');
const zoomLabel = document.createElement('div');
zoomLabel.className = 'tool-tag-label tool-tag-label--divider';
const primarySwatch = document.createElement('div');
primarySwatch.className = 'tool-tag-swatch';
primarySwatch.addEventListener('mouseenter', () => showTip(colors.primary()));
primarySwatch.addEventListener('mouseleave', () => showTip(null));
// Export progress (§14, export.js's onExportProgress): a small bar that
// takes the tool label's place while an export is running, so it doesn't
// need its own reserved slot the rest of the time.
const exportBar = document.createElement('div');
exportBar.className = 'tool-tag-export';
exportBar.hidden = true;
const exportBarTrack = document.createElement('div');
exportBarTrack.className = 'tool-tag-export-track';
const exportBarFill = document.createElement('div');
exportBarFill.className = 'tool-tag-export-fill';
exportBarTrack.append(exportBarFill);
exportBar.append(exportBarTrack);
// Lingering export-failure marker: hidden while nothing has failed (or a
// fresh export is running), shown as a short clickable label otherwise;
// click opens a modal with the full error detail (openExportErrorModal,
// below). Red/white styling only for failures the user can act on.
const exportErrorLabel = document.createElement('div');
exportErrorLabel.className = 'tool-tag-label tool-tag-export-error';
exportErrorLabel.hidden = true;
exportErrorLabel.addEventListener('click', () => { if (exportError) openExportErrorModal(exportError); });
toolTag.append(zoomIcon, zoomLabel, toolLabel, exportBar, exportErrorLabel, primarySwatch);

const MODE_LABELS = { place: 'Place', paint: 'Paint', erase: 'Erase' };

// A final export failure leaves a quiet marker here (cleared the moment
// the next export starts) instead of an interrupting dialog: see
// export.js's runExport for the retry-then-classify logic that decides
// `actionable` (red/white, worth a click) vs. not.
let exportError = null;
onExportProgress((status) => {
  exportBar.hidden = !status.active;
  if (status.active) exportBarFill.style.width = Math.round((status.fraction ?? 0) * 100) + '%';
  if ('error' in status) exportError = status.error;
  exportErrorLabel.hidden = status.active || !exportError;
  if (exportError) {
    exportErrorLabel.textContent = exportError.short;
    exportErrorLabel.classList.toggle('tool-tag-export-error--actionable', exportError.actionable);
  }
  updateToolTag();
});

// A hovered/focused button's own tip text takes over the tool tag's label
// in place of a native tooltip: cleared back to the normal tool/brush
// readout on mouseleave/blur. Set synchronously (not waiting for the next
// animation frame) so it's responsive even while that loop is paused (e.g.
// viewing a read-only group grid, § renderGroupCanvas).
let hoverTip = null;
onHoverTip((text) => { hoverTip = text; updateToolTag(); });

// Hovering a panel names the keys that focus it. A button's own tip (set on its
// mouseenter, after this mouseover) replaces it, and comes back to this one when
// the pointer moves off the button onto the panel again.
const PANEL_KEYS = { 'project-panel': 'Projects (Ctrl+Left)', 'layers-panel': 'Layers (Ctrl+Right)', 'timeline-bar': 'Timeline (Ctrl+Up)', 'palette-bar': 'Colors (Ctrl+Down)' };
let panelTipShown = false;
document.addEventListener('mouseover', (e) => {
  const tip = PANEL_KEYS[e.target.closest?.('.panel-overlay')?.id];
  if (tip) { showTip(tip); panelTipShown = true; }
  else if (panelTipShown) { showTip(null); panelTipShown = false; }
});
// Whichever artboard the mouse is over in the group grid (§ canvas
// pointermove, below): "name WxH", or null over empty space between
// cells. A button's own hoverTip still wins if somehow both are set.
let groupHoverTip = null;

// The tool tag updates on every render, so it reads a cached canvas box
// (refreshed by resize()) rather than forcing a layout each time, and only
// touches the DOM when a value actually changed.
let canvasRect = canvas.getBoundingClientRect();
let swatchColor = null;
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden; };

function updateToolTag() {
  const rect = canvasRect;
  // An export in progress takes over the label slot with the progress bar
  // (already shown/hidden by the onExportProgress subscription above):
  // nothing else competes for it while that's up.
  if (!exportBar.hidden) {
    setHidden(toolLabel, true);
  } else if (activeGroupId) {
    // The group grid (§ project panel group select) has no active tool or
    // color: a hovered button's tip is still worth showing there, but the
    // brush/mode readout and primary-swatch are meaningless outside actual
    // editing, and the zoom % needs to read the grid's own camera, not the
    // single-file canvas's.
    const tip = hoverTip || groupHoverTip;
    setHidden(toolLabel, !tip); // nothing to show between artboards: don't render an empty tip section
    setText(toolLabel, tip || '');
    setHidden(primarySwatch, true);
    const scale = groupViewState.zoom || groupFitScale(groupLayoutModel(), rect.width, rect.height);
    setText(zoomLabel, zoomPercent(scale) + '%');
    return;
  } else {
    setHidden(toolLabel, false);
    const modeLabel = MODE_LABELS[inputController && inputController.getMode()] || 'Place';
    const size = brushSize;
    setText(toolLabel, hoverTip || `${size}px ${modeLabel}${paintOptions.dither ? ' (dither)' : ''}${paintOptions.symmetry !== 'off' ? ' (mirror)' : ''}`);
  }
  setHidden(primarySwatch, false);
  const scale = (viewState.zoom || fitScale(model, rect.width, rect.height));
  setText(zoomLabel, zoomPercent(scale) + '%');
  const primary = colors.primary();
  if (primary !== swatchColor) primarySwatch.style.background = swatchColor = primary;
}

// Corner-tag hide/show state: `~` (Global) pins/unpins both at once.
let tagsHidden = uiPrefs.tagsHidden;
helpTag.classList.toggle('hidden-tag', tagsHidden);
toolTag.classList.toggle('hidden-tag', tagsHidden);
function toggleTagsHidden() {
  tagsHidden = !tagsHidden;
  helpTag.classList.toggle('hidden-tag', tagsHidden);
  toolTag.classList.toggle('hidden-tag', tagsHidden);
  uiPrefs.tagsHidden = tagsHidden;
  saveUiPrefs(uiPrefs);
}

// Timeline (top) and Palette (bottom) both shrink horizontally to clear
// whichever side panel is open, rather than staying full width and
// pushing anything: side panels just run the full viewport height.
// Pushes are whole blocks of the live --block, not pixel constants: pixel-snap.js
// resizes the block with the device pixel ratio, and a fixed pixel offset would drift from it.
const SIDE_PANEL_BLOCKS = 6; // must match --panel-width in style.css
const PALETTE_BLOCKS = 1;
const blocks = (n) => (n ? `calc(var(--block) * ${n})` : '0px');

// A shut slide-out can't be seen, so its rebuild (thumbnails and all) waits
// until it opens; these mark it as owing one. Declared before the panels are
// built: a pinned panel reports itself visible during construction.
let layersStale = true, timelineStale = true;
let projectReveal, exportReveal, openProjectReveal, layersReveal, timelineReveal, paletteReveal;
function updatePushes() {
  const projectOpen = !!(projectReveal && projectReveal.isFocused());
  // Export and Open Project only ever show docked beside an open Project
  // panel, and never both at once (each force-closes the other when
  // opened, below): if Project closes out from under whichever is open
  // (e.g. unpinned via Tab), close it too.
  if (!projectOpen) {
    if (exportReveal && exportReveal.isFocused()) exportReveal.forceHide();
    if (openProjectReveal && openProjectReveal.isFocused()) openProjectReveal.forceHide();
  }
  const exportOpen = !!(exportReveal && exportReveal.isFocused());
  const openProjectOpen = !!(openProjectReveal && openProjectReveal.isFocused());
  const secondSlotOpen = exportOpen || openProjectOpen;
  if (exportPanel) exportPanel.style.setProperty('--export-left', blocks(projectOpen ? SIDE_PANEL_BLOCKS : 0));
  if (openProjectPanel) openProjectPanel.style.setProperty('--open-project-left', blocks(projectOpen ? SIDE_PANEL_BLOCKS : 0));
  const pushedLeft = projectOpen || secondSlotOpen;
  const pushedRight = !!(layersReveal && layersReveal.isFocused());
  const leftPush = blocks(((projectOpen ? 1 : 0) + (secondSlotOpen ? 1 : 0)) * SIDE_PANEL_BLOCKS);
  const rightPush = blocks(pushedRight ? SIDE_PANEL_BLOCKS : 0);
  // The help tag always sits as far right/down as it can: right of the
  // layers panel when closed, flush with the window bottom when the
  // palette itself is closed, not pinned to the palette's height always.
  const paletteVisible = !!(paletteReveal && paletteReveal.isFocused());
  const bottomPush = blocks(paletteVisible ? PALETTE_BLOCKS : 0);
  for (const el of [timelineBar, paletteBar]) {
    el.style.setProperty('--push-left', leftPush);
    el.style.setProperty('--push-right', rightPush);
    // Dark shadow line where an open side panel butts against this edge:
    // shows the side panel stacking in front of it (§ panel-edge treatment).
    el.classList.toggle('pushed-left', pushedLeft);
    el.classList.toggle('pushed-right', pushedRight);
  }
  // Both corner tags always sit as far into their corner as they can: only
  // lifted above the palette when it's actually visible, only pulled in
  // from their side when that side panel is actually open.
  helpTag.style.setProperty('--push-right', helpTagPush ? `max(${rightPush}, ${helpTagPush}px)` : rightPush);
  helpTag.style.setProperty('--push-bottom', bottomPush);
  toolTag.style.setProperty('--push-left', slideOutPush ? `max(${leftPush}, ${slideOutPush}px)` : leftPush);
  toolTag.style.setProperty('--push-bottom', bottomPush);
}

// An open slide-out that covers the tool tag's corner shoves the tag past
// its own right edge instead of hiding it. The help tag does the same to the
// left (a menu from the layers panel opens leftward over it).
let slideOutPush = 0, helpTagPush = 0;
document.addEventListener('slideout-bounds', (e) => {
  const bar = e.detail, tag = toolTag.getBoundingClientRect(), helpRect = helpTag.getBoundingClientRect();
  const covers = bar && bar.top < tag.bottom && bar.bottom > tag.top && bar.left < tag.right;
  const coversHelpTag = bar && bar.top < helpRect.bottom && bar.bottom > helpRect.top && bar.right > helpRect.left;
  slideOutPush = covers ? snapPx(bar.right) : 0;
  helpTagPush = coversHelpTag ? snapPx(window.innerWidth - bar.left) : 0;
  updatePushes();
});

// Shared reveal/hide/pin/focus mechanic (§15), one instance per panel.
// Pin state is restored from uiPrefs (palette starts pinned by default:
// §7.2 flagged assumption 3: on a first run with nothing saved yet), and
// persisted back on every pin/unpin so a reload looks the way you left it.
// Export doesn't get this: it isn't independently pinnable (only ever
// opens alongside Project, via openExport()), so there's no pin state of
// its own worth remembering.
projectReveal = createRevealablePanel(projectPanel, document.getElementById('project-trigger'), {
  initiallyPinned: uiPrefs.project, onVisibility: updatePushes,
  onPinChange: (v) => { uiPrefs.project = v; saveUiPrefs(uiPrefs); },
});
// No edge trigger: opened only by the Project panel's Export button
// (openExport(), below); its own element is its "trigger" so hovering it
// keeps it open with the same grace-period behavior as every other panel.
exportReveal = createRevealablePanel(exportPanel, exportPanel, { onVisibility: updatePushes });
// Same non-pinnable, own-element-as-trigger treatment as Export: opened
// only by the Project panel's "Open" menu item (openProjectListPanel(), below).
openProjectReveal = createRevealablePanel(openProjectPanel, openProjectPanel, { onVisibility: updatePushes });
layersReveal = createRevealablePanel(layersPanel, document.getElementById('layers-trigger'), {
  initiallyPinned: uiPrefs.layers, onVisibility: (visible) => { updatePushes(); if (visible && layersStale && layersReveal) redrawLayersPanel(); }, // not during construction: layersReveal is unset and the project isn't loaded yet
  onPinChange: (v) => { uiPrefs.layers = v; saveUiPrefs(uiPrefs); },
});
timelineReveal = createRevealablePanel(timelineBar, document.getElementById('timeline-trigger'), {
  initiallyPinned: uiPrefs.timeline, onVisibility: (visible) => { updatePushes(); if (visible && timelineStale && timelineReveal) redrawTimelinePanel(); },
  onPinChange: (v) => { uiPrefs.timeline = v; saveUiPrefs(uiPrefs); },
});
paletteReveal = createRevealablePanel(paletteBar, document.getElementById('palette-trigger'), {
  initiallyPinned: uiPrefs.palette, onVisibility: updatePushes,
  onPinChange: (v) => { uiPrefs.palette = v; saveUiPrefs(uiPrefs); },
});
updatePushes(); // final pass: the four constructions above ran with partial info
const keybindHelp = createKeybindHelp();
paletteBar.addEventListener('click', (e) => { if (e.target.closest('.palette-hamburger')) setHint('kofi'); });

// Minimal generic modal for the export-error label's "click for more info"
// (openExportErrorModal above). Mirrors keybind-help.js's proven
// overlay+panel+fade pattern but with its own classes: deliberately not
// shared, keybind-help.js is unrelated and untouched.
let exportErrorOverlay = null;
function openExportErrorModal(error) {
  if (exportErrorOverlay) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const panel = document.createElement('div');
  panel.className = 'modal-panel panel';
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Export failed';
  const body = document.createElement('div');
  body.className = 'modal-body';
  body.textContent = error.detail;
  panel.append(title, body);
  overlay.append(panel);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeExportErrorModal(); });
  document.body.append(overlay);
  exportErrorOverlay = overlay;
  requestAnimationFrame(() => overlay.classList.add('visible'));
}
function closeExportErrorModal() {
  if (!exportErrorOverlay) return;
  const el = exportErrorOverlay;
  exportErrorOverlay = null;
  el.classList.remove('visible');
  setTimeout(() => el.remove(), 180); // matches keybind-help.js's TRANSITION_MS
}

// Tab: pin/unpin every panel at once. A plain toggle on whether *any*
// panel is currently pinned: the earlier stash-and-restore-exact-prior-state
// version was a no-op whenever nothing happened to be pinned yet, which read
// as broken.
function toggleHideAllPanels() {
  // Colors/Layers/Timeline are removed outright in group view (setActiveGroup)
  //: Tab shouldn't be able to pin them back open behind the scenes.
  const reveals = activeGroupId ? [projectReveal] : [projectReveal, layersReveal, timelineReveal, paletteReveal];
  const anyPinned = reveals.some((r) => r.isPinned());
  for (const r of reveals) {
    if (anyPinned) r.forceHide();
    else r.setPinned(true);
  }
}

// --- Focus-based control scheme: Ctrl(left)+Arrow focuses a panel (pulling
// it out, red hairline), staying focused after keyup until focus moves
// elsewhere: unlike the old hold-to-reveal Tab/C/\/T keys. `Tab` cycles
// through PANEL_CYCLE; a tap of Ctrl alone (no arrow) returns to 'canvas'.
let focusedPanel = 'canvas'; // 'canvas' | 'timeline' | 'layers' | 'colors' | 'projects'
const PANEL_REVEAL = { timeline: timelineReveal, layers: layersReveal, colors: paletteReveal, projects: projectReveal };
const PANEL_EL = { timeline: timelineBar, layers: layersPanel, colors: paletteBar, projects: projectPanel };
const PANEL_CYCLE = ['timeline', 'layers', 'colors', 'projects'];
// Hovering a panel focuses it, but the red ring is the keyboard's indicator: it
// shows only once the keyboard is in use (a key press) or focus was moved by it.
let focusFromMouse = false;
document.addEventListener('keydown', () => { if (focusFromMouse) { focusFromMouse = false; syncFocusRing(); } }, true);
// Two presses of the same panel's Ctrl+Arrow within this many ms make a double tap.
const DOUBLE_TAP_MS = 350;
let lastFocusTap = { panel: null, at: 0 };
function setFocus(panel, { mouse = false } = {}) {
  focusFromMouse = mouse;
  const reveal = PANEL_REVEAL[panel];
  const now = performance.now();
  const doubleTap = !mouse && !!reveal && lastFocusTap.panel === panel && now - lastFocusTap.at < DOUBLE_TAP_MS;
  if (!mouse && reveal) lastFocusTap = { panel: doubleTap ? null : panel, at: now }; // a third press starts a new count
  if (focusedPanel === panel) {
    // Only a real double tap of the same panel's key toggles whether it stays
    // open; a single press on the panel that already has focus does nothing.
    // Unpinning has to close it and hand the keyboard back to the canvas: the
    // focus itself would otherwise keep it open, and the unpin would look like nothing happened.
    if (!doubleTap) return;
    if (reveal.isPinned()) {
      reveal.forceHide();
      focusedPanel = 'canvas';
      syncFocusRing();
    } else {
      reveal.setPinned(true);
    }
    return;
  }
  if (PANEL_REVEAL[focusedPanel]) PANEL_REVEAL[focusedPanel].setKeyHeld(false);
  focusedPanel = panel;
  if (PANEL_REVEAL[panel]) PANEL_REVEAL[panel].setKeyHeld(true);
  syncFocusRing();
}

// Hovering a panel gives it keyboard focus too, same as Ctrl+Arrow: mouse
// and keyboard stay in sync rather than needing a keyboard focus step after
// an already-visible (hovered) panel. Colors/Layers/Timeline aren't
// reachable in group view (§ setActiveGroup): Projects is the only one
// still worth hover-focusing there.
const PANEL_TRIGGER_ID = { timeline: 'timeline-trigger', layers: 'layers-trigger', colors: 'palette-trigger', projects: 'project-trigger' };
for (const name of PANEL_CYCLE) {
  const trigger = document.getElementById(PANEL_TRIGGER_ID[name]);
  const onHoverEnter = () => { if (name !== 'projects' && activeGroupId) return; if (focusedPanel !== name) setFocus(name, { mouse: true }); };
  const onHoverLeave = () => { if (focusedPanel === name) setFocus('canvas', { mouse: true }); };
  PANEL_EL[name].addEventListener('mouseenter', onHoverEnter);
  PANEL_EL[name].addEventListener('mouseleave', onHoverLeave);
  if (trigger) { trigger.addEventListener('mouseenter', onHoverEnter); trigger.addEventListener('mouseleave', onHoverLeave); }
}

// The panel that owns the keyboard wears an accent outline (`.kb-focused`).
// It is drawn by the panel itself, not by a floating element tracking its
// rect: a separate fixed element landed on fractional device pixels at
// display scales like 1.25x and rendered as an anti-aliased smear (26% / 100% /
// 75% red across three pixels, measured from a screenshot), while an outline
// is pixel-snapped with the panel's own border box, so the two can't disagree.
function syncFocusRing() {
  for (const [name, el] of Object.entries(PANEL_EL)) el.classList.toggle('kb-focused', name === focusedPanel && !focusFromMouse);
}

// The read-only group grid (§ project panel group select) has no colors,
// layers, or frames of its own to show: it's an overview of other files'
// already-composited pixels, none of it editable. Colors/Layers/Timeline
// have nothing to do there, so entering group view force-closes and hides
// all three (CSS keyed off `.group-view` on <body>, toggled here) instead
// of leaving them reachable but pointless. The single call site every
// `activeGroupId` assignment now goes through, so this can't be missed by
// a future one.
function setActiveGroup(id) {
  // Remember the outgoing collection's own zoom/pan (§7 issue: "remember
  // zoom per collection"), and restore the incoming one's: stored directly
  // on the collection object, same as .order/.collapsed. Only persists on
  // switch, not live-tracked mid-pan/zoom.
  if (activeGroupId) {
    const prev = project.collections.find((c) => c.id === activeGroupId);
    if (prev) { prev.zoom = groupViewState.zoom; prev.panX = groupViewState.panX; prev.panY = groupViewState.panY; }
  }
  activeGroupId = id;
  fileSelection = null; // group view has no per-file menu concept
  multiLayerSelection = null; // group view has no layers panel either
  groupHoverTip = null; // stale artboard tip from whichever group was last shown
  document.body.classList.toggle('group-view', !!id);
  if (id) {
    const target = project.collections.find((c) => c.id === id);
    // Re-snapped: the saved zoom may predate whole-device-pixel stops, or come from another display.
    if (target && target.zoom != null) { groupViewState.zoom = snapScale(target.zoom); groupViewState.panX = target.panX || 0; groupViewState.panY = target.panY || 0; }
    else resetGroupView();
    layersReveal.forceHide();
    timelineReveal.forceHide();
    paletteReveal.forceHide();
    if (focusedPanel === 'colors' || focusedPanel === 'layers' || focusedPanel === 'timeline') setFocus('canvas');
  } else {
    resetGroupView();
  }
}

// Autosave (§10, §18): every committed change writes to whichever backend
// was resolved (real folder via FSA, or the IndexedDB fallback), debounced
// so a fast drag-stroke doesn't fire one write per pixel. IndexedDB is
// unavailable in some contexts (a file:// origin, private browsing): fall
// back to an in-memory no-op backend rather than taking the whole app down,
// since losing autosave is much better than losing the app.
let project;
try {
  // Reopen whichever project was open last time; failing that, whatever's
  // most recently touched in the registry; failing that (first-ever run),
  // start a fresh one. Projects persist indefinitely once saved (§
  // ProjectSwitching): this is just which one to land on, not the only one.
  project = (uiPrefs.lastProjectId && await loadProject(backend, uiPrefs.lastProjectId)) || null;
  if (!project) {
    const registry = await listProjects(backend);
    if (registry.length) {
      const mostRecent = registry.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
      project = await loadProject(backend, mostRecent.id);
    }
  }
  if (!project) project = (await loadStarterProject()) || createProject('My Project');
} catch (err) {
  console.error('Storage backend unavailable, autosave disabled:', err);
  backend = { write: async () => {}, read: async () => null, delete: async () => {}, list: async () => [] };
  project = createProject('My Project');
}
uiPrefs.lastProjectId = project.id;
saveUiPrefs(uiPrefs);
// Declared up here because autosave() (called at startup) consults them.
let collabSession = null; // null outside a live session
let localSession = null; // a guest's own { backend, project }, restored when the session ends
// A call naming the File it edited saves just that File; a bare call (every
// rarer path: renames, moves, panel edits) sweeps them all, so a path that
// forgets to name its File costs time, never data.
const pendingFiles = new Set();
let sweepAll = true;
const flushAutosave = debounce(() => {
  const only = sweepAll ? undefined : [...pendingFiles];
  pendingFiles.clear();
  sweepAll = false;
  saveProject(backend, project, only).catch((err) => console.error('Autosave failed:', err));
}, () => {
  const file = getActiveFile(project);
  return autosaveDelay(file.canvasWidth * file.canvasHeight);
});
function autosave(file) {
  if (!file) structureChanged(); // a bare call is a structural edit (rename, move, frame change, panel edit)
  if (backend.kind === 'remote') return; // a guest's edits reach the host as strokes, never as saves
  if (file) pendingFiles.add(file);
  else sweepAll = true;
  flushAutosave();
}
autosave();

// Memory follows what's open: a File nobody has used for a minute (and that
// isn't one of the few most recent) drops its pixels; they reload from
// storage on next use.
setInterval(() => {
  const active = getActiveFile(project);
  unloadIdle(backend, project, (f) => f === active || (!!activeGroupId && f.groupId === activeGroupId))
    .catch((err) => console.error('Unload failed:', err));
}, 15_000);

// The debounce can be several seconds on a large canvas, so flush right
// away when the tab is hidden or closed rather than lose the last edits.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && backend.kind !== 'remote') saveProject(backend, project).catch((err) => console.error('Autosave failed:', err));
});

// `model` is a stable view object; switching files/layers/frames re-points
// model.pixels at that combination's array in place (same reference the
// SpriteFile stores) rather than rebuilding every module that holds `model`.
// stride = the logical canvas width, which can exceed the visible width
// after a shrink (§13.4): width/height stay the visible (edit/display)
// window, cropped from the top-left of that wider backing array.
const model = { width: 0, height: 0, stride: 0, pixels: null, colors: null };

function bindActiveFile() {
  const file = getActiveFile(project);
  model.width = file.visibleWidth;
  model.height = file.visibleHeight;
  model.stride = file.canvasWidth;
  model.colors = file.colors;
  markUsed(file);
  if (file._stub) {
    // Not loaded yet (persistence.js lazy loading): a blank stand-in until
    // the pixels arrive, then bind for real and refresh everything.
    model.pixels = new Uint16Array(file.canvasWidth * file.canvasHeight);
    ensureLoaded(file).then(() => {
      if (getActiveFile(project) !== file) return;
      bindActiveFile(); redrawProjectPanel(); draw();
    });
    return;
  }
  model.pixels = activePixels(file);
  // Linked references reload lazily from their file handles; each finishing
  // decode just asks for a fresh canvas frame.
  for (const ref of referencesOf(file)) resolveReference(ref).then((loaded) => { if (loaded) draw(); });
}

// Reopen on the canvas that was open, at the zoom and pan it had. Kept in
// localStorage (uiPrefs), which a page unload can write synchronously; the
// project's own save is async and may not finish before the tab goes away.
const savedView = uiPrefs.view;
if (savedView && savedView.projectId === project.id && project.files[savedView.fileIndex]) {
  project.activeFileIndex = savedView.fileIndex;
  viewState.zoom = savedView.zoom ? snapScale(savedView.zoom) : null; // may have been saved on another display
  viewState.panX = savedView.panX || 0;
  viewState.panY = savedView.panY || 0;
}
function rememberView() {
  uiPrefs.view = { projectId: project.id, fileIndex: project.activeFileIndex, zoom: viewState.zoom, panX: viewState.panX, panY: viewState.panY };
  saveUiPrefs(uiPrefs);
}
window.addEventListener('pagehide', rememberView);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') rememberView(); });
bindActiveFile();

let inputController = null;
let showGrid = uiPrefs.showGrid;
paintOptions.dither = uiPrefs.dither;
paintOptions.symmetry = uiPrefs.symmetry;
let showRuler = uiPrefs.showRuler;
// Shared step order for every checker/solid backdrop in the app (the
// single-file canvas's own `u`, its app-wide `Shift+U` chrome, and the
// group grid's `U`: the group grid has no per-artboard canvas background
// of its own, every artboard is always transparent, showing this one
// shared backdrop through it): transparent, then dark to light, looping.
// One array: all three cycles share the exact same stops.
const BG_STEPS = ['checker', 'black', 'grey', 'white'];
// Pre-unification saves may still have the old 'dark'/'mid'/'light' app
// backdrop names on disk: map them onto their new equivalents so an
// upgrade doesn't silently reset (or crash indexOf into -1) a returning
// user's chosen background.
const LEGACY_BG_NAMES = { dark: 'black', mid: 'grey', light: 'white' };
function normalizeBg(value, fallback) { return LEGACY_BG_NAMES[value] || value || fallback; }

// One shared "advance to the next step, persist, redraw" shape behind
// every backdrop cycle key below: they differ only in which uiPrefs key
// they read/write and their own starting fallback.
function makeBgCycler(prefsKey, fallback) {
  let value = normalizeBg(uiPrefs[prefsKey], fallback);
  return {
    get: () => value,
    set(v) { value = v; uiPrefs[prefsKey] = value; saveUiPrefs(uiPrefs); },
    cycle() {
      this.set(BG_STEPS[(BG_STEPS.indexOf(value) + 1) % BG_STEPS.length]);
      draw();
    },
  };
}

const canvasBgCycler = makeBgCycler('canvasBg', 'white');
function cycleCanvasBg() { canvasBgCycler.cycle(); }

// App-wide chrome background (Shift+U): the space the canvas itself sits
// on, painted by renderer.js as part of the canvas fill (the canvas element
// covers the full viewport, so a CSS body background would never be
// visible). Distinct from the sprite's own backdrop (`u`/canvasBgCycler
// above), though both share the same transparency checkerboard:
// renderer.js draws it once, pixel-aligned to the canvas, as a base layer
// under both, so the two can never drift out of alignment with each other.
const appBgCycler = makeBgCycler('appBg', 'white');
function cycleAppBg() { appBgCycler.cycle(); }

// Ctrl+U: cycle the canvas and app backdrops together instead of one at a
// time. If they're currently different colors, the first press just snaps
// the app backdrop onto the canvas's own (canvas wins) rather than also
// stepping past it: only once they agree does a press actually cycle
// both, in step, from there. Genuinely its own thing (not another
// makeBgCycler instance): it reads and compares two cyclers' values
// together, which the shared factory has no shape for.
function cycleBothBg() {
  if (appBgCycler.get() !== canvasBgCycler.get()) {
    appBgCycler.set(canvasBgCycler.get());
    draw();
  } else {
    appBgCycler.cycle(); // also redraws
    canvasBgCycler.set(appBgCycler.get());
  }
}

const groupAppBgCycler = makeBgCycler('groupAppBg', 'white');
function cycleGroupAppBg() { groupAppBgCycler.cycle(); }
let hoverPixel = null;
// Declared this early because updateToolTag() (called from renderCanvas(),
// which the animateCursor loop invokes synchronously right away) reads it:
// a `let` declared further down is in the temporal dead zone until its own
// line runs, so referencing it before then throws and silently aborts the
// entire module, which is what broke rendering/the tool tag altogether.
let heldD = false;
let dPickPreview = null;
// Keyboard-first control scheme (CONTEXT.md): brush size is keyboard-owned
// state, read by both the tool tag and input.js's mouse handlers (which
// just mirror whatever's set here). Paint/erase is momentary now: which
// key/button is down at the time, not a persisted mode.
let brushSize = 1;
// Panel keyboard focus: a position in the panel's visible combined order
// (project-panel.js/layers-panel.js) that Up/Down moves through: distinct
// from `activeFileIndex`/`activeLayerIndex`, since focus can land on a
// header (to fold/unfold it with Space) where "the active file/layer"
// doesn't mean anything. Landing on a file/layer still syncs the active
// one, same as before. Declared this early (like brushSize
// above) because redrawProjectPanel()'s first call, a few lines down, reads
// it via focusedCollectionId() before this point in the file would
// otherwise have run.
let tabFocusPos = null;
let backslashFocusPos = null;
let layerSelection = null; // { anchor, to } inclusive layer/group range, while Layers panel Shift+Up/Down selects multiple
let selectionMask = null;
let selectionRender = null;
// The Collection currently shown as a read-only artboard grid instead of
// the normal single-file editing canvas (§ project panel group select):
// null means the canvas shows the active file as usual.
let activeGroupId = null;
// Multi-file selection in the project panel (Shift/Alt-click, § buildFileRow)
//: a Set of `project.files` indices, or null when nothing's multi-selected
// (the plain single active-file highlight applies instead). Indices, not
// file references, matching how layerSelection/frameSelection already
// track transient panel selection elsewhere in this app.
let fileSelection = null;
// Same idea, for the layers panel (Shift/Alt-click, § layers-panel.js's
// buildLayerRow): a Set of `file.layers` indices, distinct from the
// existing `layerSelection` {anchor,to} range (that one drives the
// backslash+arrows bulk-reorder feature, an unrelated keyboard mechanic).
let multiLayerSelection = null;
let clipboard = null;
let rotating = null; // { snapshot, center } while R is held
const playback = { fps: 8, onionSkin: false, onionLayerOnly: false, playing: false, timer: null };

// Collab (§ collab plan, phase 1: cursor sync only). `null` outside a
// session; only created on the first Collab click, so a solo user never
// even fetches PeerJS (see peerjs-loader.js's lazy import).
let strokeSync = null; // §phase 2: live pixel sync, created alongside collabSession
const remoteCursors = new Map(); // participant id -> { x, y, name }
let lastCursorSendAt = 0;
let cursorIntervalMs = 100; // re-derived once a second from the link's health (collab/throttle.js)
let frameMsAvg = 16; // smoothed rAF delta: a struggling tab is one of the throttle's signals
let lastFrameAt = 0;
let throttleTimer = null;

function startThrottle() {
  throttleTimer = setInterval(async () => {
    const link = await collabSession?.sample();
    if (link) cursorIntervalMs = 1000 / targetFps({ ...link, frameMs: frameMsAvg });
  }, 1000);
}

// 'idle' (no session), 'waiting' (in one, but nobody else has joined yet) or
// 'live' (two or more participants): what the Collab button shows.
function collabState() {
  if (!collabSession) return 'idle'; // a session that is still connecting counts as waiting
  return collabSession.getParticipants().length > 1 ? 'live' : 'waiting';
}

// Strokes name their canvas by File name + frame/layer index. Returns null
// for a canvas not resident here (a stub loads the host's saved state when
// first opened, so nothing is lost by skipping it), and a promise for a
// frame the in-memory cache has compressed (frame-cache.js).
function resolveStrokeTarget({ fileId, frame, layer }) {
  if (reloading) return reloading.then(() => resolveStrokeTarget({ fileId, frame, layer }));
  const file = project.files.find((f) => f.name === fileId);
  if (!file || file._stub || !Number.isInteger(frame) || !Number.isInteger(layer) || !file.frames[frame]) return null;
  const toTarget = () => {
    const pixels = file.frames[frame]?.layerPixels[layer];
    return pixels && { file, width: file.visibleWidth, height: file.visibleHeight, stride: file.canvasWidth, pixels, colors: file.colors };
  };
  return file.frames[frame]._compressed ? ensureFrameLoaded(file, frame).then(toTarget) : toTarget();
}

// A guest swaps to the host's project over a remote backend; this is what
// it left behind, restored when the session ends.
let flushing = null;
// One shared save however many reads ask, so a guest fetching a canvas sees
// the host's latest strokes without the host saving once per chunk.
const flushForGuests = (hostBackend) => () => flushing ||= saveProject(hostBackend, project).finally(() => { flushing = null; });

// Only pixel diffs stream; a structural edit (layers, frames, resize,
// renames, moves) is settled by reloading the project from the host's
// saved copy. The host tells guests once its edits settle; a guest's own
// structural edit can't be sent anywhere, so it just snaps back to the
// host's version.
const announceResync = debounce(() => collabSession?.send(MSG.RESYNC, {}), 500);
function structureChanged() {
  const role = collabSession?.getRole();
  if (role === 'host') announceResync();
  else if (role === 'guest' && backend.kind === 'remote') reloadFromHost();
}

// Strokes that arrive mid-reload wait for it (resolveStrokeTarget) and then
// apply to the fresh project: a diff is absolute pixel values, so replaying
// one the host's saved copy already contains changes nothing. Reloads
// queue, so a second RESYNC never overlaps the first.
let reloading = null;
function reloadFromHost() {
  const run = (reloading || Promise.resolve()).then(doReload);
  const me = reloading = run.finally(() => { if (reloading === me) reloading = null; });
  return me;
}

async function doReload() {
  if (backend.kind !== 'remote') return;
  const activeName = getActiveFile(project).name;
  const fresh = await loadProject(backend, project.id).catch((err) => { console.error('Resync failed', err); return null; });
  if (!fresh || backend.kind !== 'remote') return;
  fresh.activeFileIndex = Math.max(0, fresh.files.findIndex((f) => f.name === activeName));
  project = fresh;
  palette.setState(project.palette);
  bindActiveFile();
  redrawProjectPanel(); redrawLayersPanel(); redrawTimelinePanel();
  draw();
}

async function endCollab() {
  collabSession?.leave();
  collabSession = null;
  clearInterval(throttleTimer);
  cursorIntervalMs = 100;
  strokeSync = null;
  remoteCursors.clear();
  if (localSession) {
    ({ backend, project } = localSession);
    localSession = null;
    await switchToProject(project, { save: false });
  }
  redrawProjectPanel();
}

// Ctrl-click on a guest's icon or name in the presence tile. The token rotates, so the old link is
// dead: the host's clipboard gets the new one to re-invite with.
function kickGuest(id) {
  if (collabSession?.getRole() !== 'host') return;
  collabSession.kick(id);
  remoteCursors.delete(id);
  navigator.clipboard.writeText(makeJoinLink(collabSession.getSelfId(), collabSession.getToken())).catch(() => { /* clipboard write can be denied: the link is then only recoverable by restarting */ });
}

async function toggleGoLive() {
  if (collabSession) { await endCollab(); return; }
  let target = null;
  try { target = parseJoinCode(await navigator.clipboard.readText()); } catch { /* clipboard read can be denied; treat as no code */ }
  collabSession = createSession();
  strokeSync = createStrokeSync({ session: collabSession, resolveTarget: resolveStrokeTarget, requestRender: (target) => { if (target?.file) autosave(target.file); draw(); } });
  collabSession.onMessage(MSG.CURSOR, (payload, fromId) => { remoteCursors.set(fromId, payload); needsRender = true; });
  collabSession.onMessage('roster', redrawProjectPanel); // also what flips the button from waiting to live
  collabSession.onMessage(MSG.FULL, () => { console.warn('Session is full'); endCollab(); });
  collabSession.onMessage('participant-left', ({ id }) => {
    remoteCursors.delete(id);
    if (collabSession?.getRole() === 'guest') endCollab(); // a guest's only connection is the host: it's gone, so the session is over
  });
  redrawProjectPanel(); // shows the waiting pulse straight away, while the connection is still being made
  try {
    if (target) {
      // The host relays every guest's messages to the other guests, so
      // these two are only believed from the host itself.
      const remote = createRemoteHostBackend(collabSession, target.hostId);
      collabSession.onMessage(MSG.PROJECT, async (payload, fromId) => {
        if (fromId !== target.hostId || typeof payload?.id !== 'string') return;
        const shared = await loadProject(remote, payload.id).catch((err) => { console.error('Could not load the host\'s project', err); return null; });
        if (!shared || !collabSession) return;
        const first = !localSession;
        if (first) localSession = { backend, project };
        await switchToProject(shared, { save: first }); // first swap flushes the local project, while `backend` is still the local one
        backend = remote;
      });
      collabSession.onMessage(MSG.RESYNC, (_, fromId) => { if (fromId === target.hostId && localSession) reloadFromHost(); });
      await collabSession.join(target.hostId, target.token);
      if (uiPrefs.collabName) collabSession.setName(uiPrefs.collabName);
    } else {
      const hostBackend = backend;
      serveReads(collabSession, hostBackend, () => project.id, { beforeRead: flushForGuests(hostBackend) });
      collabSession.onMessage('participant-joined', ({ id }) => collabSession.sendTo(id, MSG.PROJECT, { id: project.id }));
      const hostId = await collabSession.host();
      if (uiPrefs.collabName) collabSession.setName(uiPrefs.collabName);
      await navigator.clipboard.writeText(makeJoinLink(hostId, collabSession.getToken()));
    }
  } catch (err) {
    console.error('Collab session failed to start', err);
    await endCollab();
    return;
  }
  startThrottle();
  redrawProjectPanel();
}

// Fixed range: 2 frames each direction, not user-configurable (§12.3).
const ONION_RANGE = 2;
function computeOnionFrames(file) {
  // T+Shift+Left/Right (multi-frame select) onion-ghosts every frame in the
  // selected range instead of the fixed ±2: "onion all" (§ new control
  // scheme), still focused on the active frame as the real (non-ghost) one.
  // This overrides the plain onion-skin toggle rather than requiring it:
  // a multi-frame selection is itself the signal to show the ghosts.
  const selRange = frameSelection.getRange();
  if (selRange) {
    const ghosts = [];
    for (let i = selRange.lo; i <= selRange.hi; i++) {
      if (i === file.activeFrameIndex) continue;
      ghosts.push({ side: i < file.activeFrameIndex ? 'before' : 'after', distance: Math.abs(i - file.activeFrameIndex), ...ghostSource(file, i, playback.onionLayerOnly) });
    }
    return ghosts;
  }
  if (!playback.onionSkin) return null;
  const ghosts = [];
  for (let d = 1; d <= ONION_RANGE; d++) {
    if (file.activeFrameIndex - d >= 0) {
      ghosts.push({ side: 'before', distance: d, ...ghostSource(file, file.activeFrameIndex - d, playback.onionLayerOnly) });
    }
    if (file.activeFrameIndex + d < file.frames.length) {
      ghosts.push({ side: 'after', distance: d, ...ghostSource(file, file.activeFrameIndex + d, playback.onionLayerOnly) });
    }
  }
  return ghosts;
}


const palette = createPalette(paletteBar, project.palette, () => autosave(), (hex) => {
  selectionApi.set(maskFromColor(model, hex));
  draw();
}, () => project.name);
const colors = { primary: () => palette.getPrimary() };

let contentDragSnapshot = null;
const selectionApi = {
  setLiveRect(x0, y0, x1, y1) {
    selectionMask = maskFromRect(model, x0, y0, x1, y1);
    selectionRender = toRenderSelection(model, selectionMask);
  },
  set(mask) {
    selectionMask = mask;
    selectionRender = toRenderSelection(model, mask);
  },
  clear() {
    selectionMask = null;
    selectionRender = null;
  },
  getMask: () => selectionMask,
  moveContentBy(dx, dy) {
    if (!contentDragSnapshot) contentDragSnapshot = snapshotPixels(model);
    selectionMask = moveContent(model, selectionMask, dx, dy);
    selectionRender = toRenderSelection(model, selectionMask);
    renderCanvas(); // live drag feedback only; commitContentMove does the full refresh
  },
  commitContentMove() {
    if (!contentDragSnapshot) return;
    const { before, after } = diffFromSnapshot(model, contentDragSnapshot);
    history.commit({ type: 'moveSelectionContent', before, after });
    contentDragSnapshot = null;
  },
};

// Undo/redo lives on the active SpriteFile (§5, §10): this just resolves it.
const history = {
  // Full refresh (thumbnails included) once per committed edit: not per
  // animation frame or per pointermove, which is what made this laggy
  // before (see the animateCursor comment further down).
  commit: (cmd) => {
    const file = getActiveFile(project);
    commitCommand(file, cmd);
    autosave(file);
    draw();
    strokeSync?.sendStroke(cmd, { fileId: file.name, frame: file.activeFrameIndex, layer: file.activeLayerIndex, colors: file.colors });
    if (cmd.type === 'layers' || cmd.type === 'resize') structureChanged();
  },
};

// Layer structural edits (add/delete/reorder) go through undo too, as a
// layer-stack snapshot (buffers by reference) rather than a pixel diff: snapshot before, run the
// mutation, snapshot after, hand both to history.commit.
// Undo or redo one step. When it changed the canvas size (a resize), the view,
// selection and panel thumbnails follow it.
async function stepHistory(step) {
  const file = getActiveFile(project);
  const { width, height } = model;
  // A popped command may be a layer/resize snapshot, which reassigns every
  // frame's layerPixels outright: any frame the cache has compressed must
  // be raw first, or that assignment throws (§ frame-cache.js's stub-style
  // accessor). Pixel-diff commands only touch the always-raw active frame,
  // so this is a no-op for those.
  await ensureAllFramesLoaded(file);
  // Peeked before the step pops it: an undo/redo changes this copy only, so
  // what it did has to be streamed like any other edit.
  const cmd = (step === undoCmd ? file.undoStack : file.redoStack).at(-1);
  if (!step(file, model)) return;
  if (cmd.type === 'layers' || cmd.type === 'resize') structureChanged();
  else strokeSync?.sendStroke({ type: cmd.type, after: step === undoCmd ? cmd.before : cmd.after }, { fileId: file.name, frame: file.activeFrameIndex, layer: file.activeLayerIndex, colors: file.colors });
  bindActiveFile();
  if (model.width !== width || model.height !== height) { resetView(); selectionApi.clear(); redrawProjectPanel(); }
  draw(); autosave(file);
}

// A resize is one undo step. Undoing it hands back the old buffers, so older
// steps in the stack (which address pixels in the old layout) stay valid.
// Every frame must be raw first: resizeCanvas rebuilds every frame's
// buffers, not just the active one's (§ frame-cache.js's hot window).
async function resizeWithUndo(file, w, h, anchor) {
  await ensureAllFramesLoaded(file);
  const before = snapshotResize(file);
  resizeCanvas(file, w, h, anchor);
  commitCommand(file, { type: 'resize', before, after: snapshotResize(file) });
}

// Fits `file` to its placed pixels as one undo step; false if there was nothing to trim.
async function trimWithUndo(file) {
  await ensureAllFramesLoaded(file); // trimCanvas reads every frame's pixels to find the bounding box
  const before = snapshotResize(file);
  if (!trimCanvas(file, MIN_CANVAS)) return false;
  commitCommand(file, { type: 'resize', before, after: snapshotResize(file) });
  return true;
}

// Layer structural edits touch every frame's layerPixels (a new layer's
// empty buffer, a deleted layer's slot), not just the active frame's.
async function commitLayerChange(file, mutate) {
  await ensureAllFramesLoaded(file);
  const before = snapshotLayers(file);
  mutate();
  const after = snapshotLayers(file);
  bindActiveFile();
  history.commit({ type: 'layers', before, after });
}

// The drawing surface in CSS pixels, as a whole number of device pixels. A
// backing store even one device pixel off the size the browser actually
// displays (clientWidth is rounded, and times a fractional devicePixelRatio it
// truncates) gets stretched to fit, which softens rows and columns unevenly
// across the whole canvas. Sizing from the real rect and drawing in units of
// exactly that many device pixels keeps every blit 1:1.
const view = { w: canvas.clientWidth, h: canvas.clientHeight }; // until the first resize() measures it exactly
function resize() {
  canvasRect = canvas.getBoundingClientRect();
  canvas.width = Math.round(canvasRect.width * devicePixelRatio);
  canvas.height = Math.round(canvasRect.height * devicePixelRatio);
  view.w = canvas.width / devicePixelRatio;
  view.h = canvas.height / devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  // A stored zoom is in CSS pixels, so a change of devicePixelRatio (browser zoom,
  // another monitor) leaves it off the stops; put it back on one.
  if (viewState.zoom) viewState.zoom = snapScale(viewState.zoom);
  if (groupViewState.zoom) groupViewState.zoom = snapScale(groupViewState.zoom);
  draw();
}

// Retro trailing brush cursor: the on-canvas cursor indicator eases toward
// the real pointer position instead of snapping to it instantly. This was
// originally an accidental side effect of an expensive per-move redraw
// (rebuilding the layers/timeline panels on every pointermove): that was a
// real perf bug, fixed by splitting the cheap per-frame canvas render
// (renderCanvas) from the expensive full refresh (draw, panels included,
// now only called once per committed action via history.commit). This is
// that same trailing look recreated on purpose, driven by a steady
// animation loop rather than dropped frames, so it looks the same at any
// frame rate and the amount of lag is one number to tune.
const CURSOR_TRAIL_EASE = 0.35; // 1 = no lag (snaps instantly), lower = laggier/more retro
const CURSOR_SETTLE = 0.01; // the easing is asymptotic; snap once this close so the loop can go idle
let displayCursorPos = null;

// The loop below draws only when this is set or something is mid-animation.
// A blanket input listener (see the end of the loop) sets it, so state
// changes that never called renderCanvas() themselves still show up.
let needsRender = true;
let antsMarching = false;
const requestRender = () => { needsRender = true; };

function renderCanvas() {
  antsMarching = false;
  if (activeGroupId) { renderGroupCanvas(); return; }
  // The canvas always shows the composited result of every visible layer
  // (§11), while `model` (the active layer's own raw buffer) is what
  // painting/selection/undo actually mutate.
  const file = getActiveFile(project);
  if (file._stub) return; // still loading: bindActiveFile redraws when it lands
  const display = { width: model.width, height: model.height, pixels: compositeFrame(file) };
  const onionFrames = computeOnionFrames(file);
  const brushCursor = { mode: (inputController && inputController.getMode()) || 'place', size: brushSize };
  antsMarching = render(ctx, display, view.w, view.h, {
    showGrid, showRuler, symmetry: paintOptions.symmetry, references: drawableReferences(file), hoverPixel, selection: selectionRender, onionFrames, brushCursor, cursorPos: displayCursorPos, canvasBg: canvasBgCycler.get(), appBg: appBgCycler.get(),
  });
  updateToolTag();
}

// Read-only grid view of a Collection's files (§ project panel group
// select): no editing tool touches these pixels, this is display only.
// `groupId` defaults to whichever collection is actively open in the group
// grid, but export.js's collection export needs this for an arbitrary
// collection without first entering group view for it.
function groupArtboards(groupId = activeGroupId) {
  const combined = projectOrder(project); // order-sorted [header|file] view
  const artboards = [];
  combined.forEach((entry) => {
    if (entry.isHeader || entry.item.groupId !== groupId) return;
    const f = entry.item;
    // `fileIndex` isn't read by renderArtboardGrid itself: carried through
    // purely so double-clicking an artboard (§ canvas dblclick, below) can
    // jump straight to the right File without a fragile lookup by name.
    const fileIndex = project.files.indexOf(f);
    // A File not loaded yet shows blank and fills in when it arrives (load
    // on view).
    if (f._stub) loadForGrid(f);
    artboards.push({ name: f.name, width: f.visibleWidth, height: f.visibleHeight, pixels: f._stub ? blankPixels(f.visibleWidth, f.visibleHeight) : compositeFrame(f), fileIndex });
  });
  return artboards;
}

// This runs on every render, tool-tag update and pointer move over the grid,
// so it must not do per-call work per file: a stub's placeholder is one shared
// array per size (stable identity, so the renderer's per-board cache holds),
// and each stub's load is requested once, with one coalesced redraw for however
// many land in the same frame instead of a redraw (and a re-walk of every
// file) per load per call.
const blanks = new Map();
const blankPixels = (w, h) => {
  const key = w + 'x' + h;
  if (!blanks.has(key)) blanks.set(key, new Uint32Array(w * h));
  return blanks.get(key);
};
const loadRequested = new WeakSet();
let gridRedrawQueued = false;
function loadForGrid(file) {
  if (loadRequested.has(file)) return;
  loadRequested.add(file);
  ensureLoaded(file).then(() => {
    loadRequested.delete(file);
    if (gridRedrawQueued) return;
    gridRedrawQueued = true;
    requestAnimationFrame(() => { gridRedrawQueued = false; if (activeGroupId) renderCanvas(); });
  });
}

// The whole laid-out grid, treated as one "model" purely so the existing
// fit/min/max zoom-bound math (viewport.js, written for the single-file
// canvas) applies unchanged to panning/zooming the collection as a whole.
function groupLayoutModel(artboards = groupArtboards()) {
  const layout = computeArtboardLayout(artboards);
  return { width: Math.max(1, layout.totalW), height: Math.max(1, layout.totalH) };
}

// This is an overview, not a single sprite being edited: "fit" leaves a
// margin around the whole grid instead of running it edge-to-edge (which is
// what the single-file canvas's own fitScale does, floored to whole pixels
// and never below 1:1: both wrong here: a large collection needs to shrink
// below 1:1 to fit at all, and it should never fit flush to the viewport).
const GROUP_FIT_PADDING = 96; // screen px margin on every side at "fit" zoom
function groupFitScale(layoutModel, viewW, viewH) {
  return snapScale(Math.max(0.05, Math.min((viewW - GROUP_FIT_PADDING * 2) / layoutModel.width, (viewH - GROUP_FIT_PADDING * 2) / layoutModel.height)), undefined, -1);
}

// Dragging a canvas around the collection grid to reorder it: `from` is its slot when
// picked up, `to` the slot it hovers over (the others shift to make room), and (x, y)
// the pointer in canvas pixels. Nothing changes in the project until it is dropped.
let gridDrag = null; // { from, to, startX, startY, x, y, started }
const GRID_DRAG_THRESHOLD = 4; // px before a press becomes a drag

function renderGroupCanvas() {
  const artboards = groupArtboards();
  const dragging = gridDrag && gridDrag.started;
  if (dragging) artboards.splice(gridDrag.to, 0, ...artboards.splice(gridDrag.from, 1));
  const rect = canvas.getBoundingClientRect();
  const scale = groupViewState.zoom || groupFitScale(groupLayoutModel(artboards), rect.width, rect.height);
  renderArtboardGrid(ctx, view.w, view.h, artboards, {
    appBg: groupAppBgCycler.get(), scale, panX: groupViewState.panX, panY: groupViewState.panY,
    lift: dragging ? { index: gridDrag.to, x: gridDrag.x, y: gridDrag.y } : null,
  });
  updateToolTag();
}

function groupZoomTo(nextScale) {
  const rect = canvas.getBoundingClientRect();
  const layoutModel = groupLayoutModel();
  const fit = groupFitScale(layoutModel, rect.width, rect.height);
  const min = minZoomScale(layoutModel, rect.width, rect.height);
  const max = maxZoomScale(layoutModel, rect.width, rect.height);
  groupViewState.zoom = snapScale(Math.max(min, Math.min(max, nextScale)));
  if (Math.abs(groupViewState.zoom - fit) < 0.01) { groupViewState.zoom = fit; groupViewState.panX = 0; groupViewState.panY = 0; }
  draw();
}
function groupZoomStep(dir) {
  const rect = canvas.getBoundingClientRect();
  const current = groupViewState.zoom || groupFitScale(groupLayoutModel(), rect.width, rect.height);
  groupZoomTo(stepScale(current, current * (dir > 0 ? 1.15 : 1 / 1.15)));
}

function draw() {
  // Full refresh: cheap canvas render plus the layers/timeline panel
  // rebuilds (thumbnails etc.): only called once per committed action
  // (see history.commit below), not per animation frame or per pointermove.
  renderCanvas();
  redrawLayersPanel();
  redrawTimelinePanel();
}

(function animateCursor() {
  // The group grid has nothing that animates (no cursor trail, nothing
  // live), so redrawing it 60x/sec here is pure waste. Every state change
  // it cares about (zoom, pan, backdrop cycle, selecting a different group)
  // already calls draw()/renderCanvas() on its own, so skipping this loop's
  // call entirely while it's showing loses nothing.
  if (!activeGroupId) {
    if (hoverPixel) {
      if (!displayCursorPos) displayCursorPos = { x: hoverPixel.x, y: hoverPixel.y };
      const dx = hoverPixel.x - displayCursorPos.x, dy = hoverPixel.y - displayCursorPos.y;
      if (dx || dy) {
        const settled = Math.abs(dx) < CURSOR_SETTLE && Math.abs(dy) < CURSOR_SETTLE;
        displayCursorPos.x = settled ? hoverPixel.x : displayCursorPos.x + dx * CURSOR_TRAIL_EASE;
        displayCursorPos.y = settled ? hoverPixel.y : displayCursorPos.y + dy * CURSOR_TRAIL_EASE;
        needsRender = true;
      }
    } else if (displayCursorPos) {
      displayCursorPos = null;
      needsRender = true;
    }
    if (needsRender || antsMarching) {
      needsRender = false;
      renderCanvas();
    }
  }
  if (collabSession) {
    const t = performance.now();
    if (lastFrameAt) frameMsAvg += ((t - lastFrameAt) - frameMsAvg) * 0.1;
    lastFrameAt = t;
  }
  if (collabSession && hoverPixel) {
    const now = performance.now();
    if (now - lastCursorSendAt >= cursorIntervalMs) {
      lastCursorSendAt = now;
      collabSession.send(MSG.CURSOR, { x: hoverPixel.x, y: hoverPixel.y });
    }
  }
  if (collabSession) updateRemoteCursorOverlay();
  requestAnimationFrame(animateCursor);
})();

// One absolutely-positioned box + name label per remote cursor, laid over
// the canvas element, in that participant's presence.js color. DOM rather
// than a renderer.js draw call (renderer.js's draw object doesn't know about
// collab, and a positioned div with text is what HTML already does well).
const collabCursorEls = new Map(); // participant id -> element
function updateRemoteCursorOverlay() {
  const rect = canvas.getBoundingClientRect();
  const viewport = computeViewport(model, rect.width, rect.height);
  const seen = new Set();
  for (const [id, pos] of remoteCursors) {
    seen.add(id);
    let el = collabCursorEls.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'collab-cursor';
      el.append(document.createElement('span'));
      canvas.parentElement.append(el);
      collabCursorEls.set(id, el);
    }
    const who = collabSession.getParticipants().find((p) => p.id === id);
    if (who) { el.style.setProperty('--collab-color', presenceColor(who)); el.firstChild.textContent = who.name; }
    el.style.left = `${viewport.ox + pos.x * viewport.scale}px`;
    el.style.top = `${viewport.oy + pos.y * viewport.scale}px`;
    el.style.width = `${Math.max(viewport.scale, 1)}px`;
    el.style.height = `${Math.max(viewport.scale, 1)}px`;
  }
  for (const [id, el] of collabCursorEls) {
    if (!seen.has(id)) { el.remove(); collabCursorEls.delete(id); }
  }
}

// Any input can change what the canvas shows (hover, zoom, tool, colour,
// toggles), and most handlers rely on the loop noticing rather than calling
// renderCanvas() themselves: so treat every input event as a render request.
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'wheel', 'input', 'change', 'click']) {
  window.addEventListener(type, requestRender, { capture: true, passive: true });
}

// redrawProjectPanel() fully rebuilds the panel's DOM (innerHTML=''),
// resetting scroll to the top: used after that rebuild to bring a specific
// file or collection row back into view instead of leaving the list stuck
// at the top. Shared by new-file creation and inline rename.
function scrollProjectRowIntoView({ scrollToFileIndex, scrollToCollectionId } = {}) {
  const selector = scrollToFileIndex != null ? `[data-file-index="${scrollToFileIndex}"]`
    : scrollToCollectionId != null ? `[data-collection-id="${scrollToCollectionId}"]`
    : null;
  const row = selector && projectPanel.querySelector(selector);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// The Collection a new File should join by default: whichever one is
// currently being worked on: the open group grid, or the active File's own
// Collection: rather than always whichever Collection happens to sit last
// in display order.
function currentCollectionId() {
  if (activeGroupId) return activeGroupId;
  projectOrder(project); // refreshes each file's derived .groupId
  const file = getActiveFile(project);
  if (file && file.groupId != null) return file.groupId;
  const lc = lastCollection(project);
  return lc ? lc.id : null;
}

// Shared by the size picker's fixed presets and its Current option: both
// just resolve a (w, h) differently, then land the new File the same way. An
// open collection grid stays open and gains the new canvas.
function commitNewFile(w, h, preset) {
  const collectionId = currentCollectionId();
  addFile(project, nextName('Canvas', project.files.map((f) => f.name)), w, h, collectionId);
  if (preset && preset.palette) palette.loadPreset(preset.palette); // console sizes bring their palette
  bindActiveFile();
  resetView();
  redrawProjectPanel();
  scrollProjectRowIntoView({ scrollToFileIndex: project.activeFileIndex });
  draw();
  autosave();
}

// Makes File `i` the active one, keeping the current zoom/pan: shared by
// a plain file-row click and double-clicking an artboard in the group grid
// (§ canvas dblclick listener, below).
function selectFile(i) {
  project.activeFileIndex = i;
  fileSelection = null; // switching file drops any multi-select
  setActiveGroup(null); // selecting a file exits the read-only group grid
  bindActiveFile(); selectionApi.clear(); redrawProjectPanel(); draw();
}

function redrawProjectPanel() {
  renderProjectPanel(projectPanel, project, {
    onChange: (scrollTo) => {
      bindActiveFile(); resetView(); selectionApi.clear(); redrawProjectPanel();
      if (scrollTo) scrollProjectRowIntoView(scrollTo);
      draw();
      if (exportReveal && exportReveal.isFocused()) redrawExportPanel();
    },
    onSelectFile: (i) => selectFile(i),
    onShiftSelectFile: (targetIndex) => shiftSelectFile(targetIndex),
    onAltSelectFile: (targetIndex) => altSelectFile(targetIndex),
    onSelectGroup: (id) => {
      setActiveGroup(id); // restores (or resets) that collection's own zoom/pan
      redrawProjectPanel(); draw();
    },
    onAddFile: (w, h, preset) => commitNewFile(w, h, preset),
    // The panel's import button: a spritesheet (new File) or a whole .sprite project.
    onImport: (anchor) => pickFile('image/*,.sprite,.json', (f) => (isImageFile(f) ? importSpritesheet(f, { mode: 'frames', anchor }) : importProjectFile(f))),
    onSplitProject: () => splitProject(),
    onGoLive: () => toggleGoLive(),
    collabState: collabState(),
    collabParticipants: () => collabSession?.getParticipants().sort((a, b) => (a.role === 'host' ? 0 : a.slot || 1) - (b.role === 'host' ? 0 : b.slot || 1)).map((p) => ({ ...p, color: presenceColor(p), isSelf: p.id === collabSession.getSelfId() })) || [],
    onKick: kickGuest,
    onRenameSelf: (name) => { uiPrefs.collabName = name; saveUiPrefs(uiPrefs); collabSession?.setName(name); },
    // Double click on New File: same size as whichever canvas was last worked
    // on, wherever it lives; the new-project default only if nothing was.
    onAddFileCurrent: () => {
      const ref = mostRecentFileIn(project);
      commitNewFile(ref ? ref.visibleWidth : DEFAULT_CANVAS_SIZE, ref ? ref.visibleHeight : DEFAULT_CANVAS_SIZE);
    },
    onResizeFile: async (file, w, h, anchor) => {
      await ensureLoaded(file);
      await resizeWithUndo(file, w, h, anchor);
      if (file === getActiveFile(project)) { bindActiveFile(); resetView(); selectionApi.clear(); } // a selection mask is sized for the old canvas
      redrawProjectPanel();
      draw();
      autosave();
    },
    onTrimFile: async (file) => {
      await ensureLoaded(file);
      if (!(await trimWithUndo(file))) { flashTip('Nothing to trim'); return; }
      if (file === getActiveFile(project)) { bindActiveFile(); resetView(); selectionApi.clear(); }
      redrawProjectPanel(); draw(); autosave();
    },
    onExportFile: (file, i) => {
      project.activeFileIndex = i;
      setActiveGroup(null);
      bindActiveFile(); resetView(); selectionApi.clear(); redrawProjectPanel(); draw();
      openExport({ kind: 'file', file, fps: playback.fps });
    },
    onExportCollection: async (collection) => {
      await Promise.all(projectOrder(project).filter((e) => !e.isHeader && e.item.groupId === collection.id).map((e) => ensureLoaded(e.item)));
      openExport({ kind: 'collection', name: collection.name, artboards: groupArtboards(collection.id) });
    },
    onReorder: (from, to) => { moveProjectItem(project, from, to); redrawProjectPanel(); draw(); autosave(); },
    onRemoveFile: (i) => {
      deleteFile(project, i);
      bindActiveFile(); resetView(); selectionApi.clear(); redrawProjectPanel(); draw();
      autosave();
    },
    onAddCollection: () => { addCollection(project); redrawProjectPanel(); autosave(); },
    onDeleteCollection: (id) => {
      deleteCollection(project, id);
      if (activeGroupId === id) { setActiveGroup(null); draw(); }
      redrawProjectPanel();
      autosave();
    },
    onOpenProject: (anchor) => openProjectPicker(anchor),
    workDirName: backend.name,
    onReadBackupWarning: () => setHint('menu'),
    onPickWorkDir: window.showDirectoryPicker && pickWorkDir,
  }, focusedCollectionId(), activeGroupId, fileSelection);
}

// The backend is chosen once at startup (chooseBackend), so a new folder takes
// effect through a reload, after the outgoing project's edits are flushed.
async function pickWorkDir() {
  setHint('menu');
  try {
    await saveProject(backend, project);
    if (!await connectFolder()) return;
  } catch (err) {
    if (err.name !== 'AbortError') flashTip('Could not use that folder');
    return;
  }
  location.reload();
}

// Shift+click a file (§ buildFileRow): select it and every file between it
// and the current active file: but only within one Collection. Different
// collection (or the target IS the current file, i.e. no real range) is a
// no-op, same as this app's other "nothing to do" guards rather than doing
// something surprising.
function shiftSelectFile(targetIndex) {
  projectOrder(project); // refreshes every file's derived .groupId
  const currentFile = project.files[project.activeFileIndex];
  const targetFile = project.files[targetIndex];
  if (!currentFile || !targetFile || currentFile.groupId == null || currentFile.groupId !== targetFile.groupId) return;
  const members = visibleOrder(projectOrder(project))
    .filter((e) => !e.isHeader && e.item.groupId === currentFile.groupId)
    .map((e) => e.item);
  const a = members.indexOf(currentFile), b = members.indexOf(targetFile);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  fileSelection = new Set(members.slice(lo, hi + 1).map((f) => project.files.indexOf(f)));
  openFileSelectionMenu(targetIndex);
}

// Alt+click a file (§ buildFileRow): add it to whatever's already
// multi-selected (starting from just the current active file if nothing
// was yet): unlike Shift, not restricted to one collection.
function altSelectFile(targetIndex) {
  if (!fileSelection) fileSelection = new Set([project.activeFileIndex]);
  fileSelection.add(targetIndex);
  openFileSelectionMenu(targetIndex);
}

// Clicking away from a multi-select menu without picking anything collapses
// the selection back down too: passed as every such menu's `onDismiss`.
function dismissFileSelection() {
  fileSelection = null;
  redrawProjectPanel();
}

// Resize/Export/Remove all for the whole multi-selection, anchored (chevron
// included, same as every other row menu) at whichever file was most
// recently added to it: the same "⋯" menu shape a single file gets, just
// scoped wider. Every action ends the multi-select the same way dismissing
// it does: the menu was for this one operation.
function openFileSelectionMenu(lastAddedIndex) {
  redrawProjectPanel();
  const anchor = projectPanel.querySelector(`[data-file-index="${lastAddedIndex}"]`);
  if (!anchor || !fileSelection) return;
  const files = [...fileSelection].map((i) => project.files[i]).filter(Boolean);
  openSlideOut(anchor, [
    { label: 'Resize', onClick: () => openMultiResizePopup(anchor, files) },
    { label: 'Export', onClick: () => exportSelectedFiles(files) },
    { label: 'Remove all', onClick: () => removeSelectedFiles(files) },
  ], { onDismiss: dismissFileSelection });
}

function openMultiResizePopup(anchor, files) {
  openSizePopup(anchor, async (w, h, _preset, where) => {
    await Promise.all(files.map(ensureLoaded));
    for (const file of files) {
      await resizeWithUndo(file, w, h, where);
    }
    fileSelection = null;
    bindActiveFile(); resetView(); selectionApi.clear(); redrawProjectPanel(); draw(); autosave();
  }, {
    onDismiss: dismissFileSelection,
    anchored: true,
    onTrim: async () => {
      await Promise.all(files.map(ensureLoaded));
      const trimmed = (await Promise.all(files.map(trimWithUndo))).filter(Boolean).length;
      fileSelection = null;
      if (!trimmed) flashTip('Nothing to trim');
      bindActiveFile(); resetView(); selectionApi.clear(); redrawProjectPanel(); draw(); autosave();
    },
  });
}

// One PNG download per selected file (the same default 'e' itself exports
// a single active file with): a full per-file format/scale picker for a
// multi-export is more than this needed yet.
async function exportSelectedFiles(files) {
  for (const file of files) await exportFile(file, { format: 'png', scale: 1, mode: 'canvas' });
  fileSelection = null;
  redrawProjectPanel();
}

// Descending index order: deleting high indices first means earlier ones
// never shift out from under the next delete. deleteFile's own "at least
// one file" guard already stops short of emptying the project entirely.
function removeSelectedFiles(files) {
  const indices = files.map((f) => project.files.indexOf(f)).filter((i) => i >= 0).sort((a, b) => b - a);
  for (const i of indices) deleteFile(project, i);
  fileSelection = null;
  bindActiveFile(); resetView(); selectionApi.clear(); redrawProjectPanel(); draw();
  autosave();
}

// The collection header currently under keyboard focus (Tab held, Up/Down
// navigated onto it): null whenever focus is on a file instead, or Tab
// hasn't been used to navigate at all this hold.
function focusedCollectionId() {
  if (tabFocusPos === null) return null;
  const list = visibleOrder(projectOrder(project));
  const entry = list[tabFocusPos];
  return entry && entry.isHeader ? entry.item.id : null;
}
redrawProjectPanel();

// What the Export panel is currently showing: a File, a Collection, or
// the whole Project (§ export-panel.js's own `target` shapes): so a
// generic refresh (e.g. onChange, below, whenever anything the panel might
// be displaying could have changed) knows what to re-render without every
// caller having to re-supply it.
let exportTarget = null;
function redrawExportPanel() {
  if (exportTarget) renderExportPanel(exportPanel, exportTarget);
}

// Opens the Export panel already showing `target`, docked beside the
// Project panel (which it reveals/pins open too, since Export only makes
// sense next to it). Switching to a new target while already open just
// re-points it, rather than toggling closed: only the plain "E" shortcut
// (toggleExportForActiveFile, below) toggles.
let exportOpenedProject = false; // Export had to open the Project panel to sit beside it
function openExport(target) {
  if (openProjectReveal.isPinned()) openProjectReveal.forceHide(); // same docked slot: mutually exclusive
  exportTarget = target;
  if (!exportReveal.isPinned()) exportOpenedProject = !projectReveal.isPinned();
  projectReveal.setPinned(true);
  exportReveal.setPinned(true);
  redrawExportPanel();
}

// A click anywhere outside the Export panel closes it (and the Project panel too, if Export was what opened it).
// The Project panel, menus and dialogs spawned from Export count as inside.
document.addEventListener('pointerdown', (e) => {
  if (!exportReveal || !exportReveal.isPinned()) return;
  if (e.target.closest('#export-panel, #project-panel, .slide-out-bar, .modal-overlay')) return;
  exportReveal.forceHide();
  if (exportOpenedProject) projectReveal.forceHide();
  exportOpenedProject = false;
}, true);

function toggleExportForActiveFile() {
  if (exportReveal.isPinned()) { exportReveal.forceHide(); return; }
  openExport({ kind: 'file', file: getActiveFile(project), fps: playback.fps });
}

async function redrawOpenProjectPanel() {
  const registry = await listProjects(backend);
  const otherProjects = registry.filter((entry) => entry.id !== project.id).sort((a, b) => b.updatedAt - a.updatedAt);
  renderOpenProjectPanel(openProjectPanel, otherProjects, async (entry) => {
    const p = await loadProject(backend, entry.id);
    if (p) await switchToProject(p);
    openProjectReveal.forceHide();
  }, async (entry) => {
    await deleteProject(backend, entry.id);
    redrawOpenProjectPanel();
  }, () => {
    openProjectReveal.forceHide();
    newProject();
  });
}

// "Open" (project panel menu, § openProjectPicker below): docks the list of
// other saved projects beside Project, same treatment as Export (openExport
// above) rather than a floating slide-out menu: switching projects is a
// real navigation action with its own list, not a one-off pick.
function openProjectListPanel() {
  if (openProjectReveal.isPinned()) { openProjectReveal.forceHide(); return; }
  if (exportReveal.isPinned()) exportReveal.forceHide(); // same docked slot: mutually exclusive
  projectReveal.setPinned(true);
  openProjectReveal.setPinned(true);
  redrawOpenProjectPanel();
}

// --- Project switching (§ ProjectSwitching, Tab+N/Tab+O) ---
// Only one project is ever open at a time (no simultaneous multi-project),
// but every saved project persists in the registry indefinitely: switching
// away doesn't touch the old one, it just stops being what's on screen.
async function switchToProject(newProject, { save = true } = {}) {
  if (save) await saveProject(backend, project); // flush the outgoing project's latest edits first
  project = newProject;
  uiPrefs.lastProjectId = project.id;
  saveUiPrefs(uiPrefs);
  palette.setState(project.palette);
  setActiveGroup(null); // a different project has no relation to the previous one's group view
  bindActiveFile();
  resetView();
  selectionApi.clear();
  redrawProjectPanel();
  redrawLayersPanel();
  redrawTimelinePanel();
  draw();
  if (collabSession?.getRole() === 'host') collabSession.send(MSG.PROJECT, { id: project.id });
  autosave();
}

// Capacity meter's offer at 100%: each Collection becomes its own Project,
// Files at the Project root stay here. New Projects are saved before the
// moved Files' old copies are deleted, so a failure never loses a File.
async function splitProject() {
  setActiveGroup(null); // read collections before splitByCollection empties them
  const { parts, moved } = splitByCollection(project);
  for (const part of parts) await saveProject(backend, part);
  await Promise.all(moved.map((file) => deleteStoredFile(backend, project.id, file)));
  bindActiveFile();
  resetView();
  selectionApi.clear();
  redrawProjectPanel();
  redrawLayersPanel();
  redrawTimelinePanel();
  draw();
  autosave();
}

// Import (project panel menu): a real system file-picker dialog
// (<input type="file">: the native/platform picker, no custom UI of its
// own), accepting the same whole-project .sprite archive
// exportProjectSprite (Tab+Shift+E) writes: its inverse: or a
// pre-archive plain-JSON whole-project export, for anything exported
// before that format existed. Routed through saveProject+loadProject
// rather than switched to directly, so an imported project picks up the
// same field defaults/migrations every other saved project gets on load.
const importProject = () => pickFile('.sprite,.json,application/json', importProjectFile);

// The project inside a `.sprite` archive (or a pre-archive plain JSON export), as saved data.
function projectFromArchive(bytes) {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B; // 'PK': zip local-file-header signature
  if (!isZip) {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    data.files = data.files.map((f) => parseFile(f, null));
    return data;
  }
  const entries = unzipSync(bytes);
  const decode = (name) => JSON.parse(new TextDecoder().decode(entries[name]));
  const meta = decode('project.json');
  return {
    name: meta.name, palette: meta.palette, activeFileIndex: meta.activeFileIndex,
    collections: meta.collections, files: meta.fileNames.map((name) => parseFile(decode(`${name}.sprite`), (kind, id) => entries[kind === 'chunk' ? `${name}.sprite.${id}` : kind === 'frame' ? `${name}.sprite.frame-${id}` : `${name}.sprite.bin`] ?? null)),
  };
}

// First run: the project that ships with the app (starter/), saved as the user's own copy.
// Null if it cannot be fetched or read, and the caller starts an empty project instead.
async function loadStarterProject() {
  try {
    const res = await fetch('starter/sprite-ui.sprite');
    if (!res.ok) return null;
    const starter = { ...projectFromArchive(new Uint8Array(await res.arrayBuffer())), id: crypto.randomUUID(), name: 'Sprite UI' };
    await saveProject(backend, starter);
    return await loadProject(backend, starter.id);
  } catch (err) {
    console.error('Could not load the starter project:', err);
    return null;
  }
}

async function importProjectFile(file) {
  try {
    const data = projectFromArchive(new Uint8Array(await file.arrayBuffer()));
    // Fresh id: importing an exported copy of a still-open (or
    // previously-imported) project shouldn't collide with it in the registry.
    const imported = { ...data, id: crypto.randomUUID() };
    await saveProject(backend, imported);
    const p = await loadProject(backend, imported.id);
    if (p) await switchToProject(p);
  } catch (err) {
    console.error('Import failed: not a project archive/JSON file:', err);
  }
}

async function newProject() {
  setHint('colors');
  // Iterative naming (matches how new files/layers avoid colliding, just
  // checked against the real saved-project registry instead of an index):
  // "New Project", then "New Project 2", "New Project 3", ... rather than
  // every click producing another project literally named "New Project".
  const registry = await listProjects(backend);
  const existing = new Set(registry.map((entry) => entry.name));
  let name = 'New Project';
  for (let n = 2; existing.has(name); n++) name = `New Project ${n}`;
  const p = createProject(name);
  await saveProject(backend, p);
  await switchToProject(p);
}

// Spritesheet -> a new File in the current Collection (never into the open
// File). The grid is auto-detected from transparent gutters; only if that
// fails does a slide-out ask, carrying the numeric fields.
async function importSpritesheet(file, { mode = 'frames', anchor, whole = false } = {}) {
  try {
    const bitmap = await decodeImage(file, { maxPixels: 16_000_000 });
    const image = bitmapPixels(bitmap);
    bitmap.close();
    // `whole`: the image is one canvas, not a sheet to slice: no detection, no question.
    let grid = whole ? { cellW: image.width, cellH: image.height, margin: 0, spacing: 0 } : detectGrid(image.data, image.width, image.height);
    if (!grid) {
      const answer = await askSheetGrid(anchor, { cellW: image.width, cellH: image.height, margin: 0, spacing: 0, mode });
      if (!answer) return;
      grid = answer;
      mode = answer.mode;
    }
    const sheet = buildSheetFile(uniqueFileName(project, paletteNameFromFile(file.name)), image, grid, mode, project.palette.chips);
    const collectionId = currentCollectionId();
    addExistingFile(project, sheet, collectionId);
    bindActiveFile();
    resetView();
    redrawProjectPanel();
    scrollProjectRowIntoView({ scrollToFileIndex: project.activeFileIndex });
    draw();
    autosave();
  } catch (err) {
    console.error('Spritesheet import failed:', err);
    flashTip(err.message);
  }
}

// --- File drag-and-drop -------------------------------------------------
// Each panel is an unambiguous target (the `drop` event fires on the element
// under the pointer): Colors takes palette files and images (extract);
// Layers takes images (reference); Canvas takes images (reference) and
// .sprite projects; Projects takes images (spritesheet -> new File) and
// .sprite projects. Timeline isn't a target: it has a button instead.
// Hovering a drag over a panel (or its edge) focuses it, which reveals it.
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

// Handles must be requested synchronously inside the drop event, so this
// collects the promises first; the caller awaits them afterward.
function droppedEntries(dataTransfer) {
  return [...dataTransfer.items].filter((item) => item.kind === 'file').map((item) => {
    const handle = item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
    const file = item.getAsFile();
    return Promise.resolve(handle).then((h) => ({ file, handle: h && h.kind === 'file' ? h : null })).catch(() => ({ file, handle: null }));
  });
}

async function handleDrop(target, pending) {
  const isProject = (f) => /\.(sprite|json)$/i.test(f.name);
  for (const { file, handle } of await Promise.all(pending)) {
    if (!file) continue;
    const image = isImageFile(file);
    if (target === 'colors' && (image || /\.(gpl|hex|pal|txt)$/i.test(file.name))) palette.importFile(file).catch((err) => { console.error('Palette import failed:', err); flashTip(err.message); });
    else if ((target === 'layers' || target === 'canvas') && image) await addReferenceFrom(file, handle);
    else if (target === 'projects' && image) await importSpritesheet(file, { mode: 'frames', anchor: projectPanel });
    else if ((target === 'canvas' || target === 'projects') && isProject(file)) await importProjectFile(file);
  }
}

const DROP_ZONES = { colors: [paletteBar, 'palette-trigger'], layers: [layersPanel, 'layers-trigger'], projects: [projectPanel, 'project-trigger'], canvas: [canvas, null] };
for (const [name, [el, triggerId]] of Object.entries(DROP_ZONES)) {
  const zones = [el, triggerId && document.getElementById(triggerId)].filter(Boolean);
  for (const zone of zones) {
    zone.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      if (name !== 'canvas' && focusedPanel !== name) setFocus(name);
    });
    zone.addEventListener('dragleave', (e) => {
      if (name !== 'canvas' && focusedPanel === name && !zones.some((z) => z.contains(e.relatedTarget))) setFocus('canvas');
    });
    zone.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const pending = droppedEntries(e.dataTransfer);
      if (focusedPanel !== 'canvas') setFocus('canvas');
      handleDrop(name, pending);
    });
  }
}
// A drop anywhere else must not navigate the tab to the dropped file.
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

function openProjectPicker(anchor) {
  setHint('new');
  const options = [
    { label: 'New', className: 'hint-target', keys: 'Alt++', onClick: () => newProject() },
    { label: 'Import', onClick: () => openImportMenu(anchor) },
    // Docks the actual project list beside Project (openProjectListPanel):
    // not flattened into this menu (projects aren't fixed one-off actions
    // like New/Import, and the list can be long).
    { label: 'Open', keys: '\\', onClick: () => openProjectListPanel() },
  ];
  // Right (the default): snapped to the project panel's own outer edge
  // with a chevron pointing back at the button, same treatment as every
  // other row menu: not the floating-popup feel `{ side: 'up' }` gave it.
  openSlideOut(anchor, options);
}

// Chained slide-outs from the same anchor: each replaces the last, so
// Import > Sheet reads as drilling down rather than stacking menus.
function openImportMenu(anchor) {
  openSlideOut(anchor, [
    { label: 'Project', onClick: () => importProject() },
    { label: 'Canvas', onClick: () => pickFile('image/*', (f) => importSpritesheet(f, { mode: 'frames', anchor, whole: true })) },
    { label: 'Sheet', onClick: () => openSheetMenu(anchor) },
    { label: 'Reference', onClick: () => importReference() },
    { label: 'Palette', onClick: () => palette.pickAndImport() },
  ]);
}

function openSheetMenu(anchor) {
  openSlideOut(anchor, [
    { label: '> Frames', onClick: () => pickFile('image/*', (f) => importSpritesheet(f, { mode: 'frames', anchor })) },
    { label: '> Layers', onClick: () => pickFile('image/*', (f) => importSpritesheet(f, { mode: 'layers', anchor })) },
  ]);
}

function redrawLayersPanel(force = false) {
  const file = getActiveFile(project);
  if (file._stub) return; // still loading
  if (!force && !(layersReveal && layersReveal.isFocused())) { layersStale = true; return; }
  layersStale = false;
  renderLayersPanel(layersPanel, file, {
    onAddLayer: () => commitLayerChange(file, () => addLayer(file)),
    onSelect: (i) => { file.activeLayerIndex = i; multiLayerSelection = null; bindActiveFile(); redrawLayersPanel(); },
    onSelectGroup: (id) => {
      backslashFocusPos = visibleOrder(layerOrder(file)).findIndex((entry) => entry.isHeader && entry.item.id === id);
      layerSelection = null;
      redrawLayersPanel();
    },
    onShiftSelectLayer: (i) => shiftSelectLayer(i),
    onAltSelectLayer: (i) => altSelectLayer(i),
    onToggleVisible: (i) => { file.layers[i].visible = !file.layers[i].visible; draw(); autosave(); },
    onToggleVisibleSelection: () => toggleSelectedLayersVisibility(),
    onDelete: (i) => commitLayerChange(file, () => deleteLayer(file, i)),
    onReorder: (from, to) => commitLayerChange(file, () => moveLayerItem(file, from, to)),
    onRename: () => { redrawLayersPanel(); autosave(); },
    // Live drag feedback is cheap (canvas only); autosave/thumbnail
    // refresh happens once when the drag ends, not on every tick.
    onOpacityChange: (i, value) => { file.layers[i].opacity = value; renderCanvas(); },
    onOpacityCommit: () => { redrawLayersPanel(); autosave(); },
    onAddGroup: () => { addLayerGroup(file); redrawLayersPanel(); autosave(); },
    onImportReference: () => importReference(),
    onSelectReference: (id) => {
      activeReferenceId = id;
      const ref = referencesOf(file).find((r) => r.id === id);
      resolveReference(ref, { interactive: true }).finally(() => draw());
    },
    onToggleReferenceMode: (id) => toggleReferenceMode(id),
    onReorderReference: (from, to) => { reorderReference(file, from, to); draw(); autosave(); },
    onRemoveReference: (id) => { removeReference(file, id); if (activeReferenceId === id) activeReferenceId = null; draw(); autosave(); },
    // Both can change what's actually composited (a deleted group's members
    // re-render at full visibility; a hidden group's members stop
    // rendering), so a full draw(): which also redraws this panel: not
    // just a plain redrawLayersPanel().
    onDeleteGroup: (id) => { deleteLayerGroup(file, id); draw(); autosave(); },
    onToggleGroupVisible: (id) => {
      const g = file.layerGroups.find((group) => group.id === id);
      g.visible = !g.visible;
      draw(); autosave();
    },
    onChange: () => { redrawLayersPanel(); autosave(); },
  }, focusedGroupId(), layerSelection, multiLayerSelection, activeReferenceId);
}

function toggleReferenceMode(id = activeReferenceId) {
  const ref = referencesOf(getActiveFile(project)).find((r) => r.id === id) || referencesOf(getActiveFile(project)).at(-1);
  if (!ref) return;
  ref.mode = ref.mode === 'fit' ? 'full' : 'fit';
  draw(); autosave();
}

// Chromium's picker hands back a file handle, which lets the reference
// persist across sessions; anywhere else it's a plain File and the
// reference lasts until reload.
async function importReference() {
  try {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'] } }] });
      await addReferenceFrom(await handle.getFile(), handle);
    } else {
      pickFile('image/*', (f) => addReferenceFrom(f, null));
    }
  } catch (err) {
    if (err.name !== 'AbortError') { console.error('Reference import failed:', err); flashTip(err.message); }
  }
}

async function addReferenceFrom(image, handle) {
  try {
    const ref = await addReference(getActiveFile(project), image, handle);
    activeReferenceId = ref.id;
    draw(); autosave();
  } catch (err) {
    console.error('Reference import failed:', err);
    flashTip(err.message);
  }
}

// Shift+click a layer (§ layers-panel.js buildLayerRow): select it and
// every layer between it and the current active layer: but only within
// one Group (including "no group": an ungrouped layer's groupId is null
// either way, so two ungrouped layers still count as the same context).
// Different group is a no-op.
function shiftSelectLayer(targetIndex) {
  const file = getActiveFile(project);
  layerOrder(file); // refreshes every layer's derived .groupId
  const currentLayer = file.layers[file.activeLayerIndex];
  const targetLayer = file.layers[targetIndex];
  if (!currentLayer || !targetLayer || currentLayer.groupId !== targetLayer.groupId) return;
  const members = visibleOrder(layerOrder(file))
    .filter((e) => !e.isHeader && e.item.groupId === currentLayer.groupId)
    .map((e) => e.item);
  const a = members.indexOf(currentLayer), b = members.indexOf(targetLayer);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  multiLayerSelection = new Set(members.slice(lo, hi + 1).map((l) => file.layers.indexOf(l)));
  openLayerSelectionMenu(targetIndex);
}

// Alt+click a layer: add it to whatever's already multi-selected (starting
// from just the current active layer if nothing was yet): not restricted
// to one group.
function altSelectLayer(targetIndex) {
  const file = getActiveFile(project);
  if (!multiLayerSelection) multiLayerSelection = new Set([file.activeLayerIndex]);
  multiLayerSelection.add(targetIndex);
  openLayerSelectionMenu(targetIndex);
}

function dismissLayerSelection() {
  multiLayerSelection = null;
  redrawLayersPanel();
}

// Toggle-all, not "flip each independently": if any selected layer is
// currently visible, hide the whole selection; only once they're all
// already hidden does it show them all again: same aggregate rule
// onToggleGroupVisible already uses for a layer group's own single flag,
// just computed across a set instead of read off one field. Also what a
// selected layer's own thumbnail click does (layers-panel.js).
function toggleSelectedLayersVisibility() {
  if (!multiLayerSelection) return;
  const file = getActiveFile(project);
  const layers = [...multiLayerSelection].map((i) => file.layers[i]).filter(Boolean);
  const anyVisible = layers.some((l) => l.visible);
  for (const l of layers) l.visible = !anyVisible;
  draw(); autosave();
}

// Descending index order: deleting high indices first means earlier ones
// never shift out from under the next delete. deleteLayer's own "at least
// one layer" guard already stops short of emptying the file entirely.
function removeSelectedLayers() {
  if (!multiLayerSelection) return;
  const file = getActiveFile(project);
  const indices = [...multiLayerSelection].sort((a, b) => b - a);
  commitLayerChange(file, () => { for (const i of indices) deleteLayer(file, i); });
  multiLayerSelection = null;
}

// Hide/Remove for the whole multi-selection, anchored at whichever layer
// was most recently added to it. Layers panel docks at the right edge, so
// 'left' (not the default 'right', which would run the menu off-screen):
// same side its own "Add layer or group" menu already uses.
function openLayerSelectionMenu(lastAddedIndex) {
  redrawLayersPanel(true); // the menu anchors on a row, so it must exist
  const anchor = layersPanel.querySelector(`[data-layer-index="${lastAddedIndex}"]`);
  if (!anchor || !multiLayerSelection) return;
  openSlideOut(anchor, [
    { label: 'Hide', onClick: () => { toggleSelectedLayersVisibility(); multiLayerSelection = null; redrawLayersPanel(); } },
    { label: 'Remove', onClick: () => removeSelectedLayers() },
  ], { side: 'left', onDismiss: dismissLayerSelection });
}

// The layer-group header currently under keyboard focus (\ held, Up/Down
// navigated onto it): null whenever focus is on a layer, or \ hasn't been
// used to navigate at all this hold.
function focusedGroupId() {
  if (backslashFocusPos === null) return null;
  const file = getActiveFile(project);
  const list = visibleOrder(layerOrder(file));
  const entry = list[backslashFocusPos];
  return entry && entry.isHeader ? entry.item.id : null;
}

// After anything that changes which frames exist or which is active: keeps
// the in-memory frame cache's hot window in sync (§ frame-cache.js) before
// the next paint, so onion-skin/render never reads a frame this just made
// "cold".
async function afterFrameChange(file, { autosave: doAutosave = true } = {}) {
  await syncHotWindow(file, frameSelection.getRange());
  bindActiveFile();
  draw();
  if (doAutosave) autosave();
}

async function selectFrame(file, i) {
  file.activeFrameIndex = i;
  await afterFrameChange(file, { autosave: false }); // selection persists across frame switches (§9.3)
}

async function shiftSelectFrame(file, i) {
  frameSelection.extendTo(i);
  await syncHotWindow(file, frameSelection.getRange());
  draw();
}

function redrawTimelinePanel() {
  const file = getActiveFile(project);
  if (file._stub) return; // still loading
  if (!(timelineReveal && timelineReveal.isFocused())) { timelineStale = true; return; }
  timelineStale = false;
  renderTimelinePanel(timelineBar, file, playback, {
    onSetFps: (fps) => { playback.fps = fps; if (playback.playing) startPlayback(); },
    onToggleOnion: () => { playback.onionSkin = !playback.onionSkin; draw(); },
    onToggleOnionSource: () => { playback.onionLayerOnly = !playback.onionLayerOnly; draw(); },
    onSelect: (i) => selectFrame(file, i),
    onShiftSelect: (i) => shiftSelectFrame(file, i),
    onAddFrame: () => { addFrame(file); afterFrameChange(file); },
    onInsertFrame: (i) => { addFrame(file, i); afterFrameChange(file); },
    onDelete: (i) => { deleteFrame(file, i); afterFrameChange(file); },
    onReorder: (from, to) => { reorderFrame(file, from, to); afterFrameChange(file); },
  }, frameSelection.getRange(), getCachedThumbnail);
}

async function stepFrame(dir) {
  const file = getActiveFile(project);
  const next = (file.activeFrameIndex + dir + file.frames.length) % file.frames.length;
  file.activeFrameIndex = next;
  await afterFrameChange(file, { autosave: false }); // selection persists across frame switches (§9.3)
}

// Playback loops within the selected frame range if one exists, the whole
// reel otherwise: this is why togglePlayback pre-loads exactly that range
// (and no more) before starting, so playbackStep itself never has to await
// a decompress mid-tick.
function playbackStep() {
  const file = getActiveFile(project);
  const range = frameSelection.getRange();
  const lo = range ? range.lo : 0, hi = range ? range.hi : file.frames.length - 1;
  const span = hi - lo + 1;
  file.activeFrameIndex = lo + (((file.activeFrameIndex - lo + 1) % span + span) % span);
  bindActiveFile();
  draw();
}

function startPlayback() {
  clearInterval(playback.timer);
  playback.timer = setInterval(playbackStep, 1000 / playback.fps);
}

async function togglePlayback() {
  const file = getActiveFile(project);
  playback.playing = !playback.playing;
  if (playback.playing) {
    const range = frameSelection.getRange();
    const lo = range ? range.lo : 0, hi = range ? range.hi : file.frames.length - 1;
    // The "rendering pass before playback" a selection scopes down: without
    // one this loads the whole reel, same as always having stepped through it.
    await Promise.all(Array.from({ length: hi - lo + 1 }, (_, k) => ensureFrameLoaded(file, lo + k)));
    if (!playback.playing) return; // stopped again while loading
    startPlayback();
  } else {
    clearInterval(playback.timer);
    await syncHotWindow(file, frameSelection.getRange()); // shrink back to the normal hot window
    draw();
  }
}

const SHAPE_CURSORS = { rect: 'rectangle', triangle: 'triangle', circle: 'circle' }; // the line tool has no cursor of its own
let shapeState = null; // { key, anchor, snapshot } while a shape key is held (Q/W/A/S, below)
let heldFill = false; // Ctrl+Enter is down: fill has no held state of its own, this is only for its cursor

// Lets the mouse drive whichever tool the keyboard already has armed: a
// held shape key (Q/W/A/S) sizes that shape by drag instead of painting,
// and held Shift drags out a selection rect instead: both mirroring the
// existing keyboard-arrow versions of the same gestures.
const mouseDragTools = {
  shapeActive: () => !!shapeState,
  heldTool: () => (shapeState && SHAPE_CURSORS[shapeState.key]) || (heldFill ? 'fill' : null),
  shapeStart: (x, y) => { if (shapeState) shapeState.anchor = { x, y }; },
  shapeDrag: (x, y) => { hoverPixel = { x, y }; updateShapePreview({ x, y }); },
  shapeEnd: () => endShape(),
  // Reads the PointerEvent's own live shiftKey/ctrlKey/altKey rather than
  // our tracked `held` latch: a missed keyup (§ known stuck-Shift bug,
  // __spriteDebug below) used to only strand arrow-key rect-select; once
  // the mouse also gated on `held.shift`, the same desync stranded mouse
  // painting in selection mode too, with no key event left to self-heal it.
  // Trusting the browser's own per-event modifier state sidesteps that
  // class of bug entirely, and resyncs `held.shift` on the way.
  selectActive: (e) => {
    if (held.shift && !e.shiftKey) { held.shift = held.leftShift = held.rightShift = false; arrowAnchor = null; rectSelecting = false; }
    return e.shiftKey && !e.ctrlKey && !e.altKey;
  },
  selectStart: (x, y) => { arrowAnchor = { x, y }; rectSelecting = true; selectionApi.setLiveRect(x, y, x, y); },
  selectDrag: (x, y) => { hoverPixel = { x, y }; selectionApi.setLiveRect(arrowAnchor.x, arrowAnchor.y, x, y); },
  selectEnd: () => {
    if (rectSelecting && arrowAnchor) {
      selectionApi.set(maskFromRect(model, arrowAnchor.x, arrowAnchor.y, hoverPixel.x, hoverPixel.y));
      draw();
    }
    arrowAnchor = null;
    rectSelecting = false;
  },
};
inputController = createInputController(canvas, model, colors, renderCanvas, history, () => brushSize, () => selectionMask, mouseDragTools, () => !!activeGroupId);

// Pressing on a canvas in the grid picks it up; past a few pixels it becomes a drag.
function groupGridView() {
  const rect = canvas.getBoundingClientRect();
  const artboards = groupArtboards();
  const scale = groupViewState.zoom || groupFitScale(groupLayoutModel(), rect.width, rect.height);
  return { rect, artboards, opts: { scale, panX: groupViewState.panX, panY: groupViewState.panY } };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!activeGroupId || e.button !== 0) return;
  const { rect, artboards, opts } = groupGridView();
  const from = hitTestArtboardGrid(view.w, view.h, artboards, opts, e.clientX - rect.left, e.clientY - rect.top);
  if (from < 0) return;
  gridDrag = { from, to: from, startX: e.clientX, startY: e.clientY, x: 0, y: 0, started: false };
  canvas.setPointerCapture(e.pointerId);
});

function endGridDrag(commit) {
  const drag = gridDrag;
  gridDrag = null;
  if (!drag || !drag.started) return;
  forceCursor(null);
  if (commit && drag.to !== drag.from) {
    // Slots are positions among this collection's canvases; the project orders them among everything.
    const positions = projectOrder(project).flatMap((entry, pos) => (!entry.isHeader && entry.item.groupId === activeGroupId ? [pos] : []));
    moveProjectItem(project, positions[drag.from], positions[drag.to]);
    redrawProjectPanel();
    autosave();
  }
  draw();
}
canvas.addEventListener('pointerup', () => endGridDrag(true));
canvas.addEventListener('pointercancel', () => endGridDrag(false));

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  if (gridDrag && activeGroupId) {
    if (!gridDrag.started) {
      if (Math.hypot(e.clientX - gridDrag.startX, e.clientY - gridDrag.startY) < GRID_DRAG_THRESHOLD) return;
      gridDrag.started = true;
      forceCursor('grab');
    }
    const { artboards, opts } = groupGridView();
    gridDrag.x = e.clientX - rect.left;
    gridDrag.y = e.clientY - rect.top;
    gridDrag.to = slotAtPoint(view.w, view.h, artboards, opts, gridDrag.x, gridDrag.y);
    draw();
    return;
  }
  if (activeGroupId) {
    // § tool tag tip: name + canvas size of whichever artboard the mouse
    // is over, same hit-test double-click (canvas dblclick, below) uses.
    const artboards = groupArtboards();
    const scale = groupViewState.zoom || groupFitScale(groupLayoutModel(), rect.width, rect.height);
    const index = hitTestArtboardGrid(
      view.w, view.h, artboards,
      { scale, panX: groupViewState.panX, panY: groupViewState.panY },
      e.clientX - rect.left, e.clientY - rect.top,
    );
    const hit = artboards[index];
    groupHoverTip = hit ? `${hit.name} ${hit.width}x${hit.height}` : null;
    setCanvasCursor(hit ? 'click' : 'arrow');
    // updateToolTag() isn't in the per-frame render loop while a group is
    // showing (that loop is paused for it, § renderGroupCanvas): same
    // reasoning onHoverTip's own listener already set synchronously here.
    updateToolTag();
    return;
  }
  const viewport = computeViewport(model, rect.width, rect.height);
  hoverPixel = screenToPixel(viewport, e.clientX - rect.left, e.clientY - rect.top);
  // No render call here: the window-level input listener flags a render
  // and the animateCursor loop picks up the new hoverPixel on its own;
  // forcing a full draw() per pointermove was the original (expensive)
  // cause of the cursor lag this replaced.
});

canvas.addEventListener('pointerleave', () => {
  if (!activeGroupId || !groupHoverTip) return;
  groupHoverTip = null;
  updateToolTag();
});

// Scroll wheel zooms (§6). Scale is snapped to whole numbers: the spec
// calls for continuous zoom, but a fractional scale would leave subpixel
// seams between adjacent pixel rects, breaking "pixels always render
// perfectly square." Integer-only zoom is the pixel-safe simplification.
// Below 1:1 (only reachable once `min` allows it: see minZoomScale) steps
// multiplicatively instead of by whole pixels, since a flat +/-1 step
// stops meaning anything once scale is fractional.
function zoomTo(nextScale) {
  const rect = canvas.getBoundingClientRect();
  const fit = fitScale(model, rect.width, rect.height);
  const min = minZoomScale(model, rect.width, rect.height);
  const max = maxZoomScale(model, rect.width, rect.height);
  viewState.zoom = snapScale(Math.max(min, Math.min(max, nextScale)));
  if (Math.abs(viewState.zoom - fit) < 0.01) { viewState.zoom = fit; viewState.panX = 0; viewState.panY = 0; }
  draw();
}

// `=`: fit the selection if there is one, otherwise the whole canvas.
function fitView() {
  const rect = canvas.getBoundingClientRect();
  const bounds = selectionMask && maskBounds(model, selectionMask);
  if (bounds) Object.assign(viewState, regionView(model, rect.width, rect.height, bounds));
  else { viewState.panX = 0; viewState.panY = 0; zoomTo(fitScale(model, rect.width, rect.height)); return; }
  draw();
}

// Inertial zoom step: a notched mouse wheel reports the same |deltaY| on
// every tick, so speed has to come from the *cadence* between events, not
// the event's own magnitude. Ticks arriving close together (a fast flick)
// nudge the smoothed velocity up; a lone slow tick lets it decay back down.
let wheelVelocity = 0;
let lastWheelTime = 0;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (activeGroupId) { groupZoomStep(e.deltaY < 0 ? 1 : -1); return; }
  const rect = canvas.getBoundingClientRect();
  const fit = fitScale(model, rect.width, rect.height);
  const min = minZoomScale(model, rect.width, rect.height);
  const current = viewState.zoom || fit;
  const zoomingIn = e.deltaY < 0;

  const now = performance.now();
  const dt = Math.min(now - lastWheelTime, 300);
  lastWheelTime = now;
  const instantSpeed = Math.abs(e.deltaY) / Math.max(dt, 1);
  wheelVelocity = wheelVelocity * 0.6 + instantSpeed * 0.4;

  const rate = Math.min(wheelVelocity * 0.15, 0.5);
  const next = current * (zoomingIn ? 1 + rate : 1 - rate);
  zoomTo(stepScale(current, next < trueScale() && min >= trueScale() ? trueScale() : next));
}, { passive: false });

// Double-click an artboard in the group grid (§ project panel group
// select) to jump straight to editing that File: the grid is otherwise
// entirely read-only (input.js's getReadOnly), so this lives here instead,
// gated the same way.
canvas.addEventListener('dblclick', (e) => {
  if (!activeGroupId) return;
  const rect = canvas.getBoundingClientRect();
  const artboards = groupArtboards();
  const scale = groupViewState.zoom || groupFitScale(groupLayoutModel(), rect.width, rect.height);
  const index = hitTestArtboardGrid(
    view.w, view.h, artboards,
    { scale, panX: groupViewState.panX, panY: groupViewState.panY },
    e.clientX - rect.left, e.clientY - rect.top,
  );
  if (index < 0) return;
  selectFile(artboards[index].fileIndex);
});

function doCopy() {
  const mask = selectionMask || (hoverPixel && (() => {
    const m = new Uint8Array(model.width * model.height);
    if (inBoundsPixel(hoverPixel)) m[hoverPixel.y * model.width + hoverPixel.x] = 1;
    return m;
  })());
  if (mask) clipboard = extract(model, mask);
}

function inBoundsPixel(p) {
  return p.x >= 0 && p.y >= 0 && p.x < model.width && p.y < model.height;
}

function doCut() {
  if (activeGroupId) return; // read-only group grid: nothing here to cut
  doCopy();
  deleteSelectionOrHover();
}

function doPaste() {
  if (!clipboard || activeGroupId) return; // read-only group grid: nothing here to paste into
  const at = hoverPixel || { x: 0, y: 0 };
  const snapshot = snapshotPixels(model);
  stamp(model, clipboard, at.x, at.y, false);
  const { before, after } = diffFromSnapshot(model, snapshot);
  history.commit({ type: 'pixelEdit', before, after }); // triggers the full refresh
}

// Flips the selection if one exists, otherwise the whole active layer.
function doFlip(axis) {
  const mask = selectionMask || fullMask(model);
  const snapshot = snapshotPixels(model);
  flip(model, mask, axis);
  const { before, after } = diffFromSnapshot(model, snapshot);
  history.commit({ type: 'flip', layer: getActiveFile(project).activeLayerIndex, axis, before, after });
}

// [I]: inverts the RGB of every selected pixel, or just the pixel under
// the cursor when there's no selection. Editing-only (main.js's own keydown
// handler already gates every canvas edit key on !activeGroupId: the
// read-only group grid has no cursor/selection of its own to invert).
function invertColors() {
  const snapshot = snapshotPixels(model);
  const invertAt = (x, y, mask) => {
    const hex = getPixel(model, x, y);
    if (!hex) return;
    const { r, g, b } = hexToRgb(hex);
    setPixel(model, x, y, rgbToHex(255 - r, 255 - g, 255 - b), mask);
  };
  if (selectionMask) {
    for (let y = 0; y < model.height; y++) {
      for (let x = 0; x < model.width; x++) invertAt(x, y, selectionMask);
    }
  } else {
    const c = currentCursor();
    invertAt(c.x, c.y);
  }
  const { before, after } = diffFromSnapshot(model, snapshot);
  history.commit({ type: 'invert', before, after });
}

function moveSelection(dx, dy, moveContentToo) {
  if (!selectionMask) return;
  if (moveContentToo) {
    const snapshot = snapshotPixels(model);
    selectionMask = moveContent(model, selectionMask, dx, dy);
    selectionRender = toRenderSelection(model, selectionMask);
    const { before, after } = diffFromSnapshot(model, snapshot);
    history.commit({ type: 'moveSelectionContent', dx, dy, before, after }); // triggers the full refresh
  } else {
    selectionMask = shiftMask(model, selectionMask, dx, dy);
    selectionRender = toRenderSelection(model, selectionMask);
    renderCanvas(); // boundary-only move: no committed edit, just a cheap redraw
  }
}

// Keyboard-driven rotate (§ new control scheme): hold R, then Left/Right
// steps degrees: 1° per step (accelerating hold), or 15° per step with
// Shift+R. Pivot is the selection's own center, or the whole layer's if
// nothing's selected (same fallback as flip). Left = CCW, right = CW.
// Re-applies to the pristine snapshot on every step (rather than compounding
// a small rotation onto an already-rotated, lossy result).
function beginRotate(stepDegrees) {
  if (rotating) return;
  const mask = selectionMask || fullMask(model);
  const b = maskBounds(model, mask);
  if (!b) return;
  rotating = {
    mask, step: stepDegrees, angle: 0,
    snapshot: snapshotPixels(model),
    center: { x: b.minX + b.w / 2, y: b.minY + b.h / 2 },
  };
}

function stepRotate(dir) {
  if (!rotating) return;
  rotating.angle += dir * rotating.step;
  for (let i = 0; i < model.pixels.length; i++) model.pixels[i] = rotating.snapshot[i];
  touch(model.pixels);
  rotate(model, rotating.mask, rotating.angle);
  renderCanvas(); // live feedback only; endRotate does the full refresh
}

function endRotate() {
  if (!rotating) return;
  const { before, after } = diffFromSnapshot(model, rotating.snapshot);
  if (before.length) history.commit({ type: 'rotate', degrees: rotating.angle, before, after });
  rotating = null;
}

function deleteSelectionOrHover() {
  const snapshot = snapshotPixels(model);
  if (selectionMask) {
    for (let y = 0; y < model.height; y++) {
      for (let x = 0; x < model.width; x++) {
        if (selectionMask[y * model.width + x]) setPixel(model, x, y, null);
      }
    }
  } else if (hoverPixel) {
    for (const [x, y] of mirroredPoints(model, hoverPixel.x, hoverPixel.y, paintOptions.symmetry)) setPixel(model, x, y, null);
  }
  const { before, after } = diffFromSnapshot(model, snapshot);
  history.commit({ type: 'pixelEdit', before, after });
  draw();
}

const DIGIT_INDEX = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8, '0': 9 };

window.addEventListener('resize', resize);

// ===== Focus-based control scheme (CONTEXT.md, todo/control.md) =====
// Canvas cursor, paint/erase/fill, selection, undo, flip/rotate, brush size,
// zoom, grid, Q/W/A/S shape tools, and the four focus-based panels
// (Projects/Colors/Layers/Timeline) are all wired. Multi-project open/new
// and focused-category/group navigation are still gaps (see dispatchProjects
// below). Mouse still works alongside this: left click/drag places (Alt:
// paints; or drives a held shape key / Shift-select instead, see
// mouseDragTools), right click/drag erases (input.js), scroll zooms (below).

// Generic accelerating hold-repeat, modeled on a phone's backspace-hold:
// fires once immediately, then again at a shrinking interval the longer a
// key stays held, without needing to know in advance which key it's for.
function createHoldRepeater(step) {
  let timer = null;
  let heldSince = 0;
  function tick() {
    step();
    const held = performance.now() - heldSince;
    const interval = held > 1500 ? 20 : held > 600 ? 60 : 150;
    timer = setTimeout(tick, interval);
  }
  return {
    start() { if (timer) return; heldSince = performance.now(); tick(); },
    stop() { clearTimeout(timer); timer = null; },
    get running() { return timer !== null; },
  };
}

function maxBrushSize() {
  return Math.max(1, Math.floor(Math.min(model.width, model.height) * 0.25)); // §8: capped at 1/4 canvas dimension
}

// --- Held-modifier tracking (Alt/Ctrl/Shift, distinguishing L/R Shift) ---
const held = {
  alt: false, ctrl: false, shift: false, leftShift: false, rightShift: false, space: false, z: false,
};

// --- Keyboard cursor + arrow dispatch (Canvas focus only) ---
// One live mode at a time while arrows are held, decided fresh each repeat
// tick from whatever modifiers are currently down (not latched at the first
// arrow press) so switching modifiers mid-hold changes behavior live.
const heldArrows = new Set();
let arrowAnchor = null; // canvas-pixel anchor captured when Shift first went down, for the live rect preview
let rectSelecting = false; // true once Shift+arrows actually drew a live rect: gates the commit on Shift's keyup, so a Shift press that never involved arrows (Shift+C, Shift+G, a stray tap) commits no selection
let contentMoveActive = false; // shift+ctrl+arrows: batches into one undo commit on release
// Ctrl+Space is ambiguous until it's clear whether arrows follow: no arrows
// before Space releases = toggle playback (global); any arrow while both are
// still held = pan instead (and cancels the pending playback toggle).
let ctrlSpaceArmed = false;
let panningKeyboard = false;
const PAN_STEP = 12;

function currentCursor() {
  return hoverPixel || { x: 0, y: 0 };
}

function clampToCanvas(p) {
  return { x: Math.max(0, Math.min(model.width - 1, p.x)), y: Math.max(0, Math.min(model.height - 1, p.y)) };
}

function moveCursorBy(dx, dy) {
  hoverPixel = clampToCanvas({ x: currentCursor().x + dx, y: currentCursor().y + dy });
}

function arrowTick() {
  let dx = 0, dy = 0;
  if (heldArrows.has('ArrowLeft')) dx -= 1;
  if (heldArrows.has('ArrowRight')) dx += 1;
  if (heldArrows.has('ArrowUp')) dy -= 1;
  if (heldArrows.has('ArrowDown')) dy += 1;
  if (!dx && !dy) return;

  if (ctrlSpaceArmed) { // Ctrl+Space+arrows: pan, not playback-toggle (see ctrlSpaceArmed above)
    panningKeyboard = true;
    const pan = activeGroupId ? groupViewState : viewState;
    pan.panX -= dx * PAN_STEP;
    pan.panY -= dy * PAN_STEP;
    renderCanvas();
    return;
  }
  // Nothing past this point is interactive over the read-only group grid.
  if (activeGroupId) return;
  if (rotating) { // hold-R rotate mode (left/right only)
    if (dx) stepRotate(dx > 0 ? 1 : -1);
    return;
  }
  if (held.shift && held.alt && !held.ctrl) { // move the selection boundary only
    moveSelection(dx, dy, false);
    return;
  }
  if (held.shift && held.ctrl && !held.alt) { // move the selected content
    contentMoveActive = true;
    selectionApi.moveContentBy(dx, dy);
    return;
  }
  // Every other combination just aims the cursor, stepped by brush size:
  // the shift-family selection tools (rect) confirm on Shift's own keyup.
  moveCursorBy(dx * brushSize, dy * brushSize);
  if (held.shift && !held.ctrl && !held.alt && arrowAnchor) {
    rectSelecting = true;
    selectionApi.setLiveRect(arrowAnchor.x, arrowAnchor.y, hoverPixel.x, hoverPixel.y);
  } else if (held.z && !held.shift && !held.alt) {
    stampCurrentTool(hoverPixel.x, hoverPixel.y, true); // Z+arrows: erase-while-moving tool
  } else if (held.alt && !held.shift && !held.z) {
    stampCurrentTool(hoverPixel.x, hoverPixel.y, false); // Alt+arrows: paint-while-moving tool
  }
}
const arrowRepeater = createHoldRepeater(arrowTick);

// --- Place / Paint / erase / fill ---
// `erase` is momentary now (Z+arrows, Backspace/Delete), not a persisted
// mode: every caller says explicitly which one it wants. Place vs Paint
// (plain vs Alt-held) isn't passed in the same way: it reads `held.alt`
// live, same as the mouse side reads the click event's own altKey: so
// Alt+Space and Alt+Arrows (which route through here too) get the
// antialiased brush for free without their callers needing to know that.
function stampCurrentTool(x, y, erase = false) {
  const snap = snapshotPixels(model);
  paintAt(model, x, y, { ...paintOptions, size: brushSize, antialiased: held.alt, erase, color: colors.primary(), mask: selectionMask });
  const { before, after } = diffFromSnapshot(model, snap);
  if (before.length) history.commit({ type: 'pixelEdit', before, after });
}
const stampRepeater = createHoldRepeater(() => stampCurrentTool(currentCursor().x, currentCursor().y));

// Ctrl+Enter: flood fill at cursor, or (with an active selection) solid-fill
// every selected pixel: same mask-walk `deleteSelectionOrHover` already
// uses, just setting the primary color instead of clearing.
function fillCurrentTool(x, y) {
  const snap = snapshotPixels(model);
  if (selectionMask) {
    const idx = colorIndex(model.colors, colors.primary());
    for (let py = 0; py < model.height; py++) {
      for (let px = 0; px < model.width; px++) {
        if (selectionMask[py * model.width + px] && !(paintOptions.dither && (px + py) % 2)) setPixelIndex(model, px, py, idx);
      }
    }
  } else {
    for (const [fx, fy] of mirroredPoints(model, x, y, paintOptions.symmetry)) floodFill(model, fx, fy, colors.primary(), false, undefined, paintOptions.dither);
  }
  const { before, after } = diffFromSnapshot(model, snap);
  if (before.length) history.commit({ type: 'fill', before, after });
}

// --- Zoom ---
function zoomStep(dir) {
  const rect = canvas.getBoundingClientRect();
  const current = viewState.zoom || fitScale(model, rect.width, rect.height);
  zoomTo(stepScale(current, current * (dir > 0 ? 1.15 : 1 / 1.15)));
}

// --- Focus-based panels: Projects, Colors, Layers, Timeline ---
// Each panel owns the whole keyboard while `focusedPanel` points at it (see
// setFocus() above): no held-key gate anymore. Phase 2 gap: no "focused
// category/group" concept exists yet, so new/delete-category and
// new/delete-group act on the project's/active layer's *current* one rather
// than an independently navigable one.

function renameInline(selector, getName, setName, redrawFn) {
  const el = document.querySelector(selector);
  if (!el) return;
  const name = getName();
  el.textContent = name; // drop any ▸/▾ fold prefix (headers) before it becomes editable text
  startInlineEdit(el, name, (v) => { if (v) { setName(v); redrawFn(); autosave(); } });
}
const renameActiveFile = () => renameInline('.file-row.selected .file-row-name', () => getActiveFile(project).name, (v) => renameFile(project, getActiveFile(project), v), redrawProjectPanel);
// A single-file project reads as one thing to the user: its one .sprite
// file should track the project's own name, not drift to whatever the file
// was originally called.
const renameProject = () => renameInline('.project-name', () => project.name, (v) => {
  project.name = v;
  if (project.files.length === 1) renameFile(project, project.files[0], v);
}, redrawProjectPanel);
const renameActiveLayer = () => renameInline('.layer-row.selected .layer-label', () => getActiveFile(project).layers[getActiveFile(project).activeLayerIndex].name, (v) => { getActiveFile(project).layers[getActiveFile(project).activeLayerIndex].name = v; }, redrawLayersPanel);

// Tab + [+]: arrows cycle NEW_FILE_SIZES, Return creates the file at that
// size and drops straight into renaming it.
let pickingFileSize = null;
function beginPickFileSize() { pickingFileSize = 0; }
function stepPickFileSize(dir) { pickingFileSize = (pickingFileSize + dir + NEW_FILE_SIZES.length) % NEW_FILE_SIZES.length; draw(); }
function commitPickFileSize() {
  const { w, h, palette: presetPalette } = NEW_FILE_SIZES[pickingFileSize];
  addFile(project, `sprite${project.files.length + 1}`, w, h, focusedCollectionId());
  if (presetPalette) palette.loadPreset(presetPalette);
  bindActiveFile(); resetView(); redrawProjectPanel(); draw(); autosave();
  pickingFileSize = null;
  requestAnimationFrame(renameActiveFile); // panel needs one redraw for the new row to exist
}

function opacityStep(dir, step = 1) {
  const file = getActiveFile(project);
  const layer = file.layers[file.activeLayerIndex];
  layer.opacity = Math.max(0, Math.min(1, layer.opacity + dir * step * 0.01));
  renderCanvas(); redrawLayersPanel();
}
let fpsRepeater = null;

// --- Q/W/A/S shape tools: hold, arrows resize from the cursor's position
// when the key went down, Shift constrains to equal width/height, release
// commits. Always paint (primary color): no keyboard erase-shape variant. ---
const SHAPE_KEYS = { q: 'rect', w: 'triangle', a: 'circle', s: 'line' };

function beginShape(key, anchor) {
  if (shapeState) return;
  shapeState = { key, anchor: anchor || { ...currentCursor() }, snapshot: snapshotPixels(model) };
  inputController.updateCursor();
}
function setHeldFill(active) {
  if (heldFill === active) return;
  heldFill = active;
  inputController.updateCursor();
}
function updateShapePreview(endpoint) {
  if (!shapeState) return;
  for (let i = 0; i < model.pixels.length; i++) model.pixels[i] = shapeState.snapshot[i];
  touch(model.pixels);
  const { x: x0, y: y0 } = shapeState.anchor;
  let { x: x1, y: y1 } = endpoint || currentCursor();
  if (held.shift) [x1, y1] = constrainSquare(x0, y0, x1, y1);
  const idx = colorIndex(model.colors, colors.primary());
  for (const [x, y] of SHAPE_OUTLINES[shapeState.key](x0, y0, x1, y1)) setPixelIndex(model, x, y, idx, selectionMask);
  renderCanvas();
}
function endShape() {
  if (!shapeState) return;
  const { before, after } = diffFromSnapshot(model, shapeState.snapshot);
  if (before.length) history.commit({ type: 'pixelEdit', before, after });
  shapeState = null;
  inputController.updateCursor();
}

// --- Per-panel dispatch (focus-based control scheme, todo/control.md) ---
// Each function owns the whole keyboard while `focusedPanel` points at it.

function dispatchCanvas(e) {
  if (e.key === ':' && !e.repeat && !activeGroupId) { toggleReferenceMode(); return; }
  // Read-only group grid (§ project panel group select): the canvas isn't
  // showing the active file's own pixel space, so every paint/select/shape
  // keyboard tool below would edit a file the user can't even see. Zoom and
  // the two backdrop-cycle keys still work here: they only change how the
  // grid displays, not any file's actual pixels. Pan
  // (Ctrl+Space+arrows) is handled in arrowTick, not here. (Escape exits
  // the group view: handled globally, above, regardless of focus.)
  if (activeGroupId) {
    if (e.key === '+' && !e.repeat) { groupZoomStep(1); return; }
    if (e.key === '-' && !e.repeat) { groupZoomTo(1); return; }
    if (e.key === '=' && !e.repeat) {
      const rect = canvas.getBoundingClientRect();
      groupZoomTo(maxZoomScale(groupLayoutModel(), rect.width, rect.height));
      return;
    }
    if (e.key === '_' && !e.repeat) { groupZoomStep(-1); return; }
    if (e.key === 'U' && e.shiftKey) { cycleGroupAppBg(); return; }
    // Registers the arrow key so arrowTick's Ctrl+Space+arrows pan branch
    // can fire: everything else arrowTick does is gated on !activeGroupId.
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      if (!heldArrows.has(e.key)) { heldArrows.add(e.key); arrowRepeater.start(); }
      return;
    }
    return;
  }
  // Q/W/A/S shape tools resizing take priority over everything else arrows
  // do: 1px-precise, not stepped by brush size.
  if (shapeState && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const [dx, dy] = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    moveCursorBy(dx, dy);
    updateShapePreview();
    return;
  }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    if (!heldArrows.has(e.key)) { heldArrows.add(e.key); arrowRepeater.start(); } // start() fires the first tick itself
    return;
  }
  if (e.key === ' ' && !e.repeat) {
    e.preventDefault();
    if (held.shift) { // Shift+Space: magic wand at cursor
      const c = currentCursor();
      selectionApi.set(maskFromWand(model, c.x, c.y));
      draw();
      return;
    }
    held.space = true;
    stampCurrentTool(currentCursor().x, currentCursor().y);
    stampRepeater.start();
    return;
  }
  if ((e.key === 'c' || e.key === 'C') && e.shiftKey && !e.repeat) { // Shift+C: select same color under cursor
    const c = currentCursor();
    const hex = getPixel(model, c.x, c.y);
    if (hex) { selectionApi.set(maskFromColor(model, hex)); draw(); }
    return;
  }
  if (e.key in DIGIT_INDEX) { palette.setPrimaryByIndex(DIGIT_INDEX[e.key]); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.repeat) { deleteSelectionOrHover(); return; }
  if (e.ctrlKey && e.key === 'Enter' && !e.repeat) {
    e.preventDefault();
    setHeldFill(true);
    const c = currentCursor();
    fillCurrentTool(c.x, c.y);
    return;
  }
  if (SHAPE_KEYS[e.key.toLowerCase()] && !e.repeat) { beginShape(SHAPE_KEYS[e.key.toLowerCase()]); return; }
  if (e.key === '[' || e.key === ']') {
    const growing = e.key === ']';
    brushSize = Math.max(1, Math.min(maxBrushSize(), brushSize + (growing ? 1 : -1)));
    return;
  }
  if (e.key === '{' || e.key === '}') {
    const growing = e.key === '}';
    brushSize = growing ? Math.min(maxBrushSize(), brushSize * 2) : Math.max(1, Math.floor(brushSize / 2));
    return;
  }
  if (e.key === 'i' && !e.shiftKey && !e.repeat) { invertColors(); return; } // i: invert selection, or just the hovered pixel
  if (e.key === 'I' && e.shiftKey && !e.repeat) {
    const c = currentCursor();
    const hex = getPixel(model, c.x, c.y);
    if (hex) palette.pickColor(hex);
    setHeldD(true); // arms hold-Shift+I+click to add any color under the mouse, anywhere in the viewport
    return;
  }
  if (e.key === 'f' && !e.shiftKey) { doFlip('horizontal'); return; }
  if (e.key === 'F' && e.shiftKey) { doFlip('vertical'); return; }
  if ((e.key === 'r' || e.key === 'R') && !e.repeat) { beginRotate(e.shiftKey ? 15 : 1); return; }
  if (e.key === 'z' && !e.repeat) { held.z = true; return; }
  if (e.key === '+' && !e.repeat) { zoomStep(1); return; }
  if (e.key === '-' && !e.repeat) { zoomTo(trueScale()); return; }
  if (e.key === '=' && !e.repeat) { fitView(); return; }
  if (e.key === '_' && !e.repeat) { zoomStep(-1); return; }
  if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) { paintOptions.dither = !paintOptions.dither; uiPrefs.dither = paintOptions.dither; saveUiPrefs(uiPrefs); draw(); return; }
  if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
    paintOptions.symmetry = SYMMETRY_CYCLE[(SYMMETRY_CYCLE.indexOf(paintOptions.symmetry) + 1) % SYMMETRY_CYCLE.length];
    uiPrefs.symmetry = paintOptions.symmetry; saveUiPrefs(uiPrefs); draw(); return;
  }
  if (e.key === 'g' && !e.shiftKey) { showGrid = !showGrid; uiPrefs.showGrid = showGrid; saveUiPrefs(uiPrefs); draw(); return; }
  if (e.key === 'G' && e.shiftKey) { showRuler = !showRuler; uiPrefs.showRuler = showRuler; saveUiPrefs(uiPrefs); draw(); return; }
  if (e.key === 'u' && e.ctrlKey) { e.preventDefault(); cycleBothBg(); return; }
  if (e.key === 'u' && !e.shiftKey) { cycleCanvasBg(); return; }
  if (e.key === 'U' && e.shiftKey) { cycleAppBg(); return; }
}

function dispatchTimeline(e) {
  const file = getActiveFile(project);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (e.repeat) return;
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    if (e.shiftKey) {
      // Anchor is the frame you started selecting from: it stays the
      // active/editing frame throughout; only the far edge moves.
      if (!frameSelection.getRange()) frameSelection.setAnchor(file.activeFrameIndex);
      frameSelection.extendTo(Math.max(0, Math.min(file.frames.length - 1, frameSelection.getTo() + dir)));
      syncHotWindow(file, frameSelection.getRange()).then(() => draw());
    } else if (e.altKey) {
      const range = frameSelection.getRange();
      if (range) {
        const target = dir > 0 ? range.hi + 1 : range.lo - 1;
        if (target >= 0 && target < file.frames.length) {
          reorderFrame(file, target, dir > 0 ? range.lo : range.hi);
          frameSelection.shift(dir);
          afterFrameChange(file);
        }
      } else {
        reorderFrame(file, file.activeFrameIndex, file.activeFrameIndex + dir);
        afterFrameChange(file);
      }
    } else {
      frameSelection.clear();
      stepFrame(dir);
    }
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { // FPS, accelerating hold
    e.preventDefault();
    if (!e.repeat) {
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      fpsRepeater = createHoldRepeater(() => {
        playback.fps = Math.max(1, Math.min(60, playback.fps + dir));
        if (playback.playing) startPlayback();
        redrawTimelinePanel();
      });
      fpsRepeater.start();
    }
    return;
  }
  if (e.key === '+' && !e.repeat) { addFrame(file); afterFrameChange(file); return; }
  if (e.key === '=' && !e.repeat) { duplicateFrame(file, file.activeFrameIndex); afterFrameChange(file); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.repeat) {
    const range = frameSelection.getRange();
    if (range) {
      for (let i = range.hi; i >= range.lo; i--) deleteFrame(file, i); // high-to-low so earlier deletes don't shift later indices
      frameSelection.clear();
    } else {
      deleteFrame(file, file.activeFrameIndex);
    }
    afterFrameChange(file);
    return;
  }
  if (e.key === '\\' && !e.repeat) { playback.onionSkin = !playback.onionSkin; draw(); return; }
  if (e.key === ' ' && !e.repeat) { togglePlayback(); return; }
}

function dispatchLayers(e) {
  const file = getActiveFile(project);
  if (e.key === ':' && !e.repeat) { toggleReferenceMode(); return; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (e.repeat) return;
    const dir = e.key === 'ArrowUp' ? -1 : 1; // ascending order = top-to-bottom
    const fullList = visibleOrder(layerOrder(file));
    if (!fullList.length) return;
    if (held.rightShift && !held.leftShift) { // r-shift+arrows: navigate groups only
      const headers = fullList.filter((entry) => entry.isHeader);
      if (!headers.length) return;
      let hi = headers.findIndex((entry) => entry.pos === (fullList[backslashFocusPos] || {}).pos);
      hi = Math.max(0, Math.min(headers.length - 1, hi + dir));
      backslashFocusPos = fullList.indexOf(headers[hi]);
      layerSelection = null;
      redrawLayersPanel();
      return;
    }
    if (e.shiftKey) {
      if (backslashFocusPos === null || backslashFocusPos >= fullList.length) {
        const active = file.layers[file.activeLayerIndex];
        backslashFocusPos = Math.max(0, fullList.findIndex((entry) => entry.item === active));
      }
      if (!layerSelection) layerSelection = { anchor: backslashFocusPos, to: backslashFocusPos };
      layerSelection.to = Math.max(0, Math.min(fullList.length - 1, layerSelection.to + dir));
      backslashFocusPos = layerSelection.to;
      redrawLayersPanel();
      return;
    }
    if (e.altKey) {
      if (layerSelection) {
        const lo = Math.min(layerSelection.anchor, layerSelection.to);
        const hi = Math.max(layerSelection.anchor, layerSelection.to);
        const target = dir > 0 ? hi + 1 : lo - 1;
        if (target >= 0 && target < fullList.length) {
          commitLayerChange(file, () => moveLayerItem(file, target, dir > 0 ? lo : hi));
          layerSelection.anchor += dir; layerSelection.to += dir; backslashFocusPos += dir;
          redrawLayersPanel();
        }
      } else if (backslashFocusPos !== null) {
        const toPos = Math.max(0, Math.min(fullList.length - 1, backslashFocusPos + dir));
        if (toPos !== backslashFocusPos) {
          commitLayerChange(file, () => moveLayerItem(file, backslashFocusPos, toPos));
          backslashFocusPos = toPos;
        }
      }
      return;
    }
    layerSelection = null;
    if (backslashFocusPos === null || backslashFocusPos >= fullList.length) {
      const active = file.layers[file.activeLayerIndex];
      backslashFocusPos = Math.max(0, fullList.findIndex((entry) => entry.item === active));
    }
    backslashFocusPos = Math.max(0, Math.min(fullList.length - 1, backslashFocusPos + dir));
    const focused = fullList[backslashFocusPos];
    if (!focused.isHeader) file.activeLayerIndex = file.layers.indexOf(focused.item);
    bindActiveFile(); redrawLayersPanel(); draw(); autosave();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (!e.repeat) opacityStep(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey ? 10 : 1);
    return;
  }
  const focusedGroup = focusedGroupId() && file.layerGroups.find((g) => g.id === focusedGroupId());
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.repeat) {
    if (layerSelection) {
      const list = visibleOrder(layerOrder(file));
      const lo = Math.min(layerSelection.anchor, layerSelection.to);
      const hi = Math.max(layerSelection.anchor, layerSelection.to);
      const entries = list.slice(lo, hi + 1);
      commitLayerChange(file, () => {
        for (const entry of entries) {
          if (entry.isHeader) deleteLayerGroup(file, entry.item.id);
          else { const idx = file.layers.indexOf(entry.item); if (idx >= 0) deleteLayer(file, idx); }
        }
      });
      layerSelection = null; backslashFocusPos = null;
      redrawLayersPanel(); draw(); autosave();
    } else {
      commitLayerChange(file, () => deleteLayer(file, file.activeLayerIndex));
    }
    return;
  }
  if (e.key === '+' && !e.repeat) { commitLayerChange(file, () => addLayer(file, undefined, focusedGroupId())); return; }
  if (e.key === '=' && !e.repeat) {
    // New group, positioned right above whatever's currently focused: so
    // if that's a layer, it becomes the group's first member.
    const before = visibleOrder(layerOrder(file));
    const focusedEntry = backslashFocusPos !== null ? before[backslashFocusPos] : null;
    commitLayerChange(file, () => {
      addLayerGroup(file);
      if (focusedEntry && !focusedEntry.isHeader) moveLayerItem(file, layerOrder(file).length - 1, focusedEntry.pos);
    });
    redrawLayersPanel(); draw(); autosave();
    return;
  }
  if (e.key === ' ' && !e.repeat) {
    if (focusedGroup) { focusedGroup.collapsed = !focusedGroup.collapsed; redrawLayersPanel(); autosave(); }
    return;
  }
  if (e.key === 'Enter' && !e.repeat) {
    if (focusedGroup) renameInline(`[data-group-id="${focusedGroup.id}"] .layer-label`, () => focusedGroup.name, (v) => { focusedGroup.name = v; }, redrawLayersPanel);
    else renameActiveLayer();
    return;
  }
  if (e.key === '\\' && !e.repeat) {
    const layer = file.layers[file.activeLayerIndex];
    layer.visible = !layer.visible;
    draw(); autosave();
    return;
  }
}

// Colors panel's own `\` preset menu and `Return` chip editor need their own
// small keydown listeners on the popup they open (Up/Down/Enter/Escape):
// stopPropagation keeps those keys from also reaching this dispatcher.
function dispatchColors(e) {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (!e.repeat) palette.cyclePrimary(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (e.key === '+' && !e.repeat) { palette.addChip(); return; }
  if (e.key === '-' && !e.repeat) { palette.removePrimary(); return; }
  if (e.key === '\\' && !e.repeat) {
    const hamburger = paletteBar.querySelector('.palette-hamburger');
    if (!hamburger) return;
    const panel = palette.openPresetMenu(hamburger);
    const buttons = panel && Array.from(panel.querySelectorAll('button'));
    if (!buttons || !buttons.length) return;
    let idx = 0;
    buttons[idx].focus();
    const onKey = (ke) => {
      if (!panel.isConnected) { cleanup(); return; } // closed via an outside click: stop intercepting
      if (ke.key === 'ArrowDown') { ke.preventDefault(); ke.stopPropagation(); idx = (idx + 1) % buttons.length; buttons[idx].focus(); }
      else if (ke.key === 'ArrowUp') { ke.preventDefault(); ke.stopPropagation(); idx = (idx - 1 + buttons.length) % buttons.length; buttons[idx].focus(); }
      else if (ke.key === 'Enter') { ke.preventDefault(); ke.stopPropagation(); buttons[idx].click(); cleanup(); }
      else if (ke.key === 'Escape') { ke.preventDefault(); ke.stopPropagation(); panel.remove(); cleanup(); }
    };
    function cleanup() { window.removeEventListener('keydown', onKey, true); }
    window.addEventListener('keydown', onKey, true);
    return;
  }
  if (e.key === 'Enter' && e.shiftKey && !e.repeat) { palette.renamePalette(); return; }
  if (e.key === 'Enter' && !e.repeat) { palette.editPrimaryChip(); return; }
}

function dispatchProjects(e) {
  if (pickingFileSize !== null) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepPickFileSize(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); stepPickFileSize(1); return; }
    if (e.key === 'Enter') { commitPickFileSize(); return; }
    if (e.key === 'Escape') { pickingFileSize = null; draw(); return; }
    return; // swallow other keys while the size picker is up
  }
  if (e.key === '+' && e.altKey && !e.repeat) { newProject(); return; }
  if (e.key === '+' && !e.repeat) { beginPickFileSize(); return; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (!e.repeat) {
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const list = visibleOrder(projectOrder(project));
      if (list.length) {
        if (tabFocusPos === null || tabFocusPos >= list.length) {
          const active = project.files[project.activeFileIndex];
          tabFocusPos = Math.max(0, list.findIndex((entry) => entry.item === active));
        }
        tabFocusPos = Math.max(0, Math.min(list.length - 1, tabFocusPos + dir));
        const focused = list[tabFocusPos];
        if (focused.isHeader) {
          // Landing on a collection header shows it as the read-only group
          // grid, same as clicking it: mirrors landing on a file below
          // making that file active.
          setActiveGroup(focused.item.id); // restores (or resets) that collection's own zoom/pan
        } else {
          project.activeFileIndex = project.files.indexOf(focused.item);
          setActiveGroup(null);
          bindActiveFile(); selectionApi.clear(); // keep the current zoom/pan: only switching which file it applies to
        }
        redrawProjectPanel(); draw();
      }
    }
    return;
  }
  const focusId = focusedCollectionId();
  const focusedHeader = focusId && project.collections.find((c) => c.id === focusId);
  if (e.key === '_' && !e.repeat) { // Shift+-: remove selected file/collection
    if (focusedHeader) deleteCollection(project, focusedHeader.id);
    else deleteFile(project, project.activeFileIndex);
    bindActiveFile(); resetView(); selectionApi.clear(); redrawProjectPanel(); draw(); autosave();
    return;
  }
  if (e.key === '=' && !e.repeat) { addCollection(project); redrawProjectPanel(); autosave(); return; }
  if (e.key === ' ' && !e.repeat) {
    if (focusedHeader) { focusedHeader.collapsed = !focusedHeader.collapsed; redrawProjectPanel(); autosave(); }
    return;
  }
  if (e.key === 'Enter' && !e.repeat) {
    if (e.shiftKey) renameProject();
    else if (focusedHeader) renameInline(`[data-collection-id="${focusId}"] .file-row-name`, () => focusedHeader.name, (v) => { focusedHeader.name = v; }, redrawProjectPanel);
    else renameActiveFile();
    return;
  }
  if (e.key === 'e' && !e.repeat) { toggleExportForActiveFile(); return; }
  if (e.key === 'E' && !e.repeat) { exportProjectSprite(project); return; }
  if (e.key === '\\' && !e.repeat) { openProjectPicker(document.querySelector('.project-name') || projectPanel); return; }
}

// --- Main keydown/keyup dispatch ---
let leftCtrlDown = false;
let leftCtrlUsed = false; // any other key pressed while left-Ctrl was held: a clean tap-alone returns focus to canvas
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable)) return;
  if (keybindHelp.isOpen()) {
    if (e.key === '?' || e.key === 'Escape') { e.preventDefault(); keybindHelp.close(); }
    return;
  }
  if (exportErrorOverlay) {
    if (e.key === 'Escape') { e.preventDefault(); closeExportErrorModal(); }
    return;
  }

  // Modifier tracking (live state, read by arrowTick/dispatch* below).
  if (e.key === 'Shift') {
    held.shift = true;
    if (e.code === 'ShiftLeft') held.leftShift = true;
    if (e.code === 'ShiftRight') held.rightShift = true;
    if (!e.repeat && focusedPanel === 'canvas') arrowAnchor = { ...currentCursor() };
  }
  if (e.key === 'Control') {
    held.ctrl = true;
    if (e.code === 'ControlLeft' && !leftCtrlDown) { leftCtrlDown = true; leftCtrlUsed = false; }
  }
  if (e.key === 'Alt') held.alt = true;
  // Self-healing latch: every non-Shift key event carries the browser's own
  // truth about whether Shift is down right now, so a stale latch is caught
  // on the very next keypress instead of persisting. Shift's own keyup is
  // not a reliable clearing point: a remapped Shift (or an xkb layout
  // switch bound to it) can report a keyup whose e.key is not 'Shift' at
  // all, which never reaches the release branch below and leaves the latch
  // stuck, rectangle-selecting on every later arrow press.
  if (e.key !== 'Shift' && !e.shiftKey && held.shift) {
    held.shift = held.leftShift = held.rightShift = false;
    arrowAnchor = null;
    rectSelecting = false;
  }
  if (leftCtrlDown && e.key !== 'Control') leftCtrlUsed = true;

  if (e.key === '?') { keybindHelp.toggle(); return; }

  // --- Global bindings (every focus) ---
  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); doCopy(); return; }
  if (e.ctrlKey && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); doCut(); return; }
  if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); doPaste(); return; }
  if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectionApi.set(fullMask(model)); draw(); return; }
  if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault();
    selectionApi.clear(); frameSelection.clear(); layerSelection = null;
    fileSelection = null; multiLayerSelection = null;
    redrawProjectPanel(); draw();
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
    e.preventDefault();
    stepHistory(undoCmd);
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    stepHistory(redoCmd);
    return;
  }
  if (e.key === 'Escape') {
    setActiveGroup(null); // also exits the read-only group grid, if showing one
    selectionApi.clear(); frameSelection.clear(); layerSelection = null;
    setFocus('canvas'); // give the keyboard back to the canvas, same as clicking off any panel
    redrawProjectPanel(); draw();
    return;
  }
  // Ctrl+Space (tap) toggles playback; Ctrl+Space+arrows pans instead: see
  // ctrlSpaceArmed/arrowTick, resolved on Space's own keyup below.
  if (e.key === ' ' && e.ctrlKey && !e.repeat) { e.preventDefault(); ctrlSpaceArmed = true; held.space = true; return; }
  if (leftCtrlDown && e.key.startsWith('Arrow') && !e.repeat) {
    e.preventDefault();
    // Colors/Layers/Timeline aren't reachable while viewing a group.
    const target = { ArrowUp: 'timeline', ArrowRight: 'layers', ArrowDown: 'colors', ArrowLeft: 'projects' }[e.key];
    if (target && (target === 'projects' || !activeGroupId)) setFocus(target);
    return;
  }
  if (e.key === 'Tab' && !e.repeat) {
    e.preventDefault();
    if (!e.shiftKey) { toggleHideAllPanels(); return; }
    // Colors/Layers/Timeline aren't reachable while viewing a group: only
    // Projects is left to cycle to.
    const cycle = activeGroupId ? ['projects'] : PANEL_CYCLE;
    const from = focusedPanel === 'canvas' ? -1 : cycle.indexOf(focusedPanel);
    setFocus(cycle[(from + 1) % cycle.length]);
    return;
  }
  if (e.key === '`' && !e.repeat) { toggleTagsHidden(); return; }
  if (e.key === '~' && !e.repeat) { helpNavHeld = true; helpNavIndex = 0; updateHelpNavHighlight(); }
  if (helpNavHeld && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    helpNavIndex = (helpNavIndex + dir + helpNavItems.length) % helpNavItems.length;
    updateHelpNavHighlight();
    return;
  }
  if (helpNavHeld && (e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); helpNavItems[helpNavIndex].click(); return; }

  // --- Per-panel dispatch ---
  if (focusedPanel === 'projects') { dispatchProjects(e); return; }
  if (focusedPanel === 'colors') { dispatchColors(e); return; }
  if (focusedPanel === 'layers') { dispatchLayers(e); return; }
  if (focusedPanel === 'timeline') { dispatchTimeline(e); return; }
  dispatchCanvas(e);
});

window.addEventListener('keyup', (e) => {
  if (e.key.startsWith('Arrow')) {
    heldArrows.delete(e.key);
    if (heldArrows.size === 0) {
      arrowRepeater.stop();
      if (contentMoveActive) { selectionApi.commitContentMove(); contentMoveActive = false; }
    }
    return;
  }
  if (e.key === 'Shift') {
    if (e.code === 'ShiftLeft') held.leftShift = false;
    if (e.code === 'ShiftRight') held.rightShift = false;
    // Only finalize once BOTH shift keys are up: checked via the browser's
    // own modifier state (e.getModifierState), not just our own
    // leftShift/rightShift bookkeeping. Relying solely on matching every
    // keydown's e.code to a later keyup's e.code is exactly the kind of
    // thing that can desync on a real keyboard/OS combo (one side's keyup
    // reporting a code that doesn't match what its keydown set) and leave
    // held.shift stuck true forever: every arrow press after that keeps
    // rectangle-selecting with no key actually held, un-fixable by Escape
    // since nothing ever clears held.shift itself. Trusting the browser's
    // own answer for "is Shift still down right now" sidesteps that class
    // of bug entirely.
    // Two independent signals, and each one can lie on its own: our per-code
    // bookkeeping desyncs when a keyup reports a different e.code than its
    // keydown, and e.getModifierState still reports Shift down during
    // Shift's own keyup on some platforms (X11/Wayland sample the modifier
    // bitmask before applying the release). Trusting either one alone
    // leaves held.shift stuck true forever, and every later arrow press
    // keeps rectangle-selecting with no key held. Stay held only while BOTH
    // agree it is down; either one saying "up" releases.
    const modState = e.getModifierState ? e.getModifierState('Shift') : true;
    const stillHeld = (held.leftShift || held.rightShift) && modState;
    if (stillHeld) return;
    held.shift = false;
    held.leftShift = false;
    held.rightShift = false;
    if (rectSelecting && focusedPanel === 'canvas' && arrowAnchor && !held.ctrl && !held.alt) {
      const c = currentCursor();
      selectionApi.set(maskFromRect(model, arrowAnchor.x, arrowAnchor.y, c.x, c.y));
      draw();
    }
    arrowAnchor = null;
    rectSelecting = false;
    return;
  }
  if (e.key === 'Control') {
    held.ctrl = false;
    setHeldFill(false);
    if (e.code === 'ControlLeft') {
      leftCtrlDown = false;
      if (!leftCtrlUsed) setFocus('canvas');
    }
    return;
  }
  if (e.key === 'Alt') { held.alt = false; return; }
  if (e.key === ' ') {
    held.space = false;
    if (ctrlSpaceArmed) {
      if (!panningKeyboard) togglePlayback();
      ctrlSpaceArmed = false; panningKeyboard = false;
      return;
    }
    stampRepeater.stop();
    return;
  }
  if (e.key === 'z') { held.z = false; return; }
  if (e.key === 'r' || e.key === 'R') { endRotate(); return; }
  if (SHAPE_KEYS[e.key.toLowerCase()]) { endShape(); return; }
  if (e.key === 'Enter') setHeldFill(false);
  if (e.key === 'i' || e.key === 'I') { setHeldD(false); return; }
  if (e.code === 'Backquote') { helpNavHeld = false; updateHelpNavHighlight(); return; } // e.key may already read ` if Shift came up first
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (focusedPanel === 'timeline' && fpsRepeater) { fpsRepeater.stop(); fpsRepeater = null; }
  }
});

// The browser only delivers a keyup while this page has focus: alt-tabbing,
// switching browser tabs, or a native dialog stealing focus while a
// modifier is held all leave it stuck "down" forever otherwise (e.g. Shift
// stuck true keeps arrowTick() rectangle-selecting on every arrow press,
// with no key actually held). Reset every held-key/gesture flag whenever
// the page stops being the active one, same cleanup each key's own keyup
// would have done.
function resetHeldKeys() {
  held.alt = held.ctrl = held.shift = held.leftShift = held.rightShift = held.space = held.z = false;
  arrowAnchor = null;
  rectSelecting = false;
  heldArrows.clear();
  arrowRepeater.stop();
  stampRepeater.stop();
  if (contentMoveActive) { selectionApi.commitContentMove(); contentMoveActive = false; }
  ctrlSpaceArmed = false;
  panningKeyboard = false;
  leftCtrlDown = false;
  leftCtrlUsed = false;
  helpNavHeld = false;
  updateHelpNavHighlight();
  if (fpsRepeater) { fpsRepeater.stop(); fpsRepeater = null; }
  if (rotating) endRotate();
  if (shapeState) endShape();
  setHeldFill(false);
  setHeldD(false);
}
window.addEventListener('blur', resetHeldKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetHeldKeys(); });

// Hold I + left-click: samples a color from anywhere in the viewport:
// canvas pixels, the transparent backdrop, palette chips, any UI surface:
// not just the canvas. Adds the sampled color as a new chip if the palette
// doesn't already have it. (Tapping I alone instead adds whatever's under
// the keyboard cursor, handled in dispatchCanvas above.)
function setHeldD(active) {
  if (heldD === active) return;
  heldD = active;
  forceCursor(active ? 'dropper' : null);
  if (!active && dPickPreview) { dPickPreview.remove(); dPickPreview = null; }
}

function rgbStringToHex(rgbStr) {
  const m = rgbStr && rgbStr.match(/[\d.]+/g);
  if (!m || m.length < 3) return null;
  return '#' + m.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Walks up from whatever's under the cursor: canvas pixel/backdrop first,
// then a palette chip's own color, then the nearest actual background
// color in the DOM (so sampling empty panel space still gets something).
function sampleColorAt(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;

  if (el === canvas) {
    const rect = canvas.getBoundingClientRect();
    const viewport = computeViewport(model, rect.width, rect.height);
    const px = screenToPixel(viewport, clientX - rect.left, clientY - rect.top);
    const file = getActiveFile(project);
    if (px.x >= 0 && px.y >= 0 && px.x < model.width && px.y < model.height) {
      const composite = compositeFrame(file);
      const color = composite[px.y * model.width + px.x];
      if (color) return packedToHex(color);
    }
    return '#CFCFCF'; // sampled the transparent backdrop/checkerboard
  }

  const chipEl = el.closest && el.closest('.chip');
  if (chipEl) {
    const chipColor = getComputedStyle(chipEl).getPropertyValue('--chip-color').trim();
    if (chipColor) return chipColor.startsWith('#') ? chipColor.toUpperCase() : rgbStringToHex(chipColor);
  }

  let node = el;
  while (node && node !== document.documentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba?\([^)]*,\s*0\s*\)/.test(bg)) return rgbStringToHex(bg);
    node = node.parentElement;
  }
  return '#121214';
}

document.addEventListener('pointerdown', (e) => {
  if (!heldD) return;
  e.preventDefault();
  e.stopPropagation();
  const hex = sampleColorAt(e.clientX, e.clientY);
  if (hex) palette.pickColor(hex);
}, true);

// Clicking anywhere outside the currently focused panel gives the keyboard
// back to the canvas, same as Escape: but not a click inside a slide-out
// menu the panel itself opened (§ slide-out.js), which floats as its own
// <body>-level node outside the panel's DOM but still belongs to it.
document.addEventListener('pointerdown', (e) => {
  if (focusedPanel === 'canvas') return;
  const panelEl = PANEL_EL[focusedPanel];
  if (panelEl && !panelEl.contains(e.target) && !e.target.closest('.slide-out-bar')) setFocus('canvas');
});

document.addEventListener('pointermove', (e) => {
  if (!heldD) return;
  const hex = sampleColorAt(e.clientX, e.clientY);
  if (!dPickPreview) {
    dPickPreview = document.createElement('div');
    dPickPreview.className = 'd-pick-preview';
    document.body.append(dPickPreview);
  }
  dPickPreview.style.background = hex || 'transparent';
  // Offset up-right of the actual cursor/sample point so the preview
  // itself never covers what's being sampled.
  dPickPreview.style.left = e.clientX + 14 + 'px';
  dPickPreview.style.top = e.clientY - 14 - 16 + 'px';
}, true);

document.addEventListener('contextmenu', (e) => {
  if (heldD) e.preventDefault();
}, true);

resize();

// TEMPORARY diagnostic hook: remove once the stuck-Shift selection bug is
// pinned down. Exposes the live modifier/selection state so a reproduction
// on real hardware can be inspected from the console.
window.__spriteDebug = () => ({
  held: { ...held },
  arrowAnchor,
  rectSelecting,
  focusedPanel,
  heldArrows: [...heldArrows],
  shapeActive: !!shapeState,
  hasSelection: !!selectionMask,
});
