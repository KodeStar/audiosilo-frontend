import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { ApiError, apiErrorKind, isSignedOutError } from '@/api/client';
import { CapabilityError, qk, useCapability, useReadalong } from '@/api/hooks';
import type { Book } from '@/api/types';
import { fitsEbook } from '@/downloads/readalong-file';
import {
  readDownloadedReadalong,
  useDownloadedEbookSha,
  useDownloadedReadalong,
} from '@/downloads/store';
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

/** Why a book's map shows nothing though there may be one (`useBookReadalong`):
 * - `retry`: the read failed for a reason that says nothing about the map (offline, a 5xx,
 *   a timeout, a copy on the device that would not read): Try again can work;
 * - `signedOut`: the server refused the token (401): signing in again is the way;
 * - `denied`: the book is outside the caller's access (403);
 * - `missing`: no such book on the server (a 404 without the read-along's own code);
 * - `ebookChanged`: the server's map was made from another ebook than the one this
 *   download holds (fe#193): downloading the book again is the way.
 * Only `retry` offers Try again; none offers Make (a needless multi-hour job). */
export type ReadalongFailure = 'retry' | 'signedOut' | 'denied' | 'missing' | 'ebookChanged';

/** A book's map as a reader host takes it (see `useBookReadalong`). */
export type BookReadalongMap = {
  /** The map's sections and spans for the reader (`readerMapOf`; memoised per map), or
   * null: none to follow (no map, a stale one, one with no sentence, or its read failed). */
  map: ReaderReadalongMap | null;
  /** Still reading it: nothing is shown about read-along yet. */
  pending: boolean;
  /** Why there is no map when its read failed (see {@link ReadalongFailure}), else null:
   * never "no read-along" (an admin would be offered a job the book does not need). */
  failure: ReadalongFailure | null;
  /** The server's map waits for the connection (offline, nothing on the device): nothing
   * can be said about it yet, so a surface shows nothing (no spinner, no Make). */
  offline: boolean;
  /** Read it again (for `retry`). */
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

/** What a failed map read says (see {@link ReadalongFailure}); null for the server's none. */
export function readalongFailure(error: unknown): ReadalongFailure | null {
  if (readalongNone(error)) return null;
  if (isSignedOutError(error)) return 'signedOut';
  if (error instanceof ApiError) {
    if (error.status === 403) return 'denied';
    if (error.status === 404) return 'missing';
  }
  return 'retry';
}

/**
 * A book's read-along map for the reader (Bridge Phase 3c): the download's copy when one is
 * kept (offline too, with the capability unknown), else the server's (`useReadalong`), by
 * `readalongSource`. `readable` is `canRead`'s answer for the book; `enabled: false` asks
 * nothing (a surface not on screen). While another copy of the map shown is on its way (the
 * book's download took it, it was made again), that one stays: a tab or a reader that has a
 * map never loses it in between. A downloaded EPUB is the book its reader shows, so a map
 * of the server's made from another ebook (`ebookSha256` differs) is never used: the copy
 * the download kept stands in, else it is `ebookChanged` (fe#193).
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
  const ebookSha = useDownloadedEbookSha(connectionId, libraryId, path);
  const wanted = enabled ? readalongSource({ serves, book, readable, kept }) : null;
  const generatedAt = book?.readalong?.generated_at ?? '';
  // The server's map: when it is the source, or the copy could not be read (`fallback`,
  // known only once the copy's read below settled: kept as state, set while rendering).
  const [fallback, setFallback] = useState(false);
  const server = useReadalong(
    libraryId,
    path,
    { enabled: wanted === 'server' || fallback, generatedAt },
    connectionId,
  );
  // The server's map was made from another ebook than the download's `book.epub`.
  const foreign = !!ebookSha && server.data !== undefined && !fitsEbook(server.data, ebookSha);
  const local = useQuery({
    queryKey: qk.readalongLocal(connectionId, libraryId, path, kept ?? ''),
    queryFn: () => readDownloadedReadalong({ connectionId, libraryId, path }),
    enabled: wanted === 'local' || (wanted === 'server' && foreign && !!kept),
    staleTime: Infinity,
    retry: false,
    // It reads the device, so it runs offline too.
    networkMode: 'always',
  });
  // A copy that could not be read (gone, damaged, a read that threw) gives way to the
  // server's, when it has the map ready; else a copy that is gone is none, one whose read
  // threw a failure to say (`retry`).
  const copyUnread = local.isError || (local.isSuccess && local.data === null);
  const unread = wanted === 'local' && copyUnread;
  const wantFallback = unread && readalongReady(serves, book, readable);
  if (wantFallback !== fallback) setFallback(wantFallback);
  let source: ReadalongSource = !unread
    ? wanted
    : wantFallback
      ? 'server'
      : local.isError
        ? 'local'
        : null;
  // The server's map of another ebook never reaches this download's reader: the copy the
  // download kept (of its own ebook) instead, else nothing (`ebookChanged`).
  const ebookChanged = source === 'server' && foreign && (!kept || copyUnread);
  if (source === 'server' && foreign) source = ebookChanged ? null : 'local';
  const read = source === 'local' ? local : source === 'server' ? server : null;
  const data = read?.data;
  // Not while Try again reads it again: on its way meanwhile (`pending`).
  const errored = read?.isError === true && !read.isFetching;
  // A device copy's read never says "none": it is `retry`.
  const failure: ReadalongFailure | null = ebookChanged
    ? 'ebookChanged'
    : !errored
      ? null
      : source === 'local'
        ? 'retry'
        : readalongFailure(read?.error);
  const refetch = read?.refetch;
  const retry = useCallback(() => void refetch?.(), [refetch]);
  const map = useMemo(() => (data && hasSpans(data) ? readerMapOf(data) : null), [data]);
  // The server's map held back by the connection (TanStack's `paused`), with no copy here.
  const offline = source === 'server' && data === undefined && server.fetchStatus === 'paused';
  const pending = source !== null && data === undefined && !errored && !offline;
  // The map last shown for this book, kept while it has one or another is on its way (set
  // while rendering, React's pattern for state that follows a prop).
  const bookKey = contentKey(connectionId, libraryId, path);
  const [last, setLast] = useState<{ book: string; map: ReaderReadalongMap } | null>(null);
  if (map && (last?.map !== map || last.book !== bookKey)) setLast({ book: bookKey, map });
  else if (!map && !pending && last) setLast(null);
  const held = !map && pending && last?.book === bookKey ? last.map : null;
  return {
    map: held ?? map,
    pending: !held && pending,
    failure: map ? null : failure,
    offline: !map && offline,
    retry,
  };
}
