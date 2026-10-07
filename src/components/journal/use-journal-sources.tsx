import type { InfiniteData } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import {
  flattenPages,
  useAllHistory,
  useCapability,
  useMyBookmarks,
  useMyNotes,
} from '@/api/hooks';
import { useApis } from '@/api/provider';
import type { HistoryEntry, MyBookmark, MyNote, Page } from '@/api/types';

import type { SourceSnapshot, SourceStatus } from './merge-model';

/**
 * The Journal's three lists on EVERY signed-in server: listening history, bookmarks and
 * notes, each one infinite query per server (`useAllHistory`, `useMyBookmarks`,
 * `useMyNotes`, through each server's own connection and its own capability gate).
 *
 * TanStack has no "many infinite queries" hook, so each (list, server) pair is a small
 * component that runs the existing hook and reports its state up (`feeders`, rendered
 * by the screen; they draw nothing). A server's query never waits on another's, and a
 * removed server's feeder unmounts and takes its rows with it.
 */

/** One server's list, with the actions to page it. */
export type Source<T> = SourceSnapshot<T> & {
  fetchNextPage: () => void;
  refetch: () => void;
};

export type JournalSources = {
  history: Source<HistoryEntry>[];
  bookmarks: Source<MyBookmark>[];
  notes: Source<MyNote>[];
  /** The feeders: render them once, anywhere (they draw nothing). */
  feeders: ReactNode;
};

type Kind = 'history' | 'bookmarks' | 'notes';
type AnySource = Source<HistoryEntry> | Source<MyBookmark> | Source<MyNote>;
type Report = (id: string, source: AnySource | null) => void;

type FeederProps = {
  id: string;
  connectionId: string;
  connectionName: string;
  report: Report;
};

/** The state of one infinite query, as a source. `supported` false: the server can't
 * list this (an older one without `annotations`); undefined: not known yet. */
function useReport<T>(
  { id, connectionId, connectionName, report }: FeederProps,
  query: {
    data: InfiniteData<Page<T>> | undefined;
    isError: boolean;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => unknown;
    refetch: () => unknown;
  },
  supported: boolean | undefined,
) {
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = query;
  const status: SourceStatus =
    supported === false ? 'unsupported' : data ? 'ready' : isError ? 'error' : 'loading';
  useEffect(() => {
    report(id, {
      connectionId,
      connectionName,
      status,
      rows: flattenPages(data),
      hasNextPage: status === 'ready' && hasNextPage,
      isFetchingNextPage,
      fetchNextPage: () => void fetchNextPage(),
      refetch: () => void refetch(),
    } as AnySource);
  }, [
    id,
    connectionId,
    connectionName,
    status,
    data,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
    report,
  ]);
  useEffect(() => () => report(id, null), [id, report]);
}

function HistoryFeeder(props: FeederProps) {
  useReport(props, useAllHistory(props.connectionId), true);
  return null;
}

function BookmarksFeeder(props: FeederProps) {
  const supported = useCapability('annotations', props.connectionId);
  useReport(props, useMyBookmarks(props.connectionId), supported);
  return null;
}

function NotesFeeder(props: FeederProps) {
  const supported = useCapability('annotations', props.connectionId);
  useReport(props, useMyNotes(props.connectionId), supported);
  return null;
}

const FEEDERS = { history: HistoryFeeder, bookmarks: BookmarksFeeder, notes: NotesFeeder };
const KINDS: Kind[] = ['history', 'bookmarks', 'notes'];

/** A source that has not reported yet: loading. */
const pending = (connectionId: string, connectionName: string): Source<never> => ({
  connectionId,
  connectionName,
  status: 'loading',
  rows: [],
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: () => {},
  refetch: () => {},
});

export function useJournalSources(): JournalSources {
  const apis = useApis();
  const [reported, setReported] = useState<Record<string, AnySource>>({});
  const report = useCallback<Report>((id, source) => {
    setReported((prev) => {
      if (source) return { ...prev, [id]: source };
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // The React Compiler memoizes these on `apis` and `reported`.
  const feeders = apis.flatMap(({ connection }) =>
    KINDS.map((kind) => {
      const Feeder = FEEDERS[kind];
      const id = `${kind}\n${connection.id}`;
      return (
        <Feeder
          key={id}
          id={id}
          connectionId={connection.id}
          connectionName={connection.name}
          report={report}
        />
      );
    }),
  );
  const list = <T,>(kind: Kind) =>
    apis.map(
      ({ connection: c }) =>
        (reported[`${kind}\n${c.id}`] as Source<T> | undefined) ?? pending(c.id, c.name),
    );
  return {
    history: list<HistoryEntry>('history'),
    bookmarks: list<MyBookmark>('bookmarks'),
    notes: list<MyNote>('notes'),
    feeders,
  };
}
