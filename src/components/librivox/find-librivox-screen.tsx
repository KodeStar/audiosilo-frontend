import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, View } from 'react-native';

import { useServerInfo } from '@/api/hooks';
import { useCid } from '@/api/provider';
import { ContentScope } from '@/components/layout/content-scope';
import { OfflineState } from '@/components/layout/offline-state';
import { EmptyState } from '@/components/ui/empty-state';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { BRIDGE_IDLE_POLL_MS } from '@/lib/bridge-jobs';
import { useUnreadQuery } from '@/lib/offline-state';
import { parseFindLibrivoxParams } from '@/lib/paths';
import { useRouteParams } from '@/lib/route-params';
import { usePageTitle } from '@/lib/use-page-title';
import { useSession } from '@/stores/session';

import { librivoxAccess } from './librivox-model';
import { LibrivoxSearch } from './librivox-search';

/**
 * Find on LibriVox (LibriVox L6): `/find-librivox?connection=&library=`
 * (`findLibrivoxHref`), scoped to its own `?connection=`. An admin searches the community
 * metadata's LibriVox works (never librivox.org), opens one to see its recordings, and adds
 * one to a books library: the server's Bridge downloads it from archive.org, places and
 * rescans it, and the server records the book as that recording, so it is matched with no
 * console match. The page is only for someone `librivoxAccess` allows (an admin, the
 * Bridge online with `librivox`, community metadata on); anyone else, or an older server,
 * gets a sentence and no request is sent. A link without `?connection=` is the default
 * connection's, as on the book and series pages (`useCid`).
 *
 * Once open, the page stays while a `/server` read again finds the Bridge away (its
 * heartbeat lapsed: `/server` drops its features), so the search and the fetches its rows
 * follow are kept; it says so and holds Add back until the Bridge is online again. While
 * it is away the page asks `/server` again every `BRIDGE_IDLE_POLL_MS` (nothing else
 * would while the page stays open), so Add comes back with the Bridge.
 */
export function FindLibrivoxScreen() {
  return (
    <ContentScope>
      <FindLibrivoxContent />
    </ContentScope>
  );
}

/** What the page says to someone it is closed to, by why (`librivoxAccess`). */
const CLOSED = {
  notAdmin: { title: 'librivox.access.notAdmin', hint: undefined },
  unavailable: {
    title: 'librivox.access.unavailable',
    hint: 'librivox.access.unavailableHint',
  },
  metadataOff: {
    title: 'librivox.access.metadataOff',
    hint: 'librivox.access.metadataOffHint',
  },
} as const;

function FindLibrivoxContent() {
  const { t } = useTranslation();
  const params = parseFindLibrivoxParams(useRouteParams());
  const cid = useCid();
  usePageTitle(t('librivox.title'));
  const user = useSession((s) => s.connections.find((c) => c.id === cid)?.user);
  const info = useServerInfo(cid);
  const server = info.data;
  const access = librivoxAccess(user, server);
  // Before the skeleton: a `/server` read held for the network stays pending.
  const offline = useUnreadQuery(info) === 'offline';
  // The connection the page was open for (`allowed` once): a Bridge that went away since
  // keeps the page (`away`), never another connection's.
  const [openFor, setOpenFor] = useState<string | null>(null);
  if (access === 'allowed' && openFor !== cid) setOpenFor(cid);
  const away = access === 'unavailable' && openFor === cid;
  // Away: `/server` is asked again while the app is in the foreground. Its answer is fresh
  // for minutes and nothing reads it again on an open page, so "add once it's back" would
  // wait for the app to be left and opened again (and the followed fetches' reads with it,
  // which the same flag holds).
  const refetchInfo = info.refetch;
  useEffect(() => {
    if (!away) return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refetchInfo();
    }, BRIDGE_IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [away, refetchInfo]);

  if (!params) return <EmptyState icon="book" title={t('library.detail.badLink')} />;
  if (access === 'unknown') {
    if (offline) return <OfflineState hint={t('common.offlinePage')} />;
    // Failed with nothing kept: say so with Retry, never a skeleton for ever.
    if (info.isError) {
      return (
        <View testID="find-librivox-error">
          <EmptyState
            icon="server"
            title={t('librivox.access.readFailed')}
            action={{ label: t('common.retry'), onPress: () => void info.refetch() }}
          />
        </View>
      );
    }
    return (
      <View className="p-4" testID="find-librivox-loading">
        <RowSkeletonList />
      </View>
    );
  }
  if (access !== 'allowed' && !away) {
    return (
      <View testID="find-librivox-closed">
        <EmptyState
          icon="book"
          title={t(CLOSED[access].title)}
          hint={CLOSED[access].hint && t(CLOSED[access].hint)}
        />
      </View>
    );
  }

  const header = (
    <View className="gap-2 pb-4 pt-5">
      <Text variant="display" role="heading">
        {t('librivox.title')}
      </Text>
      <Text variant="muted">{t('librivox.intro')}</Text>
      {away ? (
        <Text variant="caption" role="alert" testID="find-librivox-away">
          {t('librivox.access.away')}
        </Text>
      ) : null}
    </View>
  );
  return (
    <LibrivoxSearch
      key={`${cid}:${params.libraryId}`}
      connectionId={cid}
      libraryId={params.libraryId}
      header={header}
      bridgeAway={away}
    />
  );
}
