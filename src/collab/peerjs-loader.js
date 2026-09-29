// Loaded only when a collab session actually starts, so solo users never
// pay for it. PeerJS is the one accepted third-party dependency for this
// feature (its free public broker, 0.peerjs.com, is the signaling channel there's no
// backend to run otherwise) - CDN import, no build step, matching how
// export.js already pulls in zipSync.
let peerCtor;
export async function loadPeerConstructor() {
  if (!peerCtor) {
    ({ Peer: peerCtor } = await import('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/+esm'));
  }
  return peerCtor;
}
