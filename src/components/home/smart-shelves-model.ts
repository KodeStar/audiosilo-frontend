import { type GridSpec, gridMetrics } from '@/components/library/cover-layout';
import type { LayoutClass } from '@/lib/layout';

/** The shelves' grid: cards of at least 180 (the title and its eyebrow still fit on whole
 * words), never fewer than two a row, two on a phone, `gap-3` across and down. */
const SHELF_GRID: GridSpec = {
  min: 180,
  minColumns: 2,
  phoneColumns: 2,
  columnGap: [12, 12],
  rowGap: [12, 12],
};

/** The space between two cards, across and down, in pixels on every platform (the web's
 * `gap-3`; a native `gap-3` would be 10.5, rem being 14 there). */
export const SHELF_GAP = SHELF_GRID.columnGap[1];
/** The narrowest a card may be on a tablet or desktop: below it the row takes fewer. */
export const SHELF_MIN_WIDTH = SHELF_GRID.min;
/** The most cards a row holds. */
export const SHELF_MAX_COLUMNS = 4;

/**
 * How many cards a row of smart shelves holds. A phone always takes two. A tablet or
 * desktop takes as many as fit at `SHELF_MIN_WIDTH` in the measured row (`gridMetrics`),
 * between two and `SHELF_MAX_COLUMNS`. Before the row is measured (a zero width) it is
 * two on a tablet and four on a desktop.
 */
export function shelfColumns(layout: LayoutClass, rowWidth: number): number {
  if (!(rowWidth > 0)) return layout === 'desktop' ? SHELF_MAX_COLUMNS : 2;
  return Math.min(SHELF_MAX_COLUMNS, gridMetrics(rowWidth, layout, SHELF_GRID).columns);
}

/**
 * The shelves split into the fewest rows of at most `columns` (at least one a row),
 * balanced so the rows differ by at most one card, the fuller rows first: four in rows
 * of three become two and two, three in rows of two become two and one. Each card in a
 * row takes an equal share of it, so a row with fewer cards (the last of an odd count)
 * still fills the width.
 */
export function shelfRows<T>(shelves: readonly T[], columns: number): T[][] {
  if (shelves.length === 0) return [];
  const rowCount = Math.ceil(shelves.length / Math.max(1, Math.floor(columns) || 1));
  const base = Math.floor(shelves.length / rowCount);
  const fuller = shelves.length % rowCount;
  const rows: T[][] = [];
  for (let r = 0, i = 0; r < rowCount; r++) {
    const size = base + (r < fuller ? 1 : 0);
    rows.push(shelves.slice(i, i + size));
    i += size;
  }
  return rows;
}
