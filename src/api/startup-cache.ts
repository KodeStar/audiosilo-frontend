import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';

import { isRecord, STARTUP_CACHE_KEY } from '@/lib/storage-keys';
import { APP_VERSION } from '@/lib/version';

/**
 * Web: the answers the first screens paint from (Home, the Library grid, the shell), kept
 * from the last visit so the next one paints at once and asks again behind it (a "stale
 * while revalidate" start). Without it a reload waits for `/server`, the libraries and the
 * first page of books before a single cover is drawn.
 *
 * Restored synchronously into the query cache before any screen mounts (`restore`), every
 * entry marked invalidated and asked again by its first observer (whatever its
 * `refetchOnMount`), so the answer replaces the kept one a moment later. A kept answer
 * whose server now refuses the token goes (`dropOnError`). Saved (`save`) a while after
 * one of these queries succeeds and when the page is hidden, only for the connections
 * signed in (`keep`). Only the queries `isStartupQuery` names are kept, and of the
 * whole-library list only its first page, each while the document stays under
 * `MAX_CHARS` (about 100 KB for a 1,000-book library). Every key carries its connection
 * id, so a kept entry of another connection or a signed-out one is never read (and the
 * query cache drops it unread). A sign-out drops the connection's entries (`forget`); a
 * storage reset wipes the document (`SCOPED_STORAGE_KEYS`), and a document of another
 * app version is ignored (the answers' shapes may have changed).
 *
 * Native keeps none of it: its query cache lives as long as the app, a cold start is not
 * the browser's reload, and AsyncStorage can't be read before the first render.
 */

/** The document's shape version: a document of another is ignored (and replaced). */
const VERSION = 1;
/** The most (characters of JSON) the document holds: localStorage is one small quota per
 * origin (about 5 MB, counted in UTF-16 by some browsers) that the session, the progress
 * queue and the downloads registry share, and their writes fail quietly once it is full. */
const MAX_CHARS = 500_000;

type Entry = { key: unknown[]; data: unknown; updatedAt: number; firstPage?: true };
type Doc = { v: number; app: string; entries: Entry[] };

/** Whether this runtime keeps a startup cache (a browser with localStorage). */
function storage(): Storage | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null; // storage blocked (a privacy setting)
  }
}

/** The single-key queries kept (their first key element), and the narrower ones below. */
const KEPT = new Set([
  'server',
  'libraries',
  'favourites',
  'queue',
  'collections',
  'listeningGoal',
  'household',
  'authors',
  'narrators',
  'seriesList',
]);

/** The whole-library list's query: the library in the server's order, nothing narrowed
 * (`useWholeLibrary`; the one the Library grid paints from). */
function isWholeLibrary(key: readonly unknown[]): boolean {
  const q = key[3];
  return (
    key[0] === 'libraryBooks' && isRecord(q) && Object.keys(q).length === 1 && q.sort === 'recent'
  );
}

/** Whether a query (by key) is one the startup cache keeps. */
export function isStartupQuery(key: readonly unknown[]): boolean {
  const head = key[0];
  if (typeof head !== 'string') return false;
  if (KEPT.has(head)) return true;
  if (head === 'books') return key[1] === 'recent'; // Home's Recently added
  if (head === 'progress') return key[1] === 'all'; // Continue listening
  // Home's ranges only (the Now card, This week), not every year Your year probes.
  if (head === 'myStats') return key[2] === '30d';
  if (head === 'myListening') return key[2] === '1y';
  return isWholeLibrary(key);
}

function isInfinite(data: unknown): data is InfiniteData<unknown, unknown> {
  return isRecord(data) && Array.isArray(data.pages) && Array.isArray(data.pageParams);
}

/** The kept entries of `client`'s cache: each startup query's last answer (of an infinite
 * one only the first page, the one a reload starts from), of the queries `keep` takes. */
export function snapshot(
  client: QueryClient,
  keep: (key: readonly unknown[]) => boolean = () => true,
): Entry[] {
  const out: Entry[] = [];
  for (const q of client.getQueryCache().getAll()) {
    // The last answer, also when the latest ask failed (a server down for a moment).
    if (q.state.data === undefined) continue;
    if (!isStartupQuery(q.queryKey) || !keep(q.queryKey)) continue;
    const { data, dataUpdatedAt: updatedAt } = q.state;
    const key = [...q.queryKey];
    if (!isInfinite(data)) out.push({ key, data, updatedAt });
    else if (data.pages.length > 0)
      out.push({ key, data: data.pages[0], updatedAt, firstPage: true });
  }
  return out;
}

/** Write `entries` as the document (best-effort): each while the document stays under
 * `MAX_CHARS` (in the cache's order, so one big list never costs the shell its answers),
 * and on a failed write (quota) the old document goes rather than stay stale. */
function write(store: Storage, entries: Entry[]): void {
  try {
    const parts: string[] = [];
    let size = 0;
    for (const e of entries) {
      const json = JSON.stringify(e);
      if (size + json.length > MAX_CHARS) continue;
      parts.push(json);
      size += json.length + 1;
    }
    const head = JSON.stringify({ v: VERSION, app: APP_VERSION } satisfies Omit<Doc, 'entries'>);
    store.setItem(STARTUP_CACHE_KEY, `${head.slice(0, -1)},"entries":[${parts.join(',')}]}`);
  } catch {
    try {
      store.removeItem(STARTUP_CACHE_KEY);
    } catch {
      // storage blocked: the next visit just starts without it
    }
  }
}

/** Write the startup cache from `client`'s cache now (the queries `keep` takes). */
export function save(client: QueryClient, keep?: (key: readonly unknown[]) => boolean): void {
  const store = storage();
  if (store) write(store, snapshot(client, keep));
}

/** The kept entries, or none when there is no document, it can't be read or another
 * version of the app wrote it. */
function readEntries(store: Storage): Entry[] {
  try {
    const doc: unknown = JSON.parse(store.getItem(STARTUP_CACHE_KEY) ?? 'null');
    if (!isRecord(doc) || doc.v !== VERSION || doc.app !== APP_VERSION) return [];
    if (!Array.isArray(doc.entries)) return [];
    return doc.entries.filter(
      (e): e is Entry =>
        isRecord(e) &&
        Array.isArray(e.key) &&
        isStartupQuery(e.key) &&
        e.data !== undefined &&
        typeof e.updatedAt === 'number' &&
        // The whole-library list is the one infinite query kept: only ever its first page.
        (e.firstPage === true) === (e.key[0] === 'libraryBooks'),
    );
  } catch {
    return [];
  }
}

/**
 * Put the kept answers into `client`'s cache, each invalidated (the kept answer shows
 * until the new one lands). A query already in the cache is left alone. Call once, before
 * anything renders.
 *
 * Each is asked again when its first observer arrives, also one that reads the cache as
 * is (`refetchOnMount: false`: a tile's saved progress, Up next), which would otherwise
 * keep last visit's answer as the truth; a disabled one waits (enabling it asks). A kept
 * answer whose ask fails with an error `dropOnError` names (a refused token) is cleared and
 * asked again, so the screen says what the server says rather than show the last visit's.
 */
export function restore(
  client: QueryClient,
  { dropOnError }: { dropOnError?: (error: unknown) => boolean } = {},
): void {
  const store = storage();
  if (!store) return;
  const cache = client.getQueryCache();
  // The restored queries still holding the kept answer, and those not yet asked again.
  const kept = new Set<string>();
  const unasked = new Set<string>();
  for (const e of readEntries(store)) {
    if (cache.find({ queryKey: e.key, exact: true })) continue;
    // An infinite query restarts from its first page (whose param is always `undefined`:
    // JSON can't keep it).
    const data = e.firstPage ? { pages: [e.data], pageParams: [undefined] } : e.data;
    client.setQueryData(e.key, data, { updatedAt: e.updatedAt });
    const query = cache.find({ queryKey: e.key, exact: true });
    if (!query) continue;
    query.invalidate();
    kept.add(query.queryHash);
    unasked.add(query.queryHash);
  }
  if (kept.size === 0) return;
  const settle = (hash: string) => {
    kept.delete(hash);
    unasked.delete(hash);
  };
  const unsubscribe = cache.subscribe((event) => {
    const { query } = event;
    const hash = query.queryHash;
    if (!kept.has(hash)) return;
    if (event.type === 'removed') settle(hash);
    else if (event.type === 'observerAdded' && unasked.has(hash)) {
      // After the observer's own mount fetch (if it makes one), which this then joins.
      queueMicrotask(() => {
        if (!unasked.has(hash) || query.isDisabled()) return;
        unasked.delete(hash);
        void client.refetchQueries(
          { queryKey: query.queryKey, exact: true },
          { cancelRefetch: false },
        );
      });
    } else if (event.type === 'updated' && event.action.type === 'success') settle(hash);
    else if (event.type === 'updated' && event.action.type === 'error') {
      if (!dropOnError?.(event.action.error)) return;
      settle(hash);
      queueMicrotask(() => void client.resetQueries({ queryKey: query.queryKey, exact: true }));
    }
    if (kept.size === 0) unsubscribe();
  });
}

/** Drop a connection's kept answers (it was signed out or removed). */
export function forget(connectionId: string): void {
  const store = storage();
  if (!store) return;
  const entries = readEntries(store);
  const kept = entries.filter((e) => !e.key.includes(connectionId));
  if (kept.length < entries.length) write(store, kept);
}

/** How long after the last startup query's answer the cache is written. */
export const SAVE_DELAY_MS = 2_000;

/**
 * Keep the startup cache current for `client`: written `SAVE_DELAY_MS` after a startup
 * query's answer arrives (debounced) and whenever the page is hidden or left, with the
 * queries `keep` takes (the signed-in connections'). Returns the stop function. A no-op
 * off the web.
 */
export function startSaving(
  client: QueryClient,
  keep?: (key: readonly unknown[]) => boolean,
): () => void {
  if (!storage()) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  // A startup answer arrived since the last write (a tab switch with none writes nothing).
  let dirty = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    save(client, keep);
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (!isStartupQuery(event.query.queryKey)) return;
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  });
  const onHidden = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onHidden);
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onHidden);
  };
}
