/**
 * How much of the layout viewport the on-screen keyboard is covering, kept on
 * an element as `--kb-inset` (px) plus a `kb-open` class.
 *
 * A chat composer pinned to the bottom of the screen is pinned to the bottom
 * of the LAYOUT viewport, and on a phone the keyboard does not shrink that:
 * Chrome on Android (since 108) and Safari both resize only the VISUAL
 * viewport, and `100dvh` tracks the URL bar, not the keyboard. So without this
 * the composer sits under the keyboard and the student types blind. The
 * difference between the two viewports is the keyboard, and `visualViewport`
 * is the only API that reports it. A browser without `visualViewport` gets no
 * variable at all, which every consumer reads as 0 — the layout it had before.
 */
export const KB_OPEN_THRESHOLD_PX = 80;

/** The keyboard's height from the two viewport measurements, never negative.
 *  Under the threshold it is browser chrome (a URL bar settling), not a
 *  keyboard, and reads as 0. */
export function keyboardInset(innerHeight: number, viewportHeight: number, offsetTop: number): number {
  const inset = Math.round(innerHeight - viewportHeight - offsetTop);
  return inset >= KB_OPEN_THRESHOLD_PX ? inset : 0;
}

/** Start writing the inset onto `target`; returns the function that stops it. */
export function watchKeyboardInset(target: HTMLElement, onChange?: (inset: number) => void): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => undefined;
  let last = -1;
  const update = (): void => {
    const inset = keyboardInset(window.innerHeight, vv.height, vv.offsetTop);
    if (inset === last) return;
    last = inset;
    target.style.setProperty('--kb-inset', `${inset}px`);
    target.classList.toggle('kb-open', inset > 0);
    onChange?.(inset);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
    target.style.removeProperty('--kb-inset');
    target.classList.remove('kb-open');
  };
}
