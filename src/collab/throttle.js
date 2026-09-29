export const MAX_FPS = 30;
export const MIN_FPS = 4;

// Each pressure signal scales the send rate down independently; they
// multiply, so a slow link that is also backed up and on a struggling tab
// backs off harder than any one alone. Thresholds are where each signal
// starts to matter: RTT above 50ms, more than 16KB queued in the data
// channel, frames slower than 20ms. Reliable data channels report no packet
// loss (SCTP retransmits underneath), so RTT and the queue stand in for it.
const ramp = (over, span) => Math.max(0.2, 1 - over / span);

export function targetFps({ rtt = 0, buffered = 0, frameMs = 0 } = {}) {
  let fps = MAX_FPS;
  if (rtt > 0.05) fps *= ramp(rtt - 0.05, 0.4);
  if (buffered > 16384) fps *= ramp(buffered - 16384, 262144);
  if (frameMs > 20) fps *= Math.max(0.3, 20 / frameMs);
  fps = Math.round(fps);
  return Number.isFinite(fps) ? Math.min(MAX_FPS, Math.max(MIN_FPS, fps)) : MAX_FPS;
}
