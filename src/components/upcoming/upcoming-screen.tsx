import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useUpcomingAll } from '@/api/hooks';
import { useServerFlag } from '@/components/library/cover-tile';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { isNewUpcoming, upcomingSectionOf } from '@/lib/upcoming';

import { UpcomingRow } from './upcoming-parts';

/** The screen's sections, in order (`upcomingSectionOf` places each item). */
const SECTIONS = [
  { key: 'preorder', titleKey: 'upcoming.sections.preorder' },
  { key: 'released', titleKey: 'upcoming.sections.released' },
  { key: 'missing', titleKey: 'upcoming.sections.missing' },
] as const;

/** Rows standing in for the list while the first answers load. */
function UpcomingSkeleton() {
  return (
    <View testID="upcoming-skeleton" className="gap-3" accessibilityElementsHidden>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} className="flex-row items-center gap-3 py-3">
          <Skeleton className="h-14 w-14 rounded-cover" />
          <View className="flex-1 gap-1.5">
            <Skeleton className="h-3.5 w-2/3 rounded-sm" />
            <Skeleton className="h-3 w-1/3 rounded-sm" />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The Upcoming page's body (Track U2; `/upcoming`, and the You hub's Upcoming section): the
 * listener's upcoming releases on every server, in three sections (Coming soon, Just
 * released, Missing from your series; an empty one hidden). The states: rows standing in
 * while the first answers load; a server's first check still running ("this list fills
 * after its first check"); nothing coming up; and, where no server offers it (or the
 * listener is a kid there), a quiet "not available" in place of a list that would ask
 * nothing. A stale server, or one still on its first check beside others, is a quiet note
 * over the list. `embedded`: under the hub's own large title (phone), so no heading.
 */
export function UpcomingContent({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const serverLabel = useServerFlag();
  const { items, available, isLoading, statuses } = useUpcomingAll();
  // Counted from when the page opened (its badges stay put while it is open).
  const [now] = useState(() => new Date());
  const pending = statuses.filter((s) => s.status === 'pending').map((s) => s.connectionName);
  const stale = statuses.filter((s) => s.status === 'stale').map((s) => s.connectionName);

  let body: React.ReactNode;
  if (available === undefined || (isLoading && items.length === 0)) {
    body = <UpcomingSkeleton />;
  } else if (available === false) {
    body = (
      <EmptyState
        icon="book"
        title={t('upcoming.unavailable.title')}
        hint={t('upcoming.unavailable.hint')}
      />
    );
  } else if (items.length === 0) {
    const allPending = statuses.length > 0 && pending.length === statuses.length;
    body = allPending ? (
      <EmptyState
        icon="clock"
        title={t('upcoming.pending.title')}
        hint={t('upcoming.pending.hint')}
      />
    ) : (
      <EmptyState icon="inbox" title={t('upcoming.empty.title')} hint={t('upcoming.empty.hint')} />
    );
  } else {
    body = (
      <>
        {stale.length > 0 ? (
          <Text variant="muted" testID="upcoming-stale">
            {t('upcoming.stale', { server: stale.join(', ') })}
          </Text>
        ) : null}
        {pending.length > 0 ? (
          <Text variant="muted" testID="upcoming-pending-some">
            {t('upcoming.pendingSome', { server: pending.join(', ') })}
          </Text>
        ) : null}
        {SECTIONS.map(({ key, titleKey }) => {
          const rows = items.filter((item) => upcomingSectionOf(item) === key);
          if (rows.length === 0) return null;
          return (
            <View key={key} className="gap-1" testID={`upcoming-section-${key}`}>
              <Text variant="heading" accessibilityRole="header">
                {t(titleKey)}
              </Text>
              <View role="list">
                {rows.map((item, i) => (
                  <UpcomingRow
                    key={item.work.id}
                    item={item}
                    first={i === 0}
                    isNew={isNewUpcoming(item, now)}
                    server={serverLabel(item.connectionId)}
                  />
                ))}
              </View>
            </View>
          );
        })}
      </>
    );
  }

  return (
    <View className="w-full max-w-[880px] gap-6 self-center" testID="upcoming-page">
      {embedded ? null : (
        <Text variant="display" accessibilityRole="header">
          {t('upcoming.title')}
        </Text>
      )}
      {body}
    </View>
  );
}
