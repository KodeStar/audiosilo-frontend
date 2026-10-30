import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useUpcomingAll } from '@/api/hooks';
import { HomeSection } from '@/components/home/home-section';
import { useServerFlag } from '@/components/library/cover-tile';
import { ShelfRow } from '@/components/library/shelf-row';
import { upcomingHref } from '@/lib/paths';
import { isNewUpcoming, type SourcedUpcomingItem } from '@/lib/upcoming';

import { UpcomingTile } from './upcoming-parts';

/** The most the rail shows; See all opens the rest. */
export const UPCOMING_RAIL_LIMIT = 12;

const itemKey = (item: SourcedUpcomingItem) => item.work.id;

/**
 * Home's Coming up in your series (Track U2), after Next in your series: preorders, then
 * recent releases, then missing volumes in the series the listener holds, merged across
 * their servers (`useUpcomingAll`). Renders nothing while there is none, while loading and
 * where no server has `upcoming` (or the listener is a kid there): a rail that may never
 * show keeps no skeleton, so Home never jumps. See all opens `/upcoming`.
 */
export function UpcomingRail() {
  const { t } = useTranslation();
  const serverLabel = useServerFlag();
  const { items } = useUpcomingAll();
  // Counted from when Home opened (a long-open Home keeps its badges steady).
  const [now] = useState(() => new Date());
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
          <UpcomingTile
            item={item}
            isNew={isNewUpcoming(item, now)}
            server={serverLabel(item.connectionId)}
            width={width}
          />
        )}
      />
    </HomeSection>
  );
}
