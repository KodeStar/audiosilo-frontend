import { skipToken, useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { qk, useAllProgressAll, useLibrariesAll } from '@/api/hooks';
import { useApis } from '@/api/provider';
import type { BookMeta, Capabilities, PeopleList, SeriesCount } from '@/api/types';
import { selectBookPosition, usePlayer } from '@/playback/store';

import {
  type CharacterBook,
  characterBooksToLoad,
  listeningIn,
  type ListSource,
  type SourcedList,
} from './search-model';

/**
 * Search's data across every signed-in server (feature-local: the screen and the web
 * palette both read it). Each source is capability-gated per server (`skipToken` until
 * its `/server` flag is known to be on, so an older server is never asked) and shares the
 * cache of the single-server hooks (`qk.*`), so a list Library already loaded is reused.
 */

/** Same freshness as `useServerInfo` and the browse lists (`hooks.ts`). */
const SERVER_STALE_MS = 5 * 60_000;
const BROWSE_STALE_MS = 5 * 60_000;
const META_STALE_MS = 60 * 60_000;
/** How coarsely the loaded book's live position is sampled (as the book page does): a
 * reveal is only ever late by this much, never early. */
const LIVE_POSITION_BUCKET_S = 15;

/** Every connection's advertised capabilities, `undefined` while its `/server` is not
 * known (loading or unreachable). */
export function useCapabilitiesAll(): Record<string, Capabilities | undefined> {
  const apis = useApis();
  return useQueries({
    queries: apis.map(({ connection, client }) => ({
      queryKey: qk.server(connection.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => client.serverInfo(signal),
      staleTime: SERVER_STALE_MS,
      gcTime: Infinity,
    })),
    combine: (results) =>
      Object.fromEntries(results.map((r, i) => [apis[i].connection.id, r.data?.capabilities])),
  });
}

/** Whether any server has a capability: true as soon as one does, false once every one
 * is known to lack it, undefined while that is still open. */
export function anyCapability(
  caps: Record<string, Capabilities | undefined>,
  flag: keyof Capabilities,
): boolean | undefined {
  const values = Object.values(caps);
  if (values.some((c) => c?.[flag])) return true;
  return values.length > 0 && values.every((c) => c !== undefined) ? false : undefined;
}

type BrowseKind = 'authors' | 'narrators' | 'series';

export type PeopleSources = {
  authors: SourcedList<PeopleList['people'][number]>[];
  narrators: SourcedList<PeopleList['people'][number]>[];
  series: SourcedList<SeriesCount>[];
  /** Whether any server can list people and series (`browse_people`). */
  supported: boolean | undefined;
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
};

/**
 * The authors, narrators and series lists of every library on every server with
 * `browse_people`, for matching on the device. `enabled` false keeps whatever is cached
 * and fetches nothing (the palette before anything is typed).
 */
export function usePeopleSources(enabled: boolean): PeopleSources {
  const apis = useApis();
  const caps = useCapabilitiesAll();
  const { libraries, isLoading: librariesLoading } = useLibrariesAll();
  const slots = useMemo(() => {
    const out: { kind: BrowseKind; source: ListSource }[] = [];
    for (const lib of libraries) {
      const source = {
        connectionId: lib.connectionId,
        connectionName: lib.connectionName,
        libraryId: lib.id,
      };
      for (const kind of ['authors', 'narrators', 'series'] as const) out.push({ kind, source });
    }
    return out;
  }, [libraries]);

  return useQueries({
    queries: slots.map(({ kind, source }) => {
      const client = apis.find((a) => a.connection.id === source.connectionId)?.client;
      const on = caps[source.connectionId]?.browse_people === true && !!client;
      const { connectionId: cid, libraryId: lib } = source;
      return {
        queryKey:
          kind === 'authors'
            ? qk.authors(cid, lib)
            : kind === 'narrators'
              ? qk.narrators(cid, lib)
              : qk.seriesList(cid, lib),
        queryFn:
          on && client
            ? ({ signal }: { signal: AbortSignal }) =>
                kind === 'authors'
                  ? client.authors(lib, signal)
                  : kind === 'narrators'
                    ? client.narrators(lib, signal)
                    : client.seriesList(lib, signal)
            : skipToken,
        enabled,
        staleTime: BROWSE_STALE_MS,
      };
    }),
    combine: (results): PeopleSources => {
      const authors: PeopleSources['authors'] = [];
      const narrators: PeopleSources['narrators'] = [];
      const series: PeopleSources['series'] = [];
      results.forEach((r, i) => {
        const { kind, source } = slots[i];
        if (!r.data) return;
        if (kind === 'series') series.push({ source, items: r.data as SeriesCount[] });
        else
          (kind === 'authors' ? authors : narrators).push({
            source,
            items: (r.data as PeopleList).people,
          });
      });
      const failed = results.filter((r) => r.isError);
      return {
        authors,
        narrators,
        series,
        supported: anyCapability(caps, 'browse_people'),
        isLoading: (enabled && librariesLoading) || results.some((r) => r.isLoading),
        isError: failed.length > 0,
        retry: () => failed.forEach((r) => void r.refetch()),
      };
    },
  });
}

export type CharacterSources = {
  books: CharacterBook[];
  /** Whether any server serves community metadata (`metadata`). */
  supported: boolean | undefined;
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
};

/**
 * The community characters of the listener's started books (`characterBooksToLoad`:
 * in progress and finished, newest first, capped), each with where the listener is in
 * that book (`listeningIn`: the saved place, the live one for the loaded book, over the
 * book's own chapters, which are only fetched for unfinished books that have
 * characters). `enabled` false fetches nothing. `refetchProgress` false reads the saved
 * places as cached (the palette: opening it must not refetch every server's progress).
 */
export function useCharacterSources(
  enabled: boolean,
  { refetchProgress = true }: { refetchProgress?: boolean } = {},
): CharacterSources {
  const apis = useApis();
  const caps = useCapabilitiesAll();
  const { progress, isLoading: progressLoading } = useAllProgressAll({
    enabled,
    refetchOnMount: refetchProgress,
  });
  const picks = useMemo(
    () => characterBooksToLoad(progress, (cid) => caps[cid]?.metadata === true),
    [progress, caps],
  );
  const clientOf = (cid: string) => apis.find((a) => a.connection.id === cid)?.client;

  const metas = useQueries({
    queries: picks.map((p) => {
      const client = clientOf(p.connectionId);
      return {
        queryKey: qk.bookMeta(p.connectionId, p.library_id, p.path),
        queryFn: client
          ? ({ signal }: { signal: AbortSignal }) => client.bookMeta(p.library_id, p.path, signal)
          : skipToken,
        enabled,
        staleTime: META_STALE_MS,
        // As `useBookMeta`: a down meta service answers 502; don't spin on it.
        retry: false,
      };
    }),
  });
  const withCharacters = (meta: BookMeta | undefined) =>
    !!meta?.matched && (meta.work.characters?.length ?? 0) > 0;

  const chapters = useQueries({
    queries: picks.map((p, i) => {
      const client = clientOf(p.connectionId);
      return {
        queryKey: qk.chapters(p.connectionId, p.library_id, p.path),
        queryFn: client
          ? ({ signal }: { signal: AbortSignal }) => client.chapters(p.library_id, p.path, signal)
          : skipToken,
        enabled: enabled && !p.finished && withCharacters(metas[i]?.data),
      };
    }),
  });

  // The loaded book's live place, bucketed; '' when nothing is loaded.
  const live = usePlayer((s) =>
    s.nowPlaying
      ? `${s.nowPlaying.connectionId}\n${s.nowPlaying.libraryId}\n${s.nowPlaying.path}\n${
          Math.floor(selectBookPosition(s) / LIVE_POSITION_BUCKET_S) * LIVE_POSITION_BUCKET_S
        }`
      : '',
  );

  // Rebuilt each render: at most `MAX_CHARACTER_BOOKS` books, and `useQueries` hands
  // back new result arrays every render anyway.
  const [liveCid, liveLib, livePath, livePos] = live.split('\n');
  const books: CharacterBook[] = [];
  // Still settling: a book's metadata, or the chapters of an unfinished book with
  // characters (its gate is "from the start" until they arrive).
  let pending = enabled && progressLoading;
  picks.forEach((p, i) => {
    const meta = metas[i];
    if (!meta.data) {
      if (enabled && !meta.isError) pending = true;
      return;
    }
    if (!meta.data.matched || !withCharacters(meta.data)) return;
    const ch = chapters[i];
    if (!p.finished && !ch.data && !ch.isError) pending = true;
    const loaded =
      live !== '' &&
      liveCid === p.connectionId &&
      Number(liveLib) === p.library_id &&
      livePath === p.path;
    books.push({
      connectionId: p.connectionId,
      libraryId: p.library_id,
      path: p.path,
      title: meta.data.work.title,
      listening: listeningIn({
        progress: p,
        chapters: ch.data,
        livePosition: loaded ? Number(livePos) : undefined,
      }),
      characters: meta.data.work.characters ?? [],
      attribution: meta.data.work.attribution,
    });
  });

  const failed = metas.filter((m) => m.isError);
  return {
    books,
    supported: anyCapability(caps, 'metadata'),
    isLoading: pending,
    isError: failed.length > 0,
    retry: () => failed.forEach((m) => void m.refetch()),
  };
}
