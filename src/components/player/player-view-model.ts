import type { CoverColor } from '@/api/types';
import { layoutFor, type LayoutClass } from '@/lib/layout';

/**
 * The full player's pure rules (STYLEGUIDE section 8, "Full player"): which layout a
 * width gets, how big the cover is, what the top line says and how the sync state reads.
 */

/** The companion column's width on a desktop. */
export const COMPANION_WIDTH = 420;

/** The player's layout from its MEASURED width (0: not measured yet, so the window's
 * class): the player is a root modal, but a desktop browser can be any size. */
export function playerLayout(width: number, windowLayout: LayoutClass): LayoutClass {
  return width > 0 ? layoutFor(width) : windowLayout;
}

/** The cover's edge for a layout, a width and a height (the desktop cover leaves room
 * for the controls under it, the companion beside it). */
export function playerCoverSize(layout: LayoutClass, width: number, height: number): number {
  if (layout === 'phone') return Math.round(Math.min(320, width * 0.78));
  if (layout === 'tablet') return Math.round(Math.min(440, width * 0.6));
  return Math.round(Math.max(200, Math.min(380, (width - COMPANION_WIDTH) * 0.6, height * 0.4)));
}

/** The line under "Playing from <server>": the book's place in its series, else its
 * library, else nothing. */
export type PlayerContext =
  { kind: 'series'; series: string; position?: number } | { kind: 'library'; name: string } | null;

export function playerContext(
  book: { series?: string; series_index?: number } | undefined,
  libraryName: string | undefined,
): PlayerContext {
  if (book?.series) {
    return {
      kind: 'series',
      series: book.series,
      position: book.series_index && book.series_index > 0 ? book.series_index : undefined,
    };
  }
  return libraryName ? { kind: 'library', name: libraryName } : null;
}

/** How the status line tells where the place is: kept on this device until it can sync
 * (the book's server is offline, or saves are queued), else synced. */
export function syncState(offline: boolean, pending: number): 'local' | 'synced' {
  return offline || pending > 0 ? 'local' : 'synced';
}

/** The wash's colours: the book's cover colour, else a quiet neutral with the brand as
 * its accent (never a made-up cover colour). */
export function playerWash(
  color: CoverColor | undefined,
  neutral: string,
  brand: string,
): CoverColor {
  return color?.bg ? color : { bg: neutral, accent: brand };
}
