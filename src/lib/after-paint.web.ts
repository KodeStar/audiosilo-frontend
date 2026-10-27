/** The longest `afterPaint` waits for the main thread to go idle. */
export const AFTER_PAINT_MAX_MS = 300;

/**
 * Web: run `fn` once the browser has painted the current render and the main thread is
 * idle (at most `AFTER_PAINT_MAX_MS` later), returning the cancel function. For work that
 * would otherwise hold the first paint back: the next pages of a long list, whose
 * rendering would delay the first page's covers. `after-paint.ts` is native's.
 */
export function afterPaint(fn: () => void): () => void {
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // After the next frame (the commit painted), then when idle.
  const frame = requestAnimationFrame(() => {
    if (typeof requestIdleCallback === 'function') {
      idle = requestIdleCallback(fn, { timeout: AFTER_PAINT_MAX_MS });
    } else {
      timer = setTimeout(fn, 0);
    }
  });
  return () => {
    cancelAnimationFrame(frame);
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
  };
}
