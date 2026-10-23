import { router, useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapability } from '@/api/hooks';
import { useScopedCid } from '@/api/provider';
import { pageGutter } from '@/components/library/cover-layout';
import { ContentScope } from '@/components/layout/content-scope';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { TabPageScroll } from '@/components/shell/tab-page-scroll';
import { EmptyState } from '@/components/ui/empty-state';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { useLayout } from '@/lib/layout';
import { type FindShowsSection, parseFindShowsParams } from '@/lib/paths';
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
 * demo or a server that can't follow now get a sentence instead. An import carries on
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
  const params = parseFindShowsParams(useLocalSearchParams());
  const cid = useScopedCid();
  usePageTitle(t('podcasts.find.title'));
  const access = useAddShowsAccess(cid);
  const discovery = useCapability('podcast_discovery', cid);
  const opml = useCapability('podcast_opml', cid);
  // The import lives for the page, whichever section shows.
  const importer = useOpmlImport(cid, params?.libraryId ?? 0);

  if (!params) return <EmptyState icon="microphone" title={t('library.detail.badLink')} />;
  if (access === 'unknown') {
    return (
      <View className="p-4">
        <RowSkeletonList />
      </View>
    );
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
          <OpmlImportPanel opml={importer} />
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
