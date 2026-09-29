// Message type constants for the collab data channel (§ collab plan, phase 1).
export const MSG = {
  CURSOR: 'cursor',
  STROKE: 'stroke',
  PROJECT: 'project', // host -> joiner: which project id to load over READ_REQ
  FULL: 'session-full', // host -> a would-be third guest, sent by session.js itself
  RESYNC: 'resync', // host -> guests: structure changed, reload the project
  READ_REQ: 'read-req',
  READ_RES: 'read-res',
};

// A join link just carries the host's PeerJS id after a fixed marker, so
// pasting it in Discord (or anywhere) and clicking it is enough: no query
// string parsing, no routing, the app reads its own location on load.
const LINK_MARKER = 'sprite-collab=';

export function makeJoinLink(hostId, token) {
  const base = typeof location !== 'undefined' ? location.origin + location.pathname : '';
  return `${base}#${LINK_MARKER}${hostId}.${token}`;
}

// Pulls { hostId, token } out of arbitrary clipboard text (a pasted link, or
// just the bare code): null if nothing matching is present, never throws.
// The token is what a kick rotates, so a link from before it stops working.
export function parseJoinCode(text) {
  if (!text) return null;
  const m = String(text).match(new RegExp(`${LINK_MARKER}([\\w-]+)\\.([\\w-]+)(?![\\w.-])`));
  return m ? { hostId: m[1], token: m[2] } : null;
}
