/**
 * Where a virtual list of rows of one height opens, so it shows a row (the current chapter,
 * the reader's place in its contents) without blank rows. The player's Chapters list and
 * the reader's long contents share it.
 */

/**
 * The row a virtual list opens at (`initialScrollIndex`): `want`, when the rows from it on
 * fill a window's height, so the list can scroll that far. Otherwise none: a list too short
 * below that row renders from it and never fills in the rows above it, which stay blank and
 * untappable (FlatList on Android: Part 1 of a four-file book opened on Part 4). The list
 * then opens at its top and is scrolled toward the row once laid out (`openingOffset`).
 */
export function openingIndex(
  want: number,
  count: number,
  rowHeight: number,
  windowHeight: number,
): number | undefined {
  return want > 0 && (count - want) * rowHeight >= windowHeight ? want : undefined;
}

/**
 * How far a list that opened at its top (`openingIndex` gave none) is scrolled once laid
 * out at `listHeight`: to the row, or as far toward it as the list scrolls (`padBottom`,
 * its content's bottom padding, is part of that room).
 */
export function openingOffset(
  want: number,
  count: number,
  rowHeight: number,
  listHeight: number,
  padBottom = 0,
): number {
  const room = count * rowHeight + padBottom - listHeight;
  return Math.min(want * rowHeight, Math.max(0, room));
}
