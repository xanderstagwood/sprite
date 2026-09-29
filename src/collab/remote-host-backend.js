import { MSG } from './protocol.js';

// Guest side of phase 3: the same {read, readBytes, write, list, delete}
// shape storage.js's backends have, answered by the host over the data
// channel, so persistence.js's loadProject/stub loading run unmodified.
export function createRemoteHostBackend(session, hostId, { timeoutMs = 10_000 } = {}) {
  let nextId = 0;
  const pending = new Map(); // request id -> { resolve, reject, timer }

  session.onMessage(MSG.READ_RES, (res, fromId) => {
    // Only the host answers reads; anyone else's reply is noise or forgery.
    if (fromId !== hostId) return;
    const req = pending.get(res?.id);
    if (!req) return;
    pending.delete(res.id);
    clearTimeout(req.timer);
    if (res.error) req.reject(new Error('Host failed to read'));
    else req.resolve(res.data ?? null);
  });

  function request(op, path) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host read timed out')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      session.sendTo(hostId, MSG.READ_REQ, { id, op, path });
    });
  }

  // Guest edits reach the host as strokes (stroke-sync.js), never as storage
  // writes, so a guest's storage calls must not touch or fake any state.
  return {
    kind: 'remote',
    read: (path) => request('read', path),
    async readBytes(path) {
      const v = await request('readBytes', path);
      return v && new Uint8Array(v);
    },
    async write() {},
    async delete() {},
    async list() { return []; },
  };
}

const SAFE_NAME = (n) => typeof n === 'string' && n !== '.' && n !== '..' && !/[/\\]/.test(n);

// Host side: answers a guest's read requests from its own backend. The one
// place a peer can make the host touch storage, so it serves exactly the
// shared project's flat files ([projectId, name]) and nothing else, whatever
// the message claims. `projectId` may be a getter, for a host that switches
// projects mid-session. `beforeRead` lets the host flush unsaved edits first.
export function serveReads(session, backend, projectId, { beforeRead } = {}) {
  session.onMessage(MSG.READ_REQ, async (req, fromId) => {
    const { id, op, path } = req || {};
    if (!Number.isInteger(id)) return;
    const ok = (op === 'read' || op === 'readBytes') && Array.isArray(path) && path.length === 2 && path[0] === (typeof projectId === 'function' ? projectId() : projectId) && SAFE_NAME(path[1]);
    if (!ok) { session.sendTo(fromId, MSG.READ_RES, { id, data: null }); return; }
    try {
      await beforeRead?.();
      session.sendTo(fromId, MSG.READ_RES, { id, data: await backend[op](path) });
    } catch {
      session.sendTo(fromId, MSG.READ_RES, { id, error: true });
    }
  });
}
