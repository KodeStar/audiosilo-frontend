import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useServerInfo } from '@/api/hooks';
import { useScopedCid } from '@/api/provider';
import { ContentScope } from '@/components/layout/content-scope';
import { EmptyState } from '@/components/ui/empty-state';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
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
 * gets a sentence and no request is sent.
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
  const cid = useScopedCid();
  usePageTitle(t('librivox.title'));
  const user = useSession((s) => s.connections.find((c) => c.id === cid)?.user);
  const server = useServerInfo(cid).data;
  const access = librivoxAccess(user, server);

  if (!params) return <EmptyState icon="book" title={t('library.detail.badLink')} />;
  if (access === 'unknown') {
    return (
      <View className="p-4" testID="find-librivox-loading">
        <RowSkeletonList />
      </View>
    );
  }
  if (access !== 'allowed') {
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
    </View>
  );
  return (
    <LibrivoxSearch
      key={`${cid}:${params.libraryId}`}
      connectionId={cid}
      libraryId={params.libraryId}
      header={header}
    />
  );
}
