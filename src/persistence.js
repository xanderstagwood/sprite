import { resumeFolder, createDefaultBackend } from './storage.js';
import { releaseReferences } from './references.js';
import { encodeFile, encodeStubMeta, stubFile, parseFile, chunkName, needsTidy, tidyFile, FORMAT_VERSION } from './sprite-format.js';
import { deflate, inflate } from './compression.js';

// Debounced write: autosave fires after every committed EditCommand, but
// batched against rapid-fire commits (e.g. end-of-stroke) rather than
// writing mid-stroke (§18).
// `ms` may be a function, re-read on every call, for a delay that depends
// on current state (see autosaveDelay).
export function debounce(fn, ms = 400) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), typeof ms === 'function' ? ms() : ms);
  };
}

// Serializing a file costs roughly its canvas area, so a big canvas waits
// longer to batch more edits per write: a flat 400ms up to 64x64, stretching
// linearly to 5s at 512x512.
export function autosaveDelay(area) {
  const SMALL = 64 * 64, LARGE = 512 * 512;
  const t = Math.min(1, Math.max(0, (area - SMALL) / (LARGE - SMALL)));
  return 400 + t * 4600;
}

export async function chooseBackend() {
  const fsa = await resumeFolder().catch(() => null);
  return fsa || createDefaultBackend();
}

// Every saved project gets its own [projectId, ...] subtree: the registry
// (a flat list at the backend root, outside any project's own subtree) is
// the index of what's out there, so "Open Project" doesn't need to load
// every project's full data just to list their names.
const REGISTRY_PATH = ['projects.json'];

export async function listProjects(backend) {
  return (await backend.read(REGISTRY_PATH)) || [];
}

async function touchRegistry(backend, project) {
  const registry = await listProjects(backend);
  const i = registry.findIndex((p) => p.id === project.id);
  const entry = { id: project.id, name: project.name, updatedAt: Date.now() };
  if (i >= 0) registry[i] = entry; else registry.push(entry);
  await backend.write(REGISTRY_PATH, registry);
}

export async function loadProject(backend, projectId) {
  const meta = await backend.read([projectId, 'project.json']);
  if (!meta) return null;
  const storedJson = JSON.stringify(meta); // as saved, before anything below fills in what an older save lacked
  const files = [];
  for (const fileName of meta.fileNames) {
    const raw = await backend.read([projectId, fileName]);
    if (!raw) continue;
    // Only the active File's pixels are read now. Every other current-format
    // File is a stub (sprite-format.js stubFile) that loads on first use, so
    // opening a big project stops costing memory and time for Files never
    // touched. Older formats are read in full: they need rewriting anyway.
    const lazy = raw.version === FORMAT_VERSION && !needsTidy(raw) && files.length !== meta.activeFileIndex;
    if (lazy) {
      const stub = stubFile(raw);
      stub._load = () => loadStub(backend, projectId, fileName, raw, stub);
      files.push(stub);
      continue;
    }
    const file = await readFile(backend, projectId, fileName, raw);
    // An older file, or one holding hidden pixels, is rewritten right away, so
    // the old shape doesn't linger in storage until this file happens to be
    // edited. Only once the new chunks are written are the old ones dropped.
    const tidy = needsTidy(file);
    if (tidy) tidyFile(file);
    if (raw.version !== FORMAT_VERSION || tidy) {
      await writeFile(backend, projectId, file);
      await dropLegacyChunks(backend, projectId, fileName, raw);
    }
    files.push(file);
  }
  if (!files.length) return null;
  const collections = meta.collections || [];
  // Redo stack is session-only, never persisted (§10): reopening starts
  // empty. `layerGroups` and every `.order` field are newer than some
  // already-saved projects: default rather than crash on an old one.
  // (Stale `collectionId`/`groupId` fields from the pre-ordering.js model
  // are harmless leftovers: membership is derived fresh from `.order` on
  // every read now, never read back off those fields.)
  files.forEach((file, i) => {
    file.redoStack = [];
    file.layerGroups ||= [];
    file.references ||= [];
    file.order ??= (i + 1) * 1000;
    file.layers.forEach((layer, li) => { layer.order ??= (li + 1) * 1000; });
    file.layerGroups.forEach((g, gi) => { g.order ??= (gi + 1) * 1000; });
  });
  // `gridset` was a per-collection column count, since removed.
  collections.forEach((c, i) => { c.order ??= (i + 1) * 1000; delete c.gridset; });
  // What's on disk now is what was just read, so the first autosave of a
  // freshly opened project needn't rewrite every File.
  files.forEach((file) => {
    if (file._stub) lastWritten.set(file, { path: `${projectId}/${file.name}`, json: JSON.stringify(encodeStubMeta(file)), chunkSigs: new Map() });
    else if (!lastWritten.has(file)) lastWritten.set(file, snapshotOf(projectId, file, encodeFile(file)));
  });
  const project = { id: projectId, name: meta.name, palette: meta.palette, activeFileIndex: meta.activeFileIndex, collections, files };
  // Same for project.json (and, by way of it, the registry): a project that is only opened writes nothing.
  // One whose saved JSON lacked something filled in above differs from it, and is written once.
  lastProjectJson.set(project, storedJson);
  return project;
}

const projectJsonOf = (project) => ({
  name: project.name,
  palette: project.palette,
  activeFileIndex: project.activeFileIndex,
  collections: project.collections,
  fileNames: project.files.map((f) => f.name + '.sprite'),
});

// Reads a File's chunks (every layer buffer's for v4, every Frame's for v3,
// the single sidecar for v2, nothing for v1) and decodes them. Chunks are
// fetched up front because parseFile is synchronous.
async function readFile(backend, projectId, fileName, raw) {
  const chunks = new Map();
  // `fileName` is the JSON's stored name ("x.sprite"); chunks are named
  // after the File ("x"), see writeFile.
  const base = fileName.replace(/\.sprite$/, '');
  if (raw.version === FORMAT_VERSION || raw.version === 4) {
    for (const { id, buffers } of raw.frames) {
      for (const cid of buffers) {
        const name = chunkName(id, cid);
        let bytes = await backend.readBytes([projectId, `${base}.sprite.${name}`]);
        if (bytes && raw.version === FORMAT_VERSION) bytes = await inflate(bytes);
        chunks.set(`chunk:${name}`, bytes);
      }
    }
  } else if (raw.version === 3) {
    for (const id of raw.frames) chunks.set(`frame:${id}`, await backend.readBytes([projectId, legacyFrameChunk(base, id)]));
  } else if (raw.version === 2) {
    chunks.set('bin', await backend.readBytes([projectId, fileName + '.bin']));
  }
  for (const [key, bytes] of chunks) {
    if (!bytes && key !== 'bin') console.error(`Missing pixel data (${key}) for "${base}": it will open blank`);
  }
  return parseFile(raw, (kind, id) => chunks.get(id === undefined ? kind : `${kind}:${id}`) ?? null);
}

// What an older format left in storage that the current one no longer uses.
async function dropLegacyChunks(backend, projectId, fileName, raw) {
  const base = fileName.replace(/\.sprite$/, '');
  if (raw.version === 2) await backend.delete([projectId, fileName + '.bin']);
  if (raw.version === 3) {
    for (const id of raw.frames) await backend.delete([projectId, legacyFrameChunk(base, id)]);
    await backend.delete([projectId, base + UNDO_SUFFIX]);
  }
}

// Fills a stub in place from storage, once (concurrent callers share the
// same promise). Only the pixels come from disk: the stub's own fields
// (e.g. an `order` changed since opening) are newer.
async function loadStub(backend, projectId, fileName, raw, stub) {
  const full = await readFile(backend, projectId, fileName, raw);
  stub.frames = full.frames;
  delete stub._stub;
  delete stub._load;
  lastWritten.set(stub, snapshotOf(projectId, stub, encodeFile(stub)));
  // Puts the File back to a stub, but only while nothing has changed since it
  // was read (its saved state is then still exactly what's in memory).
  stub._release = () => {
    const enc = encodeFile(stub);
    const last = lastWritten.get(stub);
    if (JSON.stringify(enc.meta) !== last.json || enc.chunks.some((c) => last.chunkSigs.get(c.name) !== c.sig)) return;
    becomeStub(backend, projectId, stub, JSON.parse(JSON.stringify(enc.meta)));
  };
}

// Resolves once `file`'s pixels are in memory (immediately if they already
// are). Anything about to read a File that may not be the active one:
// export, resize, the collection grid: awaits this first.
export function ensureLoaded(file) {
  markUsed(file);
  if (!file._stub) return Promise.resolve();
  return file._loading ||= file._load().finally(() => { delete file._loading; });
}

// Loads `file` for a one-off read (an export) and returns a function that
// puts it back to a stub if it was one and nobody has used it since, so a
// whole-project read doesn't leave the whole project resident.
export async function loadTemporarily(file) {
  const wasStub = !!file._stub;
  await ensureLoaded(file);
  const stamp = lastUsed.get(file);
  return () => { if (wasStub && lastUsed.get(file) === stamp) file._release?.(); };
}

const lastUsed = new WeakMap(); // File -> ms timestamp of its last activation/load
export const markUsed = (file) => lastUsed.set(file, Date.now());

// Turns a saved, loaded File back into a stub (drops its buffers and its
// session undo history from memory; the pixels are on disk). `raw` is its current saved meta.
function becomeStub(backend, projectId, file, raw) {
  const stub = stubFile(raw);
  file.frames = stub.frames;
  file.undoStack = [];
  file.redoStack = [];
  releaseReferences(file);
  file._stub = true;
  delete file._release;
  file._load = () => loadStub(backend, projectId, `${file.name}.sprite`, raw, file);
  lastWritten.set(file, { path: `${projectId}/${file.name}`, json: JSON.stringify(encodeStubMeta(file)), chunkSigs: new Map() });
}

// Releases the pixels of Files nobody is using, so memory follows what's
// actually open rather than everything ever visited. A File is kept if
// `inUse` says so, if it's one of the `keep` most recently used, or if it was
// used within `idleMs` (which also covers an export still reading it). It is
// saved first, and left alone if anything changed while that write ran.
export async function unloadIdle(backend, project, inUse, { keep = 3, idleMs = 60_000 } = {}) {
  const candidates = project.files
    .filter((f) => !f._stub && !inUse(f))
    .sort((a, b) => (lastUsed.get(b) || 0) - (lastUsed.get(a) || 0))
    .slice(keep);
  for (const file of candidates) {
    if (Date.now() - (lastUsed.get(file) || 0) < idleMs) continue;
    await writeFile(backend, project.id, file);
    if (file._stub || inUse(file)) continue;
    const enc = encodeFile(file);
    const last = lastWritten.get(file);
    if (enc.chunks.some((c) => last.chunkSigs.get(c.name) !== c.sig)) continue;
    becomeStub(backend, project.id, file, JSON.parse(JSON.stringify(enc.meta)));
  }
}

// Deletes every file a project owns (its subtree is flat: project.json
// plus one .sprite per File, no nested directories) and drops it from the
// registry. No undo: this is a hard delete, same as every other
// delete/remove button in the app (file, collection, layer, group), none
// of which confirm either.
// Removes a project's whole folder: its files, then the folder itself, so a failed
// or abandoned save leaves nothing on the disk.
async function removeProjectFolder(backend, projectId) {
  const names = await backend.list([projectId]);
  await Promise.all(names.map((name) => backend.delete([projectId, name])));
  await backend.removeDir?.([projectId]);
}

const PROJECT_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Project folders in the working directory that no project owns: what a save that
 * failed half way, or an import that was abandoned, leaves behind. `keep` names
 * ids to leave alone (the project that is open). Only folders named like a
 * project id count; anything else in the directory is never touched. With
 * `olderThan` (ms), a folder written to more recently than that is left too: it may
 * be a save or import still running in another tab, which registers its project last.
 */
export async function findOrphans(backend, keep = [], { olderThan = 0 } = {}) {
  const owned = new Set([...(await listProjects(backend)).map((entry) => entry.id), ...keep]);
  const orphans = (await backend.list([])).filter((name) => PROJECT_FOLDER.test(name) && !owned.has(name));
  if (!olderThan || !backend.newestChange) return orphans;
  const now = Date.now();
  const settled = await Promise.all(orphans.map(async (id) => now - (await backend.newestChange([id])) >= olderThan));
  return orphans.filter((_, i) => settled[i]);
}

/** Removes what `findOrphans` finds; resolves to how many folders went. */
export async function removeOrphans(backend, keep = [], options) {
  const orphans = await findOrphans(backend, keep, options);
  for (const id of orphans) await removeProjectFolder(backend, id);
  return orphans.length;
}

export async function deleteProject(backend, projectId) {
  await removeProjectFolder(backend, projectId);
  const registry = await listProjects(backend);
  await backend.write(REGISTRY_PATH, registry.filter((entry) => entry.id !== projectId));
}

// A File's pixels live in binary chunks beside its JSON: one per layer
// buffer (see sprite-format.js). Chunks are written before the JSON, so a
// saved JSON never points at chunks that aren't there yet.
const legacyFrameChunk = (fileName, id) => `${fileName}.sprite.frame-${id}`; // v3: every layer of a Frame in one
const UNDO_SUFFIX = '.sprite.undo'; // v3 only

// What each File / project.json last wrote, so an autosave rewrites only
// what changed: drawing one pixel in one Frame of a 10-File project used to
// re-serialize all ten Files, and now rewrites just that Frame's chunk. The
// chunks are gated on their cheap change signatures; the small JSON is
// compared as text, which also catches edits that touch no pixels (layer
// visibility, renames). Not persisted, so a cold start (or a rename, which
// changes the path) just writes once.
const lastWritten = new WeakMap(); // File -> { path, json, chunkSigs: Map<chunk name, sig> }
const lastProjectJson = new WeakMap(); // project -> string

const snapshotOf = (projectId, file, enc) => ({
  path: `${projectId}/${file.name}`,
  json: JSON.stringify(enc.meta),
  chunkSigs: new Map(enc.chunks.map((c) => [c.name, c.sig])),
});

// Returns whether anything was written.
async function writeFile(backend, projectId, file) {
  if (file._stub) {
    const path = `${projectId}/${file.name}`;
    const last = lastWritten.get(file);
    if (last && last.path === path) {
      // Untouched pixels: at most the small JSON changed (e.g. its `order`).
      const json = JSON.stringify(encodeStubMeta(file));
      if (json === last.json) return false;
      await backend.write([projectId, file.name + '.sprite'], JSON.parse(json));
      last.json = json;
      return true;
    }
    // Moved to another Project or renamed: it must be written under the new
    // path, which needs its pixels.
    await ensureLoaded(file);
  }
  const enc = encodeFile(file);
  const now = snapshotOf(projectId, file, enc);
  const last = lastWritten.get(file);
  const same = last && last.path === now.path;
  let wrote = false;
  for (const chunk of enc.chunks) {
    if (same && last.chunkSigs.get(chunk.name) === chunk.sig) continue;
    const bytes = chunk.bytes();
    await backend.write([projectId, `${file.name}.sprite.${chunk.name}`], chunk.deflated ? bytes : await deflate(bytes));
    wrote = true;
  }
  if (!same || last.json !== now.json) {
    await backend.write([projectId, file.name + '.sprite'], enc.meta);
    wrote = true;
  }
  // Chunks of Frames or layers deleted since the last write are now unreferenced.
  if (same) {
    for (const name of last.chunkSigs.keys()) {
      if (!now.chunkSigs.has(name)) await backend.delete([projectId, `${file.name}.sprite.${name}`]);
    }
  }
  lastWritten.set(file, now);
  return wrote;
}

// Drops a File's stored JSON and every chunk (it moved to another Project,
// or was deleted). The chunks are named from what its last write recorded, so
// nothing scans the whole store; a File with no record (never written by this
// session) falls back to listing the Project for its prefix.
export async function deleteStoredFile(backend, projectId, file) {
  const base = `${file.name}.sprite`;
  const last = lastWritten.get(file);
  // A stub keeps no chunk signatures, but its frames still name their buffers.
  const chunks = file._stub
    ? file.frames.flatMap(({ id, buffers }) => buffers.map((cid) => chunkName(id, cid)))
    : last && [...last.chunkSigs.keys()];
  const names = chunks
    ? [base, ...chunks.map((name) => `${base}.${name}`)]
    : (await backend.list([projectId])).filter((n) => n === base || n.startsWith(base + '.'));
  await Promise.all(names.map((n) => backend.delete([projectId, n])));
}

// `files` narrows the write to Files known to have changed (project.json is
// always checked); omitted, every File is checked. Resolves to whether anything
// was written. `onProgress(fraction)` is told as each file finishes.
export async function saveProject(backend, project, files = project.files, onProgress) {
  const projectJson = projectJsonOf(project);
  const serialized = JSON.stringify(projectJson);
  let wrote = false;
  if (lastProjectJson.get(project) !== serialized) {
    await backend.write([project.id, 'project.json'], projectJson);
    lastProjectJson.set(project, serialized);
    wrote = true;
  }
  let done = 0;
  const results = await Promise.all(files.map(async (file) => {
    const wroteFile = await writeFile(backend, project.id, file);
    onProgress?.(++done / files.length);
    return wroteFile;
  }));
  const changed = wrote || results.includes(true);
  if (changed) await touchRegistry(backend, project);
  return changed;
}

// Writes the whole project into another backend (a newly chosen working folder),
// every file and chunk whether or not it changed: nothing there has it yet. The
// project keeps its id, so it opens in the new place as the same project. Files
// that were stubs are read only for as long as it takes, then put back.
export async function copyProject(target, project) {
  for (const file of project.files) {
    const release = await loadTemporarily(file);
    const enc = encodeFile(file);
    for (const chunk of enc.chunks) {
      const bytes = chunk.bytes();
      await target.write([project.id, `${file.name}.sprite.${chunk.name}`], chunk.deflated ? bytes : await deflate(bytes));
    }
    await target.write([project.id, file.name + '.sprite'], enc.meta);
    release();
  }
  await target.write([project.id, 'project.json'], projectJsonOf(project));
  await touchRegistry(target, project);
}
