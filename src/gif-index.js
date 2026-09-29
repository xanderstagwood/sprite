// Streaming GIF encoding over packed-RGBA composites (canvas-model.js's
// hexToPacked). Holds one frame's index array at a time, never every frame's
// RGBA at once.
//
// Frames carry only what changed: a pixel that is the same as the frame
// before is written as the transparent index so the previous frame shows
// through, and the frame is cropped to the extent of what remains. gifenc
// gives every frame's top-left corner as (0, 0), so the crop can only trim
// from the right and bottom.

const MAX_COLORS = 255; // palette slot 0 is the transparent one
const SAMPLE_FRAMES = 8; // frames fed to the quantizer when the colours don't fit
export const MAX_GIF_BYTES = 100 * 1024 * 1024;

/** The animation would encode past the size cap. Not worth retrying. */
export class GifTooLargeError extends RangeError {
  constructor() {
    super('The animation is over 100MB as a GIF');
    this.name = 'GifTooLargeError';
  }
}

const shown = (word) => word >>> 24 !== 0;
// Two words look the same on a GIF, which has no partial alpha: any transparent word is alike.
const same = (a, b) => (shown(a) ? a === b : !shown(b));

// Every distinct colour across all frames as a GIF palette (slot 0 kept for
// transparent), or null past `max`. Keyed on RGB: alpha is all or nothing.
function exactPalette(frameCount, wordsAt, max) {
  const slot = new Map(); // rgb -> palette index
  const palette = [[0, 0, 0]];
  for (let i = 0; i < frameCount; i++) {
    for (const word of wordsAt(i)) {
      if (!shown(word)) continue;
      const rgb = word & 0xffffff;
      if (slot.has(rgb)) continue;
      if (palette.length > max) return null;
      slot.set(rgb, palette.length);
      palette.push([rgb & 255, (rgb >> 8) & 255, rgb >> 16]);
    }
  }
  return { palette, slot };
}

// A pixel that stops being shown cannot be drawn over a frame left in place.
function erases(from, to) {
  for (let p = 0; p < from.length; p++) if (shown(from[p]) && !shown(to[p])) return true;
  return false;
}

// `wordsAt(i)` gives frame i's composite (w*h packed words); `gifenc` is the
// library's { GIFEncoder, quantize, applyPalette }, injected so this stays
// testable without the CDN import. Throws GifTooLargeError past `maxBytes`.
export function encodeGifStream({ frameCount, wordsAt, w, h, delayMs, onFrame, maxBytes = MAX_GIF_BYTES, gifenc: { GIFEncoder, quantize, applyPalette } }) {
  const exact = exactPalette(frameCount, wordsAt, MAX_COLORS);
  let palette = exact?.palette, shades = null;
  if (!palette) {
    // Too many colours for a verbatim palette: one shared palette from a
    // sample, so colours still can't drift between frames.
    const picks = Array.from({ length: Math.min(SAMPLE_FRAMES, frameCount) }, (_, k) => Math.floor(k * frameCount / Math.min(SAMPLE_FRAMES, frameCount)));
    const sample = new Uint8Array(picks.length * w * h * 4);
    picks.forEach((frame, k) => sample.set(new Uint8Array(wordsAt(frame).buffer), k * w * h * 4));
    shades = quantize(sample, MAX_COLORS);
    palette = [[0, 0, 0], ...shades];
  }

  // Palette index of every pixel, 0 where transparent.
  const indexOf = (words) => {
    const index = new Uint8Array(words.length);
    const near = shades && applyPalette(new Uint8Array(words.buffer, words.byteOffset, words.byteLength), shades);
    for (let p = 0; p < words.length; p++) {
      if (shown(words[p])) index[p] = exact ? exact.slot.get(words[p] & 0xffffff) : near[p] + 1;
    }
    return index;
  };

  const gif = GIFEncoder();
  let shownBefore = null; // the composite left on screen; null when the screen is empty
  for (let i = 0; i < frameCount; i++) {
    const words = wordsAt(i);
    const clearAfter = i + 1 < frameCount && erases(words, wordsAt(i + 1));
    let index = indexOf(words);
    if (shownBefore) for (let p = 0; p < words.length; p++) if (same(words[p], shownBefore[p])) index[p] = 0;

    // The first frame sets the GIF's size, and a frame that clears the screen
    // afterwards has to cover everything on it: both stay full size.
    let fw = w, fh = h;
    if (i > 0 && !clearAfter) {
      let x1 = 0, y1 = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (index[y * w + x]) { if (x >= x1) x1 = x + 1; y1 = y + 1; }
      fw = Math.max(1, x1); fh = Math.max(1, y1);
      if (fw < w) {
        const cropped = new Uint8Array(fw * fh);
        for (let y = 0; y < fh; y++) cropped.set(index.subarray(y * w, y * w + fw), y * fw);
        index = cropped;
      } else index = index.subarray(0, fw * fh);
    }
    gif.writeFrame(index, fw, fh, { ...(i === 0 && { palette }), transparent: true, transparentIndex: 0, delay: delayMs, repeat: 0, dispose: clearAfter ? 2 : 1 });
    if (gif.bytesView().length > maxBytes) throw new GifTooLargeError();
    shownBefore = clearAfter ? null : words;
    onFrame?.((i + 1) / frameCount);
  }
  gif.finish();
  return gif.bytes();
}
