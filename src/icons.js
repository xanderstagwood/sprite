// The UI's icons: pixel-art SVGs in src/icons/ (and src/icons/keys/ for keyboard
// keys), drawn on a 6px grid to match the pixel font, whose capitals are 6px
// tall. Each is used as a mask, filled with `currentColor`, so it takes the
// colour of the text around it. Icon pixels are one font pixel (style.css
// --icon-px): at the snapped 16px font size an icon is a whole number of
// device pixels, and a 6px icon centres on a whole pixel in the 24px blocks.
//
// A caller may pass the character the icon replaced ('+', '✕', ...) or the
// icon's name ('bug', 'project', ...); `keyIcon` takes a key's name.
const FROM_CHARACTER = {
  '+': 'new', '✕': 'remove', '⋮': 'grab', '⋯': 'menu', '☰': 'menu', '↓': 'import',
  '◈': 'onion', '⤢': 'resize', '⌕': 'zoom', '▸': 'folded', '▾': 'unfolded',
};
const NAMES = new Set(['bug', 'discord', 'heart', 'help', 'zoom', 'new', 'resize', 'import', 'export', 'menu', 'project', 'remove', 'visibility', 'unfolded', 'folded', 'sprite', 'pixi', 'onion', 'grab', 'users']);
const KEYS = new Set(['ctrl', 'alt', 'shift', 'super', 'return', 'space', 'backspace', 'tab', 'up', 'down', 'left', 'right']);

const resolve = (name) => FROM_CHARACTER[name] || (NAMES.has(name) ? name : null);

/** True if `name` (a replaced character, or an icon name) has an icon. */
export const hasIcon = (name) => resolve(name) !== null;

function build(url, h = 6) {
  const w = 6; // every icon is drawn on a 6px-wide grid, and 6 tall unless it says otherwise
  const el = document.createElement('span');
  el.className = 'icon';
  el.style.width = `calc(var(--icon-px) * ${w})`;
  el.style.height = `calc(var(--icon-px) * ${h})`;
  el.style.webkitMaskImage = el.style.maskImage = `url(${url})`;
  return el;
}

/** A new element showing the icon for `name`. */
export const iconElement = (name) => {
  const file = resolve(name);
  const el = build(`src/icons/${file}.svg`, file === 'users' ? 7 : 6); // users: head, gap, shoulders is seven rows
  if (file === 'new') el.classList.add('icon--new'); // drawn with an empty top row
  if (file === 'heart') el.classList.add('icon--lift'); // drawn a device pixel low in its block
  if (file === 'sprite') el.classList.add('icon--lift-2');
  if (file === 'heart') el.classList.add('icon--heart');
  if (file === 'menu') el.classList.add('icon--menu'); // three pixels wide, drawn against the left of its box
  return el;
};

/** A new element showing the key named `name` ('ctrl', 'up', ...). */
export const keyIcon = (name) => {
  const el = build(`src/icons/keys/${name}.svg`);
  el.classList.add('icon--inline');
  return el;
};

/** True if `name` is a key that has an icon. */
export const hasKeyIcon = (name) => KEYS.has(name);

/** Replaces `el`'s content with the icon for `name`. */
export function setIcon(el, name) {
  el.replaceChildren(iconElement(name));
}
