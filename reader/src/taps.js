// The centre tap (fe#246, immersive mode): a tap in the middle of the page shows or hides the
// host's top bar. The page edges that turn pages are the host's own, over the book, so a tap
// that reaches the book is never a page turn; only one in the middle counts, so a tap that
// just missed a narrow edge does nothing. Never a tap that did something else: a link
// (foliate's handler, which prevents the click), a selection, or a swipe (the paginator turns
// the page under it). A sentence the read-along seeks to still counts: with a map in, nearly
// every tap lands on one, and the bar must come back.
//
// The path is the read-along's: a `click` listener on the section's document, which iOS
// WebKit delivers for a tap on plain text (Bridge 3c-2's sentence tap, verified in the iOS
// simulator). The host keeps a fallback in case one never arrives (reader-chrome.ts).

/** The middle of the page, as shares of the reader's width. */
const CENTRE_FROM = 0.25;
const CENTRE_TO = 0.75;

/** How far (px) a press may move and still be a tap. */
export const TAP_SLOP = 10;

/** Whether `x` (px from the reader's left) is in the middle of a reader `width` px wide. An
 * unknown place (null) counts as the middle. */
export function isCentre(x, width) {
  if (x === null || !(width > 0)) return true;
  const share = x / width;
  return share >= CENTRE_FROM && share <= CENTRE_TO;
}

/** Whether a click in `doc` belongs to something else: a link (by its element, or foliate's
 * handler having prevented it) or a selection being made. */
export function clickTaken(e, doc) {
  if (e.defaultPrevented || e.target?.closest?.('a[href]')) return true;
  const selection = doc.getSelection?.();
  return !!selection && !selection.isCollapsed;
}

/**
 * Listens on `doc` (the reader document, or a section's document inside it) for a tap in the
 * middle of the page, and calls `onTap` for each. `viewportX(e)` is the click's distance from
 * the reader's left (a section's document lies in a frame that scrolls sideways under the
 * page, so its own clientX is not), null when it cannot tell; `width()` the reader's width.
 * The click is judged once its other listeners ran (`defer`), so a link that took it is seen
 * whatever order the listeners were added in.
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
      if (!clickTaken(e, doc) && isCentre(x, width())) onTap();
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
