const HOST_COLOR = '#E53935';
const GUEST_COLORS = { 1: '#FFFFFF', 2: '#000000' };
const MAX_NAME = 20;

// Color follows role and join slot alone, so every participant paints
// everyone else the same without any of it being sent.
export function presenceColor({ role, slot }) {
  return role === 'host' ? HOST_COLOR : GUEST_COLORS[slot] || GUEST_COLORS[1];
}

// A display name arrives from a peer, so it is cleaned at the boundary:
// text only, no control characters, capped; null if nothing usable is left.
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME);
  return name || null;
}
