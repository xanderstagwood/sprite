// Persisted UI preferences: which panels are pinned open, grid/ruler
// visibility, backgrounds, corner-tag visibility: restored on reload so the
// workspace looks the same as when you left it. Distinct from Project data
// (which goes through persistence.js): this is a display preference, not part
// of the .sprite file. It lives in localStorage like the export panel's
// remembered format/scale, and, when the user has connected a real folder, is
// mirrored to a `.prefs` file there, so clearing the browser's storage and
// re-adding the folder brings the workspace back. The folder's copy wins when
// both exist: it is the one that survives.
const KEY = 'sprite-ui-prefs';
const PREFS_PATH = ['.prefs'];
const WRITE_DELAY_MS = 500;
const DEFAULTS = {
  project: false, layers: false, timeline: false, palette: true, // panel pin state (§7.2 flagged assumption 3: palette starts pinned)
  showGrid: true, showRuler: false, dither: false, symmetry: 'off', tagsHidden: false, canvasBg: 'white', appBg: 'white', lastProjectId: null, collabName: null, // collabName: display name shown to collaborators (collab/presence.js)
  // The group grid (§ project panel group select) has no canvas background
  // of its own (every artboard is always transparent): just its own `U`
  // backdrop, separate from the single-file canvas's above.
  groupAppBg: 'white',
  hint: 'folder', // first-run hint: which control pulses next (folder, menu, new, colors), 'done' once all are used
};

let folder = null; // the connected-folder backend that mirrors prefs, if any
let writeTimer = null;

/** Prefs from the connected folder's `.prefs` if present, else localStorage, over the defaults. */
export async function loadUiPrefs(backend) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { /* unavailable or corrupt: use defaults */ }
  if (backend.kind === 'fsa') {
    folder = backend;
    saved = (await backend.read(PREFS_PATH).catch(() => null)) || saved;
  }
  return { ...DEFAULTS, ...saved };
}

export function saveUiPrefs(prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore quota/availability */ }
  if (!folder) return;
  // Debounced: toggles arrive in bursts (Shift+U held down, a drag-pin), and the file is a real write.
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => folder.write(PREFS_PATH, prefs).catch(() => { /* folder gone or read-only: localStorage still has it */ }), WRITE_DELAY_MS);
}
