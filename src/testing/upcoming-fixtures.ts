import type { UpcomingItem } from '@/api/types';
import type { SourcedUpcomingItem } from '@/lib/upcoming';

/** An upcoming item (`GET /me/upcoming`): a missing volume 1 of "Series" by default. */
export function upcomingItem(over: Partial<UpcomingItem> & { id: string }): UpcomingItem {
  const { id, ...rest } = over;
  return {
    kind: 'missing',
    first_seen_at: '2026-01-01T00:00:00Z',
    work: { id, title: `Title ${id}`, authors: [], web_url: `https://meta/works/${id}` },
    series: { id: 's', name: 'Series', position: '1' },
    local: { library_id: 1, series: 'Series' },
    ...rest,
  };
}

/** {@link upcomingItem} from connection `connectionId` (named like it). */
export function sourcedUpcoming(
  over: Partial<UpcomingItem> & { id: string },
  connectionId = 'a',
): SourcedUpcomingItem {
  return { ...upcomingItem(over), connectionId, connectionName: connectionId };
}
