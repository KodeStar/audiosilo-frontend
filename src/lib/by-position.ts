/** A book's bookmarks or notes in book order, earliest place first (ties by id, so the
 * order is stable; the server's order is not promised). Pure. */
export function byPosition<T extends { position: number; id: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position || a.id - b.id);
}
