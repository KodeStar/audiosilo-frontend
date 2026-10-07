import type { LayoutClass } from '@/lib/layout';

/** The list view's columns beside the title: none (a phone's subtitle carries them),
 * some (narrator and progress) or all (plus length). */
export type ListColumns = 'none' | 'some' | 'all';

/**
 * The columns a list `width` wide has room for (0: not measured yet, which trusts the
 * window's class). The list's width, not the window's: the Up next drawer takes up to
 * 480 of a desktop, and the full set left the title a dozen characters.
 */
export function listColumns(layout: LayoutClass, width: number): ListColumns {
  if (layout === 'phone' || (width > 0 && width < 520)) return 'none';
  return layout === 'desktop' && (width === 0 || width >= 820) ? 'all' : 'some';
}
