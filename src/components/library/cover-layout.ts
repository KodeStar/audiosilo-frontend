import type { LayoutClass } from '@/lib/layout';

/**
 * Cover sizing shared by the shelves and the grid (STYLEGUIDE section 5, density): shelf
 * tiles 164 (132 on a phone), a grid of `repeat(auto-fill, minmax(158px, 1fr))` (two
 * columns on a phone), and the page gutter they bleed to (the `p-4 lg:px-8` the pages
 * use: 16, 32 on a desktop).
 */
const GRID_MIN_TILE = 158;

/** The page's side padding on this form factor. */
export function pageGutter(layout: LayoutClass): number {
  return layout === 'desktop' ? 32 : 16;
}

/** A shelf row's tile width and the gap between its tiles. */
export function shelfMetrics(layout: LayoutClass): { tile: number; gap: number } {
  return layout === 'phone' ? { tile: 132, gap: 14 } : { tile: 164, gap: 22 };
}

/** How a grid divides its width: tiles of at least `min` on a tablet or desktop (never
 * fewer than `minColumns`), `phoneColumns` on a phone, and its gaps (phone, wider). */
export type GridSpec = {
  min: number;
  minColumns: number;
  phoneColumns: number;
  columnGap: readonly [phone: number, wide: number];
  rowGap: readonly [phone: number, wide: number];
};

/** The cover grid: `repeat(auto-fill, minmax(158px, 1fr))`, two columns on a phone. */
export const COVER_GRID: GridSpec = {
  min: GRID_MIN_TILE,
  minColumns: 2,
  phoneColumns: 2,
  columnGap: [14, 22],
  rowGap: [22, 30],
};

/** A grid of cards (the Series, Authors and Narrators modes): at least `min` wide, one
 * wide card or two on a phone. */
export function cardGrid(min: number, phoneColumns: 1 | 2): GridSpec {
  return { min, minColumns: 1, phoneColumns, columnGap: [12, 18], rowGap: [12, 18] };
}

/** A grid's columns, tile width and gaps for an inner (gutter-less) `width`: as many
 * columns of at least `spec.min` as fit, sharing the width. */
export function gridMetrics(
  width: number,
  layout: LayoutClass,
  spec: GridSpec = COVER_GRID,
): { columns: number; tile: number; columnGap: number; rowGap: number } {
  const phone = layout === 'phone';
  const columnGap = spec.columnGap[phone ? 0 : 1];
  const rowGap = spec.rowGap[phone ? 0 : 1];
  const columns = phone
    ? spec.phoneColumns
    : Math.max(spec.minColumns, Math.floor((width + columnGap) / (spec.min + columnGap)));
  const tile = Math.max(0, Math.floor((width - columnGap * (columns - 1)) / columns));
  return { columns, tile, columnGap, rowGap };
}
