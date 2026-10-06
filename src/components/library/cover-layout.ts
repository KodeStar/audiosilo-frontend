import type { LayoutClass } from '@/lib/layout';

/**
 * Cover sizing shared by the shelves and the grid (STYLEGUIDE section 5, density): shelf
 * tiles 164 (132 on a phone), a grid of `repeat(auto-fill, minmax(158px, 1fr))` (two
 * columns on a phone), and the page gutter they bleed to (the `p-4 lg:px-8` the pages
 * use: 16, 32 on a desktop).
 */
export const GRID_MIN_TILE = 158;

/** The page's side padding on this form factor. */
export function pageGutter(layout: LayoutClass): number {
  return layout === 'desktop' ? 32 : 16;
}

/** A shelf row's tile width and the gap between its tiles. */
export function shelfMetrics(layout: LayoutClass): { tile: number; gap: number } {
  return layout === 'phone' ? { tile: 132, gap: 14 } : { tile: 164, gap: 22 };
}

/** A cover grid's columns, tile width and gaps for an inner (gutter-less) `width`: as
 * many columns of at least 158 as fit (always two on a phone), sharing the width. */
export function coverGridMetrics(
  width: number,
  layout: LayoutClass,
): { columns: number; tile: number; columnGap: number; rowGap: number } {
  const phone = layout === 'phone';
  const columnGap = phone ? 14 : 22;
  const rowGap = phone ? 22 : 30;
  const columns = phone
    ? 2
    : Math.max(2, Math.floor((width + columnGap) / (GRID_MIN_TILE + columnGap)));
  const tile = Math.max(0, Math.floor((width - columnGap * (columns - 1)) / columns));
  return { columns, tile, columnGap, rowGap };
}
