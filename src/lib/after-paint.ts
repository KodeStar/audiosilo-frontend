/**
 * Run `fn` once the screen has painted what the current render committed, returning the
 * cancel function. Native: at once (`after-paint.web.ts` is the web's): a native list
 * draws off the JS thread, so following work never holds its first frame back.
 */
export function afterPaint(fn: () => void): () => void {
  fn();
  return () => {};
}
