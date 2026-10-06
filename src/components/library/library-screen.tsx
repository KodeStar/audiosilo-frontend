import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  useAuthors,
  useCapability,
  useCollections,
  useNarrators,
  useSeriesList,
} from '@/api/hooks';
import { SubNavActions, SubNavSections } from '@/components/shell/tab-root-nav';
import { EmptyState } from '@/components/ui/empty-state';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { useLayout } from '@/lib/layout';

import { LibraryPicker } from './library-picker';
import {
  availableLibraryModes,
  DEFAULT_LIBRARY_MODE,
  LIBRARY_MODE_LABEL_KEY,
  LIBRARY_MODES,
  type LibraryMode,
  type LibraryModeProps,
  parseLibraryMode,
  resolveLibraryMode,
} from './library-modes';
import { AuthorsMode } from './modes/authors-mode';
import { BooksMode } from './modes/books-mode';
import { CollectionsMode } from './modes/collections-mode';
import { FoldersMode } from './modes/folders-mode';
import { NarratorsMode } from './modes/narrators-mode';
import { SeriesMode } from './modes/series-mode';
import { useSelectedLibrary } from './use-selected-library';

const MODE_BODY: Record<
  Exclude<LibraryMode, 'folders'>,
  (p: LibraryModeProps) => React.ReactNode
> = {
  books: BooksMode,
  authors: AuthorsMode,
  series: SeriesMode,
  narrators: NarratorsMode,
  collections: CollectionsMode,
};

/**
 * The Library tab root (`/library?mode=`): the browse modes as its sections (the sub-nav
 * on tablet/desktop, under the large title on a phone), the library picker as its
 * contextual action, and the current mode's body. Every mode but Folders shows the
 * selected library (`useSelectedLibrary`); a mode the library's server lacks is not
 * offered, and a link to one falls back to Books once that is known.
 */
export function LibraryScreen() {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const { mode: modeParam } = useLocalSearchParams<{ mode?: string | string[] }>();
  const { selection, isLoading } = useSelectedLibrary();
  const cid = selection?.connectionId ?? '';
  const libraryId = selection?.libraryId ?? 0;
  // An empty id (nothing selected yet) resolves to no client: nothing is asked.
  const caps = {
    browsePeople: useCapability('browse_people', cid),
    collections: useCapability('collections', cid),
  };
  const mode = resolveLibraryMode(parseLibraryMode(modeParam), caps);
  const counts = useModeCounts(cid, libraryId);

  const available = availableLibraryModes(caps);
  // A deep-linked mode still waiting on its capability keeps its segment meanwhile.
  const options = LIBRARY_MODES.filter((m) => m === mode || available.includes(m)).map((m) => ({
    value: m,
    label: t(LIBRARY_MODE_LABEL_KEY[m]),
    count: counts[m],
  }));

  const setMode = (next: LibraryMode) =>
    router.setParams({ mode: next === DEFAULT_LIBRARY_MODE ? undefined : next });

  const Body = mode === 'folders' ? null : MODE_BODY[mode];

  return (
    <View className="flex-1">
      <View className={phone ? 'gap-3 px-4 pb-2' : undefined}>
        <SubNavSections
          tab="(library)"
          options={options}
          value={mode}
          onChange={setMode}
          accessibilityLabel={t('library.modes.label')}
          className="max-w-full"
        />
        {mode === 'folders' ? null : (
          <SubNavActions tab="(library)" id="library-picker" order={-100}>
            <LibraryPicker className={phone ? 'max-w-full self-start' : undefined} />
          </SubNavActions>
        )}
      </View>
      {Body === null ? (
        <FoldersMode />
      ) : selection ? (
        <Body key={`${cid}:${libraryId}`} connectionId={cid} libraryId={libraryId} />
      ) : isLoading ? (
        <View className="p-4 lg:px-8">
          <RowSkeletonList />
        </View>
      ) : (
        <EmptyState
          icon="library"
          title={t('library.list.noLibraries')}
          hint={t('library.list.noLibrariesHint')}
        />
      )}
    </View>
  );
}

/** The segment counts the server can give for the selected library (each hook is
 * capability-gated, so an older server is never asked). Books has no total on the
 * wire (its list is paged), and Folders spans every library, so neither has one. */
function useModeCounts(cid: string, libraryId: number): Partial<Record<LibraryMode, number>> {
  const authors = useAuthors(libraryId, cid).data;
  const narrators = useNarrators(libraryId, cid).data;
  const series = useSeriesList(libraryId, cid).data;
  const collections = useCollections(cid).data;
  return {
    authors: authors?.people.length,
    narrators: narrators?.people.length,
    series: series?.length,
    collections: collections?.length,
  };
}
