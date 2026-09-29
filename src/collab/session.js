import { loadPeerConstructor } from './peerjs-loader.js';

// Collab session: connection + participant state, closure-scoped with a
// flat function API (mirrors frame-selection.js's shape). Host-authoritative
// star topology (§ collab plan): a guest only ever talks to the host, and
// the host relays anything it receives to every other guest, so from a
// message-sender's point of view broadcast and 1:1 look the same.
//
// `createPeer` is injectable so tests can wire two sessions through a fake
// PeerJS-shaped object with no real network (see test/session-protocol.mjs);
// the real one lazy-loads PeerJS itself so solo users never fetch it.
async function defaultCreatePeer() {
  const Peer = await loadPeerConstructor();
  const peer = new Peer();
  await new Promise((resolve, reject) => {
    peer.on('open', resolve);
    peer.on('error', reject);
  });
  return peer;
}

export function createSession({ createPeer = defaultCreatePeer } = {}) {
  let role = null; // 'host' | 'guest' | null
  let peer = null;
  const connections = new Map(); // participant id -> DataConnection
  const participants = new Map(); // participant id -> { id, role, name }
  const handlers = new Map(); // message type -> Set<handler>

  function emit(type, payload, fromId) {
    for (const handler of handlers.get(type) || []) handler(payload, fromId);
  }

  function wireConnection(conn, participantId) {
    conn.on('data', (msg) => {
      if (!msg || typeof msg.type !== 'string') return;
      // A relayed message already carries its original sender's id (`from`,
      // stamped below); a direct message's sender is just whoever's on the
      // other end of this connection.
      const fromId = msg.from ?? participantId;
      emit(msg.type, msg.payload, fromId);
      // Host relay: everyone else hears it too, as if broadcast, with the
      // original sender preserved so it doesn't look like it came from the host.
      if (role === 'host') {
        const relay = msg.from ? msg : { ...msg, from: participantId };
        for (const [id, c] of connections) if (id !== participantId) c.send(relay);
      }
    });
    conn.on('close', () => {
      connections.delete(participantId);
      participants.delete(participantId);
      emit('participant-left', { id: participantId });
    });
  }

  async function host() {
    role = 'host';
    peer = await createPeer();
    participants.set(peer.id, { id: peer.id, role: 'host', name: 'Host' });
    peer.on('connection', (conn) => {
      const guestNumber = connections.size + 1;
      connections.set(conn.peer, conn);
      wireConnection(conn, conn.peer);
      conn.on('open', () => {
        const info = { id: conn.peer, role: 'guest', name: `Guest ${guestNumber}` };
        participants.set(conn.peer, info);
        emit('participant-joined', info);
      });
    });
    return peer.id;
  }

  async function join(hostId) {
    role = 'guest';
    peer = await createPeer();
    const conn = peer.connect(hostId);
    connections.set(hostId, conn);
    wireConnection(conn, hostId);
    await new Promise((resolve) => conn.on('open', resolve));
    participants.set(hostId, { id: hostId, role: 'host', name: 'Host' });
    participants.set(peer.id, { id: peer.id, role: 'guest', name: 'Guest' });
    return peer.id;
  }

  function send(type, payload) {
    const msg = { type, payload };
    for (const conn of connections.values()) conn.send(msg);
  }

  function onMessage(type, handler) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(handler);
    return () => handlers.get(type)?.delete(handler);
  }

  function getRole() { return role; }
  function getParticipants() { return [...participants.values()]; }

  function leave() {
    for (const conn of connections.values()) conn.close?.();
    peer?.destroy?.();
    connections.clear();
    participants.clear();
    role = null;
    peer = null;
  }

  return { host, join, send, onMessage, getRole, getParticipants, leave };
}
