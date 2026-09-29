// Hybrid storage backend (design-doc §1 item 5, ui-design-system §3): a real
// directory via the File System Access API when the browser grants it,
// otherwise a silent fallback to an IndexedDB-backed virtual filesystem.
// Both backends share the same path-based interface so callers (Phase 7's
// Project/File model) never need to know which one is active.
//
// Path = an array of segments, e.g. ['MyProject', 'icon.sprite'].
// `write` takes either a JSON-able value or a Uint8Array (stored raw: the
// binary pixel sidecars); binary entries are read back with `readBytes`.

const IDB_NAME = 'sprite-vfs';
const IDB_STORE = 'entries';
const IDB_HANDLE_STORE = 'fsa-handle';

// One shared connection: opening per operation costs an async round trip
// before the real work starts, and one autosave issues dozens. Dropped when
// the browser closes it or another tab needs a version upgrade, so a dead
// connection is never handed out again.
let idbPromise = null;
function openIdb() {
  return idbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if (!db.objectStoreNames.contains(IDB_HANDLE_STORE)) db.createObjectStore(IDB_HANDLE_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      const drop = () => { idbPromise = null; db.close(); };
      db.onclose = drop;
      db.onversionchange = drop;
      resolve(db);
    };
    req.onerror = () => { idbPromise = null; reject(req.error); };
  });
}

function idbRequest(store, mode, fn) {
  return openIdb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function createIndexedDbBackend() {
  return {
    kind: 'idb',
    async write(path, data) {
      await idbRequest(IDB_STORE, 'readwrite', (s) => s.put(data, path.join('/')));
    },
    async read(path) {
      const v = await idbRequest(IDB_STORE, 'readonly', (s) => s.get(path.join('/')));
      return v === undefined ? null : v;
    },
    async readBytes(path) {
      const v = await this.read(path);
      return v && new Uint8Array(v);
    },
    async delete(path) {
      await idbRequest(IDB_STORE, 'readwrite', (s) => s.delete(path.join('/')));
    },
    async removeDir(path) {
      const prefix = path.join('/') + '/';
      const keys = await idbRequest(IDB_STORE, 'readonly', (s) => s.getAllKeys());
      for (const k of keys) if (k.startsWith(prefix)) await idbRequest(IDB_STORE, 'readwrite', (s) => s.delete(k));
    },
    async list(prefix) {
      const keys = await idbRequest(IDB_STORE, 'readonly', (s) => s.getAllKeys());
      const prefixStr = prefix.length ? prefix.join('/') + '/' : '';
      return keys
        .filter((k) => k.startsWith(prefixStr) && k !== prefixStr)
        .map((k) => k.slice(prefixStr.length).split('/')[0])
        .filter((v, i, arr) => arr.indexOf(v) === i);
    },
  };
}

async function fsaDirFor(root, path, { create } = {}) {
  let dir = root;
  for (let i = 0; i < path.length - 1; i++) {
    dir = await dir.getDirectoryHandle(path[i], { create: !!create });
  }
  return dir;
}

// A canvas can be called \ or ? or CON or Cafe, and no one file name is legal on
// every system, so a name is stored in a form all of them accept and read back as
// it was:
//   - lowercase letters, digits, spaces and the few marks SAFE_CHAR lists are kept;
//   - a capital is written ^ and its lowercase (Windows and macOS treat A and a as
//     one file, and the Alphabet has both);
//   - any other ASCII (\ / : * ? " < > | control characters, % and ^ themselves, and
//     marks like ~ ' # & that some system or browser may object to) is written %XX;
//   - a dot that another dot follows is written %2E (browsers refuse ".." in a name,
//     even inside ..sprite, the file of a canvas called "."; one leading dot, as in
//     .prefs, is fine);
//   - the name Windows keeps for devices (con, nul, com1, ...) has its first letter
//     written %XX, and a dot or space at the end has itself;
//   - other characters are kept as they are, so names in other scripts stay readable.
// Older saves stored capitals as they were; readers fall back to that (legacyName).
const SAFE_CHAR = /[a-z0-9 _\-.()]/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const MAX_NAME_BYTES = 240; // 255 is the limit most file systems set, and a canvas name gets a suffix

const percent = (ch) => [...new TextEncoder().encode(ch)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');

export function encodeName(name) {
  let out = '';
  for (const ch of name) {
    const lower = ch.toLowerCase();
    if (SAFE_CHAR.test(ch)) out += ch;
    else if (lower !== ch && [...lower].length === 1 && lower.toUpperCase() === ch) out += '^' + lower;
    else if (ch.codePointAt(0) > 0x9f) out += ch;
    else out += percent(ch);
  }
  out = out.replace(/\.(?=\.)/g, '%2E');
  if (DEVICE_NAME.test(out.split('.')[0]) || out === '.') out = percent(out[0]) + out.slice(1);
  out = out.replace(/[. ]$/, (c) => percent(c));
  if (new TextEncoder().encode(out).length > MAX_NAME_BYTES) throw new RangeError(`Name too long to store: ${name.slice(0, 24)}...`);
  return out;
}

export const decodeName = (name) => name.replace(/(?:%[0-9A-F]{2})+|\^(.)/gsu, (run, capital) => (capital
  ? capital.toUpperCase()
  : new TextDecoder().decode(Uint8Array.from(run.slice(1).split('%'), (h) => parseInt(h, 16)))));

// How names were stored before capitals were written ^x: only what a file system refuses was changed.
const legacyName = (name) => name
  .replace(/[\\/:*?"<>|%\u0000-\u001f]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
  .replace(/[. ]$/, (c) => (c === '.' ? '%2E' : '%20'));

export function createFsaBackend(rootHandle) {
  const stored = (path) => path.map(encodeName);
  const open = async (names) => (await fsaDirFor(rootHandle, names)).getFileHandle(names[names.length - 1]);
  const last = (names) => names[names.length - 1];

  // Older saves wrote a capital as it was, not ^x. On Windows and macOS `A.sprite` and
  // `a.sprite` are one file to the file system, so an older-named file is only trusted
  // when the folder really lists that exact spelling. One listing per folder is kept.
  const listings = new Map(); // folder path -> Set of the spellings it holds
  async function spellings(names) {
    const key = names.slice(0, -1).join('/');
    if (!listings.has(key)) {
      const held = new Set();
      try { for await (const name of (await fsaDirFor(rootHandle, [...names.slice(0, -1), ''])).keys()) held.add(name); } catch { /* no folder yet */ }
      listings.set(key, held);
    }
    return listings.get(key);
  }
  const older = (path) => [...stored(path).slice(0, -1), legacyName(path[path.length - 1])];
  const olderCopy = async (path) => {
    const names = older(path);
    return last(names) !== last(stored(path)) && (await spellings(names)).has(last(names)) ? names : null;
  };

  return {
    kind: 'fsa',
    name: rootHandle.name,
    async write(path, data) {
      const now = stored(path);
      const dir = await fsaDirFor(rootHandle, now, { create: true });
      const fileHandle = await dir.getFileHandle(last(now), { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(data instanceof Uint8Array ? data : JSON.stringify(data));
      await writable.close();
      // A file saved under its older spelling moves to the new one: the old copy is never read again.
      const before = await olderCopy(path);
      if (before) {
        await dir.removeEntry(last(before)).catch(() => {});
        (await spellings(before)).delete(last(before));
      }
    },
    async read(path) {
      try { return JSON.parse(await (await (await open(stored(path))).getFile()).text()); } catch { /* not there: maybe under its older spelling */ }
      const before = await olderCopy(path);
      try { return before && JSON.parse(await (await (await open(before)).getFile()).text()); } catch { return null; }
    },
    async readBytes(path) {
      try { return new Uint8Array(await (await (await open(stored(path))).getFile()).arrayBuffer()); } catch { /* not there: maybe under its older spelling */ }
      const before = await olderCopy(path);
      try { return before && new Uint8Array(await (await (await open(before)).getFile()).arrayBuffer()); } catch { return null; }
    },
    async delete(path) {
      const before = await olderCopy(path);
      for (const names of [stored(path), before].filter(Boolean)) {
        try {
          await (await fsaDirFor(rootHandle, names)).removeEntry(last(names));
        } catch {
          // already gone
        }
      }
      if (before) (await spellings(before)).delete(last(before));
    },
    // When anything in the folder was last written (0 if it is empty or gone), in ms since 1970.
    async newestChange(path) {
      let newest = 0;
      try {
        for await (const handle of (await fsaDirFor(rootHandle, [...stored(path), ''])).values()) {
          if (handle.kind === 'file') newest = Math.max(newest, (await handle.getFile()).lastModified);
        }
      } catch {
        // no such folder
      }
      return newest;
    },
    async removeDir(path) {
      const names = stored(path);
      try {
        await (await fsaDirFor(rootHandle, names)).removeEntry(last(names), { recursive: true });
      } catch {
        // already gone
      }
    },
    async list(prefix) {
      const names = new Set();
      try {
        const dir = prefix.length ? await fsaDirFor(rootHandle, [...prefix.map(encodeName), '']) : rootHandle;
        for await (const name of dir.keys()) names.add(decodeName(name));
      } catch {
        // directory doesn't exist yet
      }
      return [...names];
    },
  };
}

// Reference images are never copied into a project: a Chromium file handle
// to the user's own file is kept here (handles are structured-cloneable),
// under its own key in the same store as the folder grant.
export const refHandles = {
  save: (id, handle) => idbRequest(IDB_HANDLE_STORE, 'readwrite', (s) => s.put(handle, `ref:${id}`)),
  load: (id) => idbRequest(IDB_HANDLE_STORE, 'readonly', (s) => s.get(`ref:${id}`)),
  delete: (id) => idbRequest(IDB_HANDLE_STORE, 'readwrite', (s) => s.delete(`ref:${id}`)),
};

// One-time "connect a folder" grant (ui-design-system §3.1). The handle is
// cached in IndexedDB so it can be re-requested (not re-prompted from
// scratch) on the next visit: the browser still requires a user gesture to
// re-confirm permission, this just avoids losing which folder was chosen.
export async function connectFolder() {
  if (!window.showDirectoryPicker) return null;
  // Read-write from the start: the default is read-only, and saves would then fail until the browser asked again.
  const handle = await window.showDirectoryPicker({ id: 'sprite-projects', mode: 'readwrite' });
  await idbRequest(IDB_HANDLE_STORE, 'readwrite', (s) => s.put(handle, 'root'));
  return createFsaBackend(handle);
}

let waiting = null; // the saved folder whose permission has lapsed, until it is granted again

export async function resumeFolder() {
  if (!window.showDirectoryPicker) return null;
  const handle = await idbRequest(IDB_HANDLE_STORE, 'readonly', (s) => s.get('root'));
  if (!handle) return null;
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') { // the browser drops the grant between visits; only a click can ask for it again
    waiting = handle;
    return null;
  }
  return createFsaBackend(handle);
}

/** The saved folder that is waiting to be reconnected, as `{ name, grant() }`, or null. `grant()` needs a click. */
export const pendingFolder = () => waiting && {
  name: waiting.name,
  grant: async () => (await waiting.requestPermission({ mode: 'readwrite' })) === 'granted',
};

// Falls back silently to IndexedDB (§1 item 5): this is the default backend
// until/unless the user explicitly connects a folder.
export function createDefaultBackend() {
  return createIndexedDbBackend();
}
