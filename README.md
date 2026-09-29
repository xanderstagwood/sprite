# Sprite

A minimalist pixel-art editor that runs in the browser. Icons, tiny sprites and short animation loops, made fast.

Plain JavaScript, HTML and CSS. No framework, no build step, no dependencies to install.

**Try it:** https://xanderstagwood.github.io/sprite/ (it works offline once loaded).  
**Found a bug?** [Report it](https://github.com/xanderstagwood/sprite/issues/new?template=bug_report.yml). **Questions:** [Discord](https://discord.gg/TFvXQdrjYM).

## Philosophy

- **One tool.** There is no toolbox. The same brush stamps, paints, erases, fills, selects and draws shapes depending on the modifier keys you hold.
- **Keyboard first.** Everything can be done from a 60% keyboard. The mouse works alongside it, but never is required.
- **Opinionated, not customizable.** When a feature could be a setting or a single deliberate choice, Sprite picks the choice. Fewer options, faster decisions.
- **Small and fast.** Made for small canvases. Speed and memory use are treated as features: large projects load lazily, only the canvas you are editing is held in full, and saving only rewrites what changed.
- **No save button.** Every change autosaves, and undo history is saved with the work.
- **Sharp pixels everywhere.** Pixels are always perfect squares, at every zoom level, on screen and in exports.

## Features

**Drawing**
- Place (hard-edged square stamp) and Paint (soft antialiased brush) with adjustable brush size
- Erase, flood fill, and dithering (checkerboard) for Paint and fill
- Shapes: rectangle, triangle, circle and line, with Shift to constrain
- Mirror drawing guides: horizontal, vertical or both
- Rectangle select, magic wand, select-by-color, select all
- Move, flip and rotate selections; copy, cut and paste
- Dropper that samples from the canvas or from anywhere on screen
- Continuous zoom centered on the cursor, pan, zoom to fit, grid and pixel rulers
- Cursor is drawn inverted against whatever is beneath it, so it is always visible

**Organization**
- **Projects** hold **collections**, which hold **canvases**
- Collection view shows every canvas in a collection side by side in an even number of columns
- New canvas presets from 8x8 up to Pico-8 (128x128) and Game Boy DMG (160x144), plus custom sizes up to 256x256
- Double click the new canvas button to duplicate the size you were last working on
- Resize canvases from an anchor (`R`), trim to their pixels from an anchor (`T`), both undoable; reorder by dragging, multi-select with Shift and Alt; hold Backspace/Delete to remove
- Capacity meter shows how close a project is to what a low-end machine handles comfortably

**Layers and animation**
- Layers with visibility, opacity, reordering and groups
- Reference images that stay out of your pixels
- Frame timeline with playback, adjustable framerate and onion skinning
- Duplicate, reorder and multi-select frames

**Color**
- Project-scoped palette of up to 256 colors, editable and reorderable
- Built-in presets (Pico-8, Game Boy DMG, Stagwood Brand) and a saved palette library
- HSL and hex color picker
- Import palettes from `.gpl`, `.hex` and `.pal` files, or extract one from an image

**Import and export**
- Import projects, single images as canvases, spritesheets (as frames or layers), reference images and palettes
- **Quick export** (`e`) and **full export** (`E`) follow whatever panel has focus: PNGs at 1x/4x/8x, sprite sheets of frames or layers, an animated GIF, per-layer PNGs, SVG, palette files (`.gpl`, `.hex`, `.pal`), or the whole project as a single `.sprite` archive. With a selection, only the selection is exported

**Workspace**
- Panels reveal on hover or keyboard focus and can be pinned open
- Canvas and app backgrounds cycle between checker, black, gray and white
- Your workspace preferences are remembered, and mirrored to a `.prefs` file when a folder is connected
- Installable as a web app, works offline

## Running it

Sprite is a static site. Serve the folder with anything:

```sh
node scripts/dev-server.js        # http://localhost:8000, live reload
node scripts/dev-server.js --https
```

or any static server (`python3 -m http.server`). Use a Chromium-based browser for the best experience; other browsers fall back to browser storage for projects.

`scripts/package-itch.sh` zips the app for upload to itch.io as an HTML game.

## Controls

Press `?` in the app to see this list. `Ctrl`(left)+Arrow focuses a panel (Timeline, Layers, Colors, Projects for Up, Right, Down, Left). A focused panel owns the keyboard until `Shift+Tab` moves to another panel or a tap of left `Ctrl` returns focus to the canvas. Hovering a panel focuses it too.

### Global

| Input | Action |
|---|---|
| `?` | Toggle controls help modal |
| `Shift+Tab` | Cycle focus: Timeline → Layers → Colors → Projects  |
| `Tab` | Pin/unpin every panel at once |
| `` ` `` | Pin/unpin the corner tags |
| `~` (hold) + Left/Right | Select a help tag button; `Enter` or `Space` launches it |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / Cut / Paste |
| `Ctrl+A` | Select all |
| `Ctrl+Space` (tap) | Play/pause timeline |
| `e` / `E` | Quick / full export of the focused panel |
| `Ctrl`(left)+Up/Right/Down/Left | Focus Timeline / Layers / Colors / Projects |
| `Ctrl`(left) (tap alone) | Return focus to canvas |
| `Escape` | Clear selection |

### Canvas

| Input | Action |
|---|---|
| Arrows | Move cursor, stepped by brush size |
| `Ctrl+Space` + arrows | Pan viewport |
| `Shift` + arrows | Rectangle-select, commits on release |
| `Shift+Alt` + arrows | Move the selection boundary |
| `Shift+Ctrl` + arrows | Move the selected content |
| `Shift+Space` | Magic wand at cursor |
| `Shift+C` | Select every pixel of the color under the cursor |
| `1`-`9`, `0` | Set prime color to palette chip 1-10 |
| `Space` | Place at cursor (hold for repeated stamps); hold `Alt` too for Paint (antialiased) |
| `Backspace`/`Delete` | Erase under cursor, or clear the selection |
| `Z` + arrows (hold) | Erase while moving |
| `Alt` + arrows (hold) | Paint while moving (antialiased) |
| `Ctrl+Enter` | Flood fill at cursor, or fill the whole selection |
| Left click/drag | Place (hard-edged square stamp) |
| `Alt` + left click/drag | Paint (antialiased) |
| Right click/drag | Erase |
| Scroll wheel | Zoom (inertial) |
| `Q`/`W`/`A`/`S` (hold) | Rectangle / triangle / circle / line shape (`Shift` constrains) |
| `[` / `]` | Brush size -1 / +1 |
| `{` / `}` | Brush size ÷2 / ×2 |
| `I` (tap) | Dropper: sample color under cursor |
| `I` (hold) + click | Sample color from anywhere in the viewport |
| `F` / `Shift+F` | Flip horizontal / vertical |
| `R` / `Shift+R` (hold) + Left/Right | Rotate 1°/15° per step (accelerating hold) |
| `Shift+R` (tap) | Resize the canvas: type W and H (`Tab` swaps, H follows W until edited) or `Up`/`Down` through the presets; `Enter` applies, `Escape` cancels. Click a pip to choose the resize anchor |
| `T` (tap) | Trim the canvas to its pixels |
| `T` (hold) | Dim the canvas and show the anchor pips: `Arrows` or a click choose which point holds still, letting go trims, `Escape` cancels |
| `+` | Zoom in |
| `-` | Zoom to 100% |
| `=` | Zoom to fit (selection if any) |
| `_` | Zoom out |
| `G` / `Shift+G` | Toggle grid / ruler |
| `D` | Toggle dither for Paint and fill (checkerboard, not Place) |
| `:` | Reference image: fit to canvas / full size (also from the Layers panel) |
| `M` | Cycle mirror drawing guide: off, horizontal, vertical, both |
| `u` | Cycle canvas background |
| `Shift+U` | Cycle app background |

### Panels

#### Timeline (`Ctrl+Up` to focus)
| Input | Action |
|---|---|
| Left/Right | Navigate frames |
| Up/Down | Adjust framerate (accelerating hold) |
| `Shift+`Left/Right | Select multiple frames |
| `Alt+`Left/Right | Move the selected frame(s) |
| `+` | New frame |
| `=` | Duplicate frame |
| Hold `Backspace`/`Delete` | Remove frame(s): the tool tag fills while held |
| `\` | Toggle onion skin |
| `Space` | Play/pause |

#### Layers (`Ctrl+Right` to focus)
| Input | Action |
|---|---|
| Up/Down | Navigate layers/groups |
| Right-Shift+Up/Down | Navigate groups only |
| `Shift+`Up/Down | Select multiple layers/groups |
| `Alt+`Up/Down | Move the selected layer(s)/group(s) |
| Left/Right | Adjust layer/group opacity |
| `Shift+`Left/Right | Adjust opacity by 10 |
| Hold `Backspace`/`Delete` | Remove selected layer(s)/group(s): the tool tag fills while held |
| `+` | New layer |
| `=` | New group |
| `Space` | Expand/collapse focused group |
| `Enter` | Rename focused layer/group |
| `\` | Toggle layer visibility |

#### Colors (`Ctrl+Down` to focus)
| Input | Action |
|---|---|
| Left/Right | Cycle prime color |
| `+` | Add chip |
| `-` | Remove current chip |
| `\` | Open palette preset menu (Up/Down navigate, `Enter` commits) |
| `Enter` | Edit the primary chip's color (arrows move on the color square, `Alt+`Left/Right adjust hue, `Enter`/`Escape` close) |
| `Shift+Enter` | Rename (and save) the palette |

#### Projects (`Ctrl+Left` to focus)
| Input | Action |
|---|---|
| Up/Down | Navigate canvases and collections |
| `Space` | Fold/unfold the focused collection |
| `+` | New canvas (opens size picker; Left/Right adjusts size, `Enter` commits, `Escape` cancels) |
| `Alt++` | New project |
| Hold `Backspace`/`Delete` | Remove the selected canvases, or the focused collection: the tool tag fills while held |
| `_` | Remove selected canvas or collection at once |
| `=` | New collection |
| `Enter` | Rename focused canvas/collection |
| `Shift+Enter` | Rename project |
| `\` | Open project picker |

## License

The source is public so it can be read, but this is not open source. You can read it, run the app and keep everything you make with it. Copying, modifying, redistributing or reusing any of it needs written permission. See [LICENSE](LICENSE).
