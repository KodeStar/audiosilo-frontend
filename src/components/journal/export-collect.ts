import type { InfiniteData } from '@tanstack/react-query';

import type { Page } from '@/api/types';

/**
 * Everything of one paged list for the export: the pages the Journal already loaded,
 * then the rest from the server, a page at a time, until the list ends or `maxRows` is
 * reached (an export of a huge journal stays bounded; `truncated` says so). Pure apart
 * from the injected `fetchPage`, so the paging is tested without a server.
 */
export async function collectPages<T extends { id: number }>(
  cached: InfiniteData<Page<T>> | undefined,
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  { maxRows, onProgress }: { maxRows: number; onProgress?: (rows: number) => void },
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  const seen = new Set<number>();
  const take = (page: Page<T>) => {
    for (const row of page.items) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      items.push(row);
    }
  };
  let cursor: string | undefined;
  if (cached && cached.pages.length > 0) {
    cached.pages.forEach(take);
    cursor = cached.pages[cached.pages.length - 1].next_cursor || undefined;
  } else {
    const first = await fetchPage(undefined);
    take(first);
    cursor = first.next_cursor || undefined;
  }
  onProgress?.(items.length);
  while (cursor && items.length < maxRows) {
    const page = await fetchPage(cursor);
    const before = items.length;
    take(page);
    onProgress?.(items.length);
    const next = page.next_cursor || undefined;
    // A server that hands back the same cursor (or nothing new) would loop forever.
    if (next === cursor || (items.length === before && page.items.length > 0)) break;
    cursor = next;
  }
  return { items: items.slice(0, maxRows), truncated: !!cursor || items.length > maxRows };
}
