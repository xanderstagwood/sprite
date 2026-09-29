// DEBUG ONLY, not for release: delete this file and every `DEBUG` line in
// main.js before 1.0 (listed in todo/pre-1.0.md).
//
// J+K+L held together raises a sample warning in the tool tag; Shift+J+K+L an
// urgent one (ui.js's flashTip), for checking the alert styling and pulse.
import { flashTip } from './ui.js';

const held = new Set(); // key codes of J, K, L currently down

export const debugAlerts = {
  /** True when this keydown completed the chord and has been handled. */
  keydown(e) {
    if (e.code !== 'KeyJ' && e.code !== 'KeyK' && e.code !== 'KeyL') return false;
    held.add(e.code);
    if (held.size < 3 || e.repeat) return false;
    flashTip(e.shiftKey ? 'this is urgent' : 'this is a warning.', { urgent: e.shiftKey });
    return true;
  },
  keyup(e) { held.delete(e.code); },
  reset() { held.clear(); },
};
