import type { LayoutClass } from '@/lib/layout';

/** The narrowest page that takes the book page's two panes (a 300 cover panel and the
 * details beside it); a narrower one stacks like the phone's. */
export const BOOK_TWO_PANE_MIN = 720;
/** The narrowest page whose cover panel is the desktop's 380 (else 300). */
const WIDE_PANEL_MIN = 960;

/**
 * The book page's layout for the window's class and the page's MEASURED width (0: not
 * measured yet, which trusts the class): the Up next drawer takes up to 480 of a desktop,
 * so a 1024 window can leave the page phone-narrow. Null is the single column.
 */
export function bookPanes(layout: LayoutClass, width: number): { panel: 300 | 380 } | null {
  if (layout === 'phone') return null;
  if (width > 0 && width < BOOK_TWO_PANE_MIN) return null;
  const roomy = width === 0 || width >= WIDE_PANEL_MIN;
  return { panel: layout === 'desktop' && roomy ? 380 : 300 };
}
