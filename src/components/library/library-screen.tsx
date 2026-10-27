import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  useAuthors,
  useCapability,
  useCollections,
  useNarrators,
  usePodcastShows,
  useSeriesList,
} from '@/api/hooks';
import {
  refusedConnection,
  SignInAgainState,
  useSignedOutConnections,
} from '@/components/layout/sign-in-again';
import { PodcastShowsMode } from '@/components/podcasts/shows-mode';
import { SubNavActions, SubNavSections } from '@/components/shell/tab-root-nav';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { useLayout } from '@/lib/layout';
import { isPodcastLibrary } from '@/lib/library-kind';
import { useRouteParams } from '@/lib/route-params';

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
import { LoadError } from './books/book-states';
import { LibraryPicker } from './library-picker';
import { AuthorsMode } from './modes/authors-mode';
import { BooksMode } from './modes/books-mode';
import { CollectionsMode } from './modes/collections-mode';
import { FoldersMode } from './modes/folders-mode';
import { NarratorsMode } from './modes/narrators-mode';
import { SeriesMode } from './modes/series-mode';
import { NoLibrariesState } from './no-libraries-state';
import { useSelectedLibrary } from './use-selected-library';

const MODE_BODY: Record<
  Exclude<LibraryMode, 'folders'>,
  (p: LibraryModeProps) => React.ReactNode
> = {
  shows: PodcastShowsMode,
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
 * offered, and a link to one falls back to Books once that is known. A podcast library
 * (Bridge Phase 2d-1) offers Shows and Folders, and a book mode's link lands on Shows.
 */
export function LibraryScreen() {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const { mode: modeParam } = useRouteParams<{ mode?: string | string[] }>();
  const { selection, library, groups, isLoading, offline, retry } = useSelectedLibrary();
  const signedOut = useSignedOutConnections();
  const cid = selection?.connectionId ?? '';
  const libraryId = selection?.libraryId ?? 0;
  // Unknown until the selected library is listed (`resolveLibraryMode` keeps a request).
  const podcasts = library ? isPodcastLibrary(library) : selection ? undefined : false;
  // An empty id (nothing selected yet) resolves to no client: nothing is asked.
  const caps = {
    browsePeople: useCapability('browse_people', cid),
    collections: useCapability('collections', cid),
  };
  const mode = resolveLibraryMode(parseLibraryMode(modeParam), caps, podcasts);
  const counts = useModeCounts(cid, libraryId, podcasts);

  const available = availableLibraryModes(caps, podcasts);
  // A deep-linked mode still waiting on its capability keeps its segment meanwhile.
  const options = LIBRARY_MODES.filter((m) => m === mode || available.includes(m)).map((m) => ({
    value: m,
    label: t(LIBRARY_MODE_LABEL_KEY[m]),
    count: counts[m],
  }));

  const setMode = (next: LibraryMode) =>
    router.setParams({ mode: next === DEFAULT_LIBRARY_MODE ? undefined : next });

  const body = () => {
    if (mode === 'folders') return <FoldersMode />;
    if (selection) {
      const Body = MODE_BODY[mode];
      return <Body key={`${cid}:${libraryId}`} connectionId={cid} libraryId={libraryId} />;
    }
    if (isLoading) {
      return (
        <View className="p-4 lg:px-8">
          <RowSkeletonList />
        </View>
      );
    }
    // A server whose sign-in ended lists no libraries: it is not that none are shared
    // (frontend#124).
    const refused = refusedConnection(signedOut, groups);
    if (refused) {
      return (
        <View className="p-4 lg:px-8">
          <SignInAgainState connection={refused} />
        </View>
      );
    }
    // A server that did not answer has not said it shares nothing (frontend#131): its
    // lists come back on their own once it answers again (`onReconnect`), or on Retry.
    if (groups.some((g) => g.status === 'error')) {
      return (
        <View className="p-4 lg:px-8">
          <LoadError
            title={t('library.list.loadLibrariesError')}
            retryLabel={t('common.retry')}
            onRetry={retry}
          />
        </View>
      );
    }
    // Offline before a server listed its libraries: not "none shared", and no skeleton
    // that would never end. The lists arrive when the network does.
    return <NoLibrariesState offline={offline} connectionIds={groups.map((g) => g.connectionId)} />;
  };

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
            <LibraryPicker
              by={mode === 'collections' ? 'server' : 'library'}
              className={phone ? 'max-w-full self-start' : undefined}
            />
          </SubNavActions>
        )}
      </View>
      {body()}
    </View>
  );
}

/** The segment counts the server can give for the selected library (each hook is
 * capability-gated, so an older server is never asked). Books has no total on the
 * wire (its list is paged), and Folders spans every library, so neither has one. A
 * podcast library counts its shows; its book lists are never asked (no connection is
 * no request), nor a books library's shows. */
function useModeCounts(
  cid: string,
  libraryId: number,
  podcasts: boolean | undefined,
): Partial<Record<LibraryMode, number>> {
  const bookCid = podcasts === false ? cid : '';
  const authors = useAuthors(libraryId, bookCid).data;
  const narrators = useNarrators(libraryId, bookCid).data;
  const series = useSeriesList(libraryId, bookCid).data;
  const collections = useCollections(bookCid).data;
  const shows = usePodcastShows(libraryId, cid, { enabled: podcasts === true }).data;
  return {
    shows: shows?.length,
    authors: authors?.people.length,
    narrators: narrators?.people.length,
    series: series?.length,
    collections: collections?.length,
  };
}
