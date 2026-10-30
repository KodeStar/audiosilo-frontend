import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useUpcomingAll } from '@/api/hooks';
import { LoadError } from '@/components/library/books/book-states';
import { useServerFlag } from '@/components/library/cover-tile';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { joinList } from '@/lib/names';
import { isNewUpcoming, upcomingSectionOf } from '@/lib/upcoming';

import { UpcomingCalendarCard } from './upcoming-calendar';
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
 * after its first check"); nothing coming up; no server answering, with its list or its
 * flags (a Retry, never "nothing coming up", nor rows standing in forever); and, where no
 * server offers it (or the listener is a kid there), a quiet "not available" in place of a
 * list that would ask nothing. A server that didn't answer beside
 * others, a stale one, or one still on its first check beside others, is a note over the
 * list (or over "nothing coming up"). Under the list, "Add to your calendar"
 * (`UpcomingCalendarCard`, Track U3) where a server offers the calendar. `embedded`: under
 * the hub's own large title (phone), so no heading.
 */
export function UpcomingContent({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const serverLabel = useServerFlag();
  const { items, available, isLoading, statuses, failed, retry } = useUpcomingAll();
  // Counted from when the page opened (its badges stay put while it is open).
  const [now] = useState(() => new Date());
  const pending = statuses.filter((s) => s.status === 'pending').map((s) => s.connectionName);
  const stale = statuses.filter((s) => s.status === 'stale').map((s) => s.connectionName);
  // Servers named in a note: "Home", "Home and Maya", counted for the verb.
  const servers = (names: readonly string[]) => ({
    server: joinList(names, (rest, last) => t('common.and', { rest, last })),
    count: names.length,
  });

  let body: React.ReactNode;
  if (available === undefined || (isLoading && items.length === 0)) {
    body = <UpcomingSkeleton />;
  } else if (available === false && failed.length === 0) {
    body = (
      <EmptyState
        icon="book"
        title={t('upcoming.unavailable.title')}
        hint={t('upcoming.unavailable.hint')}
      />
    );
  } else if (statuses.length === 0 && failed.length > 0) {
    // No server answered: never "nothing coming up", which nobody said.
    body = (
      <LoadError
        title={t('upcoming.error.title')}
        hint={t('upcoming.error.hint', servers(failed))}
        retryLabel={t('common.retry')}
        onRetry={retry}
      />
    );
  } else {
    const allPending =
      items.length === 0 && statuses.length > 0 && pending.length === statuses.length;
    body = (
      <>
        {failed.length > 0 ? (
          <LoadError
            compact
            title={t('upcoming.error.partial', servers(failed))}
            retryLabel={t('common.retry')}
            onRetry={retry}
          />
        ) : null}
        {stale.length > 0 ? (
          <Text variant="muted" testID="upcoming-stale">
            {t('upcoming.stale', servers(stale))}
          </Text>
        ) : null}
        {pending.length > 0 && !allPending ? (
          <Text variant="muted" testID="upcoming-pending-some">
            {t('upcoming.pendingSome', servers(pending))}
          </Text>
        ) : null}
        {items.length === 0 ? (
          allPending ? (
            <EmptyState
              icon="clock"
              title={t('upcoming.pending.title')}
              hint={t('upcoming.pending.hint')}
            />
          ) : (
            <EmptyState
              icon="inbox"
              title={t('upcoming.empty.title')}
              hint={t('upcoming.empty.hint')}
            />
          )
        ) : (
          SECTIONS.map(({ key, titleKey }) => {
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
          })
        )}
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
      {available ? <UpcomingCalendarCard /> : null}
    </View>
  );
}
