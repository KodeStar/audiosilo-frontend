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
