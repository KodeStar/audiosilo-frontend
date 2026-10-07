import { usePathname } from 'expo-router';
import { useEffect } from 'react';

import { BROWSE_PATHS } from '@/lib/paths';
import { clearScrollMemory } from '@/lib/scroll-memory';
import { useSearchStore } from '@/stores/search';

import { useActiveTab } from './destinations';

/** Whether a pathname is inside the browse section (its scroll memory is kept). */
export function isBrowsePath(pathname: string): boolean {
  return BROWSE_PATHS.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

/**
 * The route-driven side effects of the shell, run by both `(app)` layouts:
 * - Leaving the Search tab clears the query, so the next visit starts fresh. Within the
 *   tab it is kept: opening a result and coming back shows the same results.
 * - Remembered browse scroll positions only make sense while moving within the library
 *   (drilling into folders/books and back). Leaving the section - Home, Settings, etc. -
 *   forgets them, so re-entering the library starts at the top.
 */
export function useShellEffects() {
  const active = useActiveTab();
  const setQuery = useSearchStore((s) => s.setQuery);
  // `null` (the player modal, connect) is not "leaving": the tab is still underneath.
  const inSearch = active === '(search)' || active === null;
  useEffect(() => {
    if (!inSearch) setQuery('');
  }, [inSearch, setQuery]);

  const pathname = usePathname();
  const inBrowse = isBrowsePath(pathname);
  useEffect(() => {
    if (!inBrowse) clearScrollMemory();
  }, [inBrowse]);
}
