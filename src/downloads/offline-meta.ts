import type { QueryKey } from '@tanstack/react-query';

import type { ApiClient } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { bookMetaQuery, fetchCapabilities, fetchFailFast, metaWorkQuery, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { parseServerSnapshot, type ServerSnapshot } from '@/api/server-snapshots';
import type { Book, BookMeta, BookMetaWork } from '@/api/types';
import { metaEnabledFor } from '@/components/library/meta-gating';
import { previousWorks, seriesRails } from '@/components/library/series-rails';
import { isRecord } from '@/lib/storage-keys';
import { useSeriesOrderings } from '@/stores/series-orderings';
import { useSession } from '@/stores/session';

import { engine } from './engine';
import type { DownloadEntry } from './types';

/**
 * The offline companion: a downloaded book keeps its community metadata (the `/meta`
 * envelope, the previous book's work, and the server's `/server` answer) so the book page
 * and the player's companion read exactly what they would online, with no network. The
 * spoiler gate is unchanged: it still runs on the device against the listener's place
 * (`meta-gating.ts`); nothing here decides what to show.
 *
 * Where it lives: in its own file beside the book's audio (`OFFLINE_META_FILE`, through
 * `engine.writeText`: a file in the book's folder on native, a Cache API entry under the
 * book's prefix on web), never in the downloads registry. The registry is ONE JSON
 * document, saved every couple of seconds while a download runs (and on every status
 * change), and an envelope with its characters and recaps can be hundreds of KB: inside
 * it, every one of those saves would rewrite all of it, and AsyncStorage on Android and
 * localStorage on web cap the whole store at a few MB. Beside the audio it is scoped by
 * connection like the files (the folder/prefix leads with the connection id), deleted with
 * them (`removeBook`, the connection purge, `clearAll` on a storage reset) and survives a
 * relaunch like them. The registry carries only a marker (`DownloadManifest.meta`).
 *
 * Who reads it (every reader of community metadata, and the key each one uses):
 * - the book page (`book/[libraryId].tsx`), `useBookCommunity` (the companion's
 *   `useCompanionData`, `RevealListener`, Home's Previously on), Home's now card, the end
 *   credits, the series page's anchor book and Search's character sources: all
 *   `qk.bookMeta(cid, lib, path)`, the plain request (no `include`/`spoilers` option);
 * - the "catch up on previous books" rows (`book-meta.tsx`) and the work series page:
 *   `qk.metaWork(cid, workId)`;
 * - every one of them first waits on the server's `metadata` flag, read from
 *   `qk.server(cid)`: on a cold start with no network that is never answered, so every
 *   connection's last `/server` answer is kept and seeded at launch
 *   (`src/api/server-snapshots.ts`), not in every book's file.
 * Nothing reads the `spoilers=hide` variant today (it is cut at the saved place when it is
 * fetched, so it is not stored); the `include=previous` variant is seeded when the payload
 * was fetched that way.
 */

/** The payload's file name in the book's folder (audio files are numbered, the cover is
 * `cover.jpg`). */
export const OFFLINE_META_FILE = 'meta.json';

/** What a download keeps of its community metadata (version 1 of the file). */
export type OfflineMeta = {
  v: 1;
  /** When `meta` was read from the server (epoch ms). The seeds carry it as their update
   * time, so an online screen still refetches them once they are stale. */
  savedAt: number;
  /** `meta` was asked for with `include=previous` (`meta_bundle`): it then also answers
   * that variant's key, and its `previous` works seed `qk.metaWork`. */
  previous: boolean;
  /** The envelope as the server sent it (a `matched: false` answer is kept too, so an
   * unmatched book reads as such offline rather than waiting on a request). */
  meta: BookMeta;
  /** Works read one by one (`/meta/work`): the nearest earlier book in the reading order
   * the listener picked, when the envelope's own `previous` doesn't hold it (a server
   * without `meta_bundle`, or a pick other than the main order). */
  works: BookMetaWork[];
  /** The server's `/server` answer, in a file written before it had its own key
   * (`src/api/server-snapshots.ts`); read only to carry it over. */
  server?: ServerSnapshot;
};

const isWork = (v: unknown): v is BookMetaWork =>
  isRecord(v) && typeof v.id === 'string' && v.id.length > 0;

/** A stored payload, or null when it is not one this version can read (corrupt, foreign
 * or from a future version): the caller then simply goes without (and fetches it again
 * when it can). The envelope's inner fields are trusted like a server answer. */
export function parseOfflineMeta(raw: unknown): OfflineMeta | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  const { savedAt, meta, works, server } = raw;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  if (!isRecord(meta) || typeof meta.matched !== 'boolean') return null;
  if (meta.matched && !isWork(meta.work)) return null;
  const envelope = { ...meta } as Record<string, unknown>;
  if (envelope.previous !== undefined) {
    if (Array.isArray(envelope.previous)) envelope.previous = envelope.previous.filter(isWork);
    else delete envelope.previous;
  }
  const snapshot = parseServerSnapshot(server);
  return {
    v: 1,
    savedAt,
    previous: raw.previous === true,
    meta: envelope as BookMeta,
    works: Array.isArray(works) ? works.filter(isWork) : [],
    ...(snapshot ? { server: snapshot } : {}),
  };
}

/** Keep a downloaded book's cache entry for good (`gcTime: Infinity` for the key, from
 * its next build or fetch on). Unwatched, an entry is dropped after `gcTime` (5 minutes),
 * and a book downloaded an hour before the flight would then open offline with nothing. */
function keepForGood(key: QueryKey): void {
  queryClient.setQueryDefaults(key, { gcTime: Infinity });
}

/**
 * A removed download's book entries (its item, chapters and `/meta`, every variant: a
 * default reaches every key it prefixes) go back to the default `gcTime` from their next
 * build, so the session no longer keeps them for good. TanStack can't drop a registered
 * default, only replace it, so this is an empty one. Its previous works stay kept: another
 * downloaded book of the series can share them.
 */
export function releaseOfflineBook(connectionId: string, libraryId: number, path: string): void {
  for (const key of [
    qk.item(connectionId, libraryId, path),
    qk.chapters(connectionId, libraryId, path),
    qk.bookMeta(connectionId, libraryId, path),
    qk.bookMeta(connectionId, libraryId, path, { includePrevious: true }),
  ]) {
    queryClient.setQueryDefaults(key, {});
  }
}

/**
 * Put `data` in the cache under `key` unless the cache already holds an answer there (a
 * fresh one from the server always wins over a saved copy), dated `updatedAt` so it goes
 * stale on the screens' own schedule, and keep the entry for good (`keepForGood`). Used
 * for every seed of a downloaded book.
 */
export function seedQuery(key: QueryKey, data: unknown, updatedAt: number): void {
  keepForGood(key);
  if (queryClient.getQueryData(key) === undefined) {
    queryClient.setQueryData(key, data, { updatedAt });
  }
}

/** Seed every key the payload can answer (see the module comment) for one book. The
 * server's answer, whose `metadata` flag opens the readers' gate, is seeded for every
 * connection at launch (`restoreServerSnapshots`); a reader that asked meanwhile takes
 * this copy when it lands (`seedQuery` fills a key with no data, a failed or waiting one
 * too). */
export function seedOfflineMeta(
  connectionId: string,
  libraryId: number,
  path: string,
  payload: OfflineMeta,
): void {
  const { meta, savedAt } = payload;
  const plain: BookMeta = meta.matched && meta.previous ? withoutPrevious(meta) : meta;
  seedQuery(qk.bookMeta(connectionId, libraryId, path), plain, savedAt);
  if (payload.previous) {
    seedQuery(qk.bookMeta(connectionId, libraryId, path, { includePrevious: true }), meta, savedAt);
  }
  const works = [...(meta.matched ? (meta.previous ?? []) : []), ...payload.works];
  for (const w of works) seedQuery(qk.metaWork(connectionId, w.id), w, savedAt);
}

/** The plain request's answer from an `include=previous` one (the plain answer has no
 * `previous`). */
function withoutPrevious(meta: Extract<BookMeta, { matched: true }>): BookMeta {
  const { previous: _previous, ...rest } = meta;
  return rest;
}

/** Whether a connection's server has community metadata (its `/server` read the way the
 * framework-free readers read it), false when it can't be read or the connection is gone. */
export async function serverHasMetadata(connectionId: string): Promise<boolean> {
  const client = resolveClient(connectionId);
  if (!client) return false;
  try {
    return !!(await fetchCapabilities(connectionId, client)).metadata;
  } catch {
    return false;
  }
}

/** Whether a downloaded book can have metadata at all (`metaEnabledFor`, the rule the
 * readers ask by: an ASIN or ISBN, which the server matches by, or content generated on
 * its server): the readers never ask for one without. The download's book
 * can be the list shape, so the full item is asked first. */
export function canMatch(entry: DownloadEntry): boolean {
  const { connectionId, libraryId, path } = entry;
  const item = queryClient.getQueryData<Book>(qk.item(connectionId, libraryId, path));
  return metaEnabledFor(true, item) || metaEnabledFor(true, entry.manifest.book);
}

/**
 * Read a downloaded book's community metadata from its server, for keeping: nothing (null)
 * when the book can't have any (`canMatch`), its server has no `metadata`, or anything
 * fails. With `meta_bundle` one request brings the previous works too (`include=previous`);
 * the nearest earlier book by the listener's reading order is read on its own when that
 * didn't bring it. Never throws, never retries; a fresh answer the screens already hold
 * is reused without a request.
 */
export async function captureOfflineMeta(entry: DownloadEntry): Promise<OfflineMeta | null> {
  const { connectionId: cid, libraryId, path } = entry;
  if (!canMatch(entry)) return null;
  const client = resolveClient(cid);
  if (!client) return null;
  try {
    const caps = await fetchCapabilities(cid, client);
    if (!caps.metadata) return null;
    const previous = !!caps.meta_bundle;
    const opts = previous ? { includePrevious: true } : undefined;
    // The screens' own read (`bookMetaQuery`: a fresh answer they hold is reused), kept
    // for good from here on, so its answer outlives the cache's own timer.
    const query = bookMetaQuery(cid, client, libraryId, path, opts);
    keepForGood(query.queryKey);
    const meta = await fetchFailFast(query);
    const savedAt = queryClient.getQueryState(query.queryKey)?.dataUpdatedAt || Date.now();
    const works = meta.matched ? await nearestPreviousWork(cid, client, meta) : [];
    return { v: 1, savedAt, previous, meta, works };
  } catch {
    return null;
  }
}

/** The nearest earlier work in the reading order the listener picked (`previousWorks`,
 * the rule the book page's rows follow), read on its own unless the envelope already
 * carries it. A failure is just nothing: the row then says it couldn't load, as online. */
async function nearestPreviousWork(
  cid: string,
  client: ApiClient,
  meta: Extract<BookMeta, { matched: true }>,
): Promise<BookMetaWork[]> {
  try {
    const picks = useSeriesOrderings.getState().picks;
    const nearest = previousWorks(seriesRails(meta.series, meta.work.id, picks))[0];
    if (!nearest || meta.previous?.some((w) => w.id === nearest.id)) return [];
    const query = metaWorkQuery(cid, client, nearest.id);
    keepForGood(query.queryKey);
    return [await fetchFailFast(query)];
  } catch {
    return [];
  }
}

/** Save a payload beside the book's audio (never throws, as the engine's file methods
 * don't); false when it could not be (or the book's storage is gone). */
export async function writeOfflineMeta(
  entry: DownloadEntry,
  payload: OfflineMeta,
): Promise<boolean> {
  return (
    (await engine.writeText?.(
      entry.connectionId,
      entry.libraryId,
      entry.path,
      OFFLINE_META_FILE,
      JSON.stringify(payload),
    )) ?? false
  );
}

/** A book's saved payload, or null when there is none or it can't be read. */
export async function readOfflineMeta(entry: DownloadEntry): Promise<OfflineMeta | null> {
  const raw = await engine.readText?.(
    entry.connectionId,
    entry.libraryId,
    entry.path,
    OFFLINE_META_FILE,
  );
  if (!raw) return null;
  try {
    return parseOfflineMeta(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Delete a book's saved payload (a download removed while it was being written). */
export async function removeOfflineMeta(entry: DownloadEntry): Promise<void> {
  await engine.removeFile?.(entry.connectionId, entry.libraryId, entry.path, OFFLINE_META_FILE);
}

/** Resolves once the session store has hydrated (so `resolveClient` sees the real
 * connection list): the downloads hydrate runs beside the session's at launch. */
export function whenSessionReady(): Promise<void> {
  if (sessionReady()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useSession.subscribe(() => {
      if (!sessionReady()) return;
      unsubscribe();
      resolve();
    });
  });
}
