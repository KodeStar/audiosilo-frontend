import type { FetchQueryOptions, QueryKey } from '@tanstack/react-query';
import { Platform } from 'react-native';

import { ApiError } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import {
  addBookmark,
  allProgressQuery,
  cachedCapability,
  fetchCapabilities,
  fetchFailFast,
  isAllProgressKey,
  isQueueKey,
  itemQuery,
  librariesQuery,
  qk,
  queueQuery,
  type SourcedProgress,
} from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Book, Progress, QueueEntry } from '@/api/types';
import { progressAt } from '@/components/home/home-model';
import { startBookInPlace } from '@/components/player/start-book';
import { queueConnectionId } from '@/components/upnext/up-next-model';
import { statusSignature } from '@/downloads/downloads-view';
import { downloadedEntryOf, useDownloads } from '@/downloads/store';
import type { DownloadManifest } from '@/downloads/types';
import i18n from '@/i18n';
import { bootstrapPlayback } from '@/lib/bootstrap';
import { contentKeyOf } from '@/lib/content-key';
import { mapLimit } from '@/lib/map-limit';
import { serialQueue } from '@/lib/serial-queue';
import { getItem, setItem } from '@/lib/storage';
import { onForeground } from '@/lib/when-active';
import { buildBookQueue, toBookPosition } from '@/playback/book-queue';
import { bookSourceOf } from '@/playback/book-source';
import { noteInteraction } from '@/playback/last-interaction';
import { readLocalPlaces, resumeLookupOf } from '@/playback/progress-sync';
import {
  selectBookKey,
  selectBookPosition,
  selectIsPlaying,
  selectIsTransportLive,
  usePlayer,
} from '@/playback/store';
import { bookRefOf, type BookRef } from '@/playback/types';
import {
  type LibraryGroup,
  resolveLibrarySelection,
  useLibrarySelection,
} from '@/stores/library-selection';
import { sessionHydrateFailed, useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';

import type { PendingBookmark } from '../../modules/audiosilo-player/src/AudiosiloPlayer.types';

import { artworkName, artworkOnDisk, artworkUri, ensureArtwork, pruneArtwork } from './car-artwork';
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
import { isCarConnected, setCarConnected } from './car-connection';
import { carNative } from './car-native';

/**
 * CarPlay and Android Auto, the JS side (Phase 6 contract, sections 3 and 4). Framework-free,
 * started once from the root layout and from the car's headless task (`car-task.ts`):
 *
 * - **The car snapshot**: built (`car-model.ts`) and handed to native only once a car has
 *   connected on this device (a phone that never meets a car never builds one, nor
 *   downloads car covers): at start, when a car connects (always a fresh build: native
 *   shows the last one it was handed at once, then this one), when the progress lists, the
 *   Up next queue or the downloads registry change (after `SETTLE_MS`), when the language
 *   changes, and, while a car is connected, when a book starts or pauses; never more often
 *   than every `MIN_GAP_MS`. Its covers are files the app wrote: a downloaded book's own
 *   cover, else a small JPEG (`car-artwork.ts`) fetched after the snapshot that needs it is
 *   out (a list never waits on the network). The downloaded books' play specs (Android's,
 *   for starting one with no JS; iOS has none) come from one read of the device's own
 *   places per build and are kept while their inputs stand.
 * - **Play requests** (`onCarPlayRequest`, a book native can't start alone): the loaded book
 *   plays on; any other starts through `startBookInPlace`, from its saved place (a
 *   downloaded one from its download, offline too). A failure is logged; native times the
 *   request out and says `labels.unavailable`.
 * - **Bookmarks from outside the app** (CarPlay's Now Playing button, the Android
 *   notification / Android Auto; `carNative.onBookmark`): added through the framework-free
 *   `addBookmark` (no label, so its `annotations` gate has nothing to hold back) at the
 *   engine's place at the press, on the book the engine names (else the loaded book). Those
 *   pressed while no JS ran
 *   (`consumePendingBookmarks`) are added at start and on every return to the foreground,
 *   each for its own book on its own connection (dropped when the connection is gone). One
 *   that can't reach its server is kept on the device and tried again then.
 * - **Adopting** (Android): a book the playback service loaded itself (the car started a
 *   downloaded book with no JS, or it kept playing while JS restarted) becomes the player
 *   store's book (`adoptLoaded`, no engine reload), checked at start, when a car connects,
 *   on returning to the foreground and when the engine moves to another file or starts
 *   playing on its own (never for the store's own book switch or load).
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
/** Set once a car (CarPlay or Android Auto) has connected on this device. */
const CAR_SEEN_KEY = 'audiosilo.carSeen';
/** Set once native has been handed a snapshot on this device (it keeps the last one). */
const WRITTEN_KEY = 'audiosilo.carSnapshotWritten';

/** Started (`startCarSync`), and how many callers hold it. */
let active = false;
let starts = 0;
let stops: (() => void)[] = [];
let ready: Promise<void> = Promise.resolve();

/** A car has connected on this device at least once (`CAR_SEEN_KEY`): only then is a
 * snapshot built and written, and are covers fetched for it. */
let carSeen = false;

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

/** A book's item: the downloaded copy's (no network), else through the query cache. Only the
 * item (no chapters, unlike `bookSourceOf`): a list row needs no timeline. */
async function itemOf(ref: BookRef): Promise<Book | null> {
  const dl = downloadedEntryOf(ref);
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

/** The Up next queue the app shows (`queueConnectionId`: the loaded book's server, else the
 * default, else the first), or null when that server keeps none (no `queue`). */
async function upNextEntries(): Promise<{ cid: string; entries: QueueEntry[] } | null> {
  const { connections, defaultConnectionId } = useSession.getState();
  const cid = queueConnectionId(
    usePlayer.getState().nowPlaying?.connectionId,
    defaultConnectionId,
    connections,
  );
  const client = cid ? resolveClient(cid) : null;
  if (!cid || !client) return null;
  // `fetchCapabilities` already falls back to the cached flags; it rejects only when none.
  const caps = await fetchCapabilities(cid, client).catch(() => null);
  if (!caps?.queue) return null;
  const entries = await read({ ...queueQuery(cid, client), staleTime: LIST_STALE_MS });
  return { cid, entries: entries ?? [] };
}

/** The Library tab's library: the app's own pick (`resolveLibrarySelection`, as the Library
 * tab resolves it), over every signed-in server's library list. */
async function selectedLibrary(): Promise<{ connectionId: string; libraryId: number } | null> {
  const groups = await Promise.all(
    useSession.getState().connections.map(async (c): Promise<LibraryGroup> => {
      const client = resolveClient(c.id);
      const libs = client
        ? await read({ ...librariesQuery(c.id, client), staleTime: LIST_STALE_MS })
        : undefined;
      return {
        connectionId: c.id,
        connectionName: c.name,
        libraryIds: libs?.map((l) => l.id) ?? [],
        status: libs ? 'ready' : 'error',
      };
    }),
  );
  const { selection, shown } = useLibrarySelection.getState();
  return resolveLibrarySelection(selection, groups, shown);
}

/** The selected library's books, recently added first. */
async function libraryBooks(): Promise<{ cid: string; books: Book[] } | null> {
  const lib = await selectedLibrary();
  const client = lib ? resolveClient(lib.connectionId) : null;
  if (!lib || !client) return null;
  const page = await read({
    queryKey: qk.carLibrary(lib.connectionId, lib.libraryId),
    queryFn: () =>
      client.listBooks(lib.libraryId, { sort: 'recent', limit: CAR_TAB_LIMITS.library }),
    staleTime: LIST_STALE_MS,
  });
  return { cid: lib.connectionId, books: page?.books ?? [] };
}

// --- Play specs (Android) ---------------------------------------------------------------

/** The last play spec of each downloaded book, with what it was built from. */
let specs = new Map<string, { manifest: DownloadManifest; inputs: string; spec?: CarPlaySpec }>();

/**
 * Android's play specs (how a downloaded book starts with no JS), for the downloaded books
 * the tabs list. Each resumes where `playBook` would: `resumeLookupOf` over the server row
 * the progress list holds (only a server whose list is known stands in for the server) and
 * the device's own places, read ONCE for all of them (`readLocalPlaces`), with no mirror
 * write. A spec is rebuilt only when its manifest, its resume place or the defaults changed.
 */
async function playSpecs(
  books: ReadonlyMap<string, CarBook>,
  known: ReadonlySet<string>,
  progressOf: (ref: BookRef) => Progress | null,
): Promise<Map<string, CarPlaySpec | undefined>> {
  const downloaded = [...books].flatMap(([key, b]) => {
    const dl = downloadedEntryOf(b.ref);
    return dl ? [{ key, ref: b.ref, manifest: dl.manifest }] : [];
  });
  const out = new Map<string, CarPlaySpec | undefined>();
  const next: typeof specs = new Map();
  if (downloaded.length > 0) {
    const places = await readLocalPlaces();
    const { defaultRate, virtualChapterInterval } = useSettings.getState();
    for (const { key, ref, manifest } of downloaded) {
      const { connectionId, libraryId, path } = ref;
      const row = known.has(connectionId) ? progressOf(ref) : undefined;
      const lookup = resumeLookupOf(row, places, connectionId, libraryId, path);
      const inputs = JSON.stringify([lookup, defaultRate, virtualChapterInterval]);
      const had = specs.get(key);
      const spec =
        had && had.manifest === manifest && had.inputs === inputs
          ? had.spec
          : playSpec(ref, manifest, lookup, defaultRate, virtualChapterInterval);
      next.set(key, { manifest, inputs, spec });
      out.set(key, spec);
    }
  }
  specs = next;
  return out;
}

// --- The snapshot -----------------------------------------------------------------------

/** What the last write handed native, without its date (an unchanged snapshot is not sent
 * again). */
let lastBody = '';
/** Covers a written snapshot still lacks, fetched after it is out. */
let missingArtwork = new Map<string, { name: string; url: string }>();
/** Whether native keeps a snapshot from before (`WRITTEN_KEY`), read once; null until then. */
let wroteBefore: boolean | null = null;

async function buildAndWrite(): Promise<void> {
  // The session's connections never loaded (a locked keychain at a CarPlay launch): the
  // snapshot native kept is better than a signed-out one (its downloads still play).
  if (sessionHydrateFailed()) return;
  const t = i18n.t.bind(i18n);
  const settings = useSettings.getState();
  const conns = useSession.getState().connections;
  const signedIn = conns.length > 0;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  const live: LivePlace | null =
    np && player.snapshot.state !== 'ended'
      ? {
          ref: bookRefOf(np),
          position: selectBookPosition(player),
          total: np.queue.total,
          rate: player.rate,
        }
      : null;

  const [{ rows, known }, queue, library] = signedIn
    ? await Promise.all([progressRows(), upNextEntries(), libraryBooks()])
    : [{ rows: [], known: new Set<string>() }, null, null];
  // Signed in, yet no server's list could be read or found cached (a fresh runtime away from
  // every server: the car's offline case): the snapshot native kept from last time is better
  // than one with empty lists, and its covers are still wanted. Nothing is written or pruned
  // until a server's lists can be read; only a device that never wrote one writes what it
  // has (its downloads).
  if (signedIn && known.size === 0) {
    wroteBefore ??= (await getItem<boolean>(WRITTEN_KEY)) === true;
    if (wroteBefore) return;
  }
  const progressByKey = new Map<string, Progress>();
  for (const r of rows) progressByKey.set(contentKeyOf(progressAt(r)), r);
  const progressOf = (ref: BookRef) => progressByKey.get(contentKeyOf(ref)) ?? null;

  const continuing = continueRefs(rows, live?.ref ?? null);
  const continueBooks = await mapLimit(
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
    const ref = bookRefOf(e);
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

  // iOS never starts a book without JS (CarPlay asks JS for every book): no play specs.
  const plays = Platform.OS === 'android' ? await playSpecs(all, known, progressOf) : null;

  // Covers: a downloaded book's own cover file as it is (no network, no copy); any other's
  // a small JPEG written under the car artwork folder (one folder read per snapshot).
  const onDisk = artworkOnDisk();
  const names = new Set<string>();
  const artwork = new Map<string, string | null>();
  const missing = new Map<string, { name: string; url: string }>();
  for (const [key, b] of all) {
    const local = downloadedEntryOf(b.ref)?.manifest.coverUri;
    if (local) {
      artwork.set(key, local);
      continue;
    }
    const name = artworkName(key, b.book?.cover_version);
    names.add(name);
    if (onDisk.has(name)) {
      artwork.set(key, artworkUri(name));
      continue;
    }
    artwork.set(key, null);
    const client = resolveClient(b.ref.connectionId);
    if (!client) continue;
    const sizes = cachedCapability(b.ref.connectionId, 'cover_sizes') === true;
    const url = sizes
      ? client.coverUrl(b.ref.libraryId, b.ref.path, {
          size: COVER_SIZE,
          version: b.book?.cover_version,
        })
      : client.coverUrl(b.ref.libraryId, b.ref.path);
    missing.set(key, { name, url });
  }

  const { generatedAt, ...body } = buildCarSnapshot(
    {
      generatedAt: new Date().toISOString(),
      labels: carLabels(t),
      signedIn,
      books: { continue: continueBooks, upnext: upNextBooks, downloads, library: libraryList },
    },
    {
      t,
      defaultRate: settings.defaultRate,
      live,
      isDownloaded: (ref) => !!downloadedEntryOf(ref),
      artworkFor: (ref) => artwork.get(contentKeyOf(ref)) ?? null,
      playFor: (ref) => plays?.get(contentKeyOf(ref)),
    },
  );
  // Serialized once: the body is what is compared, and the date goes in front of it.
  const bodyJson = JSON.stringify(body);
  if (
    bodyJson !== lastBody &&
    (await carNative.setSnapshot(
      `{"generatedAt":${JSON.stringify(generatedAt)},${bodyJson.slice(1)}`,
    ))
  ) {
    lastBody = bodyJson;
    if (wroteBefore !== true) {
      wroteBefore = true;
      void setItem(WRITTEN_KEY, true);
    }
  }
  pruneArtwork(names, onDisk);
  missingArtwork = missing;
}

/** Write the covers the last snapshot lacked, then ask for a snapshot that names them. */
async function fetchMissingArtwork(): Promise<void> {
  const jobs = [...missingArtwork.values()];
  missingArtwork = new Map();
  if (jobs.length === 0) return;
  const written = await mapLimit(jobs, ARTWORK_CONCURRENCY, (j) => ensureArtwork(j.name, j.url));
  if (written.some(Boolean)) request(false);
}

// --- The schedule -----------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let dueAt = 0;
let writing = false;
let again: boolean | null = null;
let lastWriteAt = 0;

/** Ask for a snapshot (none before a car was seen on this device): `soon` (a car connected,
 * a book started or paused) as soon as the gap allows, else after `SETTLE_MS`. Requests
 * while one is pending join it (a sooner one moves it earlier); a request while one is being
 * written runs once it is done. */
function request(soon: boolean): void {
  if (!active || !carSeen) return;
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
    // Never build from stores the launch steps haven't hydrated yet: a car connect replayed
    // as the listener registers (the root layout's path doesn't wait for them) would write a
    // signed-out snapshot over the good one and prune every cover it no longer names.
    await bootstrapPlayback();
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
  // A tap queued natively while JS booted is replayed as the listener registers, which on
  // the root layout's path comes before the launch steps hydrated the session and the
  // downloads: started then, the book would find no connection and no download.
  await bootstrapPlayback();
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
type CarBookmark = BookRef &
  ({ position: number } | { trackIndex: number; positionInTrack: number });

/** The whole-book place of a bookmark in file coordinates: through the loaded book's queue,
 * else the book's own timeline (`bookSourceOf`: the downloaded copy's, else its item and
 * chapters). Null when none can be read now (offline, not downloaded). */
async function bookPlaceOf(b: CarBookmark): Promise<number | null> {
  if ('position' in b) return b.position;
  const np = usePlayer.getState().nowPlaying;
  if (np && contentKeyOf(np) === contentKeyOf(b)) {
    return toBookPosition(np.queue.offsets, b.trackIndex, b.positionInTrack);
  }
  const source = await bookSourceOf(b).catch(() => null);
  if (!source) return null;
  const { offsets } = buildBookQueue(null, b.libraryId, source.book, source.chapters);
  return toBookPosition(offsets, b.trackIndex, b.positionInTrack);
}

/** Add one: `done`, `retry` (its server can't be reached, or its place can't be read yet) or
 * `drop` (its connection is gone, or the server refused it). */
async function addCarBookmark(b: CarBookmark): Promise<'done' | 'retry' | 'drop'> {
  // No connection: gone for good once the session has loaded, else (a session that failed
  // to load: a CarPlay launch with the phone locked) kept until it has.
  if (!resolveClient(b.connectionId)) return sessionReady() ? 'drop' : 'retry';
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
const serially = serialQueue();

/** Add `fresh` and every kept bookmark, keeping (on the device) those to try again. */
function addBookmarks(fresh: CarBookmark[]): Promise<void> {
  return serially(async () => {
    // Each bookmark resolves its connection: before the session hydrated, every one would
    // read as a connection that is gone and be dropped, the kept ones with them.
    await bootstrapPlayback();
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
  ...bookRefOf(p),
  trackIndex: p.trackIndex,
  positionInTrack: p.position,
});

/** The bookmarks pressed while no JS ran (and any kept ones), added now. */
async function drainCarBookmarks(): Promise<void> {
  const pending = await carNative.consumePendingBookmarks();
  await addBookmarks(pending.map(fromPending));
}

/** A bookmark pressed outside the app while JS runs, at the engine's place. When the engine
 * names its book (a Phase 6 binary), it goes on THAT book at the engine's file place
 * (`bookPlaceOf` maps it through the loaded queue when that is the book, else the book's own
 * timeline): the engine can hold a book the store has not adopted yet (a car start the JS
 * boot is still adopting), and it is the one the listener heard. Without one (an older
 * binary) it goes on the book loaded here, at its whole-book place taken now, so one kept for
 * a retry needs no timeline later; a press with none loaded is dropped. */
function onBookmarkPressed(trackIndex: number, positionInTrack: number, book?: BookRef): void {
  if (book) {
    noteInteraction();
    void addBookmarks([{ ...bookRefOf(book), trackIndex, positionInTrack }]);
    return;
  }
  const np = usePlayer.getState().nowPlaying;
  if (!np) return;
  noteInteraction();
  void addBookmarks([
    { ...bookRefOf(np), position: toBookPosition(np.queue.offsets, trackIndex, positionInTrack) },
  ]);
}

// --- Adopting -------------------------------------------------------------------------------

let checking: Promise<void> | null = null;

/**
 * Android: when the playback service holds a book the player store doesn't (the car started
 * it, or it kept playing while JS restarted), adopt it. Never while a book the store started
 * is still loading (the service then still reports the previous one), and never when the
 * store changed its book while the service was asked (a book finished or stopped: the
 * service is about to drop the one it reported, which must not come back).
 */
function checkLoadedBook(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  checking ??= (async () => {
    try {
      // The book is read against the stores (its download, its connection): never before
      // the launch steps hydrated them (a connect replayed as the listener registers comes
      // first on the root layout's path).
      await bootstrapPlayback();
      const asked = usePlayer.getState();
      if (asked.loadingBook) return;
      const loaded = await carNative.getLoadedBook();
      if (!loaded) return;
      const player = usePlayer.getState();
      if (player.loadingBook || player.nowPlaying !== asked.nowPlaying) return;
      if (player.nowPlaying && contentKeyOf(player.nowPlaying) === contentKeyOf(loaded)) return;
      if (await player.adoptLoaded(loaded)) request(true);
    } catch (err) {
      console.warn('[car] adopting the loaded book failed', err);
    }
    // Cleared once the check is over, never inside it: a body that returned before its
    // first await would clear `checking` before `??=` stored the promise, which then stayed
    // set for good and every later check returned it without asking native again.
  })().finally(() => {
    checking = null;
  });
  return checking;
}

type PlayerState = ReturnType<typeof usePlayer.getState>;

/**
 * Whether an engine change may be the playback service's own (Android: the car, or a
 * resumption, loaded another queue under the book the store holds): the engine moved to
 * another file, or started playing, on the same loaded book with no book of the store's
 * loading. The store's own changes ask nothing: its book switch (a new `nowPlaying`), its
 * load (`loadingBook` set, or just cleared), its stop or finish (no book), a pause or a
 * stall.
 */
function mayBeServiceChange(s: PlayerState, prev: PlayerState): boolean {
  if (Platform.OS !== 'android' || !s.nowPlaying || s.nowPlaying !== prev.nowPlaying) return false;
  if (s.loadingBook || prev.loadingBook) return false;
  return (
    s.snapshot.trackIndex !== prev.snapshot.trackIndex ||
    (s.snapshot.state === 'playing' && prev.snapshot.state !== 'playing')
  );
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
  if (!carNative.available) return () => undefined;
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
  /** The downloads registry's state signature last seen (a progress tick changes nothing). */
  let downloadsSig = statusSignature(useDownloads.getState().entries);
  stops = [
    carNative.onConnection((connected) => {
      setCarConnected(connected);
      if (!connected) return;
      if (!carSeen) {
        carSeen = true;
        void setItem(CAR_SEEN_KEY, true);
      }
      request(true);
      void checkLoadedBook();
    }),
    carNative.onPlayRequest((id) => void handleCarPlayRequest(id)),
    carNative.onBookmark(onBookmarkPressed),
    usePlayer.subscribe((s, prev) => {
      if (
        // A car is connected now: only then does a book starting or pausing rebuild the
        // snapshot (a connect builds a fresh one anyway).
        isCarConnected() &&
        (selectBookKey(s) !== selectBookKey(prev) || selectIsPlaying(s) !== selectIsPlaying(prev))
      ) {
        request(true);
      }
      if (mayBeServiceChange(s, prev)) void checkLoadedBook();
    }),
    useDownloads.subscribe((s, prev) => {
      if (s.entries === prev.entries) return;
      const sig = statusSignature(s.entries);
      if (sig === downloadsSig) return;
      downloadsSig = sig;
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
      if (isQueueKey(key) || isAllProgressKey(key)) request(false);
    }),
    (() => {
      const onLanguage = () => request(true);
      i18n.on('languageChanged', onLanguage);
      return () => i18n.off('languageChanged', onLanguage);
    })(),
    onForeground(() => {
      void drainCarBookmarks();
      void checkLoadedBook();
    }),
  ];

  ready = (async () => {
    try {
      const [, seen] = await Promise.all([bootstrapPlayback(), getItem<boolean>(CAR_SEEN_KEY)]);
      carSeen ||= seen === true;
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
  setCarConnected(false);
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
  specs = new Map();
  carSeen = false;
  checking = null;
  wroteBefore = null;
}
