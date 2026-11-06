import type { LayoutClass } from '@/lib/layout';

/** The space between two cards, across and down (`gap-3`). */
export const SHELF_GAP = 12;
/** The narrowest a card may be on a tablet or desktop: below it the row takes fewer
 * cards. The title and its eyebrow still fit on whole words at this width. */
export const SHELF_MIN_WIDTH = 180;
/** The most cards a row holds. */
export const SHELF_MAX_COLUMNS = 4;

/**
 * How many cards a row of smart shelves holds. A phone always takes two. A tablet or
 * desktop takes as many as fit at `SHELF_MIN_WIDTH` in the measured row, between two and
 * `SHELF_MAX_COLUMNS`. Before the row is measured (no width, or a zero one) it is two on
 * a tablet and four on a desktop, the split the cards had before they were measured.
 */
export function shelfColumns(layout: LayoutClass, rowWidth?: number): number {
  if (layout === 'phone') return 2;
  if (!rowWidth || !Number.isFinite(rowWidth) || rowWidth <= 0) {
    return layout === 'desktop' ? SHELF_MAX_COLUMNS : 2;
  }
  const fit = Math.floor((rowWidth + SHELF_GAP) / (SHELF_MIN_WIDTH + SHELF_GAP));
  return Math.max(2, Math.min(SHELF_MAX_COLUMNS, fit));
}

/**
 * The shelves split into rows of at most `columns`, balanced so no row is left with
 * one card when a fuller split exists: four in rows of three become two and two, three
 * in rows of two become two and one. Each card in a row takes an equal share of it, so
 * a row with fewer cards (the last of an odd count) still fills the width.
 *
 * The rows are explicit Views rather than one `flex-wrap` row with percentage widths:
 * on native, Yoga shrank such cards into one row instead of wrapping them (#213).
 */
export function shelfRows<T>(shelves: readonly T[], columns: number): T[][] {
  if (shelves.length === 0) return [];
  const cols = Math.max(1, Math.floor(columns));
  const rowCount = Math.ceil(shelves.length / cols);
  const perRow = Math.ceil(shelves.length / rowCount);
  const rows: T[][] = [];
  for (let i = 0; i < shelves.length; i += perRow) rows.push(shelves.slice(i, i + perRow));
  return rows;
}
