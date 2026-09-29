import { encodeFile } from './sprite-format.js';
import { loadTemporarily } from './persistence.js';
import { encodeName } from './storage.js';
import { zipSync } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
import { GIFEncoder, quantize, applyPalette } from 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';
import { encodeGifStream, GifTooLargeError } from './gif-index.js';

// Export (§14): quick exports only. export-plan.js decides what each focus
// produces; this turns a plan's entries into files and downloads them: one
// file as is, several as a zip. Scale is an integer upscale, nearest-neighbor:
// no smoothing, so pixel edges stay hard.

// --- progress + retry/error handling ------------------------------------

// main.js's tool tag subscribes here to show a progress bar while an
// export runs, and a quiet "(export error)" marker if one ultimately
// fails: see runExport below for the full lifecycle.
let progressListener = null;
export function onExportProgress(fn) { progressListener = fn; }
function reportProgress(status) { if (progressListener) progressListener(status); }

const MAX_ATTEMPTS = 4; // 1 initial try + 3 silent retries

// A transient hiccup (a GC pause, a momentarily-busy disk cache) most
// often just works on a second try, so failures retry silently: no
// interruption, the progress bar just keeps running. Only once every
// attempt has failed does this decide whether the user can actually do
// anything about it: a message worth prompting for (free up space, export
// less) versus an unexpected internal error with no useful next
// step, where interrupting with a dialog that says nothing actionable
// would be worse than just flagging it quietly.
function fixableMessage(err) {
  if (err instanceof GifTooLargeError) return { short: 'over 100MB', detail: 'Export failed: the animation is over 100MB as a GIF. Select fewer frames and try again.' };
  if (err && err.name === 'QuotaExceededError') return { short: 'storage full', detail: 'Export failed: not enough free storage space. Free up space and try again.' };
  if (err instanceof RangeError) return { short: 'too large', detail: 'Export failed: the result was too large to build. Try exporting less.' };
  return null;
}

async function runExport(work) {
  reportProgress({ active: true, fraction: 0, error: null });
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await work((fraction) => reportProgress({ active: true, fraction }));
      reportProgress({ active: false });
      return;
    } catch (err) {
      lastErr = err;
      console.error(`Export failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, err);
      if (err instanceof GifTooLargeError) break; // the same frames will be just as large again
    }
  }
  const fixable = fixableMessage(lastErr);
  reportProgress({
    active: false,
    error: fixable
      ? { short: fixable.short, detail: fixable.detail }
      : { short: 'export error', detail: `Export failed: ${lastErr?.message || lastErr}` },
  });
}

// --- rasterization ---------------------------------------------------------

function pixelsToCanvas(pixels, w, h, scale) {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = w * scale;
  canvasEl.height = h * scale;
  const ctx = canvasEl.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const src = document.createElement('canvas');
  src.width = w;
  src.height = h;
  const img = new ImageData(w, h);
  new Uint32Array(img.data.buffer).set(pixels); // packed RGBA words, see canvas-model.js hexToPacked
  src.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(src, 0, 0, w * scale, h * scale);
  return canvasEl;
}

function canvasToBlob(canvasEl, mime) {
  return new Promise((resolve) => canvasEl.toBlob(resolve, mime));
}

// --- entries -> blobs --------------------------------------------------------

const gifenc = { GIFEncoder, quantize, applyPalette };

// The whole Project as one portable .sprite archive (a zip, same shape
// persistence.js already writes to storage: project.json plus one
// <name>.sprite per File: bundled into a single downloadable file instead
// of storage-backend records). The Project's palette (this app has exactly
// one shared palette per Project) rides along inside project.json, same as
// it already does in storage.
async function projectArchive(project, onProgress) {
  // Entry names are the same OS-safe names the working folder uses (storage.js
  // encodeName), so the archive unzips cleanly on any system whatever a canvas is
  // called; `fileNames` in project.json keeps the real names, and import reads
  // the entries back through the same encoding.
  const encoder = new TextEncoder();
  const files = {
    'project.json': encoder.encode(JSON.stringify({
      name: project.name, palette: project.palette, activeFileIndex: project.activeFileIndex,
      collections: project.collections, fileNames: project.files.map((f) => f.name),
    })),
  };
  for (const [i, file] of project.files.entries()) {
    const release = await loadTemporarily(file);
    const { meta, chunks } = encodeFile(file);
    delete meta.references; // reference images never leave the app
    files[encodeName(`${file.name}.sprite`)] = encoder.encode(JSON.stringify(meta));
    for (const chunk of chunks) files[encodeName(`${file.name}.sprite.${chunk.name}`)] = chunk.bytes();
    release();
    onProgress((i + 1) / project.files.length * 0.8);
  }
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/octet-stream' });
}

async function render(entry, onProgress) {
  switch (entry.type) {
    case 'png': {
      const { pixels, w, h } = entry.image();
      return canvasToBlob(pixelsToCanvas(pixels, w, h, entry.scale), 'image/png');
    }
    case 'text':
      return new Blob([entry.text()], { type: entry.mime });
    case 'gif': {
      const bytes = encodeGifStream({
        frameCount: entry.frameCount, wordsAt: entry.wordsAt, w: entry.w, h: entry.h,
        delayMs: Math.round(1000 / entry.fps), onFrame: onProgress, gifenc,
      });
      return new Blob([bytes], { type: 'image/gif' });
    }
    case 'sprite':
      return projectArchive(entry.project, onProgress);
  }
}

// --- download ----------------------------------------------------------------

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Images and archives are compressed already; only text is worth deflating.
const deflates = (type) => type.startsWith('text/') || type === 'image/svg+xml';

async function downloadZip(results, zipName) {
  const files = {};
  for (const { path, blob } of results) files[path] = [new Uint8Array(await blob.arrayBuffer()), { level: deflates(blob.type) ? 6 : 0 }];
  downloadBlob(new Blob([zipSync(files)], { type: 'application/zip' }), zipName);
}

/**
 * Runs `makePlan()` (export-plan.js's `{ name, entries }`, after loading
 * whatever it reads) and downloads the result: one entry as is, several as
 * `<name>.zip`. Progress and failure go through the tool tag.
 */
export function quickExport(makePlan) {
  return runExport(async (onProgress) => {
    const { name, entries } = await makePlan();
    const results = [];
    for (const [i, entry] of entries.entries()) {
      const blob = await render(entry, (f) => onProgress((i + f) / entries.length * 0.9));
      results.push({ path: entry.path, blob });
    }
    if (results.length === 1) downloadBlob(results[0].blob, results[0].path);
    else await downloadZip(results, `${name}.zip`);
  });
}
