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
import { OfflineState } from '@/components/layout/offline-state';
import {
  refusedConnection,
  SignInAgainState,
  useSignedOutConnections,
} from '@/components/layout/sign-in-again';
import { PodcastShowsMode } from '@/components/podcasts/shows-mode';
import { SubNavActions, SubNavSections } from '@/components/shell/tab-root-nav';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { useDeviceOnline } from '@/lib/device-online';
import { useLayout } from '@/lib/layout';
import { isPodcastLibrary } from '@/lib/library-kind';
import { offlineState } from '@/lib/offline-state';
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
 * selected library (`useSelectedLibrary`), or the state of the server it is on while that
 * server's list is not in (loading, offline, failed with Retry, signed out: never another
 * server's books in its place); a mode the library's server lacks is not
 * offered, and a link to one falls back to Books once that is known. A podcast library
 * (Bridge Phase 2d-1) offers Shows and Folders, and a book mode's link lands on Shows.
 */
export function LibraryScreen() {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const { mode: modeParam } = useRouteParams<{ mode?: string | string[] }>();
  const { selection, library, server, groups, retryServer } = useSelectedLibrary();
  const signedOut = useSignedOutConnections();
  const deviceOnline = useDeviceOnline();
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
    // The server the Library is on, while its list is not in: waiting for the network or
    // failed without one (`offline`), failed with one (`failed`), else still on its way.
    const unread =
      server && server.status !== 'ready'
        ? offlineState({
            waiting: server.paused,
            failed: server.status === 'error',
            deviceOnline,
          })
        : null;
    // A library whose server's list is in, or on its way: the mode's own states.
    if (selection && !unread) {
      const Body = MODE_BODY[mode];
      return <Body key={`${cid}:${libraryId}`} connectionId={cid} libraryId={libraryId} />;
    }
    // Every server answered and none shares a library (or nobody is signed in).
    if (!server) return <NoLibrariesState connectionIds={groups.map((g) => g.connectionId)} />;
    // From here on it is THAT server's state, whatever the other servers list: never
    // their books in its place (fe#142). The picker still offers their libraries.
    if (!unread) {
      return (
        <View className="p-4 lg:px-8">
          <RowSkeletonList />
        </View>
      );
    }
    const named = groups.length > 1;
    const name = server.connectionName;
    // A server whose sign-in ended lists no libraries: it is not that none are shared
    // (frontend#124), nor a load error with a Retry that cannot work.
    const refused = refusedConnection(signedOut, [server]);
    if (refused) {
      return (
        <View className="p-4 lg:px-8">
          <SignInAgainState connection={refused} />
        </View>
      );
    }
    // Offline (its list waits for the network, or failed with the device offline): the
    // offline state, not "Could not load" with a Retry that cannot work until the
    // network is back. The remembered library's server is named among several.
    if (unread === 'offline') {
      return (
        <OfflineState
          hint={named ? t('library.list.serverOffline', { name }) : t('library.list.offlineHint')}
        />
      );
    }
    // A server that did not answer has not said it shares nothing (frontend#131): its
    // list comes back on its own once it answers again (`onReconnect`), or on Retry.
    return (
      <View className="p-4 lg:px-8">
        <LoadError
          title={
            named
              ? t('library.list.loadServerLibrariesError', { name })
              : t('library.list.loadLibrariesError')
          }
          retryLabel={t('common.retry')}
          onRetry={() => retryServer(server.connectionId)}
        />
      </View>
    );
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
