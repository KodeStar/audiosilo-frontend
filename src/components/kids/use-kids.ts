import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { allProgressQuery, librariesQuery, useAllLibraryBooks } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { useReachability } from '@/api/reachability';
import type { Book, Library } from '@/api/types';
import { statusSignature } from '@/downloads/downloads-view';
import { useDownloads } from '@/downloads/store';
import { type Profile, useActiveProfile, useProfileConnections } from '@/stores/profiles';

import { kidsConnectionId, kidsDownloads, kidsLibrary, kidsShelf } from './kids-model';

/** The active profile when it is in kids mode, else null. */
export function useKidsProfile(): Profile | null {
  const profile = useActiveProfile();
  return profile?.kids ? profile : null;
}

/** Whether the active profile is in kids mode (the gate keeps it on `/kids`). */
export function useKidsActive(): boolean {
  return useKidsProfile() !== null;
}

/** What kids mode's story grid shows. */
export type KidsStories =
  | { status: 'loading' }
  /** The profile holds no connection (only for a moment: such a profile is deleted). */
  | { status: 'no-connection' }
  /** The kid's account sees no library, or the library has no books. */
  | { status: 'empty'; serverName: string }
  /** The server can't be reached and nothing is downloaded. */
  | { status: 'error'; serverName: string; offline: boolean }
  /** `offline`: the server can't be reached and these are the downloaded stories. */
  | { status: 'ready'; books: Book[]; offline: boolean };

/**
 * Kids mode's stories: the kid's connection (`kidsConnectionId`), its library
 * (`kidsLibrary`, from GET /libraries, which the server scopes to what the account may
 * see), and every book in it, continue-listening first (`kidsShelf`). Offline, the
 * downloaded stories of that connection (`kidsDownloads`). `retry` asks again.
 */
export function useKidsStories(): {
  stories: KidsStories;
  connectionId: string | null;
  library: Library | null;
  retry: () => void;
} {
  const profile = useKidsProfile();
  const connections = useProfileConnections();
  const cid = kidsConnectionId(
    connections.map((c) => c.id),
    profile?.kids,
  );
  const connection = connections.find((c) => c.id === cid);
  // '' (not undefined) when there is no connection, so no default connection stands in.
  const client = useOptionalApi(cid ?? '');
  const libraries = useQuery(librariesQuery(cid ?? '', client));
  const library = cid && libraries.data ? kidsLibrary(libraries.data, cid, profile?.kids) : null;
  const books = useAllLibraryBooks(library?.id ?? 0, {}, cid ?? '', { enabled: !!library });
  const progress = useQuery(allProgressQuery(cid ?? '', client));
  const offline = useReachability((s) => (cid ? s.online[cid] === false : false));
  // Re-read when a download lands or goes, never on a progress tick (which would
  // re-render the whole kids screen several times a second while one downloads).
  const downloadsSig = useDownloads((s) => statusSignature(s.entries));
  const downloaded = useMemo(
    () => (cid ? kidsDownloads(useDownloads.getState().entries, cid, library?.id ?? null) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on the signature
    [downloadsSig, cid, library?.id],
  );
  const shelf = useMemo(
    () => (library ? kidsShelf(books.books, progress.data ?? [], library.id) : []),
    [books.books, progress.data, library],
  );

  const retry = () => {
    void libraries.refetch();
    if (library) books.retry();
    void progress.refetch();
  };

  const serverName = connection?.name ?? '';
  let stories: KidsStories;
  // Paused (React Query's offline state) counts as unreachable, as does a failed read.
  const librariesFailed =
    libraries.isError || (libraries.isPending && libraries.fetchStatus === 'paused');
  if (!cid) stories = { status: 'no-connection' };
  else if (offline && downloaded.length > 0) {
    // The streamed stories wouldn't play: show the ones on this device.
    stories = { status: 'ready', books: downloaded, offline: true };
  } else if (librariesFailed && !libraries.data) {
    stories =
      downloaded.length > 0
        ? { status: 'ready', books: downloaded, offline: true }
        : { status: 'error', serverName, offline };
  } else if (libraries.isPending) stories = { status: 'loading' };
  else if (!library) stories = { status: 'empty', serverName };
  else if (books.isLoading || books.isIdle) stories = { status: 'loading' };
  else if (books.error && shelf.length === 0) {
    stories =
      downloaded.length > 0
        ? { status: 'ready', books: downloaded, offline: true }
        : { status: 'error', serverName, offline };
  } else if (shelf.length === 0) {
    stories = books.complete ? { status: 'empty', serverName } : { status: 'loading' };
  } else stories = { status: 'ready', books: shelf, offline: false };

  return { stories, connectionId: cid, library, retry };
}
