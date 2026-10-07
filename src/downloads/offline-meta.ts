import type { QueryKey } from '@tanstack/react-query';

import type { ApiClient } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { fetchCapabilities, fetchFailFast, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Book, BookMeta, BookMetaWork, ServerInfo } from '@/api/types';
import { metaEnabledFor } from '@/components/library/meta-gating';
import { previousWorks, seriesRails } from '@/components/library/series-rails';
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
 *   `qk.server(cid)`: on a cold start with no network that is never answered, so the
 *   payload keeps the `/server` answer too.
 * Nothing reads the `spoilers=hide` variant today (it is cut at the saved place when it is
 * fetched, so it is not stored); the `include=previous` variant is seeded when the payload
 * was fetched that way.
 */

/** The payload's file name in the book's folder (audio files are numbered, the cover is
 * `cover.jpg`). */
export const OFFLINE_META_FILE = 'meta.json';

/** `useBookMeta`'s `staleTime`: a read here reuses a fresh answer the screens fetched. */
const META_STALE_MS = 60 * 60_000;

/** A server's `/server` answer and when it was read (epoch ms). */
export type ServerSnapshot = { info: ServerInfo; savedAt: number };

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
  /** The server's `/server` answer when this was saved. */
  server?: ServerSnapshot;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isWork = (v: unknown): v is BookMetaWork =>
  isObject(v) && typeof v.id === 'string' && v.id.length > 0;

/** A stored payload, or null when it is not one this version can read (corrupt, foreign
 * or from a future version): the caller then simply goes without (and fetches it again
 * when it can). The envelope's inner fields are trusted like a server answer. */
export function parseOfflineMeta(raw: unknown): OfflineMeta | null {
  if (!isObject(raw) || raw.v !== 1) return null;
  const { savedAt, meta, works, server } = raw;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  if (!isObject(meta) || typeof meta.matched !== 'boolean') return null;
  if (meta.matched && !isWork(meta.work)) return null;
  const envelope = { ...meta } as Record<string, unknown>;
  if (envelope.previous !== undefined) {
    if (Array.isArray(envelope.previous)) envelope.previous = envelope.previous.filter(isWork);
    else delete envelope.previous;
  }
  const snapshot =
    isObject(server) &&
    isObject(server.info) &&
    isObject(server.info.capabilities) &&
    typeof server.savedAt === 'number'
      ? (server as ServerSnapshot)
      : undefined;
  return {
    v: 1,
    savedAt,
    previous: raw.previous === true,
    meta: envelope as BookMeta,
    works: Array.isArray(works) ? works.filter(isWork) : [],
    ...(snapshot ? { server: snapshot } : {}),
  };
}

/**
 * Put `data` in the cache under `key` unless the cache already holds an answer there (a
 * fresh one from the server always wins over a saved copy), dated `updatedAt` so it goes
 * stale on the screens' own schedule, and keep the entry for good. Unwatched, an entry is
 * dropped after `gcTime` (5 minutes), and a book downloaded an hour before the flight
 * would then open offline with nothing. Used for every seed of a downloaded book.
 */
export function seedQuery(key: QueryKey, data: unknown, updatedAt: number): void {
  const query = queryClient.getQueryCache().build(queryClient, { queryKey: key, gcTime: Infinity });
  if (query.state.data === undefined) queryClient.setQueryData(key, data, { updatedAt });
  // An entry that already existed keeps its own options (and its data), only for good.
  query.setOptions({ ...query.options, gcTime: Infinity });
}

/** Seed every key the payload can answer (see the module comment) for one book. The
 * server's answer is seeded separately (`seedServerSnapshot`), once per connection, after
 * every book's metadata, so a screen whose gate it opens finds its data already there. */
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

/** Seed a connection's `/server` answer when the cache has none (a cold start that can't
 * reach the server): without it every metadata surface waits on a flag that never
 * comes. The app then holds the flags it held when it was last online, which is what a
 * session that goes offline holds anyway; the first answer from the server replaces it. */
export function seedServerSnapshot(connectionId: string, snapshot: ServerSnapshot): void {
  seedQuery(qk.server(connectionId), snapshot.info, snapshot.savedAt);
}

/** The newest `/server` answer of each connection among `payloads`. */
export function newestSnapshots(
  payloads: readonly { connectionId: string; payload: OfflineMeta }[],
): Map<string, ServerSnapshot> {
  const newest = new Map<string, ServerSnapshot>();
  for (const { connectionId, payload } of payloads) {
    const s = payload.server;
    if (s && (newest.get(connectionId)?.savedAt ?? -Infinity) < s.savedAt)
      newest.set(connectionId, s);
  }
  return newest;
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

/** Whether a downloaded book can have community metadata at all (an ASIN or ISBN, which
 * the server matches by; `metaEnabledFor`): the readers never ask for one without. The
 * download's book can be the list shape, so the full item is asked first. */
export function canMatch(entry: DownloadEntry): boolean {
  const { connectionId, libraryId, path } = entry;
  const item = queryClient.getQueryData<Book>(qk.item(connectionId, libraryId, path));
  return metaEnabledFor(true, item) || metaEnabledFor(true, entry.manifest.book);
}

/**
 * Read a downloaded book's community metadata from its server, for keeping: nothing (null)
 * when the book can't match (no ASIN or ISBN), its server has no `metadata`, or anything
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
    const key = qk.bookMeta(cid, libraryId, path, opts);
    const meta = await fetchFailFast({
      queryKey: key,
      queryFn: ({ signal }) => client.bookMeta(libraryId, path, signal, opts),
      staleTime: META_STALE_MS,
    });
    const savedAt = queryClient.getQueryState(key)?.dataUpdatedAt || Date.now();
    const works = meta.matched ? await nearestPreviousWork(cid, client, meta) : [];
    const server = queryClient.getQueryState<ServerInfo>(qk.server(cid));
    return {
      v: 1,
      savedAt,
      previous,
      meta,
      works,
      ...(server?.data ? { server: { info: server.data, savedAt: server.dataUpdatedAt } } : {}),
    };
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
    const work = await fetchFailFast({
      queryKey: qk.metaWork(cid, nearest.id),
      queryFn: ({ signal }) => client.metaWork(nearest.id, signal),
      staleTime: META_STALE_MS,
    });
    return [work];
  } catch {
    return [];
  }
}

/** Save a payload beside the book's audio; false when it could not be (or the book's
 * storage is gone). */
export async function writeOfflineMeta(
  entry: DownloadEntry,
  payload: OfflineMeta,
): Promise<boolean> {
  if (!engine.writeText) return false;
  try {
    return await engine.writeText(
      entry.connectionId,
      entry.libraryId,
      entry.path,
      OFFLINE_META_FILE,
      JSON.stringify(payload),
    );
  } catch {
    return false;
  }
}

/** A book's saved payload, or null when there is none or it can't be read. */
export async function readOfflineMeta(entry: DownloadEntry): Promise<OfflineMeta | null> {
  if (!engine.readText) return null;
  try {
    const raw = await engine.readText(
      entry.connectionId,
      entry.libraryId,
      entry.path,
      OFFLINE_META_FILE,
    );
    return raw ? parseOfflineMeta(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Delete a book's saved payload (a download removed while it was being written). */
export async function removeOfflineMeta(entry: DownloadEntry): Promise<void> {
  try {
    await engine.removeFile?.(entry.connectionId, entry.libraryId, entry.path, OFFLINE_META_FILE);
  } catch {
    // best-effort cleanup
  }
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
