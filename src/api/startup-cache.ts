import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';

import { isRecord, STARTUP_CACHE_KEY } from '@/lib/storage-keys';

/**
 * Web: the answers the first screens paint from (Home, the Library grid, the shell), kept
 * from the last visit so the next one paints at once and asks again behind it (a "stale
 * while revalidate" start). Without it a reload waits for `/server`, the libraries and the
 * first page of books before a single cover is drawn.
 *
 * Restored synchronously into the query cache before any screen mounts (`restore`), every
 * entry marked invalidated, so each hook still asks its server on mount and the answer
 * replaces the kept one a moment later. Saved (`save`) a while after one of these queries
 * succeeds and when the page is hidden. Only the queries `isStartupQuery` names are kept,
 * and of the whole-library list only its first page, so the document stays small (about
 * 100 KB for a 1,000-book library). Every key carries its connection id, so a kept entry
 * of another connection or a signed-out one is never read (and the query cache drops it
 * unread). A sign-out drops the connection's entries (`forget`); a storage reset wipes the
 * document (`SCOPED_STORAGE_KEYS`).
 *
 * Native keeps none of it: its query cache lives as long as the app, a cold start is not
 * the browser's reload, and AsyncStorage can't be read before the first render.
 */

/** The document's shape version: a document of another is ignored (and replaced). */
const VERSION = 1;
/** Above this (characters of JSON) the document isn't written: localStorage is small. */
const MAX_CHARS = 1_500_000;

type Entry = { key: unknown[]; data: unknown; updatedAt: number; firstPage?: true };
type Doc = { v: number; entries: Entry[] };

/** Whether this runtime keeps a startup cache (a browser with localStorage). */
function storage(): Storage | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null; // storage blocked (a privacy setting)
  }
}

/** The single-key queries kept (their first key element), and the two-part ones below. */
const KEPT = new Set([
  'server',
  'libraries',
  'favourites',
  'queue',
  'collections',
  'listeningGoal',
  'myStats',
  'myListening',
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
  return isWholeLibrary(key);
}

function isInfinite(data: unknown): data is InfiniteData<unknown, unknown> {
  return isRecord(data) && Array.isArray(data.pages) && Array.isArray(data.pageParams);
}

/** The kept entries of `client`'s cache: each startup query's last answer (of an infinite
 * one only the first page, the one a reload starts from). */
export function snapshot(client: QueryClient): Entry[] {
  const out: Entry[] = [];
  for (const q of client.getQueryCache().getAll()) {
    if (q.state.status !== 'success' || q.state.data === undefined) continue;
    if (!isStartupQuery(q.queryKey)) continue;
    const { data } = q.state;
    if (isInfinite(data)) {
      if (data.pages.length === 0) continue;
      out.push({
        key: [...q.queryKey],
        data: data.pages[0],
        updatedAt: q.state.dataUpdatedAt,
        firstPage: true,
      });
    } else {
      out.push({ key: [...q.queryKey], data, updatedAt: q.state.dataUpdatedAt });
    }
  }
  return out;
}

/** Write the startup cache from `client`'s cache now (best-effort). */
export function save(client: QueryClient): void {
  const store = storage();
  if (!store) return;
  try {
    const json = JSON.stringify({ v: VERSION, entries: snapshot(client) } satisfies Doc);
    if (json.length > MAX_CHARS) store.removeItem(STARTUP_CACHE_KEY);
    else store.setItem(STARTUP_CACHE_KEY, json);
  } catch {
    // quota or storage blocked: the next visit just starts without it
  }
}

/** The kept entries, or none when there is no document or it can't be read. */
function readEntries(store: Storage): Entry[] {
  try {
    const doc: unknown = JSON.parse(store.getItem(STARTUP_CACHE_KEY) ?? 'null');
    if (!isRecord(doc) || doc.v !== VERSION || !Array.isArray(doc.entries)) return [];
    return doc.entries.filter(
      (e): e is Entry =>
        isRecord(e) &&
        Array.isArray(e.key) &&
        isStartupQuery(e.key) &&
        e.data !== undefined &&
        typeof e.updatedAt === 'number',
    );
  } catch {
    return [];
  }
}

/**
 * Put the kept answers into `client`'s cache, each invalidated so its hook asks again on
 * mount (the kept answer shows until the new one lands). A query already in the cache is
 * left alone. Call once, before anything renders. Returns how many were restored.
 */
export function restore(client: QueryClient): number {
  const store = storage();
  if (!store) return 0;
  let n = 0;
  for (const e of readEntries(store)) {
    if (client.getQueryCache().find({ queryKey: e.key, exact: true })) continue;
    // An infinite query restarts from its first page (whose param is always `undefined`:
    // JSON can't keep it).
    const data = e.firstPage ? { pages: [e.data], pageParams: [undefined] } : e.data;
    client.setQueryData(e.key, data, { updatedAt: e.updatedAt });
    void client.invalidateQueries({ queryKey: e.key, exact: true, refetchType: 'none' });
    n++;
  }
  return n;
}

/** Drop a connection's kept answers (it was signed out or removed). */
export function forget(connectionId: string): void {
  const store = storage();
  if (!store) return;
  const entries = readEntries(store);
  const kept = entries.filter((e) => !e.key.includes(connectionId));
  if (kept.length === entries.length) return;
  try {
    store.setItem(STARTUP_CACHE_KEY, JSON.stringify({ v: VERSION, entries: kept } satisfies Doc));
  } catch {
    store.removeItem(STARTUP_CACHE_KEY);
  }
}

/** How long after the last startup query's answer the cache is written. */
export const SAVE_DELAY_MS = 2_000;

/**
 * Keep the startup cache current for `client`: written `SAVE_DELAY_MS` after a startup
 * query's answer arrives (debounced) and whenever the page is hidden or left. Returns the
 * stop function. A no-op off the web.
 */
export function startSaving(client: QueryClient): () => void {
  if (!storage()) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    save(client);
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (!isStartupQuery(event.query.queryKey)) return;
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
