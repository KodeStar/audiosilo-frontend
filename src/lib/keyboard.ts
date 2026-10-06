/**
 * Guards shared by the web's global keyboard shortcuts (the palette's ⌘K and `/`, Up
 * next's Q): a shortcut never fires while the focus is in something you type into, nor
 * over a modal dialog. DOM-only; callers check `Platform.OS === 'web'` first.
 */

/** Whether the focus is in something you type into (no shortcut fires there). */
export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable === true
  );
}

/** Whether a modal dialog (the palette, a sheet, an alert) is open in `doc`. */
export function isModalOpen(doc: Pick<Document, 'querySelector'>): boolean {
  return doc.querySelector('[aria-modal="true"]') !== null;
}
