// Motion for the corner tag's content: a tag is as wide as its text, so a
// change of text is a change of width, which CSS cannot animate from `auto`.

const still = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Returns `slide()`, to call after `el`'s content changed: the element eases
 * from the width it was showing to its new natural one (`.sliding` in the
 * stylesheet holds the transition). Reads layout, so call it on a change, not
 * every frame.
 */
export function slideWidth(el) {
  let last = 0; // natural width at the previous call; 0 = never measured or not shown
  const settle = (e) => {
    if (e.target !== el || e.propertyName !== 'width') return;
    el.classList.remove('sliding');
    el.style.width = '';
  };
  el.addEventListener('transitionend', settle);
  el.addEventListener('transitioncancel', settle); // e.g. the tag was hidden mid-slide
  return function slide() {
    const from = el.classList.contains('sliding') ? el.getBoundingClientRect().width : last;
    el.classList.remove('sliding');
    el.style.width = '';
    const to = el.getBoundingClientRect().width;
    last = to;
    if (still.matches || !from || !to || Math.abs(from - to) < 0.5) return;
    el.style.width = from + 'px';
    void el.offsetWidth; // commit the starting width so the next one transitions
    el.classList.add('sliding');
    el.style.width = to + 'px';
  };
}

/**
 * Returns `set(text)`: fades `el` out, swaps its text, fades it back in
 * (the opacity transition lives in the stylesheet and lasts `ms`), then calls
 * `onSwap`. Changes that arrive mid-fade just retarget the text, so a run of
 * quick changes costs one dip. The first text appears without a fade.
 */
export function fadeText(el, ms, onSwap) {
  let want = el.textContent, timer = null;
  return (text) => {
    want = text;
    if (timer || el.textContent === text) return;
    if (!el.textContent || still.matches) { el.textContent = text; onSwap(); return; }
    el.style.opacity = 0;
    timer = setTimeout(() => {
      timer = null;
      el.textContent = want;
      el.style.opacity = '';
      onSwap();
    }, ms);
  };
}
