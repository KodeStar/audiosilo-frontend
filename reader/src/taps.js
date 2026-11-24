// The centre tap (fe#246, immersive mode): a tap in the middle of the page shows or hides the
// host's top bar. The page edges that turn pages are the host's own, over the book, so a tap
// that reaches the book is never a page turn; only one in the middle counts, so a tap that
// just missed a narrow edge does nothing. Never a tap that did something else: a link
// (foliate's handler, which prevents the click), a sentence the read-along seeks to (it
// prevents it too), a selection, or a swipe (the paginator turns the page under it).

/** The middle of the page, as shares of the reader's width. */
export const CENTRE_FROM = 0.25;
export const CENTRE_TO = 0.75;

/** How far (px) a press may move and still be a tap. */
export const TAP_SLOP = 10;

/** Whether `x` (px from the reader's left) is in the middle of a reader `width` px wide. An
 * unknown place (null) counts as the middle. */
export function isCentre(x, width) {
  if (x === null || !(width > 0)) return true;
  const share = x / width;
  return share >= CENTRE_FROM && share <= CENTRE_TO;
}

/**
 * Listens on `doc` (the reader document, or a section's document inside it) for a tap in the
 * middle of the page, and calls `onTap` for each. `viewportX(e)` is the click's distance from
 * the reader's left (a section's document lies in a frame that scrolls sideways under the
 * page, so its own clientX is not), null when it cannot tell; `width()` the reader's width.
 * The click is judged once its other listeners ran (`defer`), so a link or a sentence that
 * took it is seen whatever order the listeners were added in.
 */
export function watchTaps(doc, { onTap, viewportX, width, defer = (fn) => setTimeout(fn, 0) }) {
  let down = null;
  doc.addEventListener(
    'pointerdown',
    (e) => {
      down = { x: e.screenX, y: e.screenY };
    },
    true,
  );
  doc.addEventListener('click', (e) => {
    const from = down;
    down = null;
    if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (from && Math.hypot(e.screenX - from.x, e.screenY - from.y) > TAP_SLOP) return;
    const x = viewportX(e);
    defer(() => {
      if (e.defaultPrevented || e.target?.closest?.('a[href]')) return;
      const selection = doc.getSelection?.();
      if (selection && !selection.isCollapsed) return;
      if (isCentre(x, width())) onTap();
    });
  });
}

/** A section document's click, as px from the reader's left: its frame's place on the page
 * plus where in the frame it landed. Null when the frame cannot be read. */
export function frameViewportX(e) {
  try {
    const frame = e.view?.frameElement;
    if (!frame) return null;
    return frame.getBoundingClientRect().left + e.clientX;
  } catch {
    return null;
  }
}
