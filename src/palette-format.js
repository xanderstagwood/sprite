import { hexToPacked, hexToRgb } from './canvas-model.js';

// The writing side of palette-parse.js: the same three text formats, so
// anything exported here imports back unchanged.

const rgb = (hex) => { const { r, g, b } = hexToRgb(hex); return `${r} ${g} ${b}`; };

/** GIMP `.gpl`; each color is named by its hex code. */
export function formatGpl(name, chips) {
  return `GIMP Palette\nName: ${name}\nColumns: 0\n#\n${chips.map((c) => `${rgb(c)}\t${c.slice(1)}\n`).join('')}`;
}

/** Lospec `.hex`: one bare lowercase code per line. */
export function formatHex(chips) {
  return chips.map((c) => `${c.slice(1).toLowerCase()}\n`).join('');
}

/** JASC `.pal`. */
export function formatPal(chips) {
  return `JASC-PAL\r\n0100\r\n${chips.length}\r\n${chips.map((c) => `${rgb(c)}\r\n`).join('')}`;
}

/** The palette as an image: one pixel per color in a single row, as packed words. */
export function paletteRow(chips) {
  return { pixels: Uint32Array.from(chips, hexToPacked), w: chips.length, h: 1 };
}
