/** The longest `afterPaint` waits, counted from the call. */
export const AFTER_PAINT_MAX_MS = 300;

/**
 * Web: run `fn` once the browser has painted the current render and the main thread is
 * idle, and at most `AFTER_PAINT_MAX_MS` after the call, returning the cancel function.
 * For work that would otherwise hold the first paint back: the next pages of a long list,
 * whose rendering would delay the first page's covers. `after-paint.ts` is native's.
 *
 * The cap is a plain timer started at the call, not one chained after a frame: a hidden
 * tab never runs `requestAnimationFrame`, so a frame-first wait would hold the work until
 * the tab is shown (the Library grid's later pages never loading in a background tab).
 */
export function afterPaint(fn: () => void): () => void {
  let done = false;
  let idle: number | undefined;
  const cancel = () => {
    done = true;
    cancelAnimationFrame(frame);
    if (idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
    clearTimeout(cap);
  };
  const run = () => {
    if (done) return;
    cancel();
    fn();
  };
  const cap = setTimeout(run, AFTER_PAINT_MAX_MS);
  // After the next frame (the commit painted), then when idle.
  const frame = requestAnimationFrame(() => {
    if (done) return;
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run);
    else run();
  });
  return cancel;
}
