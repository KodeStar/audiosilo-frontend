// foliate's paginator lays its section out again whenever its box resizes (a
// ResizeObserver on its container calls `render()`, as does a layout attribute). It renders
// the view it has, and while a new section loads that is the new one: its frame already
// points at the section's document, which can have no root element or no body yet. Then
// foliate's `columnize` throws "Cannot destructure property 'style' of ... null" (fe#239:
// at 390 px the host's Follow narration pill goes away as Follow is tapped, so the reader's
// frame grows while the follow `goTo` loads the narrated section).
//
// foliate is vendored unmodified (reader/vendor/FOLIATE_PIN.txt), so the guard is ours: a
// relayout of a document that is not there yet is skipped. Nothing is lost, as the section's
// own load lays it out at the size the paginator has then.

/** Whether a section's document can be laid out: it has its root element and a body. */
export function canLayout(doc) {
  return Boolean(doc?.documentElement && doc.body);
}

/**
 * Makes `renderer.render()` (foliate's paginator, `foliate-paginator`) do nothing while the
 * section it shows has no document to lay out. An instance property, so the paginator's
 * own `this.render()` calls (its ResizeObserver, `attributeChangedCallback`) go through it.
 * Any other renderer (a fixed-layout book's) is left as it is. Returns whether it guarded.
 */
export function guardRender(renderer) {
  if (renderer?.localName !== 'foliate-paginator') return false;
  const render = renderer.render;
  if (typeof render !== 'function' || typeof renderer.getContents !== 'function') return false;
  renderer.render = function guardedRender(...args) {
    const contents = this.getContents();
    // Nothing shown yet: foliate's own render returns at once.
    if (contents.length > 0 && !canLayout(contents[0]?.doc)) return undefined;
    return render.apply(this, args);
  };
  return true;
}

// A relayout (the frame resized or rotated, a new text size, a section that grows as its
// fonts load) puts the paginator back on the place it holds (`#scrollToAnchor`, relocate
// reason `anchor`): no move, though the page it lands on can start a little before that
// place. Saved as a move, each one pulled the place back a little (fe#172).
//
// The reason alone does not say so. foliate relocates with `anchor` for two real moves too,
// focus going to a link on another page and a keyboard selection crossing a page
// (paginator.js, the section's `focusin` and `selectionchange`), and for a section it has
// just loaded, which it first lays out on the place the last one held. What tells a
// relayout apart is the layout: it lands in the section the last relocate was in, in a
// layout that changed since. foliate's view passes a relocate on without its reason, so
// both are read where the paginator dispatches it, before the view hears of it.

/**
 * The layout the shown section is in: the paginator's box (a resize, a rotation), the
 * section's laid-out length (its page count: fonts or images that loaded) and its text
 * size. '' when it cannot be read. A reflow that changes none of them is not seen.
 */
function layoutOf(renderer) {
  try {
    const box = renderer.getBoundingClientRect?.();
    const doc = renderer.getContents?.()[0]?.doc;
    const textSize = doc?.defaultView?.getComputedStyle?.(doc.documentElement)?.fontSize;
    return [box?.width, box?.height, renderer.viewSize, textSize].join('|');
  } catch {
    return '';
  }
}

/**
 * Watches the relocates `renderer` dispatches (an instance property, so its own
 * `this.dispatchEvent` goes through it, as `guardRender`'s does). Returns whether the last
 * one was a relayout: the paginator back on its place (`anchor`) in the same section, in a
 * layout that changed since the relocate before it. Read from the view's `relocate`, which
 * foliate sends from inside that dispatch.
 */
export function watchRelayouts(renderer) {
  const dispatch = renderer?.dispatchEvent;
  if (typeof dispatch !== 'function') return () => false;
  // The last relocate's section, and the layout it landed in.
  let section;
  let shown = '';
  let relayout = false;
  renderer.dispatchEvent = function watchedDispatch(event) {
    if (event?.type === 'relocate') {
      const { reason, index } = event.detail ?? {};
      const layout = layoutOf(this);
      relayout = reason === 'anchor' && index === section && layout !== shown;
      section = index;
      shown = layout;
    }
    return dispatch.call(this, event);
  };
  return () => relayout;
}
