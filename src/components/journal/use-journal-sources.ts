import {
  type InfiniteData,
  type QueryKey,
  useQueries,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  flattenPages,
  keepFirstPage,
  myBookmarksQuery,
  myHistoryQuery,
  myNotesQuery,
  serverInfoQuery,
} from '@/api/hooks';
import { useApis } from '@/api/provider';
import type { HistoryEntry, MyBookmark, MyNote, Page } from '@/api/types';
import { type InfiniteQueriesResult, useInfiniteQueries } from '@/lib/use-infinite-queries';

import type { SourceSnapshot, SourceStatus } from './merge-model';

/**
 * The Journal's three lists on EVERY signed-in server: listening history, bookmarks and
 * notes, each one infinite query per server (`useInfiniteQueries`), through each server's
 * own connection and gated on its own capability (bookmarks and notes need `annotations`;
 * no query function at all until it is known to be on). A server's query never waits on
 * another's, and a removed server's queries go with it. The options are `hooks.ts`'s
 * (`myHistoryQuery`, `myBookmarksQuery`, `myNotesQuery`), so a mutation's refresh of
 * those keys reaches the Journal, and a list nothing reads any more keeps only its first
 * page (`keepFirstPage`).
 */

/** One server's list, with the actions to page it. */
export type Source<T> = SourceSnapshot<T> & {
  /** Whether the server can list it: false for an older one without the capability,
   * 'unknown' once its `/server` failed, undefined while not known. History: always. */
  supported: boolean | 'unknown' | undefined;
  fetchNextPage: () => void;
  refetch: () => void;
};

export type JournalSources = {
  history: Source<HistoryEntry>[];
  bookmarks: Source<MyBookmark>[];
  notes: Source<MyNote>[];
};

/** Each loaded page's rows as one list, the same array while the pages are. */
const flattened = new WeakMap<InfiniteData<unknown>, unknown[]>();
const NO_ROWS: never[] = [];
function rowsOf<T>(data: InfiniteData<Page<T>> | undefined): readonly T[] {
  if (!data) return NO_ROWS;
  let rows = flattened.get(data) as T[] | undefined;
  if (!rows) {
    rows = flattenPages(data);
    flattened.set(data, rows);
  }
  return rows;
}

type ServerAnnotations = {
  supported: boolean | 'unknown' | undefined;
  refetch: () => unknown;
};

/** One infinite query's state as a source. `supported` false: the server can't list
 * this; 'unknown': its `/server` failed, so whether it can is not known (a failure, never
 * an endless load). Its retry asks `/server` again too (`info`): a list that never ran,
 * for want of the flag, has nothing of its own to retry (it runs once the flag says yes). */
function toSource<T>(
  connection: { id: string; name: string },
  query: InfiniteQueriesResult<Page<T>, string | undefined>,
  supported: Source<T>['supported'],
  info?: ServerAnnotations,
): Source<T> {
  const { data, isError, hasNextPage, isFetchingNextPage } = query;
  const status: SourceStatus =
    supported === false
      ? 'unsupported'
      : data
        ? 'ready'
        : isError || supported === 'unknown'
          ? 'error'
          : 'loading';
  return {
    connectionId: connection.id,
    connectionName: connection.name,
    status,
    supported,
    rows: rowsOf(data),
    hasNextPage: status === 'ready' && hasNextPage,
    isFetchingNextPage,
    fetchNextPage: () => void query.fetchNextPage(),
    refetch: () => {
      void info?.refetch();
      // A list without its flag has no query function: the flag's answer starts it.
      if (supported === true) void query.refetch();
    },
  };
}

/**
 * `notes` false holds the notes back (the cache is read, nothing is fetched): the Diary
 * shows none of them, so the screen asks only once its Notes tab is opened.
 */
export function useJournalSources({ notes: wantNotes = true } = {}): JournalSources {
  const apis = useApis();
  const infos = useQueries({
    queries: apis.map(({ connection, client }) => serverInfoQuery(connection.id, client)),
    combine: (results) =>
      results.map((r): ServerAnnotations => ({
        supported: r.data ? !!r.data.capabilities.annotations : r.isError ? 'unknown' : undefined,
        refetch: r.refetch,
      })),
  });

  const qc = useQueryClient();
  const release = (key: QueryKey) => keepFirstPage(qc, key);
  const historyQueries = useInfiniteQueries(
    useMemo(
      () => apis.map(({ connection, client }) => myHistoryQuery(connection.id, client)),
      [apis],
    ),
    release,
  );
  const bookmarkQueries = useInfiniteQueries(
    useMemo(
      () =>
        apis.map(({ connection, client }, i) =>
          myBookmarksQuery(connection.id, client, infos[i]?.supported === true),
        ),
      [apis, infos],
    ),
    release,
  );
  const noteQueries = useInfiniteQueries(
    useMemo(
      () =>
        apis.map(({ connection, client }, i) => ({
          ...myNotesQuery(connection.id, client, infos[i]?.supported === true),
          enabled: wantNotes,
        })),
      [apis, infos, wantNotes],
    ),
    release,
  );

  // Per list, so a page of notes never rebuilds the Diary's sources.
  const history = useMemo(
    () => apis.map(({ connection }, i) => toSource(connection, historyQueries[i], true)),
    [apis, historyQueries],
  );
  const bookmarks = useMemo(
    () =>
      apis.map(({ connection }, i) =>
        toSource(connection, bookmarkQueries[i], infos[i]?.supported, infos[i]),
      ),
    [apis, bookmarkQueries, infos],
  );
  const notes = useMemo(
    () =>
      apis.map(({ connection }, i) =>
        toSource(connection, noteQueries[i], infos[i]?.supported, infos[i]),
      ),
    [apis, noteQueries, infos],
  );
  return { history, bookmarks, notes };
}
