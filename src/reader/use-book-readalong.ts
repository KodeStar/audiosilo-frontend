import {
  hashKey,
  type QueryClient,
  QueryObserver,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, apiErrorKind, isSignedOutError } from '@/api/client';
import { CapabilityError, qk, useCapability, useReadalong } from '@/api/hooks';
import type { Book, ReadalongMap } from '@/api/types';
import { fitsDownload, fitsEbook } from '@/downloads/readalong-file';
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
 * unknown), or the server's book naming that same map, a stale one or none at all (a book
 * seeded from a list row says nothing; an answer without one has the background refresh drop
 * the copy). A stale server map (its ebook or audio changed there) leaves the copy shown
 * (fe#202 D4): it was made for the download's own EPUB, which is what this device reads, and
 * the hook still checks it against the EPUB actually opened; the background refresh takes a
 * map made again. The server's when `readalongReady` and the book names another map (made
 * again: the refresh fetches it into the download meanwhile). Never for a book that does
 * not read, a server that serves no maps (`false`), or a stale map with no copy (invisible
 * to a listener).
 */
export function readalongSource(opts: {
  serves: boolean | undefined;
  book: Pick<Book, 'ebook' | 'readalong'> | undefined;
  readable: boolean;
  kept: string | undefined;
}): ReadalongSource {
  const { serves, book, readable, kept } = opts;
  if (!readable || serves === false) return null;
  if (kept) {
    // Undefined for a stale map too: the copy stands.
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
  // A copy follows the download's EPUB only: not once the server's EPUB was opened instead
  // (an unreadable download), where the server's ready map is read, and a stale one is none.
  const serverEpub =
    actual?.source === 'server' &&
    (readalongReady(serves, book, readable) || book?.readalong?.state === 'stale');
  const wanted = enabled
    ? readalongSource({ serves, book, readable, kept: serverEpub ? undefined : kept })
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
  // use the recorded digest, else a changed server size: the download refresh's own rule
  // (`fitsDownload`, fe#193).
  const foreign =
    server.data !== undefined &&
    !fitsDownload(
      { sha256: ebookSha, size: savedEbookSize },
      { size: book?.ebook?.size, map: server.data },
    );
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
  const map = useMemo(() => (data && hasSpans(data) ? readerMapOfOnce(data) : null), [data]);
  // The map read last stays in the cache while no surface shows it (`pinMap`): the phone's
  // Text chip asks on every full-player open, and a map runs to 16 MiB.
  const client = useQueryClient();
  const readHash =
    data === undefined
      ? null
      : hashKey(
          source === 'local'
            ? qk.readalongLocal(connectionId, libraryId, path, kept ?? '')
            : qk.readalong(connectionId, libraryId, path, generatedAt),
        );
  useEffect(() => {
    if (readHash) pinMap(client, readHash);
  }, [client, readHash]);
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

/** The reader's form of each map read (`readerMapOf`), per map object: the cache hands the
 * same object to every surface that shows it, so a reopened player does not walk a map of
 * up to 16 MiB again. */
const readerMaps = new WeakMap<object, ReaderReadalongMap>();

function readerMapOfOnce(data: Pick<ReadalongMap, 'sections'>): ReaderReadalongMap {
  let map = readerMaps.get(data);
  if (!map) {
    map = readerMapOf(data);
    readerMaps.set(data, map);
  }
  return map;
}

/** The query each client holds (`pinMap`), by its hash. */
const pins = new WeakMap<QueryClient, { hash: string; release: () => void }>();

/**
 * Hold the map query with the hash `hash` in the cache with no surface showing it (an
 * observer that never fetches), so the book's map is read once, not on every open of a
 * surface (the phone Text chip mounts with each full-player open, after the default cache
 * time a fresh read). One map at a time per client: pinning another book's (or a map made
 * again) releases the last one, which then leaves the cache as any unwatched query does.
 */
function pinMap(client: QueryClient, hash: string): void {
  const pin = pins.get(client);
  if (pin?.hash === hash) return;
  const query = client.getQueryCache().get(hash);
  if (!query) return;
  pin?.release();
  // The query's own options (its function, `meta`...), so the pin changes nothing of it.
  const observer = new QueryObserver(client, {
    ...query.options,
    queryKey: query.queryKey,
    enabled: false,
  });
  pins.set(client, { hash, release: observer.subscribe(() => {}) });
}
