/**
 * A hold-to-confirm timer: `start()` begins filling over `ms`, calling
 * `onProgress(fraction)` as it goes and `onDone()` once when full; `cancel()`
 * (a released key) stops it and calls `onProgress(null)`. Starting again while
 * one runs does nothing.
 */
export function createHold(ms, onProgress, onDone) {
  let timer = null, began = 0;
  const stop = () => { clearInterval(timer); timer = null; };
  return {
    start() {
      if (timer) return;
      began = performance.now();
      onProgress(0);
      timer = setInterval(() => {
        const fraction = Math.min(1, (performance.now() - began) / ms);
        onProgress(fraction);
        if (fraction >= 1) { stop(); onProgress(null); onDone(); }
      }, 30);
    },
    cancel() {
      if (!timer) return;
      stop();
      onProgress(null);
    },
    get active() { return timer !== null; },
  };
}
