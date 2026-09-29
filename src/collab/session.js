import { loadPeerConstructor } from './peerjs-loader.js';
import { sanitizeName } from './presence.js';

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

const MAX_GUESTS = 2;

export function createSession({ createPeer = defaultCreatePeer } = {}) {
  let role = null; // 'host' | 'guest' | null
  let peer = null;
  const connections = new Map(); // participant id -> DataConnection
  const participants = new Map(); // participant id -> { id, role, name }
  const handlers = new Map(); // message type -> Set<handler>
  let hostPeerId = null; // a guest's only connection

  function emit(type, payload, fromId) {
    for (const handler of handlers.get(type) || []) handler(payload, fromId);
  }

  function wireConnection(conn, participantId) {
    conn.on('data', (msg) => {
      if (!msg || typeof msg.type !== 'string') return;
      // Only the host stamps `from` (below), so only a guest may believe it:
      // the host trusting a guest-supplied one would let that guest
      // impersonate anybody.
      const fromId = role === 'guest' ? (msg.from ?? participantId) : participantId;
      // Names and the roster are session state, kept here rather than left to
      // every consumer. Only the host may publish a roster.
      if (msg.type === 'hello' && role === 'host') {
        const name = sanitizeName(msg.payload?.name);
        if (name && participants.has(participantId)) { participants.get(participantId).name = name; broadcastRoster(); }
        return;
      }
      if (msg.type === 'roster') {
        if (role === 'guest' && fromId === hostPeerId) applyRoster(msg.payload);
        return;
      }
      emit(msg.type, msg.payload, fromId);
      if (msg.direct) return; // point-to-point: the host is the endpoint, nothing to relay
      // Host relay: everyone else hears it too, as if broadcast, with the
      // original sender preserved so it doesn't look like it came from the host.
      if (role === 'host') {
        const relay = { type: msg.type, payload: msg.payload, from: participantId };
        for (const [id, c] of connections) if (id !== participantId) c.send(relay);
      }
    });
    conn.on('close', () => {
      connections.delete(participantId);
      participants.delete(participantId);
      emit('participant-left', { id: participantId });
      if (role === 'host') broadcastRoster();
    });
  }

  function broadcastRoster() {
    send('roster', [...participants.values()]);
    emit('roster');
  }

  // A guest's whole view of who is here; every entry is peer-supplied, so
  // each field is checked and anything malformed is skipped.
  function applyRoster(list) {
    if (!Array.isArray(list)) return;
    participants.clear();
    for (const p of list.slice(0, 3)) {
      const name = sanitizeName(p?.name);
      if (typeof p?.id !== 'string' || (p.role !== 'host' && p.role !== 'guest') || !name) continue;
      participants.set(p.id, { id: p.id, role: p.role, name, ...(p.slot === 1 || p.slot === 2 ? { slot: p.slot } : {}) });
    }
    emit('roster');
  }

  async function host() {
    role = 'host';
    peer = await createPeer();
    participants.set(peer.id, { id: peer.id, role: 'host', name: 'Host' });
    peer.on('connection', (conn) => {
      // Host + 2 guests is the hard cap: turn a third away before it is
      // wired into anything, telling it why instead of just hanging up.
      if (connections.size >= MAX_GUESTS) {
        conn.on('open', () => { conn.send({ type: 'session-full', payload: {}, direct: true }); setTimeout(() => conn.close(), 100); });
        return;
      }
      const taken = new Set([...participants.values()].map((p) => p.slot));
      const guestNumber = [1, 2].find((n) => !taken.has(n));
      connections.set(conn.peer, conn);
      wireConnection(conn, conn.peer);
      conn.on('open', () => {
        const info = { id: conn.peer, role: 'guest', slot: guestNumber, name: `Guest ${guestNumber}` };
        participants.set(conn.peer, info);
        emit('participant-joined', info);
        broadcastRoster();
      });
    });
    return peer.id;
  }

  async function join(hostId) {
    role = 'guest';
    hostPeerId = hostId;
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

  // Point-to-point, for request/response traffic that must not reach the
  // other guest (a read request, its reply).
  function sendTo(id, type, payload) {
    connections.get(id)?.send({ type, payload, direct: true });
  }

  function onMessage(type, handler) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(handler);
    return () => handlers.get(type)?.delete(handler);
  }

  function setName(raw) {
    const name = sanitizeName(raw);
    if (!name) return;
    if (role === 'host') { participants.get(peer.id).name = name; broadcastRoster(); }
    else if (role === 'guest') sendTo(hostPeerId, 'hello', { name });
  }

  // What the throttle (throttle.js) needs: worst RTT and deepest send queue
  // across live connections. Both come from PeerJS internals a web page
  // can reach (the RTCPeerConnection and the data channel), and read as 0
  // where unavailable, i.e. no pressure.
  async function sample() {
    let rtt = 0, buffered = 0;
    for (const conn of connections.values()) {
      buffered = Math.max(buffered, conn.dataChannel?.bufferedAmount || 0);
      const stats = await conn.peerConnection?.getStats?.().catch(() => null);
      for (const report of stats?.values() || []) {
        if (report.type === 'candidate-pair' && report.nominated) rtt = Math.max(rtt, report.currentRoundTripTime || 0);
      }
    }
    return { rtt, buffered };
  }

  function getRole() { return role; }
  function getSelfId() { return peer?.id ?? null; }
  function getParticipants() { return [...participants.values()]; }

  function leave() {
    for (const conn of connections.values()) conn.close?.();
    peer?.destroy?.();
    connections.clear();
    participants.clear();
    role = null;
    peer = null;
    hostPeerId = null;
  }

  return { host, join, send, sendTo, setName, sample, getSelfId, onMessage, getRole, getParticipants, leave };
}
