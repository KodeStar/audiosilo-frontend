import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { apiErrorKind } from '@/api/client';
import { CapabilityError, qk, useCapability, useReadalong } from '@/api/hooks';
import type { Book } from '@/api/types';
import { readDownloadedReadalong, useDownloadedReadalong } from '@/downloads/store';
import { contentKey } from '@/lib/content-key';

import { readalongReady } from './readalong-gating';
import { hasSpans, type ReaderReadalongMap, readerMapOf } from './readalong-map';

/** Where a book's read-along map is read from: the download's copy (`local`), the server
 * (`server`), or nowhere (null: none to follow). */
export type ReadalongSource = 'local' | 'server' | null;

/**
 * Where to read a book's map (Bridge Phase 3c). The download's copy (`kept`: its
 * `generated_at`) while the server does not say otherwise: offline (the capability
 * unknown), or the server's book naming that same map or none at all (a book seeded from a
 * list row says nothing; an answer without one has the background refresh drop the copy).
 * The server's when `readalongReady` and the book names another map (made again: the
 * refresh fetches it into the download meanwhile). Never for a book that does not read, a
 * server that serves no maps (`false`), or a stale map (invisible to a listener).
 */
export function readalongSource(opts: {
  serves: boolean | undefined;
  book: Pick<Book, 'ebook' | 'readalong'> | undefined;
  readable: boolean;
  kept: string | undefined;
}): ReadalongSource {
  const { serves, book, readable, kept } = opts;
  if (!readable || serves === false || book?.readalong?.state === 'stale') return null;
  if (kept) {
    const named = book?.readalong?.state === 'ready' ? book.readalong.generated_at : undefined;
    if (serves !== true || named === undefined || named === kept) return 'local';
  }
  return readalongReady(serves, book, readable) ? 'server' : null;
}

/** A book's map as a reader host takes it (see `useBookReadalong`). */
export type BookReadalongMap = {
  /** The map's sections and spans for the reader (`readerMapOf`; memoised per map), or
   * null: none to follow (no map, a stale one, one with no sentence, or its read failed). */
  map: ReaderReadalongMap | null;
  /** Still reading it: nothing is shown about read-along yet. */
  pending: boolean;
  /** The read failed for a reason that says nothing about the map (offline, a 5xx, a
   * timeout, a copy on the device that would not read): never "no read-along" (an admin
   * would be offered a job the book does not need). `retry` reads it again. */
  failed: boolean;
  retry: () => void;
};

/**
 * Whether a failed map read is the server's word that there is none to follow (404
 * `no_readalong`, 409 `readalong_stale`, or the flag off), rather than a failure to say.
 */
export function readalongNone(error: unknown): boolean {
  if (error instanceof CapabilityError) return true;
  const kind = apiErrorKind(error);
  return kind === 'no_readalong' || kind === 'readalong_stale';
}

/**
 * A book's read-along map for the reader (Bridge Phase 3c): the download's copy when one is
 * kept (offline too, with the capability unknown), else the server's (`useReadalong`), by
 * `readalongSource`. `readable` is `canRead`'s answer for the book; `enabled: false` asks
 * nothing (a surface not on screen). While another copy of the map shown is on its way (the
 * book's download took it, it was made again), that one stays: a tab or a reader that has a
 * map never loses it in between.
 */
export function useBookReadalong(
  ref: { connectionId: string; libraryId: number; path: string },
  book: Pick<Book, 'ebook' | 'readalong'> | undefined,
  readable: boolean,
  enabled = true,
): BookReadalongMap {
  const { connectionId, libraryId, path } = ref;
  const serves = useCapability('readalong', connectionId);
  const kept = useDownloadedReadalong(connectionId, libraryId, path);
  const wanted = enabled ? readalongSource({ serves, book, readable, kept }) : null;
  const local = useQuery({
    queryKey: qk.readalongLocal(connectionId, libraryId, path, kept ?? ''),
    queryFn: () => readDownloadedReadalong({ connectionId, libraryId, path }),
    enabled: wanted === 'local',
    staleTime: Infinity,
    retry: false,
    // It reads the device, so it runs offline too.
    networkMode: 'always',
  });
  // A copy that could not be read (gone, damaged) gives way to the server's, when it has
  // the map ready.
  const source: ReadalongSource =
    wanted === 'local' && local.isSuccess && local.data === null
      ? readalongReady(serves, book, readable)
        ? 'server'
        : null
      : wanted;
  const generatedAt = book?.readalong?.generated_at ?? '';
  const server = useReadalong(
    libraryId,
    path,
    { enabled: source === 'server', generatedAt },
    connectionId,
  );
  const data = source === 'local' ? local.data : source === 'server' ? server.data : undefined;
  const errored = source === 'local' ? local.isError : source === 'server' && server.isError;
  const failed =
    source === 'local'
      ? local.isError
      : source === 'server' && server.isError && !readalongNone(server.error);
  const refetchLocal = local.refetch;
  const refetchServer = server.refetch;
  const retry = useCallback(() => {
    if (source === 'local') void refetchLocal();
    else if (source === 'server') void refetchServer();
  }, [source, refetchLocal, refetchServer]);
  const map = useMemo(() => (data && hasSpans(data) ? readerMapOf(data) : null), [data]);
  const pending = source !== null && data === undefined && !errored;
  // The map last shown for this book, kept while it has one or another is on its way (set
  // while rendering, React's pattern for state that follows a prop).
  const bookKey = contentKey(connectionId, libraryId, path);
  const [last, setLast] = useState<{ book: string; map: ReaderReadalongMap } | null>(null);
  if (map && (last?.map !== map || last.book !== bookKey)) setLast({ book: bookKey, map });
  else if (!map && !pending && last) setLast(null);
  const held = !map && pending && last?.book === bookKey ? last.map : null;
  return held
    ? { map: held, pending: false, failed: false, retry }
    : { map, pending, failed: !map && failed, retry };
}
