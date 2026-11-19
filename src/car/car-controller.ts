import type { FetchQueryOptions, QueryKey } from '@tanstack/react-query';
import { Platform } from 'react-native';

import { ApiError } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import {
  addBookmark,
  allProgressQuery,
  cachedCapability,
  collectionQuery,
  collectionsQuery,
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
import { endCastForCar } from '@/cast/cast-session';
import type {
  Book,
  Capabilities,
  Collection,
  Library,
  Progress,
  QueueEntry,
  ServerInfo,
} from '@/api/types';
import {
  kidsCollections,
  kidsCollectionSections,
  kidsConnectionId,
  kidsContinuePaths,
  kidsDownloads,
  kidsLibrary,
  kidsOfflineScope,
  kidsSectionBooks,
  kidsShelf,
  type KidsShelfMode,
  kidsShelfMode,
} from '@/components/kids/kids-model';
import { progressAt } from '@/components/home/home-model';
import { startBookInPlace } from '@/components/player/start-book';
import { queueConnectionId } from '@/components/upnext/up-next-model';
import { statusSignature } from '@/downloads/downloads-view';
import { downloadedEntryOf, useDownloads } from '@/downloads/store';
import type { DownloadEntry, DownloadManifest } from '@/downloads/types';
import i18n from '@/i18n';
import { bootstrapPlayback } from '@/lib/bootstrap';
import { resolveConnectionId } from '@/lib/connection-id';
import { contentKeyOf } from '@/lib/content-key';
import { mapLimit } from '@/lib/map-limit';
import { serialQueue } from '@/lib/serial-queue';
import { getItem, setItem } from '@/lib/storage';
import {
  CAR_BOOKMARKS_KEY as RETRY_KEY,
  CAR_RESUMABLE_KEY as RESUMABLE_KEY,
  CAR_SNAPSHOT_WRITTEN_KEY as WRITTEN_KEY,
} from '@/lib/storage-keys';
import { onForeground } from '@/lib/when-active';
import {
  type BookQueue,
  buildBookQueue,
  toBookPosition,
  trackIdOf,
  trackIndexById,
} from '@/playback/book-queue';
import { bookSourceOf, downloadedSourceOf } from '@/playback/book-source';
import { listenerSettings } from '@/playback/listener-settings';
import { noteInteraction } from '@/playback/last-interaction';
import { placeSavedAt, readLocalPlaces, resumeLookupOf } from '@/playback/progress-sync';
import {
  engineOtherBook,
  followsOutsidePlay,
  onOtherBookReported,
  selectBookKey,
  selectBookPosition,
  selectIsPlaying,
  selectIsTransportLive,
  usePlayer,
} from '@/playback/store';
import { bookRefOf, type BookRef } from '@/playback/types';
import {
  type LibraryGroup,
  type LibrarySelection,
  resolveCarLibrary,
  useLibrarySelection,
} from '@/stores/library-selection';
import {
  activeProfile,
  type KidsSettings,
  mayActFor,
  profileConnectionIds,
  profileConnections,
  useProfiles,
} from '@/stores/profiles';
import { type Connection, sessionHydrateFailed, useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';

import type {
  LoadedBook,
  PendingBookmark,
} from '../../modules/audiosilo-player/src/AudiosiloPlayer.types';

import { artworkName, artworkOnDisk, artworkUri, ensureArtwork, pruneArtwork } from './car-artwork';
import {
  buildCarSnapshot,
  CAR_TAB_LIMITS,
  carLabels,
  continueRefs,
  downloadedEntries,
  kidsCarBooks,
  parseCarItemId,
  playSpec,
  type CarBook,
  type CarItemContext,
  type CarPlaySpec,
  type CarSnapshotInput,
  type LivePlace,
} from './car-model';
import { isCarConnected, setCarConnected } from './car-connection';
import { carNative } from './car-native';

/**
 * CarPlay and Android Auto, the JS side. Framework-free, started once from the root layout
 * and from the car's headless task (`car-task.ts`):
 *
 * - **The car snapshot**: built (`car-model.ts`) and handed to native once a car has
 *   connected on this device (a phone that never meets a car never builds the full one, nor
 *   downloads car covers): at start, when a car connects (always a fresh build: native
 *   shows the last one it was handed at once, then this one), after adopting a book the
 *   service loaded, when the language changes, while a car is connected when a book starts
 *   or pauses, and `SETTLE_MS` after the progress lists, the Up next queue, the downloads
 *   registry, the session's connections or default, the library selection or the default
 *   speed change (and once covers a written snapshot lacked have been fetched); never more
 *   often than every `MIN_GAP_MS`. On Android a pause, a stop, a paused book's move or
 *   another book (what a Bluetooth resumption plays) with no car connected writes it at
 *   once, from the cache (`writeForResumption`); before any car, Android writes a minimal
 *   one instead (`buildResumable`, fe#251).
 *   It never replaces native's last snapshot with a worse one: not while the session's
 *   hydrate has failed, and not with no server's lists readable once one was written on
 *   this device. Every write, play request, adoption and bookmark drain
 *   waits for `bootstrapPlayback()`. Its covers are files the app wrote: a downloaded book's own
 *   cover, else a small JPEG (`car-artwork.ts`) fetched after the snapshot that needs it is
 *   out (a list never waits on the network). The downloaded books' play specs (Android's,
 *   for starting one with no JS; iOS has none) come from one read of the device's own
 *   places per build and are kept while their inputs stand.
 * - **Play requests** (`onCarPlayRequest`, a book native can't start alone): the loaded book
 *   plays on; any other starts through `startBookInPlace`, from its saved place (a
 *   downloaded one from its download, offline too). A failure is logged; native times the
 *   request out and says `labels.unavailable`. A request native gave up on (Android's
 *   `onCarPlayCancel`: its 10 s wait ran out, or another play took its place) never plays:
 *   a start still on its way stops before the load, or loads paused (`cancelledPlays`).
 * - **Bookmarks from outside the app** (CarPlay's Now Playing button, Android Auto's
 *   custom action; `carNative.onBookmark`): added through the framework-free
 *   `addBookmark` (no label, so its `annotations` gate has nothing to hold back) at the
 *   engine's place at the press, on the book the engine names (else the loaded book). Those
 *   pressed while no JS ran
 *   (`consumePendingBookmarks`) are added at start and on every return to the foreground,
 *   each for its own book on its own connection (dropped when the connection is gone). One
 *   that can't reach its server is kept on the device and tried again then.
 * - **Adopting** (Android): a book the playback service loaded itself (the car started a
 *   downloaded book with no JS, or it kept playing while JS restarted) becomes the player
 *   store's book (`adoptLoaded`: no engine reload unless the engine plays another file
 *   order than the book's queue), checked at start, when a car connects, on returning to
 *   the foreground and when the engine moves to another file or starts playing on its own
 *   (never for the store's own book switch or load).
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
/** Set once a car (CarPlay or Android Auto) has connected on this device. */
const CAR_SEEN_KEY = 'audiosilo.carSeen';

/** Started (`startCarSync`), and how many callers hold it. */
let active = false;
let starts = 0;
let stops: (() => void)[] = [];
let ready: Promise<void> = Promise.resolve();

/** A car has connected on this device at least once (`CAR_SEEN_KEY`): only then is the full
 * snapshot built and written, and are covers fetched for it (before, Android writes only the
 * minimal resumable one, `buildResumable`). */
let carSeen = false;
/** The start's read of `CAR_SEEN_KEY` into `carSeen`: a resumable build waits for it, so a
 * launch's first one never takes a car-seen phone for one no car has met. */
let carSeenRead: Promise<void> = Promise.resolve();

// --- Reading what the app knows ---------------------------------------------------------

/** How a build reads what the app knows, handed down from the build to every read. `fresh`:
 * the server's answer when the cache is stale. `cached`: a resumption's build
 * (`writeForResumption`: a pause, a stop or another book with no car connected) takes what
 * the cache holds, however old, and asks a server only for what it has never held, so the
 * write never waits on a server (whose request timeout is a JS timer Android holds in the
 * background). */
type ReadMode = 'fresh' | 'cached';

/** A read that always settles: the server's answer when fresh enough or reachable, else what
 * the cache last held, else undefined (offline with nothing cached). */
async function read<T, K extends QueryKey>(
  options: FetchQueryOptions<T, Error, T, K>,
  reads: ReadMode,
): Promise<T | undefined> {
  if (reads === 'cached') {
    const cached = queryClient.getQueryData<T>(options.queryKey);
    if (cached !== undefined) return cached;
  }
  try {
    return await fetchFailFast(options);
  } catch {
    return queryClient.getQueryData<T>(options.queryKey);
  }
}

/** A book's item: the downloaded copy's (no network), else through the query cache. Only the
 * item (no chapters, unlike `bookSourceOf`): a list row needs no timeline. */
async function itemOf(ref: BookRef, reads: ReadMode): Promise<Book | null> {
  const dl = downloadedEntryOf(ref);
  if (dl) return dl.manifest.book;
  const client = resolveClient(ref.connectionId);
  if (!client) return null;
  return (
    (await read(
      { ...itemQuery(ref.connectionId, client, ref.libraryId, ref.path), staleTime: ITEM_STALE_MS },
      reads,
    )) ?? null
  );
}

/** The progress rows of `conns` (the person listening's servers), and which servers' rows are
 * known (read now or cached): only those can stand in for the server in a resume lookup.
 * `cacheOnly`: what the query cache holds, with no request. */
async function progressRows(
  conns: readonly Connection[],
  reads: ReadMode | 'cacheOnly',
): Promise<{ rows: SourcedProgress[]; known: Set<string> }> {
  const known = new Set<string>();
  const lists = await Promise.all(
    conns.map(async (c) => {
      const client = resolveClient(c.id);
      if (!client) return [];
      const query = { ...allProgressQuery(c.id, client), staleTime: LIST_STALE_MS };
      const rows =
        reads === 'cacheOnly'
          ? queryClient.getQueryData<Progress[]>(query.queryKey)
          : await read(query, reads);
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

/** A book's progress row among `rows`, else null. */
function progressLookup(rows: readonly SourcedProgress[]): (ref: BookRef) => Progress | null {
  const byKey = new Map<string, Progress>();
  for (const r of rows) byKey.set(contentKeyOf(progressAt(r)), r);
  return (ref) => byKey.get(contentKeyOf(ref)) ?? null;
}

/** A server's flags, or null when they can't be known: the cached ones at once in a
 * resumption's build (`cached`), else `fetchCapabilities` (which already falls back to the
 * cached flags; it rejects only when none). */
async function capabilitiesOf(
  cid: string,
  client: NonNullable<ReturnType<typeof resolveClient>>,
  reads: ReadMode,
): Promise<Capabilities | null> {
  const cached =
    reads === 'cached'
      ? queryClient.getQueryData<ServerInfo>(qk.server(cid))?.capabilities
      : undefined;
  return cached ?? (await fetchCapabilities(cid, client).catch(() => null));
}

/** The Up next queue the app shows (`queueConnectionId`: the loaded book's server, else the
 * default, else the first), or null when that server keeps none (no `queue`). */
async function upNextEntries(
  reads: ReadMode,
): Promise<{ cid: string; entries: QueueEntry[] } | null> {
  const cid = queueConnectionId(
    usePlayer.getState().nowPlaying?.connectionId,
    useSession.getState().defaultConnectionId,
    profileConnections(),
  );
  const client = cid ? resolveClient(cid) : null;
  if (!cid || !client) return null;
  const caps = await capabilitiesOf(cid, client, reads);
  if (!caps?.queue) return null;
  const entries = await read({ ...queueQuery(cid, client), staleTime: LIST_STALE_MS }, reads);
  return { cid, entries: entries ?? [] };
}

/** The library the car's Library tab listed last while a car is connected (D9, fe#271): with
 * no pick, the first readable server's stands for the drive, not swapped for the first
 * server's once that answers mid-drive. Forgotten when the car goes. */
let carListed: LibrarySelection | null = null;

/** The Library tab's library: the app's own pick as the Library tab resolves it, over every
 * signed-in server's library list; with no pick, what the car listed last this drive while
 * it stands, else the library the app shows, else the first server that could be read
 * (`resolveCarLibrary`: the car has no state to show for one it waits on). */
async function selectedLibrary(reads: ReadMode): Promise<LibrarySelection | null> {
  const groups = await Promise.all(
    profileConnections().map(async (c): Promise<LibraryGroup> => {
      const client = resolveClient(c.id);
      const libs = client
        ? await read({ ...librariesQuery(c.id, client), staleTime: LIST_STALE_MS }, reads)
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
  const lib = resolveCarLibrary(selection, groups, carListed ?? shown);
  if (isCarConnected()) carListed = lib;
  return lib;
}

/** The selected library's books, recently added first. */
async function libraryBooks(reads: ReadMode): Promise<{ cid: string; books: Book[] } | null> {
  const lib = await selectedLibrary(reads);
  const client = lib ? resolveClient(lib.connectionId) : null;
  if (!lib || !client) return null;
  const page = await read(
    {
      queryKey: qk.carLibrary(lib.connectionId, lib.libraryId),
      queryFn: () =>
        client.listBooks(lib.libraryId, { sort: 'recent', limit: CAR_TAB_LIMITS.library }),
      staleTime: LIST_STALE_MS,
    },
    reads,
  );
  return { cid: lib.connectionId, books: page?.books ?? [] };
}

// --- Kids mode ----------------------------------------------------------------------------

/** The kids shelf's library page (the library's own order, as kids mode lists it), apart
 * from the Library tab's recently added page. */
const kidsLibraryKey = (cid: string, libraryId: number) =>
  [...qk.carLibrary(cid, libraryId), 'kids'] as const;

/** How a kids profile's shelf reads (`readKidsShelf`): where it comes from
 * (`kidsShelfMode`), the library it shows when that is one library and it is known (the
 * offline fallback's scope, `kidsOfflineScope`), and `shelf(progress)` to finish it with
 * the connection's progress rows (null when it can't be read: offline with nothing
 * cached). */
type KidsShelfRead = {
  mode: KidsShelfMode;
  library: Library | null;
  shelf: (progress: readonly Progress[]) => Promise<Book[] | null>;
};

const unreadable = async () => null;

/** For a household member (`managed_by`): whether its server keeps collections (undefined
 * while that can't be known) and its GET /me/collections answer (undefined when unread).
 * Neither is asked for anyone else (`kidsShelfMode` is the one library then). */
async function memberCollections(
  conn: Connection,
  client: NonNullable<ReturnType<typeof resolveClient>>,
  reads: ReadMode,
): Promise<{ has: boolean | undefined; list: Collection[] | undefined }> {
  if (!conn.user.managed_by) return { has: undefined, list: undefined };
  const caps = await capabilitiesOf(conn.id, client, reads);
  const has = caps ? !!caps.collections : undefined;
  const list = has
    ? await read({ ...collectionsQuery(conn.id, client), staleTime: LIST_STALE_MS }, reads)
    : undefined;
  return { has, list };
}

/**
 * A kids profile's shelf on its connection, as kids mode shows it (`useKidsStories`, without
 * React: a car-only session runs no React tree): the collections the account's owner shares
 * with it (`kidsShelfMode`: a household member on a server with `collections`), else one
 * library (`kidsLibrary`, its stories in progress first, then its first page). Everything
 * that doesn't need the progress is read here, while the caller reads the progress
 * (`buildAndWrite`): the libraries alongside the collections, then the shared collections'
 * items or the library's page.
 */
async function readKidsShelf(
  conn: Connection,
  kids: KidsSettings,
  reads: ReadMode,
): Promise<KidsShelfRead> {
  const client = resolveClient(conn.id);
  if (!client) {
    return {
      mode: kidsShelfMode(conn.user, undefined, undefined),
      library: null,
      shelf: unreadable,
    };
  }
  const [libraries, collections] = await Promise.all([
    read({ ...librariesQuery(conn.id, client), staleTime: LIST_STALE_MS }, reads),
    memberCollections(conn, client, reads),
  ]);
  const mode = kidsShelfMode(conn.user, collections.has, collections.list);
  if (mode === 'unknown') return { mode, library: null, shelf: unreadable };
  // Without the libraries a shared collection's episode can't be told from a story (its
  // items carry no `episode`), and the one library can't be picked.
  if (!libraries) return { mode, library: null, shelf: unreadable };
  if (mode === 'collections') {
    const shared = kidsCollections(collections.list ?? [], conn.user);
    const details = await mapLimit(shared, ITEM_CONCURRENCY, (c) =>
      read({ ...collectionQuery(conn.id, client, c.id), staleTime: LIST_STALE_MS }, reads),
    );
    if (details.every((d) => d === undefined)) return { mode, library: null, shelf: unreadable };
    return {
      mode,
      library: null,
      shelf: async (progress) =>
        kidsSectionBooks(kidsCollectionSections(shared, details, progress, libraries)),
    };
  }
  const lib = kidsLibrary(libraries, conn.id, kids);
  if (!lib) return { mode, library: null, shelf: async () => [] };
  const page = await read(
    {
      queryKey: kidsLibraryKey(conn.id, lib.id),
      queryFn: () => client.listBooks(lib.id, { limit: CAR_TAB_LIMITS.library }),
      staleTime: LIST_STALE_MS,
    },
    reads,
  );
  // Its page unreadable (offline, nothing cached): the library is still known, so the
  // downloads offered instead are that library's only, as kids mode's own.
  if (!page) return { mode, library: lib, shelf: unreadable };
  return {
    mode,
    library: lib,
    shelf: async (progress) => {
      const continuing = await mapLimit(
        kidsContinuePaths(progress, lib.id),
        ITEM_CONCURRENCY,
        (path) => itemOf({ connectionId: conn.id, libraryId: lib.id, path }, reads),
      );
      return kidsShelf(
        continuing.filter((b): b is Book => b !== null),
        page.books,
      );
    },
  };
}

/** A kids profile's car books (`kidsCarBooks`): its shelf, else (unreadable) the stories
 * downloaded on its account, as kids mode falls back to them offline (`kidsOfflineScope`). */
async function kidsBooks(
  conn: Connection | null,
  kids: KidsSettings,
  shelfRead: KidsShelfRead | null,
  rows: SourcedProgress[],
  live: LivePlace | null,
  progressOf: (ref: BookRef) => Progress | null,
): Promise<CarSnapshotInput['books']> {
  if (!conn || !shelfRead) return kidsCarBooks('', [], [], null, progressOf);
  const shelf =
    (await shelfRead.shelf(rows)) ??
    kidsDownloads(
      useDownloads.getState().entries,
      conn.id,
      kidsOfflineScope(shelfRead.mode, shelfRead.library, conn.id, kids),
    );
  return kidsCarBooks(conn.id, shelf, rows, live?.ref ?? null, progressOf);
}

/** The kids shelf's collection answers last seen (by query hash), so an answer read again
 * unchanged (the cache keeps the same data then) builds nothing. */
const kidsShelfSeen = new Map<string, unknown>();

/** Whether a query's new answer changes a kids profile's shelf of shared collections (a
 * story added to one): a collections or collection key of the connection kids mode shows,
 * with data other than last time. */
function kidsShelfChanged(key: readonly unknown[], hash: string, data: unknown): boolean {
  if (key[0] !== 'collections' && key[0] !== 'collection') return false;
  const profile = activeProfile();
  // The person listening's connections in the session's order, as kids mode reads them.
  if (!profile?.kids || key[1] !== kidsConnectionId(profileConnectionIds(), profile.kids)) {
    return false;
  }
  if (kidsShelfSeen.get(hash) === data) return false;
  kidsShelfSeen.set(hash, data);
  return true;
}

// --- Play specs (Android) ---------------------------------------------------------------

/** The last play spec of each downloaded book, with what it was built from. */
let specs = new Map<
  string,
  { manifest: DownloadManifest; inputs: string; skew: number; spec?: CarPlaySpec }
>();

/** How far a connection's measured clock skew moves (ms) before its books' specs are built
 * again with it (`CarPlaySpec.placeSavedAt`): each sync answer measures it anew, a few
 * hundred ms either way. */
const SKEW_SLACK_MS = 2_000;

/**
 * Android's play specs (how a downloaded book starts with no JS), for the downloaded books
 * the tabs list. Each resumes where `playBook` would: `resumeLookupOf` over the server row
 * the progress list holds (only a server whose list is known stands in for the server) and
 * the device's own places, read ONCE for all of them (`readLocalPlaces`), with no mirror
 * write. The loaded book, paused, starts where it was paused instead (`pausedPlaceOf`). Each
 * carries when its place was saved (`CarPlaySpec.placeSavedAt`), so Android's live place on
 * the book wins only when it is newer. A spec is rebuilt only when its manifest, its resume
 * place or the defaults changed, or its server's clock skew moved (`SKEW_SLACK_MS`).
 */
async function playSpecs(
  books: ReadonlyMap<string, CarBook>,
  known: ReadonlySet<string>,
  progressOf: (ref: BookRef) => Progress | null,
  paused: PausedPlace | null,
): Promise<Map<string, CarPlaySpec | undefined>> {
  const downloaded = [...books].flatMap(([key, b]) => {
    const dl = downloadedEntryOf(b.ref);
    return dl ? [{ key, ref: b.ref, manifest: dl.manifest }] : [];
  });
  const out = new Map<string, CarPlaySpec | undefined>();
  const next: typeof specs = new Map();
  if (downloaded.length > 0) {
    const places = await readLocalPlaces();
    const { virtualChapterInterval } = useSettings.getState();
    const { defaultRate } = listenerSettings();
    for (const { key, ref, manifest } of downloaded) {
      const { connectionId, libraryId, path } = ref;
      const row = known.has(connectionId) ? progressOf(ref) : undefined;
      const lookup = resumeLookupOf(row, places, connectionId, libraryId, path);
      const at = paused?.key === key ? paused.place : undefined;
      const inputs = JSON.stringify([lookup, defaultRate, virtualChapterInterval, at]);
      // The skew moves the lookup's time (a paused place's is this device's own): measured
      // again at every sync answer, it is a new spec (and a snapshot write) only when it
      // moved by more than SKEW_SLACK_MS.
      const skew = at ? 0 : (places.skews?.[connectionId] ?? 0);
      const had = specs.get(key);
      // A paused place was saved as JS first wrote it: an unchanged spec keeps that time.
      const reuse =
        had &&
        had.manifest === manifest &&
        had.inputs === inputs &&
        Math.abs(had.skew - skew) <= SKEW_SLACK_MS;
      const spec = reuse
        ? had.spec
        : playSpec(
            ref,
            manifest,
            lookup,
            defaultRate,
            virtualChapterInterval,
            at,
            at ? Date.now() : placeSavedAt(lookup, row, places, connectionId, libraryId, path),
          );
      // Kept with the skew it was built with, so slow drift still adds up to a rebuild.
      next.set(key, { manifest, inputs, skew: reuse ? had.skew : skew, spec });
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
/** A cover to fetch: its file name, its URL and the connection's proxy headers for it
 * (fe#167; in memory only, never in the snapshot). */
type ArtworkJob = { name: string; url: string; headers?: Record<string, string> };
/** Covers a written snapshot still lacks, fetched after it is out. */
let missingArtwork = new Map<string, ArtworkJob>();
/** Whether native keeps a snapshot from before (`WRITTEN_KEY`), read once; null until then. */
let wroteBefore: boolean | null = null;
/** The owner last stored under `SNAPSHOT_OWNER_KEY` by this runtime (a write per pause stores
 * it only when it changed). */
let ownerStored: string | null = null;

const SNAPSHOT_OWNER_KEY = 'audiosilo.carSnapshotOwner';
const snapshotOwner = () =>
  JSON.stringify([
    useProfiles.getState().activeProfileId,
    profileConnections()
      .map((c) => c.id)
      .sort(),
    // Kids mode on or off is another list (the kids shelf only).
    !!activeProfile()?.kids,
  ]);

/** The loaded book's live place, when it is the person listening's and has not ended. */
function livePlaceOf(player: PlayerState): LivePlace | null {
  const np = player.nowPlaying;
  return np && mayActFor(np.connectionId) && player.snapshot.state !== 'ended'
    ? {
        ref: bookRefOf(np),
        position: selectBookPosition(player),
        total: np.queue.total,
        rate: player.rate,
      }
    : null;
}

/** Where the loaded book was paused (its content key, place and speed). */
type PausedPlace = { key: string; place: { position: number; rate: number } };

/** The live place of a loaded book that is paused and settled (no load of the store's under
 * way), else null: only then is the live place the one the pause saves. */
function pausedPlaceOf(player: PlayerState, live: LivePlace | null): PausedPlace | null {
  if (!live || player.loadingBook || player.snapshot.state !== 'paused') return null;
  return { key: contentKeyOf(live.ref), place: { position: live.position, rate: live.rate } };
}

/**
 * Builds the snapshot of `input` (the date and the labels added) and hands it to native when
 * its body changed. True when native holds this body (written now, or unchanged); false when
 * the person listening changed while it was built (nothing is written then) or native refused
 * the write, so nothing that follows a write (the kept resumable book, the cover prune) acts on
 * a snapshot native does not have. `full`: the car's own snapshot, the one a build with no
 * readable list leaves alone once written (`WRITTEN_KEY`); the minimal resumable one is never
 * that, so the first car's build replaces it offline too.
 */
async function handOver(
  owner: string,
  input: Omit<CarSnapshotInput, 'generatedAt' | 'labels'>,
  ctx: Pick<CarItemContext, 'live' | 'artworkFor' | 'playFor'>,
  full: boolean,
): Promise<boolean> {
  const t = i18n.t.bind(i18n);
  const { generatedAt, ...body } = buildCarSnapshot(
    { generatedAt: new Date().toISOString(), labels: carLabels(t), ...input },
    {
      t,
      defaultRate: listenerSettings().defaultRate,
      isDownloaded: (ref) => !!downloadedEntryOf(ref),
      ...ctx,
    },
  );
  // Serialized once: the body is what is compared, and the date goes in front of it.
  if (snapshotOwner() !== owner) return false;
  const bodyJson = JSON.stringify(body);
  if (bodyJson === lastBody) return true;
  if (
    await carNative.setSnapshot(
      `{"generatedAt":${JSON.stringify(generatedAt)},${bodyJson.slice(1)}`,
    )
  ) {
    lastBody = bodyJson;
    if (ownerStored !== owner) {
      await setItem(SNAPSHOT_OWNER_KEY, owner);
      ownerStored = owner;
    }
    if (full && wroteBefore !== true) {
      wroteBefore = true;
      void setItem(WRITTEN_KEY, true);
    }
    return true;
  }
  return false;
}

/** The downloaded books of `conns` (the person listening's servers), as the car lists them. */
function downloadBooks(
  conns: readonly Connection[],
  progressOf: (ref: BookRef) => Progress | null,
): CarBook[] {
  return downloadedEntries(
    useDownloads.getState().entries,
    conns.map((c) => c.id),
  ).map((e): CarBook => {
    const ref = bookRefOf(e);
    return { ref, book: e.manifest.book, progress: progressOf(ref) };
  });
}

/** Every book the tabs list, once by content key (the entry that has its `Book` wins). */
function uniqueBooks(books: CarSnapshotInput['books']): Map<string, CarBook> {
  const all = new Map<string, CarBook>();
  for (const b of Object.values(books).flatMap((list) => list ?? [])) {
    const key = contentKeyOf(b.ref);
    const had = all.get(key);
    if (!had || (!had.book && b.book)) all.set(key, b);
  }
  return all;
}

/** The book a resumption is offered, kept across launches (`RESUMABLE_KEY`; undefined until
 * read) with whether it was offered to a kids profile: a launch that loads no book offers it
 * again, so opening the app after a kill without playing never takes away what a headset's
 * play resumes. */
type KeptBook = BookRef & { kids?: boolean };
let resumableRef: KeptBook | null | undefined;
/** The player has held a book in this runtime: from then on only the loaded book is offered,
 * and none once it was stopped or finished. */
let loadedHere = false;

/**
 * The book a playback resumption starts (Android; the snapshot's `resume`, both the full and
 * the minimal one's): the loaded book while it is neither stopped nor finished (`live`), unless
 * the engine plays another book the store has not adopted (`engineOtherBook`: the car's, the
 * store's book shown paused once its adoption was overdue), which is the one heard and so the
 * one resumed; with none loaded yet in this runtime, the book offered before (`RESUMABLE_KEY`)
 * while it is still the person listening's, and kids mode is as it was (a book offered before
 * kids mode was turned on may not be on the kids shelf). Never the newest Continue listening
 * row: a book stopped or finished here stays stopped at a headset's play.
 */
async function resumableBook(player: PlayerState, live: LivePlace | null): Promise<BookRef | null> {
  if (player.nowPlaying) loadedHere = true;
  if (resumableRef === undefined) {
    const stored = await getItem<KeptBook>(RESUMABLE_KEY);
    resumableRef = stored
      ? { ...stored, connectionId: resolveConnectionId(stored.connectionId) }
      : null;
  }
  if (live) {
    // Another person's book is never named: the car sync stops it (`checkLoadedBook`).
    const heard = engineOtherBook();
    return heard && mayActFor(heard.connectionId) ? heard : live.ref;
  }
  const kept = loadedHere ? null : resumableRef;
  return kept && !!kept.kids === !!activeProfile()?.kids && mayActFor(kept.connectionId)
    ? bookRefOf(kept)
    : null;
}

/** Keeps the book a written snapshot offers (`resumableBook`) for the next launch. */
async function keepResumable(offered: BookRef | null): Promise<void> {
  const kids = !!activeProfile()?.kids;
  const kept = resumableRef;
  const same = offered
    ? !!kept && contentKeyOf(kept) === contentKeyOf(offered) && !!kept.kids === kids
    : kept === null;
  if (same) return;
  resumableRef = offered ? { ...offered, kids } : null;
  await setItem(RESUMABLE_KEY, resumableRef);
}

/**
 * Android, on a phone no car has met (fe#251): Bluetooth or a headset's play after the app was
 * killed resumes the book the car snapshot names for it (`resume`) when it has a play spec
 * (`ResumptionReceiver`), so a snapshot that holds the book being listened to is written on
 * every pause, stop and book change all the same. Minimal: the loaded book at its live place
 * (paused, its spec starts there; with none loaded yet in this runtime, the book offered
 * before, `RESUMABLE_KEY`) and the downloaded books (a kids profile's loaded story only), the
 * progress rows the app last read standing in for the servers'. No server is read, no cover
 * fetched or pruned (a downloaded book's own cover file only), and no timer is waited on, so
 * a pause made in the background, where Android holds the JS timers, still writes it. Once a
 * car has been seen the full snapshot takes over.
 */
async function buildResumable(): Promise<void> {
  // The start's read of `CAR_SEEN_KEY` too: never this one over a car-seen phone's full one.
  await Promise.all([bootstrapPlayback(), carSeenRead]);
  if (carSeen || sessionHydrateFailed()) return;
  const owner = snapshotOwner();
  const conns = profileConnections();
  const player = usePlayer.getState();
  const live = livePlaceOf(player);
  const offered = await resumableBook(player, live);
  const kids = !!activeProfile()?.kids;
  const { rows, known } = await progressRows(conns, 'cacheOnly');
  const progressOf = progressLookup(rows);
  const listed: CarBook[] = offered
    ? [
        {
          ref: offered,
          book: downloadedEntryOf(offered)?.manifest.book ?? null,
          progress: progressOf(offered),
        },
      ]
    : [];
  const books: CarSnapshotInput['books'] = {
    continue: listed,
    upnext: null,
    downloads: kids ? null : downloadBooks(conns, progressOf),
    library: null,
  };
  const plays = await playSpecs(uniqueBooks(books), known, progressOf, pausedPlaceOf(player, live));
  // A car met meanwhile: its full snapshot is due, never this one over it.
  if (carSeen) return;
  const handed = await handOver(
    owner,
    { signedIn: conns.length > 0, books, resume: offered },
    {
      live,
      artworkFor: (ref) => downloadedEntryOf(ref)?.manifest.coverUri ?? null,
      playFor: (ref) => plays.get(contentKeyOf(ref)),
    },
    false,
  );
  if (handed) await keepResumable(offered);
}

async function buildAndWrite(reads: ReadMode): Promise<void> {
  const owner = snapshotOwner();
  // The session's connections never loaded (a locked keychain at a CarPlay launch): the
  // snapshot native kept is better than a signed-out one (its downloads still play).
  if (sessionHydrateFailed()) return;
  const t = i18n.t.bind(i18n);
  // The person listening on this device: the car lists their servers only (Phase 8).
  const conns = profileConnections();
  const signedIn = conns.length > 0;
  const player = usePlayer.getState();
  const live = livePlaceOf(player);

  // A kids profile: its kids shelf only, on the connection kids mode shows (Phase 8b-1).
  const profile = activeProfile();
  const kids = profile?.kids ?? null;
  // On `conns` (the session's order), as kids mode picks it (`useKidsStories`).
  const kidsCid = kids
    ? kidsConnectionId(
        conns.map((c) => c.id),
        kids,
      )
    : null;
  const kidsConn = conns.find((c) => c.id === kidsCid) ?? null;
  // The kids shelf reads alongside the progress (only the stories in progress wait for it).
  const kidsRead = signedIn && kids && kidsConn ? readKidsShelf(kidsConn, kids, reads) : null;
  const [{ rows, known }, queue, library] = !signedIn
    ? [{ rows: [], known: new Set<string>() }, null, null]
    : kids
      ? [await progressRows(kidsConn ? [kidsConn] : [], reads), null, null]
      : await Promise.all([progressRows(conns, reads), upNextEntries(reads), libraryBooks(reads)]);
  // Signed in, yet no server's list could be read or found cached (a fresh runtime away from
  // every server: the car's offline case): the snapshot native kept from last time is better
  // than one with empty lists, and its covers are still wanted. Nothing is written or pruned
  // until a server's lists can be read, unless the owner changed or is unknown. Then write
  // the current person's downloads so native cannot start the previous person's books.
  if (signedIn && known.size === 0) {
    wroteBefore ??= (await getItem<boolean>(WRITTEN_KEY)) === true;
    if (wroteBefore && (await getItem<string>(SNAPSHOT_OWNER_KEY)) === owner) return;
  }
  const progressOf = progressLookup(rows);

  const books: CarSnapshotInput['books'] = kids
    ? await kidsBooks(kidsConn, kids, await kidsRead, rows, live, progressOf)
    : await everyoneBooks(rows, live, queue, library, conns, progressOf, reads);

  // Every book any tab lists, once: its play spec (downloaded only) and its cover.
  const all = uniqueBooks(books);

  // iOS never starts a book without JS (CarPlay asks JS for every book): no play specs, and
  // no book for a resumption.
  const android = Platform.OS === 'android';
  const plays = android
    ? await playSpecs(all, known, progressOf, pausedPlaceOf(player, live))
    : null;
  const resume = android ? await resumableBook(player, live) : undefined;

  // Covers: a downloaded book's own cover file as it is (no network, no copy); any other's
  // a small JPEG written under the car artwork folder (one folder read per snapshot).
  const onDisk = artworkOnDisk();
  const names = new Set<string>();
  const artwork = new Map<string, string | null>();
  const missing = new Map<string, ArtworkJob>();
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
    missing.set(key, { name, url, headers: client.proxyHeadersFor(url) });
  }

  const handed = await handOver(
    owner,
    {
      signedIn,
      books,
      ...(resume === undefined ? {} : { resume }),
      // The kids shelf is the Library tab, under kids mode's own heading.
      ...(kids ? { titles: { library: t('kids.stories.title') } } : {}),
    },
    {
      live,
      artworkFor: (ref) => artwork.get(contentKeyOf(ref)) ?? null,
      playFor: (ref) => plays?.get(contentKeyOf(ref)),
    },
    true,
  );
  if (!handed) return;
  if (resume !== undefined) await keepResumable(resume);
  pruneArtwork(names, onDisk);
  missingArtwork = missing;
}

/** Everyone else's car books: Continue listening (Home's rule, every server of the person
 * listening), Up next, their downloads and the selected library's recently added. */
async function everyoneBooks(
  rows: SourcedProgress[],
  live: LivePlace | null,
  queue: { cid: string; entries: QueueEntry[] } | null,
  library: { cid: string; books: Book[] } | null,
  conns: readonly Connection[],
  progressOf: (ref: BookRef) => Progress | null,
  reads: ReadMode,
): Promise<CarSnapshotInput['books']> {
  const continuing = continueRefs(rows, live?.ref ?? null);
  const continueBooks = await mapLimit(
    continuing,
    ITEM_CONCURRENCY,
    async ({ ref, progress }): Promise<CarBook> => ({
      ref,
      book: await itemOf(ref, reads),
      progress,
    }),
  );
  const upNextBooks: CarBook[] | null = queue
    ? queue.entries.map((e) => {
        const ref = { connectionId: queue.cid, libraryId: e.library_id, path: e.path };
        return { ref, book: e.book ?? null, progress: progressOf(ref) };
      })
    : null;
  const downloads = downloadBooks(conns, progressOf);
  const libraryList: CarBook[] = library
    ? library.books.map((b) => {
        const ref = { connectionId: library.cid, libraryId: b.library_id, path: b.rel_path };
        return { ref, book: b, progress: progressOf(ref) };
      })
    : [];
  return { continue: continueBooks, upnext: upNextBooks, downloads, library: libraryList };
}

/** Write the covers the last snapshot lacked, then ask for a snapshot that names them. */
async function fetchMissingArtwork(): Promise<void> {
  const jobs = [...missingArtwork.values()];
  missingArtwork = new Map();
  if (jobs.length === 0) return;
  const written = await mapLimit(jobs, ARTWORK_CONCURRENCY, (j) =>
    ensureArtwork(j.name, j.url, j.headers),
  );
  if (written.some(Boolean)) request(false);
}

// --- The schedule -----------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let dueAt = 0;
let writing = false;
let again: boolean | null = null;
let lastWriteAt = 0;
/** Every snapshot write, the full and the resumable one, in the order asked: the last asked
 * lands last. */
const snapshotWrites = serialQueue();

/** Ask for the full snapshot (none before a car was seen on this device): `soon` (a car
 * connected, a book started or paused) as soon as the gap allows, else after `SETTLE_MS`.
 * Requests while one is pending join it (a sooner one moves it earlier); a request while one
 * is being written runs once it is done. */
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

/** A resumption's write (`writeForResumption`) was asked while one was under way: it runs
 * right after that one, with no timer either. */
let resumptionAgain = false;

/** Builds and writes the full snapshot; `cached`: a resumption's (`ReadMode`). */
async function write(cached = false): Promise<void> {
  timer = null;
  writing = true;
  try {
    // Never build from stores the launch steps haven't hydrated yet: a car connect replayed
    // as the listener registers (the root layout's path doesn't wait for them) would write a
    // signed-out snapshot over the good one and prune every cover it no longer names.
    await bootstrapPlayback();
    await snapshotWrites(() => buildAndWrite(cached ? 'cached' : 'fresh'));
  } catch (err) {
    console.warn('[car] snapshot failed', err);
  } finally {
    // The gap is between writes a car shows: a resumption's, made with none connected, never
    // holds back the fresh build of a car that connects right after it.
    if (!cached || isCarConnected()) lastWriteAt = Date.now();
    writing = false;
  }
  void fetchMissingArtwork();
  // A car connected meanwhile: its fresh build goes the usual way (`again`).
  const resumption = resumptionAgain && !isCarConnected();
  resumptionAgain = false;
  if (resumption) {
    again = null;
    void write(true);
  } else if (again !== null) {
    const soon = again;
    again = null;
    request(soon);
  }
}

/** Android, a car met before and none connected now: the full snapshot for a resumption (a
 * pause, a stop, another book), at once and from the cache (`ReadMode`), never on a timer
 * (Android holds the JS timers in the background, where a headset or lock-screen pause
 * happens) nor after a server read. No car shows it, so `MIN_GAP_MS` does not apply. */
function writeForResumption(): void {
  if (!active) return;
  if (writing) {
    again = true;
    resumptionAgain = true;
    return;
  }
  if (timer) clearTimeout(timer);
  void write(true);
}

/** Android: the listener paused, stopped, moved a paused book or changed book. With a car
 * connected, the full snapshot as soon as the gap allows; with one met before but none
 * connected, the full one at once (`writeForResumption`), so the one native keeps for a
 * resumption names that book at that place; else the resumable one, at once
 * (`buildResumable`). */
function placeChanged(): void {
  if (Platform.OS !== 'android') return;
  if (!carSeen) resumableChanged();
  else if (isCarConnected()) request(true);
  else writeForResumption();
}

/** A resumable write is queued and has not started: a burst of changes joins it. */
let resumableQueued = false;

/** Android, no car met yet: what the resumable snapshot holds changed (the person listening,
 * their servers, the downloads, the place). Queued behind any write under way; a request
 * while one waits joins it, since the build reads the stores when it runs. A car met before:
 * the full snapshot's own requests cover it. */
function resumableChanged(): void {
  if (!active || Platform.OS !== 'android' || carSeen || resumableQueued) return;
  resumableQueued = true;
  void snapshotWrites(() => {
    resumableQueued = false;
    return buildResumable();
  }).catch((err) => {
    console.warn('[car] resumable snapshot failed', err);
  });
}

// --- Play requests ------------------------------------------------------------------------

/**
 * The car item ids of play requests native gave up on (`onCarPlayCancel`), each with whether
 * another play took its place (the car's tap on another book, or on the loaded book, which
 * native played on) rather than its wait for the load running out (a slow or frozen server
 * holding the start). Android released a media button start's foreground service then, so a
 * start that went on to play would be heard in the background with no notification and no
 * controls: one still on its way stops before the load, or loads paused (`StartHow.wanted`),
 * and an episode still being fetched for it never starts (`requestEpisodeFetch`). One another
 * play replaced loads nothing (`StartHow.superseded`, fe#350: the last tap wins). A new
 * request for the same book takes the mark off, so a start it joins plays again. Kept when
 * the sync stops (`teardown`): a start called off before it is still on its way, and must not
 * read as wanted again.
 */
const cancelledPlays = new Map<string, boolean>();

/** The marks (`cancelledPlays`) on `id`'s book: its own, and one under another id of the same
 * book (an item of a snapshot written before the identity migration names the old connection
 * id), which a start of either joins (`startBookInPlace` joins by book). */
function marksOn(id: string): string[] {
  const book = bookOfItem(id);
  return [...cancelledPlays.keys()].filter((mark) => bookOfItem(mark) === book);
}

/** The book a car item id names (its content key), or the id itself when it names none. Read
 * at each check, never when a mark goes in: a cancel may come before the aliases load. */
function bookOfItem(id: string): string {
  const ref = parseCarItemId(id);
  return ref ? contentKeyOf(ref) : id;
}

/** The car asked to play a book (its item id). */
export async function handleCarPlayRequest(id: string): Promise<void> {
  for (const mark of marksOn(id)) cancelledPlays.delete(mark);
  const wanted = () => marksOn(id).length === 0;
  const superseded = () => marksOn(id).some((mark) => cancelledPlays.get(mark));
  if (!parseCarItemId(id)) {
    console.warn('[car] not a car item id', id);
    return;
  }
  // A tap queued natively while JS booted is replayed as the listener registers, which on
  // the root layout's path comes before the launch steps hydrated the session and the
  // downloads: started then, the book would find no connection and no download.
  await bootstrapPlayback();
  // Called off while JS booted: nothing happens for it, the cast's end below included.
  if (!wanted()) return;
  // Read again now the aliases are loaded: an item of a snapshot written before the identity
  // migration names the old connection id.
  const ref = parseCarItemId(id)!;
  // Casting: a play the car asks for plays in the car, never on the TV it would not hear (and
  // the car would show nothing playing). The cast ends with its place brought back here
  // first (`endCastForCar`); ending it beats refusing, since the listener is in the car and
  // a refusal there leaves a driver with silence to sort out. Another person's book is left
  // to the start below, which refuses it, so their cast is not ended for nothing.
  if (mayActFor(ref.connectionId)) {
    await endCastForCar().catch((err) => console.warn('[car] could not end the cast', err));
  }
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (np && contentKeyOf(np) === contentKeyOf(ref)) {
    // The loaded book plays on from where it is (never restarted); an ended or failed one
    // starts again through the resume lookup like any other.
    const state = player.snapshot.state;
    if (selectIsTransportLive(player)) return;
    if (state !== 'ended' && state !== 'error') {
      if (!wanted()) return;
      await player.toggle().catch((err) => console.warn('[car] play failed', err));
      return;
    }
  }
  if (!wanted()) return;
  // An item of a snapshot written before a switch may name another person's book: the
  // start refuses it (`mayActFor`), quietly.
  let started = false;
  try {
    started = await startBookInPlace(ref, {}, { wanted, superseded });
    if (!started && wanted()) {
      console.warn("[car] the book can't start here (no connection, or another person's)");
    }
  } catch (err) {
    console.warn('[car] the book could not start', err);
  }
  // Gave way to a play native made in its place (fe#350): the store takes the engine's book
  // back (`checkLoadedBook`), which this start's switch let go of (its saves' server, its
  // save loop, its listening span). Called off while its place was looked up, the store
  // still names that book (the switch never set another), so it is adopted all the same;
  // nothing is adopted when the engine holds the book that gave way (called off during its
  // own load: it stays loaded, paused). A check already running read the store before the
  // switch: it ends first, and this one is never joined to it.
  if (started && superseded()) {
    while (checking) await checking;
    await checkLoadedBook(ref);
  }
}

// --- Bookmarks ------------------------------------------------------------------------------

/** A bookmark placed on its book's timeline: in its file (`trackId`, the file's path-keyed
 * track id, and the seconds in it) with the whole-book place read then, or (no file known: one
 * kept before fe#146) at only a whole-book place. */
type PlacedBookmark = BookRef &
  ({ position: number } | { trackId: string; positionInTrack: number; position: number });

/** A press at the engine's file coordinates: the file's index in the engine's order at the
 * press and the seconds in it, and the file's track id when the binary named its path
 * (`relPath`, fe#185; a press an older binary kept has none). */
type EngineBookmark = BookRef & { trackIndex: number; positionInTrack: number; trackId?: string };

/** A bookmark to add: placed (pressed while the book was loaded here, or kept from a try that
 * read its place), or at the engine's file coordinates (pressed while no JS ran, or on the
 * book the engine names) until its book's timeline is read. */
type CarBookmark = PlacedBookmark | EngineBookmark;

/** The part of a book's queue a place on its timeline is read through. */
type Timeline = Pick<BookQueue, 'tracks' | 'offsets'>;

/** The book's timeline now: the loaded book's queue, else the book's own (`bookSourceOf`: the
 * downloaded copy's, else its item and chapters; only the downloaded copy's when `onDevice`,
 * never asking the server). Null when none can be read now (offline, not downloaded). */
async function timelineOf(b: BookRef, onDevice = false): Promise<Timeline | null> {
  const np = usePlayer.getState().nowPlaying;
  if (np && contentKeyOf(np) === contentKeyOf(b)) return np.queue;
  const source = onDevice ? downloadedSourceOf(b) : await bookSourceOf(b).catch(() => null);
  return source ? buildBookQueue(null, b.libraryId, source.book, source.chapters) : null;
}

/** A bookmark placed on its book's timeline now (`timelineOf`). One kept in its file is read in
 * the order the book's files are in now (`trackIndexById`), on the device only (the loaded
 * queue, else the download's: the order that moves under it is a download's, fe#146, and a
 * try never waits on the server before its send), so a download that took the server's order
 * since still puts it in its file; the whole-book place read before stands for a book that no
 * longer holds the file, or that is neither loaded nor downloaded. Null when a place in the
 * engine's file coordinates can't be read now. */
async function placeOf(b: CarBookmark): Promise<PlacedBookmark | null> {
  const ref = bookRefOf(b);
  if ('trackIndex' in b) {
    const timeline = await timelineOf(b);
    return timeline && placedIn(ref, timeline, engineIndexOn(timeline, b), b.positionInTrack);
  }
  if ('trackId' in b) {
    const timeline = await timelineOf(b, true);
    const index = timeline ? trackIndexById(timeline, b.trackId) : -1;
    const position =
      timeline && index >= 0
        ? toBookPosition(timeline.offsets, index, b.positionInTrack)
        : b.position;
    return { ...ref, trackId: b.trackId, positionInTrack: b.positionInTrack, position };
  }
  return { ...ref, position: b.position };
}

/** A press's file on `timeline`: the file it names by path when the timeline holds it (the
 * order the book's files are in now can differ from the engine's at the press: an adoption
 * reloads the engine in the download's order, fe#185), else its index in the engine's order
 * (a press an older binary made, or a file the book no longer holds). */
function engineIndexOn(timeline: Timeline, b: Pick<EngineBookmark, 'trackIndex' | 'trackId'>) {
  const byId = b.trackId === undefined ? -1 : trackIndexById(timeline, b.trackId);
  return byId >= 0 ? byId : b.trackIndex;
}

/** A place in file coordinates on `timeline`, kept by its file when the timeline names one. */
function placedIn(
  ref: BookRef,
  timeline: Timeline,
  trackIndex: number,
  positionInTrack: number,
): PlacedBookmark {
  const position = toBookPosition(timeline.offsets, trackIndex, positionInTrack);
  const trackId = timeline.tracks[trackIndex]?.id;
  return trackId === undefined
    ? { ...ref, position }
    : { ...ref, trackId, positionInTrack, position };
}

/** Add one: null when it is finished with (added, its connection is gone, or the server
 * refused it), else the bookmark to try again (its server can't be reached, or its place
 * can't be read yet). The one kept is at the place read now whenever one could be
 * (`placeOf`): kept in the engine's file coordinates it would be read later through whatever
 * order the book's files are in then (a download that took the server's order since), and
 * kept at only a whole-book place it would be read on the new order's timeline, where the
 * files can differ in length (fe#146); either can be another file's. */
async function addCarBookmark(b: CarBookmark): Promise<CarBookmark | null> {
  // No connection: gone for good once the session has loaded, else (a session that failed
  // to load: a CarPlay launch with the phone locked) kept until it has.
  const connected = resolveClient(b.connectionId) !== null;
  if (!connected && sessionReady()) return null;
  // Kept in its file already: it is read through the book's order when it can be sent.
  if (!connected && 'trackId' in b) return b;
  const placed = await placeOf(b);
  if (placed === null) return b;
  if (!connected) return placed;
  try {
    // No label: the car's bookmark is a plain one, so nothing waits on `annotations`.
    const position = Math.round(Math.max(0, placed.position));
    await addBookmark(b.connectionId, b.libraryId, b.path, position);
    return null;
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      console.warn('[car] the server refused a bookmark', err);
      return null;
    }
    return placed;
  }
}

function isCarBookmark(v: unknown): v is CarBookmark {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (
    typeof b.connectionId !== 'string' ||
    typeof b.libraryId !== 'number' ||
    typeof b.path !== 'string'
  ) {
    return false;
  }
  if ('trackIndex' in b) {
    return (
      typeof b.trackIndex === 'number' &&
      typeof b.positionInTrack === 'number' &&
      (b.trackId === undefined || typeof b.trackId === 'string')
    );
  }
  return 'trackId' in b
    ? typeof b.trackId === 'string' &&
        typeof b.positionInTrack === 'number' &&
        typeof b.position === 'number'
    : typeof b.position === 'number';
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
    // A kept one is read back here, so an old connection id in it (kept before the identity
    // migration) reads as its new one, now the aliases are loaded. The fresh ones come
    // through the native adapter, which resolved theirs (`car-native.native.ts`).
    const kept = Array.isArray(stored)
      ? stored
          .filter(isCarBookmark)
          .map((b) => ({ ...b, connectionId: resolveConnectionId(b.connectionId) }))
      : [];
    const todo = [...kept, ...fresh];
    if (todo.length === 0) return;
    const retry: CarBookmark[] = [];
    for (const b of todo) {
      const again = await addCarBookmark(b);
      if (again) retry.push(again);
    }
    if (retry.length > 0 || kept.length > 0) await setItem(RETRY_KEY, retry);
  });
}

/** A press at the engine's file coordinates, with its file's track id when the binary named
 * the file (fe#185). */
const atEngine = (
  ref: BookRef,
  trackIndex: number,
  positionInTrack: number,
  relPath: string | undefined,
): EngineBookmark => ({
  ...bookRefOf(ref),
  trackIndex,
  positionInTrack,
  ...(relPath ? { trackId: trackIdOf(ref.libraryId, relPath) } : {}),
});

const fromPending = (p: PendingBookmark): CarBookmark =>
  atEngine(p, p.trackIndex, p.position, p.relPath);

/** The bookmarks pressed while no JS ran (and any kept ones), added now. */
async function drainCarBookmarks(): Promise<void> {
  const pending = await carNative.consumePendingBookmarks();
  await addBookmarks(pending.map(fromPending));
}

/** A bookmark pressed outside the app while JS runs, at the engine's place. When the engine
 * names its book (a binary that knows `load`'s book), it goes on THAT book at the engine's file place
 * (`placeOf` maps it through the loaded queue when that is the book, else the book's own
 * timeline): the engine can hold a book the store has not adopted yet (a car start the JS
 * boot is still adopting), and it is the one the listener heard. Without one (an older
 * binary) it goes on the book loaded here, at its file and whole-book place taken now
 * (`placedIn`); a press with none loaded is dropped. Either way the file goes by the path the
 * binary names when it names one (`engineIndexOn`, fe#185). */
function onBookmarkPressed(
  trackIndex: number,
  positionInTrack: number,
  book?: BookRef,
  relPath?: string,
): void {
  if (book) {
    noteInteraction();
    void addBookmarks([atEngine(book, trackIndex, positionInTrack, relPath)]);
    return;
  }
  const np = usePlayer.getState().nowPlaying;
  if (!np) return;
  noteInteraction();
  const index = engineIndexOn(np.queue, atEngine(np, trackIndex, positionInTrack, relPath));
  void addBookmarks([placedIn(bookRefOf(np), np.queue, index, positionInTrack)]);
}

// --- Adopting -------------------------------------------------------------------------------

let checking: Promise<void> | null = null;
/** The engine changed while a check was running (`checkServiceChange`): that check may have
 * read the engine before the change, so the engine is read again once it ends. */
let checkAgain = false;

/**
 * Android: when the playback service holds a book the player store doesn't (the car started
 * it, or it kept playing while JS restarted), adopt it. Never while a book the store started
 * is still loading (the service then still reports the previous one), and never when the
 * store changed its book while the service was asked (a book finished or stopped: the
 * service is about to drop the one it reported, which must not come back). `gaveWay`: a car
 * start of that book gave way to the engine's (`handleCarPlayRequest`, fe#350); its switch let
 * the store's book go, so the engine's book is adopted even when the store names it, unless
 * it is the one that gave way.
 */
function checkLoadedBook(gaveWay?: BookRef): Promise<void> {
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
      // Another person's book (a play spec of an older snapshot that native started with no
      // JS): never adopted, and stopped here, since nothing else would stop it (the store
      // has no book to stop). Its id may be a legacy one (`resolveConnectionId`).
      const refused = (b: { connectionId: string }) =>
        !mayActFor(resolveConnectionId(b.connectionId));
      const player = usePlayer.getState();
      if (player.loadingBook || player.nowPlaying !== asked.nowPlaying) return;
      if (refused(loaded)) {
        await carNative.stopPlayback?.();
        request(true);
        return;
      }
      const named = !!player.nowPlaying && contentKeyOf(player.nowPlaying) === contentKeyOf(loaded);
      if (named && (!gaveWay || contentKeyOf(gaveWay) === contentKeyOf(loaded))) return;
      // Read again once the book's source is read (the engine plays on meanwhile).
      if (await player.adoptLoaded(loaded, () => carNative.getLoadedBook())) {
        request(true);
        return;
      }
      const current = await carNative.getLoadedBook();
      if (refused(loaded)) {
        // The person switched while the adoption read the book: stop it if still loaded.
        if (current && refused(current)) await carNative.stopPlayback?.();
      } else if (current && !sameLoad(current, loaded)) {
        // The engine holds another book (or file order) than the one the adoption read and
        // gave up on. No change of the store's may ever say so (it holds the engine's reports
        // of an outside play's book until that is adopted), so the engine is read again.
        checkAgain = true;
      }
    } catch (err) {
      console.warn('[car] adopting the loaded book failed', err);
    }
    // Cleared once the check is over, never inside it: a body that returned before its
    // first await would clear `checking` before `??=` stored the promise, which then stayed
    // set for good and every later check returned it without asking native again.
  })().finally(() => {
    checking = null;
    if (checkAgain) {
      checkAgain = false;
      void checkLoadedBook();
    }
  });
  return checking;
}

/** Two reads of the engine's book that name the same book in the same file order. */
const sameLoad = (a: LoadedBook, b: LoadedBook): boolean =>
  contentKeyOf(a) === contentKeyOf(b) && (a.files ?? []).join('\n') === (b.files ?? []).join('\n');

/**
 * The engine may hold another book now (`mayBeServiceChange`): checked. A check already
 * running may have read the engine before this change (its adoption reads the book for
 * seconds, and gives up when the engine holds another by then), and joining it would ask
 * nothing of the book the engine holds now: the engine is read again once that check ends.
 */
function checkServiceChange(): void {
  if (checking) checkAgain = true;
  else void checkLoadedBook();
}

type PlayerState = ReturnType<typeof usePlayer.getState>;

/**
 * Whether an engine change may be the playback service's own (Android: the car, or a
 * resumption, loaded another queue under the book the store holds): the engine moved to
 * another file, or started playing, on the same loaded book with no book of the store's
 * loading; or, after playback stopped in `error`, was asked to play from outside the app
 * (`loading`: the store follows it as a press, `followsOutsidePlay`), which may be another
 * book the service started, adopted at once as that play rather than paused by the store's
 * watchdog when it takes longer than its grace to start. The store's own changes ask nothing:
 * its book switch (a new `nowPlaying`), its load (`loadingBook` set, or just cleared), its
 * stop or finish (no book), a pause or a stall, its own Retry or play after playback stopped
 * (the same `error` to `loading` turn, with no play followed from outside). An engine whose
 * reports name their book (`reportedBook`) tells of another book's changes apart, the store
 * holding none of them (`onOtherBookReported`); the changes here are then its own book's
 * (another queue of it), or any book's from an older binary, whose reports name none.
 */
function mayBeServiceChange(s: PlayerState, prev: PlayerState): boolean {
  if (Platform.OS !== 'android' || !s.nowPlaying || s.nowPlaying !== prev.nowPlaying) return false;
  if (s.loadingBook || prev.loadingBook) return false;
  return (
    s.snapshot.trackIndex !== prev.snapshot.trackIndex ||
    (s.snapshot.state === 'playing' && prev.snapshot.state !== 'playing') ||
    (s.snapshot.state === 'loading' && prev.snapshot.state === 'error' && followsOutsidePlay())
  );
}

/** The loaded book, paused, moved (a second or more) or changed speed: its paused place, the
 * one a resumption starts from (`pausedPlaceOf`), is another. */
function pausedMove(s: PlayerState, prev: PlayerState): boolean {
  return (
    !!s.nowPlaying &&
    s.snapshot.state === 'paused' &&
    prev.snapshot.state === 'paused' &&
    (Math.abs(selectBookPosition(s) - selectBookPosition(prev)) >= 1 || s.rate !== prev.rate)
  );
}

// --- Start and stop -------------------------------------------------------------------------

/** The sync's connection listener: records the state, and on a connect runs the connect path. */
function onConnection(connected: boolean): void {
  setCarConnected(connected);
  if (connected) carConnected();
  else carListed = null;
}

/** A car connected: remember a car has been seen here, write a fresh snapshot and check for a
 * book the service loaded. */
function carConnected(): void {
  if (!carSeen) {
    carSeen = true;
    void setItem(CAR_SEEN_KEY, true);
  }
  request(true);
  void checkLoadedBook();
}

/** Resolves once the last start's first steps (bootstrap, adopt, the bookmark drain) ran. */
export function carSyncReady(): Promise<void> {
  return ready;
}

/** Whether a book downloaded in both registries has other chapters in `next` (a chapters
 * refresh, `refreshedChapters`, or a start's, `adoptStartedChapters`, which can also give
 * its files a new play order): its play spec is built from them (`playSpec`), and a
 * refresh changes no download's status. */
function chaptersChanged(
  next: Record<string, DownloadEntry>,
  prev: Record<string, DownloadEntry>,
): boolean {
  return Object.entries(next).some(([k, e]) => {
    const was = prev[k];
    return (
      e.status === 'downloaded' &&
      was?.status === 'downloaded' &&
      e.manifest.chapters !== was.manifest.chapters
    );
  });
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
    carNative.onConnection(onConnection),
    carNative.onPlayRequest((id) => void handleCarPlayRequest(id)),
    carNative.onPlayCancel((id, replaced) => void cancelledPlays.set(id, replaced)),
    carNative.onBookmark(onBookmarkPressed),
    usePlayer.subscribe((s, prev) => {
      if (s.nowPlaying || prev.nowPlaying) loadedHere = true;
      const otherBook = selectBookKey(s) !== selectBookKey(prev);
      // A car is connected now: a book starting or pausing rebuilds the snapshot (a connect
      // builds a fresh one anyway).
      if (isCarConnected() && (otherBook || selectIsPlaying(s) !== selectIsPlaying(prev))) {
        request(true);
      } else if (
        otherBook ||
        (selectIsTransportLive(prev) && !selectIsTransportLive(s)) ||
        pausedMove(s, prev)
      ) {
        // Else, on Android, a pause, a stop, a paused book moved (a seek, a chapter skip,
        // another device's place picked up) or another book: what a resumption plays.
        placeChanged();
      }
      if (mayBeServiceChange(s, prev)) checkServiceChange();
    }),
    // The engine reports another book than the store's (the store holds none of it): the
    // service may have started it (Android).
    onOtherBookReported(() => {
      if (Platform.OS === 'android') checkServiceChange();
    }),
    useDownloads.subscribe((s, prev) => {
      if (s.entries === prev.entries) return;
      const sig = statusSignature(s.entries);
      if (sig === downloadsSig && !chaptersChanged(s.entries, prev.entries)) return;
      downloadsSig = sig;
      request(false);
      resumableChanged();
    }),
    useSession.subscribe((s, prev) => {
      if (s.connections !== prev.connections || s.defaultConnectionId !== prev.defaultConnectionId)
        request(false);
      if (s.connections !== prev.connections) resumableChanged();
    }),
    // Another person on this device, or kids mode turned on or off (or its library
    // changed): their lists, at once (a fresh build, as on a connect).
    useProfiles.subscribe((s, prev) => {
      if (
        s.activeProfileId !== prev.activeProfileId ||
        JSON.stringify(activeProfile(s)?.kids) !== JSON.stringify(activeProfile(prev)?.kids)
      ) {
        // The library the car listed was the previous person's (D9 holds it for one).
        carListed = null;
        request(true);
        resumableChanged();
      }
    }),
    useLibrarySelection.subscribe((s, prev) => {
      if (s.selection !== prev.selection) request(false);
    }),
    // The speed and the chapter interval a downloaded book's play spec starts with: the
    // resumable snapshot's too, so a headset's play after a kill uses the new ones.
    useSettings.subscribe((s, prev) => {
      if (
        s.defaultRate !== prev.defaultRate ||
        s.virtualChapterInterval !== prev.virtualChapterInterval
      ) {
        request(false);
        resumableChanged();
      }
    }),
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const key = event.query.queryKey;
      if (isQueueKey(key) || isAllProgressKey(key)) request(false);
      else if (kidsShelfChanged(key, event.query.queryHash, event.query.state.data)) {
        request(false);
      }
    }),
    (() => {
      // The labels, the resumable snapshot's included (the placeholder's and the car's text).
      const onLanguage = () => {
        request(true);
        resumableChanged();
      };
      i18n.on('languageChanged', onLanguage);
      return () => i18n.off('languageChanged', onLanguage);
    })(),
    onForeground(() => {
      void drainCarBookmarks();
      void checkLoadedBook();
    }),
  ];

  carSeenRead = getItem<boolean>(CAR_SEEN_KEY).then((seen) => {
    carSeen ||= seen === true;
  });
  ready = (async () => {
    try {
      await Promise.all([bootstrapPlayback(), carSeenRead]);
      if (!active) return;
      await checkLoadedBook();
      await drainCarBookmarks();
    } catch (err) {
      console.warn('[car] start failed', err);
    }
    request(true);
  })();
  // A car connected before this start (the iOS car start's listener, the first, alone heard
  // the connect native queued before JS listened, or the root layout starts late): its
  // connect path runs once here, since this listener will not hear that connect again.
  if (isCarConnected()) carConnected();
  return stop;
}

function teardown() {
  active = false;
  for (const off of stops) off();
  stops = [];
  if (timer) clearTimeout(timer);
  timer = null;
  again = null;
  checkAgain = false;
  resumptionAgain = false;
  kidsShelfSeen.clear();
  setCarConnected(false);
  carListed = null;
}

/** Tests only: stop everything and forget what was written, as if the app had just started. */
export function forgetCarSync() {
  teardown();
  cancelledPlays.clear();
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
  ownerStored = null;
  resumableQueued = false;
  carSeenRead = Promise.resolve();
  resumableRef = undefined;
  loadedHere = false;
}
