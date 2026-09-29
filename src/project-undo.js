import { nextSeq } from './undo.js';

// Undo for what belongs to the project rather than to one canvas: removing
// canvases and collections, and changing the palette. It keeps its own stacks
// on the project (session-only, like a canvas's), numbered from the same counter
// as the canvas stacks (undo.js) so one Ctrl+Z always takes back the newest
// action wherever it happened.
//
// A removal is stored as what went (the removed canvases and collections, by
// reference, with the places they held), not as a copy of the project, so undoing it
// puts those back without disturbing anything made since. The removed canvases stay
// in memory while the command is on the stack, and no longer: 50 steps at most.
const CAP = 50;

export function recordProject(project, command) {
  if (!command) return;
  command.seq = nextSeq();
  (project.undoStack ||= []).push(command);
  if (project.undoStack.length > CAP) project.undoStack.shift();
  project.redoStack = [];
}

/** What a removal will need to remember: taken before it, and again after. */
export function snapshotStructure(project) {
  return {
    files: project.files.slice(),
    collections: project.collections.slice(),
    orders: new Map(project.files.map((f) => [f, f.order])),
    active: project.files[project.activeFileIndex],
  };
}

/** The command for the removal between two snapshots, or null if nothing was removed. */
export function removalCommand(before, after) {
  const files = before.files.map((file, index) => ({ file, index })).filter(({ file }) => !after.files.includes(file));
  const collections = before.collections.map((collection, index) => ({ collection, index })).filter(({ collection }) => !after.collections.includes(collection));
  if (!files.length && !collections.length) return null;
  // Canvases that stayed but moved (a removed collection's members are re-homed by giving them a new order).
  const moved = after.files.filter((f) => before.orders.has(f) && before.orders.get(f) !== after.orders.get(f));
  return {
    type: 'removal', files, collections,
    orders: { before: new Map(moved.map((f) => [f, before.orders.get(f)])), after: new Map(moved.map((f) => [f, after.orders.get(f)])) },
    active: { before: before.active, after: after.active },
  };
}

export const paletteCommand = (before, after) => ({ type: 'palette', before, after });

const setActive = (project, file) => {
  const i = project.files.indexOf(file);
  project.activeFileIndex = i >= 0 ? i : Math.min(project.activeFileIndex, project.files.length - 1);
};

const apply = {
  removal: {
    undo(project, cmd) {
      for (const { file, index } of cmd.files) project.files.splice(Math.min(index, project.files.length), 0, file);
      for (const { collection, index } of cmd.collections) project.collections.splice(Math.min(index, project.collections.length), 0, collection);
      for (const [file, order] of cmd.orders.before) file.order = order;
      setActive(project, cmd.active.before);
    },
    redo(project, cmd) {
      const gone = new Set(cmd.files.map((e) => e.file));
      const goneCollections = new Set(cmd.collections.map((e) => e.collection));
      project.files = project.files.filter((f) => !gone.has(f));
      project.collections = project.collections.filter((c) => !goneCollections.has(c));
      for (const [file, order] of cmd.orders.after) file.order = order;
      setActive(project, cmd.active.after);
    },
  },
  palette: {
    undo: (project, cmd) => Object.assign(project.palette, { name: cmd.before.name, chips: cmd.before.chips.slice(), primary: cmd.before.primary }),
    redo: (project, cmd) => Object.assign(project.palette, { name: cmd.after.name, chips: cmd.after.chips.slice(), primary: cmd.after.primary }),
  },
};

/** Undoes the project's newest command; returns it, or null if there is none. */
export function undoProject(project) {
  const cmd = project.undoStack?.pop();
  if (!cmd) return null;
  apply[cmd.type].undo(project, cmd);
  cmd.undone = nextSeq();
  (project.redoStack ||= []).push(cmd);
  return cmd;
}

export function redoProject(project) {
  const cmd = project.redoStack?.pop();
  if (!cmd) return null;
  apply[cmd.type].redo(project, cmd);
  project.undoStack.push(cmd);
  return cmd;
}

/** Which stack holds the newest action to undo, 'file' or 'project' (null: neither). */
export function newestUndo(file, project) {
  const f = file.undoStack.at(-1), p = project.undoStack?.at(-1);
  if (!f && !p) return null;
  return p && (!f || p.seq > f.seq) ? 'project' : 'file';
}

/** Which stack holds what was undone most recently, and so comes back first. */
export function newestRedo(file, project) {
  const f = file.redoStack.at(-1), p = project.redoStack?.at(-1);
  if (!f && !p) return null;
  return p && (!f || p.undone > f.undone) ? 'project' : 'file';
}
