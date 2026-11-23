import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapability, useLibrariesOf, useServerInfo } from '@/api/hooks';
import { refusedServer } from '@/api/server-read-error';
import { OfflineState } from '@/components/layout/offline-state';
import { ServerRefusal } from '@/components/layout/server-refusal-state';
import { useCid } from '@/api/provider';
import { pageGutter } from '@/components/library/cover-layout';
import { ContentScope } from '@/components/layout/content-scope';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { TabPageScroll } from '@/components/shell/tab-page-scroll';
import { EmptyState } from '@/components/ui/empty-state';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { useDialogRead } from '@/lib/offline-state';
import { useLayout } from '@/lib/layout';
import { type FindShowsSection, parseFindShowsParams } from '@/lib/paths';
import { useRouteParams } from '@/lib/route-params';
import { usePageTitle } from '@/lib/use-page-title';

import { DirectorySearch } from './directory-search';
import { availableSections, resolveSection } from './find-shows-model';
import { FollowByUrl } from './follow-by-url';
import { FollowRequests } from './follow-requests';
import { OpmlImportPanel } from './opml-import-panel';
import { useAddShowsAccess } from './shows-actions';
import { useOpmlImport } from './use-opml-import';

/**
 * Find shows (Bridge Phase 2d-2): `/find-shows?connection=&library=[&section=]`
 * (`findShowsHref`), adding shows to one podcast library, scoped to its own
 * `?connection=`. Its sections: a directory search (`podcast_discovery`), a feed's
 * address (always), an OPML list (`podcast_opml`). Every one ends in a follow, so the
 * page is for a listener who may follow (`useAddShowsAccess`); a kid's account, the
 * demo or a server that can't follow now get a sentence instead. A link naming a library
 * the server does not have (a link without `?connection=` reads the default server's) gets
 * the broken-link sentence, never a follow into another library. An import carries on
 * while another section shows, and ends with the page.
 */
export function FindShowsScreen() {
  return (
    <ContentScope>
      <FindShowsContent />
    </ContentScope>
  );
}

const SECTION_LABEL = {
  search: 'podcasts.find.sections.search',
  address: 'podcasts.find.sections.address',
  import: 'podcasts.find.sections.import',
} as const;

function FindShowsContent() {
  const { t } = useTranslation();
  const params = parseFindShowsParams(useRouteParams());
  // A link without `?connection=` is the default connection's (`useCid`), as on the book
  // and series pages.
  const cid = useCid();
  usePageTitle(t('podcasts.find.title'));
  const access = useAddShowsAccess(cid);
  const discovery = useCapability('podcast_discovery', cid);
  const opml = useCapability('podcast_opml', cid);
  // The import lives for the page, whichever section shows.
  const importer = useOpmlImport(cid, params?.libraryId ?? 0);
  const librariesRead = useLibrariesOf(cid);
  const libraries = librariesRead.data;
  const librariesOffline = useDialogRead(librariesRead).offline;

  if (!params) return <EmptyState icon="microphone" title={t('library.detail.badLink')} />;
  if (access === 'unknown') {
    return <FindShowsAccessState connectionId={cid} />;
  }
  if (access !== 'allowed') {
    return (
      <EmptyState
        icon="microphone"
        title={
          access === 'kid'
            ? t('podcasts.find.kid')
            : access === 'demo'
              ? t('podcasts.find.demo')
              : t('podcasts.find.unavailable')
        }
        hint={access === 'unavailable' ? t('podcasts.find.unavailableHint') : undefined}
      />
    );
  }

  // Only once the libraries are known and settled (a cached list read again may hold a
  // library added since): a library the server lacks. A books library is the server's to
  // refuse (`not_podcast_library`). Offline, a kept list may predate the library, so a
  // missing one waits for the network too. A list not read yet keeps the page: each
  // section says it is offline itself, and replacing the page would drop a typed address,
  // kept results or a running import with its Stop.
  if (libraries && !librariesRead.isFetching && !libraries.some((l) => l.id === params.libraryId)) {
    if (librariesOffline) return <OfflineState hint={t('common.offlinePage')} />;
    return (
      <View testID="find-shows-library-missing">
        <EmptyState icon="microphone" title={t('library.detail.badLink')} />
      </View>
    );
  }

  const offered = availableSections({ discovery, opml });
  const section = resolveSection(params.section, offered);
  const libraryId = params.libraryId;
  const header = (
    <View className="gap-4 pb-5 pt-5">
      <Text variant="display" role="heading">
        {t('podcasts.find.title')}
      </Text>
      {offered.length > 1 ? (
        <SegmentedControl<FindShowsSection>
          scrollable
          options={offered.map((s) => ({ value: s, label: t(SECTION_LABEL[s]) }))}
          value={section}
          onChange={(next) => router.setParams({ section: next })}
          accessibilityLabel={t('podcasts.find.sectionsLabel')}
          className="max-w-full self-start"
        />
      ) : null}
    </View>
  );
  const requests = <FollowRequests connectionId={cid} libraryId={libraryId} />;

  switch (section) {
    case 'search':
      return (
        <DirectorySearch
          key={`${cid}:${libraryId}`}
          connectionId={cid}
          libraryId={libraryId}
          header={header}
          footer={requests}
        />
      );
    case 'import':
      return (
        <FindShowsScroll header={header} testID="find-shows-import">
          <OpmlImportPanel opml={importer} connectionId={cid} libraryId={libraryId} />
        </FindShowsScroll>
      );
    default:
      return (
        <FindShowsScroll header={header} testID="find-shows-address">
          <FollowByUrl key={`${cid}:${libraryId}`} connectionId={cid} libraryId={libraryId} />
          {requests}
        </FindShowsScroll>
      );
  }
}

/** The capability check has no answer yet. A held or failed read needs its own state. */
function FindShowsAccessState({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const info = useServerInfo(connectionId);
  // `offline`: a server's failed answer (an `ApiError`) is `failed` whatever the network
  // does since, but its Retry can't work until the network is back.
  const { unread, offline } = useDialogRead(info);
  if (unread === 'offline') return <OfflineState hint={t('common.offlinePage')} />;
  if (unread === 'failed') {
    const refusal = refusedServer(connectionId, info.error);
    if (refusal) return <ServerRefusal {...refusal} />;
    return (
      <EmptyState
        icon="server"
        title={t('podcasts.find.accessFailed')}
        action={
          offline
            ? undefined
            : {
                label: t('common.retry'),
                onPress: () => void info.refetch(),
                loading: info.isFetching,
              }
        }
      />
    );
  }
  return (
    <View className="p-4">
      <RowSkeletonList />
    </View>
  );
}

/** The page's scroller for a section without a long list (a feed address, an import):
 * the tab page scroller with the page head, then `children`, in the search list's
 * gutters. */
function FindShowsScroll({
  header,
  children,
  testID,
}: {
  header: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const gutter = pageGutter(useLayout());
  const paddingBottom = useMiniPlayerInset();
  return (
    <TabPageScroll
      testID={testID}
      gutter={false}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: paddingBottom + 24 }}
    >
      {header}
      {children}
    </TabPageScroll>
  );
}
