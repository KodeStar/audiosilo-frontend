import type { FetchQueryOptions, QueryKey } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

import { ApiError, type ApiClient } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import {
  addBookmark,
  allProgressQuery,
  cachedCapability,
  chaptersQuery,
  fetchCapabilities,
  fetchFailFast,
  isQueueKey,
  itemQuery,
  qk,
  queueQuery,
  type SourcedProgress,
} from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Book, Progress, QueueEntry } from '@/api/types';
import { startBookInPlace } from '@/components/player/start-book';
import { statusSignature } from '@/downloads/downloads-view';
import { downloadKey, useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';
import i18n from '@/i18n';
import { bootstrapPlayback } from '@/lib/bootstrap';
import { contentKeyOf } from '@/lib/content-key';
import { getItem, setItem } from '@/lib/storage';
import { buildBookQueue, toBookPosition } from '@/playback/book-queue';
import { noteInteraction } from '@/playback/last-interaction';
import { loadInitialProgress } from '@/playback/progress-sync';
import {
  onRemoteBookmarkRequest,
  selectBookKey,
  selectBookPosition,
  selectIsPlaying,
  selectIsTransportLive,
  usePlayer,
} from '@/playback/store';
import { useLibrarySelection } from '@/stores/library-selection';
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';

import type {
  BookRef,
  PendingBookmark,
} from '../../modules/audiosilo-player/src/AudiosiloPlayer.types';

import {
  artworkName,
  ensureArtwork,
  existingArtwork,
  pruneArtwork,
  type ArtworkSource,
} from './car-artwork';
import {
  buildCarSnapshot,
  CAR_TAB_LIMITS,
  carLabels,
  continueRefs,
  downloadedEntries,
  parseCarItemId,
  playSpec,
  type CarBook,
  type CarPlaySpec,
  type LivePlace,
} from './car-model';
import { carNative } from './car-native';

/**
 * CarPlay and Android Auto, the JS side (Phase 6 contract, sections 3 and 4). Framework-free,
 * started once from the root layout and from the car's headless task (`car-task.ts`):
 *
 * - **The car snapshot**: built (`car-model.ts`) and handed to native at start, when a car
 *   connects, when the progress lists, the Up next queue or the downloads registry change
 *   (after `SETTLE_MS`), when a book starts or pauses, and when the language changes; never
 *   more often than every `MIN_GAP_MS`. Its covers are files the app wrote
 *   (`car-artwork.ts`), fetched after the snapshot that needs them is out, so a list never
 *   waits on the network.
 * - **Play requests** (`onCarPlayRequest`, a book native can't start alone): the loaded book
 *   plays on; any other starts through `startBookInPlace`, from its saved place. A failure
 *   is logged; native times the request out and says `labels.unavailable`.
 * - **Bookmarks from outside the app** (CarPlay's Now Playing button, the Android
 *   notification / Android Auto): added through the framework-free `addBookmark` (no label,
 *   so its `annotations` gate has nothing to hold back) at the reported place. Those pressed
 *   while no JS ran (`consumePendingBookmarks`) are added at start and on every return to the
 *   foreground, each for its own book on its own connection (dropped when the connection is
 *   gone). One that can't reach its server is kept on the device and tried again then.
 * - **Adopting** (Android): a book the playback service loaded itself (the car started a
 *   downloaded book with no JS, or it kept playing while JS restarted) becomes the player
 *   store's book (`adoptLoaded`, no engine reload), checked at start, when a car connects,
 *   on returning to the foreground and when the engine changes state or file.
 *
 * A no-op on the web and on an installed binary without the car functions.
 */

/** Wait this long after a list changes before writing (a burst of changes writes once). */
export const SETTLE_MS = 2_000;
/** Never write two snapshots closer than this. */
export const MIN_GAP_MS = 2_000;
/** How fresh a list must be before the snapshot asks the server again. */
const LIST_STALE_MS = 60_000;
/** How fresh a book's item must be (titles and covers barely change). */
const ITEM_STALE_MS = 10 * 60_000;
/** Server cover thumbnails are 160, 320 or 640; the car wants about 256. */
const COVER_SIZE = 320;
/** Covers fetched at once. */
const ARTWORK_CONCURRENCY = 3;
/** Items read at once. */
const ITEM_CONCURRENCY = 4;
/** Car bookmarks that couldn't reach their server yet (retried at the next drain). */
const RETRY_KEY = 'audiosilo.carBookmarks';

/** Started (`startCarSync`), and how many callers hold it. */
let active = false;
let starts = 0;
let stops: (() => void)[] = [];
let ready: Promise<void> = Promise.resolve();

// --- Reading what the app knows ---------------------------------------------------------

/** A read that always settles: the server's answer when fresh enough or reachable, else what
 * the cache last held, else undefined (offline with nothing cached). */
async function read<T, K extends QueryKey>(
  options: FetchQueryOptions<T, Error, T, K>,
): Promise<T | undefined> {
  try {
    return await fetchFailFast(options);
  } catch {
    return queryClient.getQueryData<T>(options.queryKey);
  }
}

/** Run `fn` over `items`, `limit` at a time. */
async function inBatches<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The downloads registry's entry for a book, when it is downloaded. */
function downloadedEntry(ref: BookRef): DownloadEntry | undefined {
  const e = useDownloads.getState().entries[downloadKey(ref.connectionId, ref.libraryId, ref.path)];
  return e?.status === 'downloaded' ? e : undefined;
}

/** A book's item: the downloaded copy's (no network), else through the query cache. */
async function itemOf(ref: BookRef): Promise<Book | null> {
  const dl = downloadedEntry(ref);
  if (dl) return dl.manifest.book;
  const client = resolveClient(ref.connectionId);
  if (!client) return null;
  return (
    (await read({
      ...itemQuery(ref.connectionId, client, ref.libraryId, ref.path),
      staleTime: ITEM_STALE_MS,
    })) ?? null
  );
}

/** The progress rows of every signed-in server, and which servers' rows are known (read now
 * or cached): only those can stand in for the server in a resume lookup. */
async function progressRows(): Promise<{ rows: SourcedProgress[]; known: Set<string> }> {
  const conns = useSession.getState().connections;
  const known = new Set<string>();
  const lists = await Promise.all(
    conns.map(async (c) => {
      const client = resolveClient(c.id);
      if (!client) return [];
      const rows = await read({
        ...allProgressQuery(c.id, client),
        staleTime: LIST_STALE_MS,
      });
      if (!rows) return [];
      known.add(c.id);
      return rows.map((p): SourcedProgress => ({
        ...p,
        connectionId: c.id,
        connectionName: c.name,
      }));
    }),
  );
  return { rows: lists.flat(), known };
}

/** The default server's Up next queue, or null when it keeps none (no `queue`). */
async function upNextEntries(): Promise<{ cid: string; entries: QueueEntry[] } | null> {
  const cid = useSession.getState().defaultConnectionId;
  const client = cid ? resolveClient(cid) : null;
  if (!cid || !client) return null;
  let supported: boolean | undefined;
  try {
    supported = !!(await fetchCapabilities(cid, client)).queue;
  } catch {
    supported = cachedCapability(cid, 'queue');
  }
  if (!supported) return null;
  const entries = await read({ ...queueQuery(cid, client), staleTime: LIST_STALE_MS });
  return { cid, entries: entries ?? [] };
}

/** The Library tab's library: the listener's pick while its server is signed in, else the
 * default server's first library (`resolveLibrarySelection`'s fallback, without waiting on
 * every server). */
async function selectedLibrary(): Promise<{ connectionId: string; libraryId: number } | null> {
  const { connections, defaultConnectionId } = useSession.getState();
  const pick = useLibrarySelection.getState().selection;
  if (pick && connections.some((c) => c.id === pick.connectionId)) return pick;
  const cid = defaultConnectionId ?? connections[0]?.id;
  const client = cid ? resolveClient(cid) : null;
  if (!cid || !client) return null;
  const libs = await read({
    queryKey: qk.libraries(cid),
    queryFn: () => client.libraries(),
    staleTime: LIST_STALE_MS,
  });
  return libs?.[0] ? { connectionId: cid, libraryId: libs[0].id } : null;
}

/** The selected library's books, recently added first. */
async function libraryBooks(): Promise<{ cid: string; books: Book[] } | null> {
  const lib = await selectedLibrary();
  const client = lib ? resolveClient(lib.connectionId) : null;
  if (!lib || !client) return null;
  const page = await read({
    queryKey: ['car', 'library', lib.connectionId, lib.libraryId],
    queryFn: () =>
      client.listBooks(lib.libraryId, { sort: 'recent', limit: CAR_TAB_LIMITS.library }),
    staleTime: LIST_STALE_MS,
  });
  return { cid: lib.connectionId, books: page?.books ?? [] };
}

/** A client that answers a resume lookup's server read with the row the progress list
 * already holds (`loadInitialProgress` then reconciles it with the local mirror and the
 * offline queue exactly as `playBook` does, without one request per downloaded book). */
function listedProgress(row: Progress | null): ApiClient {
  return { getProgress: async () => row } as unknown as ApiClient;
}

// --- The snapshot -----------------------------------------------------------------------

/** What the last write handed native, without its date (an unchanged snapshot is not sent
 * again). */
let lastBody = '';
/** Covers a written snapshot still lacks, fetched after it is out. */
let missingArtwork = new Map<string, { name: string; source: ArtworkSource }>();

async function buildAndWrite(): Promise<void> {
  const t = i18n.t.bind(i18n);
  const labels = carLabels(t);
  const settings = useSettings.getState();
  const conns = useSession.getState().connections;
  const signedIn = conns.length > 0;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  const live: LivePlace | null =
    np && player.snapshot.state !== 'ended'
      ? {
          ref: { connectionId: np.connectionId, libraryId: np.libraryId, path: np.path },
          position: selectBookPosition(player),
          total: np.queue.total,
          rate: player.rate,
        }
      : null;

  const [{ rows, known }, queue, library] = signedIn
    ? await Promise.all([progressRows(), upNextEntries(), libraryBooks()])
    : [{ rows: [], known: new Set<string>() }, null, null];
  const progressByKey = new Map<string, Progress>();
  for (const r of rows) {
    progressByKey.set(
      contentKeyOf({ connectionId: r.connectionId, libraryId: r.library_id, path: r.path }),
      r,
    );
  }
  const progressOf = (ref: BookRef) => progressByKey.get(contentKeyOf(ref)) ?? null;

  const continuing = continueRefs(rows, live?.ref ?? null);
  const continueBooks = await inBatches(
    continuing,
    ITEM_CONCURRENCY,
    async ({ ref, progress }): Promise<CarBook> => ({ ref, book: await itemOf(ref), progress }),
  );
  const upNextBooks: CarBook[] | null = queue
    ? queue.entries.map((e) => {
        const ref = { connectionId: queue.cid, libraryId: e.library_id, path: e.path };
        return { ref, book: e.book ?? null, progress: progressOf(ref) };
      })
    : null;
  const downloads = downloadedEntries(useDownloads.getState().entries).map((e): CarBook => {
    const ref = { connectionId: e.connectionId, libraryId: e.libraryId, path: e.path };
    return { ref, book: e.manifest.book, progress: progressOf(ref) };
  });
  const libraryList: CarBook[] = library
    ? library.books.map((b) => {
        const ref = { connectionId: library.cid, libraryId: b.library_id, path: b.rel_path };
        return { ref, book: b, progress: progressOf(ref) };
      })
    : [];

  // Every book any tab lists, once: its play spec (downloaded only) and its cover.
  const all = new Map<string, CarBook>();
  for (const b of [...continueBooks, ...(upNextBooks ?? []), ...downloads, ...libraryList]) {
    const key = contentKeyOf(b.ref);
    const had = all.get(key);
    if (!had || (!had.book && b.book)) all.set(key, b);
  }

  const plays = new Map<string, CarPlaySpec | undefined>();
  for (const [key, b] of all) {
    const dl = downloadedEntry(b.ref);
    if (!dl) continue;
    const { connectionId, libraryId, path } = b.ref;
    const lookup = await loadInitialProgress(
      known.has(connectionId) ? listedProgress(progressOf(b.ref)) : null,
      connectionId,
      libraryId,
      path,
    ).catch(() => ({ kind: 'failed' }) as const);
    plays.set(
      key,
      playSpec(b.ref, dl.manifest, lookup, settings.defaultRate, settings.virtualChapterInterval),
    );
  }

  const names = new Map<string, string>();
  const artwork = new Map<string, string | null>();
  const missing = new Map<string, { name: string; source: ArtworkSource }>();
  for (const [key, b] of all) {
    const name = artworkName(key, b.book?.cover_version);
    names.set(key, name);
    const uri = existingArtwork(name);
    artwork.set(key, uri);
    if (uri) continue;
    const local = downloadedEntry(b.ref)?.manifest.coverUri;
    if (local) {
      missing.set(key, { name, source: { localUri: local } });
      continue;
    }
    const client = resolveClient(b.ref.connectionId);
    if (!client) continue;
    const sizes = cachedCapability(b.ref.connectionId, 'cover_sizes') === true;
    const url = sizes
      ? client.coverUrl(b.ref.libraryId, b.ref.path, {
          size: COVER_SIZE,
          version: b.book?.cover_version,
        })
      : client.coverUrl(b.ref.libraryId, b.ref.path);
    missing.set(key, { name, source: { url } });
  }

  const snapshot = buildCarSnapshot(
    {
      generatedAt: new Date().toISOString(),
      labels,
      signedIn,
      books: { continue: continueBooks, upnext: upNextBooks, downloads, library: libraryList },
    },
    {
      t,
      defaultRate: settings.defaultRate,
      live,
      isDownloaded: (ref) => !!downloadedEntry(ref),
      artworkFor: (ref) => artwork.get(contentKeyOf(ref)) ?? null,
      playFor: (ref) => plays.get(contentKeyOf(ref)),
    },
  );
  const { generatedAt: _at, ...body } = snapshot;
  const bodyJson = JSON.stringify(body);
  if (bodyJson !== lastBody && (await carNative.setSnapshot(JSON.stringify(snapshot)))) {
    lastBody = bodyJson;
  }
  pruneArtwork(new Set(names.values()));
  missingArtwork = missing;
}

/** Write the covers the last snapshot lacked, then ask for a snapshot that names them. */
async function fetchMissingArtwork(): Promise<void> {
  const jobs = [...missingArtwork.values()];
  missingArtwork = new Map();
  if (jobs.length === 0) return;
  const written = await inBatches(jobs, ARTWORK_CONCURRENCY, (j) =>
    ensureArtwork(j.name, j.source),
  );
  if (written.some(Boolean)) request(false);
}

// --- The schedule -----------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let dueAt = 0;
let writing = false;
let again: boolean | null = null;
let lastWriteAt = 0;

/** Ask for a snapshot: `soon` (a car connected, a book started or paused) as soon as the
 * gap allows, else after `SETTLE_MS`. Requests while one is pending join it (a sooner one
 * moves it earlier); a request while one is being written runs once it is done. */
function request(soon: boolean): void {
  if (!active) return;
  if (writing) {
    again = (again ?? false) || soon;
    return;
  }
  const now = Date.now();
  const due = Math.max(now + (soon ? 0 : SETTLE_MS), lastWriteAt + MIN_GAP_MS);
  if (timer) {
    if (due >= dueAt) return;
    clearTimeout(timer);
  }
  dueAt = due;
  timer = setTimeout(() => void write(), Math.max(0, due - now));
}

async function write(): Promise<void> {
  timer = null;
  writing = true;
  try {
    await buildAndWrite();
  } catch (err) {
    console.warn('[car] snapshot failed', err);
  } finally {
    lastWriteAt = Date.now();
    writing = false;
  }
  void fetchMissingArtwork();
  if (again !== null) {
    const soon = again;
    again = null;
    request(soon);
  }
}

// --- Play requests ------------------------------------------------------------------------

/** The car asked to play a book (its item id). */
export async function handleCarPlayRequest(id: string): Promise<void> {
  const ref = parseCarItemId(id);
  if (!ref) {
    console.warn('[car] not a car item id', id);
    return;
  }
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (np && contentKeyOf(np) === contentKeyOf(ref)) {
    // The loaded book plays on from where it is (never restarted); an ended or failed one
    // starts again through the resume lookup like any other.
    const state = player.snapshot.state;
    if (selectIsTransportLive(player)) return;
    if (state !== 'ended' && state !== 'error') {
      await player.toggle().catch((err) => console.warn('[car] play failed', err));
      return;
    }
  }
  try {
    if (!(await startBookInPlace(ref))) console.warn('[car] the book has no connection');
  } catch (err) {
    console.warn('[car] the book could not start', err);
  }
}

// --- Bookmarks ------------------------------------------------------------------------------

/** A bookmark to add: at a whole-book place (pressed while the book was loaded here), or at
 * the engine's file coordinates (pressed while no JS ran). */
type CarBookmark = BookRef & { at: string } & (
    { position: number } | { trackIndex: number; positionInTrack: number }
  );

/** The whole-book place of a bookmark in file coordinates: through the loaded book's queue,
 * else the downloaded copy's, else the book's item and chapters. Null when none can be read
 * now (offline, not downloaded). */
async function bookPlaceOf(b: CarBookmark): Promise<number | null> {
  if ('position' in b) return b.position;
  const np = usePlayer.getState().nowPlaying;
  if (np && contentKeyOf(np) === contentKeyOf(b)) {
    return toBookPosition(np.queue.offsets, b.trackIndex, b.positionInTrack);
  }
  let book: Book;
  let chapters;
  const dl = downloadedEntry(b);
  if (dl) {
    book = dl.manifest.book;
    chapters = dl.manifest.chapters ?? undefined;
  } else {
    const client = resolveClient(b.connectionId);
    if (!client) return null;
    try {
      [book, chapters] = await Promise.all([
        fetchFailFast({
          ...itemQuery(b.connectionId, client, b.libraryId, b.path),
          staleTime: 30_000,
        }),
        fetchFailFast({
          ...chaptersQuery(b.connectionId, client, b.libraryId, b.path),
          staleTime: 30_000,
        }),
      ]);
    } catch {
      return null;
    }
  }
  const { offsets } = buildBookQueue(null, b.libraryId, book, chapters);
  return toBookPosition(offsets, b.trackIndex, b.positionInTrack);
}

/** Add one: `done`, `retry` (its server can't be reached, or its place can't be read yet) or
 * `drop` (its connection is gone, or the server refused it). */
async function addCarBookmark(b: CarBookmark): Promise<'done' | 'retry' | 'drop'> {
  if (!resolveClient(b.connectionId)) return 'drop';
  const position = await bookPlaceOf(b);
  if (position === null) return 'retry';
  try {
    // No label: the car's bookmark is a plain one, so nothing waits on `annotations`.
    await addBookmark(b.connectionId, b.libraryId, b.path, Math.round(Math.max(0, position)));
    return 'done';
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      console.warn('[car] the server refused a bookmark', err);
      return 'drop';
    }
    return 'retry';
  }
}

function isCarBookmark(v: unknown): v is CarBookmark {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.connectionId === 'string' &&
    typeof b.libraryId === 'number' &&
    typeof b.path === 'string' &&
    (typeof b.position === 'number' ||
      (typeof b.trackIndex === 'number' && typeof b.positionInTrack === 'number'))
  );
}

/** Bookmark work runs one at a time, so the kept list is never written by two at once. */
let bookmarkChain: Promise<unknown> = Promise.resolve();
function serially<T>(fn: () => Promise<T>): Promise<T> {
  const run = bookmarkChain.then(fn, fn);
  bookmarkChain = run.catch(() => undefined);
  return run;
}

/** Add `fresh` and every kept bookmark, keeping (on the device) those to try again. */
function addBookmarks(fresh: CarBookmark[]): Promise<void> {
  return serially(async () => {
    const stored = await getItem<unknown[]>(RETRY_KEY);
    const kept = Array.isArray(stored) ? stored.filter(isCarBookmark) : [];
    const todo = [...kept, ...fresh];
    if (todo.length === 0) return;
    const retry: CarBookmark[] = [];
    for (const b of todo) {
      if ((await addCarBookmark(b)) === 'retry') retry.push(b);
    }
    if (retry.length > 0 || kept.length > 0) await setItem(RETRY_KEY, retry);
  });
}

const fromPending = (p: PendingBookmark): CarBookmark => ({
  connectionId: p.connectionId,
  libraryId: p.libraryId,
  path: p.path,
  trackIndex: p.trackIndex,
  positionInTrack: p.position,
  at: p.at,
});

/** The bookmarks pressed while no JS ran (and any kept ones), added now. */
export async function drainCarBookmarks(): Promise<void> {
  const pending = await carNative.consumePendingBookmarks();
  await addBookmarks(pending.map(fromPending));
}

// --- Adopting -------------------------------------------------------------------------------

let checking: Promise<void> | null = null;

/**
 * Android: when the playback service holds a book the player store doesn't (the car started
 * it, or it kept playing while JS restarted), adopt it. Never while a book the store started
 * is still loading (the service then still reports the previous one).
 */
export function checkLoadedBook(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  checking ??= (async () => {
    try {
      if (usePlayer.getState().loadingBook) return;
      const loaded = await carNative.getLoadedBook();
      if (!loaded) return;
      const player = usePlayer.getState();
      if (player.loadingBook) return;
      if (player.nowPlaying && contentKeyOf(player.nowPlaying) === contentKeyOf(loaded)) return;
      if (await player.adoptLoaded(loaded)) request(true);
    } catch (err) {
      console.warn('[car] adopting the loaded book failed', err);
    } finally {
      checking = null;
    }
  })();
  return checking;
}

// --- Start and stop -------------------------------------------------------------------------

/** Resolves once the last start's first steps (bootstrap, adopt, the bookmark drain) ran. */
export function carSyncReady(): Promise<void> {
  return ready;
}

/**
 * Start the car sync (idempotent: callers share one; each returned stop releases one, and the
 * last releases everything). Native only; a no-op on the web and on a binary without the car
 * functions.
 */
export function startCarSync(): () => void {
  if (Platform.OS === 'web' || !carNative.available) return () => undefined;
  starts++;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    starts--;
    if (starts === 0) teardown();
  };
  if (active) return stop;
  active = true;
  stops = [
    carNative.onConnection((connected) => {
      if (!connected) return;
      request(true);
      void checkLoadedBook();
    }),
    carNative.onPlayRequest((id) => void handleCarPlayRequest(id)),
    onRemoteBookmarkRequest((r) => {
      noteInteraction();
      void addBookmarks([
        {
          connectionId: r.connectionId,
          libraryId: r.libraryId,
          path: r.path,
          position: r.position,
          at: new Date().toISOString(),
        },
      ]);
    }),
    usePlayer.subscribe((s, prev) => {
      if (
        selectBookKey(s) !== selectBookKey(prev) ||
        selectIsPlaying(s) !== selectIsPlaying(prev)
      ) {
        request(true);
      }
      if (
        s.snapshot.state !== prev.snapshot.state ||
        s.snapshot.trackIndex !== prev.snapshot.trackIndex
      ) {
        void checkLoadedBook();
      }
    }),
    useDownloads.subscribe((s, prev) => {
      if (
        s.entries !== prev.entries &&
        statusSignature(s.entries) !== statusSignature(prev.entries)
      )
        request(false);
    }),
    useSession.subscribe((s, prev) => {
      if (s.connections !== prev.connections || s.defaultConnectionId !== prev.defaultConnectionId)
        request(false);
    }),
    useLibrarySelection.subscribe((s, prev) => {
      if (s.selection !== prev.selection) request(false);
    }),
    useSettings.subscribe((s, prev) => {
      if (s.defaultRate !== prev.defaultRate) request(false);
    }),
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const key = event.query.queryKey;
      if (isQueueKey(key) || (key[0] === 'progress' && key[1] === 'all')) request(false);
    }),
    (() => {
      const onLanguage = () => request(true);
      i18n.on('languageChanged', onLanguage);
      return () => i18n.off('languageChanged', onLanguage);
    })(),
    (() => {
      const sub = AppState.addEventListener('change', (state) => {
        if (state !== 'active') return;
        void drainCarBookmarks();
        void checkLoadedBook();
      });
      return () => sub.remove();
    })(),
  ];

  ready = (async () => {
    try {
      await bootstrapPlayback();
      if (!active) return;
      await checkLoadedBook();
      await drainCarBookmarks();
    } catch (err) {
      console.warn('[car] start failed', err);
    }
    request(true);
  })();
  return stop;
}

function teardown() {
  active = false;
  for (const off of stops) off();
  stops = [];
  if (timer) clearTimeout(timer);
  timer = null;
  again = null;
}

/** Tests only: stop everything and forget what was written, as if the app had just started. */
export function forgetCarSync() {
  teardown();
  starts = 0;
  ready = Promise.resolve();
  lastBody = '';
  lastWriteAt = 0;
  writing = false;
  missingArtwork = new Map();
  checking = null;
}
