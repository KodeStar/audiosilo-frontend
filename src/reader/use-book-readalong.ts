import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { ApiError, apiErrorKind, isSignedOutError } from '@/api/client';
import { CapabilityError, qk, useCapability, useReadalong } from '@/api/hooks';
import type { Book } from '@/api/types';
import { fitsEbook } from '@/downloads/readalong-file';
import {
  readDownloadedReadalong,
  useDownloadedEbookSha,
  useDownloadedEbookSize,
  useDownloadedReadalong,
} from '@/downloads/store';
import { contentKey } from '@/lib/content-key';
import { useDeviceOnline } from '@/lib/device-online';
import { offlineState } from '@/lib/offline-state';

import type { OpenedEbook } from './ebook-identity';
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
  /** The map's EPUB digest, used by the host to withhold it until the file is identified. */
  ebookSha256: string | undefined;
  /** The host's selection session. Companion hosts key themselves by it when a download
   * changes; a full-screen reader keeps the file it already opened. */
  ebookSelectionKey: string;
  /** The host's actual file selection, bound to this book. */
  onEbook: (ebook: OpenedEbook) => void;
  /** The recorded download identity rejected the map before a host selected its file.
   * Mount the host without a map so an unreadable download can fall back to the server. */
  selectingEbook: boolean;
  /** The map's sections and spans for the reader (`readerMapOf`; memoised per map), or
   * null: none to follow (no map, a stale one, one with no sentence, or its read failed). */
  map: ReaderReadalongMap | null;
  /** Still reading it: nothing is shown about read-along yet. */
  pending: boolean;
  /** Why there is no map when its read failed (see {@link ReadalongFailure}), else null:
   * never "no read-along" (an admin would be offered a job the book does not need). */
  failure: ReadalongFailure | null;
  /** The server's map waits for the connection, or failed for want of one (offline,
   * nothing on the device): nothing can be said about it yet, so a surface shows nothing
   * (no spinner, no Make, no "couldn't load"). */
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
 * map never loses it in between. Download metadata checks the fit before the host selects
 * its file; `onEbook` then supplies the actual bytes' identity, including a server fallback
 * after an unreadable download. Neither local nor server maps may describe another EPUB.
 */
export function useBookReadalong(
  ref: { connectionId: string; libraryId: number; path: string },
  book: Pick<Book, 'ebook' | 'readalong'> | undefined,
  readable: boolean,
  enabled = true,
  options: { reselectOnDownloadChange?: boolean } = {},
): BookReadalongMap {
  const { connectionId, libraryId, path } = ref;
  const bookKey = contentKey(connectionId, libraryId, path);
  const serves = useCapability('readalong', connectionId);
  const deviceOnline = useDeviceOnline();
  const kept = useDownloadedReadalong(connectionId, libraryId, path);
  const savedSha = useDownloadedEbookSha(connectionId, libraryId, path);
  const savedEbookSize = useDownloadedEbookSize(connectionId, libraryId, path);
  const ebookSelectionKey = options.reselectOnDownloadChange
    ? JSON.stringify([bookKey, kept, savedSha, savedEbookSize])
    : bookKey;
  const [opened, setOpened] = useState<(OpenedEbook & { book: string }) | null>(null);
  const actual = opened?.book === ebookSelectionKey ? opened : null;
  const onEbook = useCallback(
    (ebook: OpenedEbook) => setOpened({ ...ebook, book: ebookSelectionKey }),
    [ebookSelectionKey],
  );
  const ebookSha = actual?.sha256 ?? savedSha;
  const wanted = enabled
    ? readalongSource({
        serves,
        book,
        readable,
        kept:
          actual?.source === 'server' && readalongReady(serves, book, readable) ? undefined : kept,
      })
    : null;
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
  // The selected EPUB's digest takes precedence over the download record. Before selection,
  // use the recorded digest, else a changed server size (`refreshReadalong`, fe#193).
  const serverSize = book?.ebook?.size;
  const foreign =
    server.data !== undefined &&
    (ebookSha
      ? !fitsEbook(server.data, ebookSha)
      : savedEbookSize !== undefined && serverSize !== undefined && serverSize !== savedEbookSize);
  const local = useQuery({
    queryKey: qk.readalongLocal(connectionId, libraryId, path, kept ?? ''),
    queryFn: () => readDownloadedReadalong({ connectionId, libraryId, path }),
    enabled: wanted === 'local' || (wanted === 'server' && foreign && !!kept),
    staleTime: Infinity,
    retry: false,
    // It reads the device, so it runs offline too.
    networkMode: 'always',
    meta: { local: true },
  });
  // A copy that could not be read or does not fit the selected EPUB gives way to the
  // server's, when it has the map ready; else a copy that is gone is none, one whose read
  // threw a failure to say (`retry`).
  const copyForeign = !!actual && !!local.data && !fitsEbook(local.data, actual.sha256);
  const copyUnread = local.isError || (local.isSuccess && local.data === null) || copyForeign;
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
  // A foreign server map gives way to a matching local map, else `ebookChanged`.
  const ebookChanged =
    (source === 'server' && foreign && (!kept || copyUnread)) ||
    (copyForeign && unread && !wantFallback);
  if (source === 'server' && foreign) source = ebookChanged ? null : 'local';
  const read = source === 'local' ? local : source === 'server' ? server : null;
  const data = ebookChanged ? undefined : read?.data;
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
  // The server's map with no network on the device and no copy here (`offlineState`): held
  // back for the connection (TanStack's `paused`), or its read failed for want of one (a
  // reload offline, where the request went out before anything knew). Not a failure with
  // a Try again that cannot work: nothing can be said about the map yet.
  const offline =
    source === 'server' &&
    data === undefined &&
    offlineState({
      waiting: server.fetchStatus === 'paused',
      failed: failure === 'retry',
      deviceOnline,
    }) === 'offline';
  const pending = source !== null && data === undefined && !errored && !offline;
  // The map last shown for this book, kept while it has one or another is on its way, or
  // waits for the connection (set while rendering, React's pattern for state that follows a
  // prop).
  const waiting = pending || offline;
  const [last, setLast] = useState<{
    book: string;
    map: ReaderReadalongMap;
    sha256: string | undefined;
  } | null>(null);
  if (map && (last?.map !== map || last.book !== bookKey))
    setLast({ book: bookKey, map, sha256: data?.ebook.sha256 });
  else if (!map && !waiting && last) setLast(null);
  const held =
    !map && waiting && last?.book === bookKey && (!actual || last.sha256 === actual.sha256)
      ? last
      : null;
  return {
    map: held?.map ?? map,
    ebookSha256: held?.sha256 ?? data?.ebook.sha256,
    ebookSelectionKey,
    onEbook,
    selectingEbook: actual === null && ebookChanged,
    pending: !held && pending,
    failure: map || offline ? null : failure,
    offline: !map && !held && offline,
    retry,
  };
}
