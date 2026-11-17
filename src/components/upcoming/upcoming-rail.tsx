import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useUpcomingAll } from '@/api/hooks';
import { HomeSection } from '@/components/home/home-section';
import { ShelfRow } from '@/components/library/shelf-row';
import { upcomingHref } from '@/lib/paths';
import { isNewUpcoming, type SourcedUpcomingItem } from '@/lib/upcoming';

import { UpcomingTile } from './upcoming-parts';
import { useUpcomingClock } from './use-upcoming-clock';

/** The most the rail shows; See all opens the rest. */
export const UPCOMING_RAIL_LIMIT = 12;

const itemKey = (item: SourcedUpcomingItem) => item.work.id;

/**
 * Home's Coming up in your series (Track U2), after Next in your series: preorders, then
 * recent releases, then missing volumes in the series the listener holds, merged across
 * their servers (`useUpcomingAll`). Renders nothing while there is none, while loading and
 * where no server has `upcoming` (or the listener is a kid there): a rail that may never
 * show keeps no skeleton, so Home never jumps. See all opens `/upcoming`. `skipWorks`: the
 * works Home's Next in your series already shows as a ghost, left out here so one work is
 * not offered twice in a row (fe#204).
 */
export function UpcomingRail({ skipWorks }: { skipWorks?: ReadonlySet<string> }) {
  const { t } = useTranslation();
  const { items: all } = useUpcomingAll();
  const items = skipWorks?.size ? all.filter((item) => !skipWorks.has(item.work.id)) : all;
  // Counted from when Home was last in front (a Home in view keeps its badges steady).
  const now = useUpcomingClock();
  if (items.length === 0) return null;
  return (
    <HomeSection
      title={t('upcoming.rail.title')}
      sub={t('upcoming.rail.sub')}
      action={{ label: t('home.seeAll'), onPress: () => router.push(upcomingHref()) }}
    >
      <ShelfRow
        data={items.slice(0, UPCOMING_RAIL_LIMIT)}
        keyExtractor={itemKey}
        accessibilityLabel={t('upcoming.rail.title')}
        renderItem={(item, width) => (
          <UpcomingTile item={item} isNew={isNewUpcoming(item, now)} width={width} />
        )}
      />
    </HomeSection>
  );
}
