import { AppState, Platform } from 'react-native';
import { create } from 'zustand';

import { resolveClient } from '@/api/connection-clients';
import { chaptersKeyParts, chaptersQuery, itemQuery, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Book, ChaptersResponse } from '@/api/types';
import { identityMovePending } from '@/lib/connection-id';
import { contentKey, contentKeyOf } from '@/lib/content-key';
import { mapLimit } from '@/lib/map-limit';
import { getItem, setItem } from '@/lib/storage';
import { DOWNLOADS_KEY } from '@/lib/storage-keys';
import { bookFileSpecs } from '@/playback/book-queue';
import type { BookRef } from '@/playback/types';
import { webTranscodeFromCache } from '@/playback/transcode-capability';
import { cachedEbookUri } from '@/reader/ebook-file';
import { onConnectionRemoved } from '@/stores/session';

import { engine } from './engine';
import { estimateBytes, pendingBytes, roomLeft } from './keep-ahead';
import { classifyDownloadError } from './failure';
import {
  canMatch,
  captureOfflineMeta,
  currentServerSnapshot,
  forgetServerSnapshot,
  readOfflineMeta,
  readServerSnapshots,
  releaseOfflineBook,
  removeOfflineMeta,
  saveServerSnapshot,
  seedOfflineMeta,
  seedQuery,
  seedServerSnapshot,
  serverHasMetadata,
  type ServerSnapshot,
  whenSessionReady,
  writeOfflineMeta,
} from './offline-meta';
import type {
  DownloadedFile,
  DownloadEntry,
  DownloadFailure,
  DownloadManifest,
  DownloadOrigin,
  DownloadOutcome,
  StorageEstimate,
} from './types';

export const downloadKey = contentKey;

type Registry = Record<string, DownloadEntry>;

// Module-level orchestration (mirrors src/playback/store.ts): one book downloads at a
// time; further requests wait in `queue` (the running one is taken off it first). The
// client is resolved per entry at run time (see runOne), so queued downloads from
// different servers each use their own server's client - the old single module-level
// apiRef raced two-server downloads.
let running = false;
const queue: string[] = [];
// The running download's controller, by book. Whoever stops a run (`stopRun`) also takes
// it out, so the run can tell it is no longer the book's live one: a cancel then Download
// again queues a new entry under the same key, which the old run must never touch.
const controllers = new Map<string, AbortController>();

/** Stop a book's waiting or running download: off the queue, its transfer aborted, and
 * its run no longer the live one (it leaves the entry, and a new one, alone). */
function stopRun(key: string) {
  const idx = queue.indexOf(key);
  if (idx >= 0) queue.splice(idx, 1);
  controllers.get(key)?.abort();
  controllers.delete(key);
}

// Books whose download was cancelled or removed in this session (by the listener, or by
// "remove a download when you finish the book"). Automatic downloads skip them, so a
// book someone just removed is never fetched again behind their back; the listener
// downloading it again clears the mark. Session-only on purpose: memory, not storage.
const declined = new Set<string>();

// The launch's read of the saved registry while it runs (`hydrate`, up to its merge). The
// registry is not known yet, so `download` and `remove` wait for it (a book already on
// disk would otherwise be fetched over its own files, or removed and then put back by the
// merge), and `persist` holds off (it would save only the live entries over the saved
// registry: an app closed mid-hydrate would lose every download).
let hydrating: Promise<void> | null = null;

/** Whether this book's download was cancelled or removed earlier in this session. */
export function isDeclined(connectionId: string, libraryId: number, path: string): boolean {
  return declined.has(downloadKey(connectionId, libraryId, path));
}

type DownloadsState = {
  entries: Registry;
  hydrated: boolean;
  supported: boolean;
  hydrate: () => Promise<void>;
  /** Queue a book. `origin` says who asked (default: the listener, which also lifts a
   * cancel/remove mark from earlier in the session). An errored entry is retried,
   * keeping the files it already finished. Resolves what it did (`DownloadOutcome`); a
   * listener's request is queued at once, an automatic one after reading the room. On
   * web, a list-shape `book` (no `direct_playable`) is first looked up in full, so a
   * book this browser plays transcoded is refused whoever asks. */
  download: (
    connectionId: string,
    libraryId: number,
    book: Book,
    chapterData?: ChaptersResponse,
    origin?: DownloadOrigin,
  ) => Promise<DownloadOutcome>;
  cancel: (connectionId: string, libraryId: number, path: string) => void;
  remove: (connectionId: string, libraryId: number, path: string) => Promise<void>;
};

export const useDownloads = create<DownloadsState>()((set, get) => ({
  entries: {},
  hydrated: false,
  supported: engine.supported,

  hydrate: async () => {
    let read!: () => void;
    hydrating = new Promise<void>((r) => (read = r));
    let cleaned: Registry;
    try {
      cleaned = await readRegistry();
    } finally {
      hydrating = null;
      read();
    }
    await persist();
    // The community metadata kept with each downloaded book, seeded for offline reading
    // (and filled in for a download made before it was kept). In the background, once the
    // launch's first screens are up: the registry is usable without it.
    afterLaunch(() => void restoreOfflineMeta(Object.keys(cleaned)).catch(() => {}));

    // On web, having the Cache API isn't enough - offline files only play if the
    // service worker is actually controlling the page and serving them. Probe the
    // real path (no real download needed) and downgrade `supported` if it can't, so
    // the UI hides downloads instead of offering ones that won't play offline.
    if (engine.supported && engine.probe) {
      const servable = await engine.probe();
      if (servable !== useDownloads.getState().supported) set({ supported: servable });
    }
  },

  download: (connectionId, libraryId, book, chapterData, origin = 'listener') => {
    if (!engine.supported) return Promise.resolve<DownloadOutcome>('unsupported');
    // Until the launch has read the registry a book already on disk looks new, and its
    // download would write over (and, offline, lose) the files it has.
    const reading = hydrating;
    if (reading)
      return reading.then(() => get().download(connectionId, libraryId, book, chapterData, origin));
    // Podcast episodes are not kept offline (Bridge Phase 2d-1, decision 6.1): one not on
    // its server yet answers 503 to the download engines, and nothing would clean them up.
    if (book.episode) return Promise.resolve<DownloadOutcome>('unsupported');
    // On web, a list-shape book (`/books`, `/fs`, shelves, tiles, the queue) carries no
    // `direct_playable`, so the transcode refusal below would read it as playable and
    // download raw files this browser cannot play. Such a book is decided on its full
    // item and chapters (through the query cache, as keep-ahead's `startOne` does), which
    // also give the download its files. Native never transcodes, so it never asks.
    const client = lacksPlayability(book, chapterData) ? resolveClient(connectionId) : null;
    if (!client) return queueBook(connectionId, libraryId, book, chapterData, origin);
    return (async () => {
      const [item, chapters] = await Promise.allSettled([
        queryClient.fetchQuery({
          ...itemQuery(connectionId, client, libraryId, book.rel_path),
          staleTime: 30_000,
        }),
        queryClient.fetchQuery({
          ...chaptersQuery(connectionId, client, libraryId, book.rel_path),
          staleTime: 30_000,
        }),
      ]);
      // A lookup that failed decides on what the caller gave, as before.
      return queueBook(
        connectionId,
        libraryId,
        item.status === 'fulfilled' ? item.value : book,
        chapters.status === 'fulfilled' ? chapters.value : chapterData,
        origin,
      );
    })();
  },

  cancel: (connectionId, libraryId, path) => {
    const key = downloadKey(connectionId, libraryId, path);
    declined.add(key);
    stopRun(key);
    void engine.removeBook(connectionId, libraryId, path);
    removeEntry(key);
  },

  remove: async (connectionId, libraryId, path) => {
    // An entry the launch is still reading would come back from its merge, its files gone.
    if (hydrating) await hydrating;
    const key = downloadKey(connectionId, libraryId, path);
    declined.add(key);
    stopRun(key);
    await engine.removeBook(connectionId, libraryId, path);
    removeEntry(key);
    releaseOfflineBook(connectionId, libraryId, path);
  },
}));

// --- helpers ---------------------------------------------------------------

/** `hydrate`'s read of the saved registry: each entry relocated, checked on disk and
 * revived (or dropped and deleted), merged into the live entries and set. Returns the
 * entries it read. */
async function readRegistry(): Promise<Registry> {
  const saved = (await getItem<Registry>(DOWNLOADS_KEY)) ?? {};
  const cleaned: Registry = {};
  for (const raw of Object.values(saved)) {
    // Re-resolve stored file uris against the live storage root first: the app's
    // document-container path can change between installs/launches (notably dev
    // rebuilds), which leaves the persisted absolute uris stale even though the
    // files are still on disk. Without this the existence check below fails and
    // the book is dropped *and deleted* - the download vanishes after a rebuild.
    const e = await relocateEntry(raw);
    // Every file the entry lists must still be on disk (`reviveEntry` has the rules).
    const allPresent =
      e.manifest.files.length > 0 &&
      (await Promise.all(e.manifest.files.map((f) => engine.fileExists(f.localUri)))).every(
        Boolean,
      );
    const revived = reviveEntry(e, allPresent);
    // Key on the entry's own connection-scoped id (stale un-scoped entries from before
    // scoping were already wiped by resetStaleStorage, so every entry here has a real id).
    const key = downloadKey(e.connectionId, e.libraryId, e.path);
    if (revived?.status === 'downloaded') {
      // A chapters answer can reach the cache before this read the registry.
      const manifest = withCachedChapters(e, revived.manifest);
      cleaned[key] = manifest === revived.manifest ? revived : { ...revived, manifest };
      seedQueryCache(e.connectionId, e.libraryId, e.path, manifest);
    } else if (revived) {
      cleaned[key] = revived;
    } else if (identityMovePending()) {
      // The identity migration gave up mid-move this launch: the files can be under the
      // new id while this entry names the old one (or the reverse). Kept as stored,
      // never dropped and deleted; the launch that finishes the move finds them.
      cleaned[key] = raw;
    } else {
      void engine.removeBook(e.connectionId, e.libraryId, e.path);
    }
  }
  // Merge, don't overwrite: a live entry made during the read's async window (per-book
  // file moves and renames, fileExists probes; `download` itself waits for the read,
  // `hydrating`) would be clobbered by a blind set(cleaned) built from the stale
  // start-of-hydrate snapshot. Keep any live entry this hydrate didn't produce; the
  // hydrated/on-disk version wins on a key collision.
  const merged: Registry = { ...cleaned };
  for (const [key, entry] of Object.entries(useDownloads.getState().entries)) {
    if (!(key in merged)) merged[key] = entry;
  }
  useDownloads.setState({ entries: merged, hydrated: true, supported: engine.supported });
  return cleaned;
}

/** Put a book on the one-at-a-time queue (`download` decided it may go). An errored
 * entry is retried, keeping the files its failed attempt finished. */
/** Whether a book's playability in this browser is unknown: on web, neither the book nor
 * its chapters carry `direct_playable` (the list shape). */
function lacksPlayability(book: Book, chapterData?: ChaptersResponse): boolean {
  return (
    Platform.OS === 'web' &&
    book.direct_playable === undefined &&
    chapterData?.direct_playable === undefined
  );
}

/** `download()` once the book is known: the transcode refusal, then queue it by the
 * listener's or the automatic rules. */
function queueBook(
  connectionId: string,
  libraryId: number,
  book: Book,
  chapterData: ChaptersResponse | undefined,
  origin: DownloadOrigin,
): Promise<DownloadOutcome> {
  const done = (outcome: DownloadOutcome) => Promise.resolve(outcome);
  // A book this browser plays through the server's transcoder would download as its
  // raw files, which it can't play offline: refuse (every path - the book page, auto
  // download, keep-ahead - lands here). The UI says why (useDownloadControls, and the
  // Downloads page's row for an earlier download of it that failed).
  if (webTranscodeFromCache(connectionId, book, chapterData)) return done('transcoded');
  const key = downloadKey(connectionId, libraryId, book.rel_path);
  const existing = useDownloads.getState().entries[key];
  if (existing && existing.status !== 'error') return done('exists'); // queued/downloading/done
  if (origin === 'listener') {
    declined.delete(key);
    enqueue(key, connectionId, libraryId, book, chapterData, origin);
    return done('queued');
  }
  // An automatic download (the book you start, keep-ahead) never takes back a book
  // the listener cancelled or removed this session, and never eats into the reserve
  // (`roomLeft`; an unknowable room lets it start, one at a time).
  if (declined.has(key)) return done('declined');
  return (async (): Promise<DownloadOutcome> => {
    let storage: StorageEstimate | null = null;
    try {
      storage = await engine.storageEstimate();
    } catch {
      // not knowable: start it, one at a time like keep-ahead
    }
    const need = estimateBytes(book);
    const entries = Object.entries(useDownloads.getState().entries);
    const room = roomLeft(storage, pendingBytes(entries.map(([, e]) => e)));
    // The book being listened to outranks keep-ahead's books still waiting their turn:
    // if only they stand in its way, they step aside (keep-ahead plans them again
    // around it, when they still fit). One already downloading finishes.
    let yielding: string[] = [];
    if (room !== null && need > room) {
      if (origin !== 'auto') return 'no-space';
      yielding = entries
        .filter(([, e]) => e.origin === 'keep-ahead' && e.status === 'queued')
        .map(([k]) => k);
      const others = entries.filter(([k]) => !yielding.includes(k)).map(([, e]) => e);
      const without = roomLeft(storage, pendingBytes(others));
      if (without !== null && need > without) return 'no-space';
    }
    // Things may have moved while the room was read.
    const now = useDownloads.getState().entries[key];
    if (declined.has(key)) return 'declined';
    if (now && now.status !== 'error') return 'exists';
    for (const k of yielding) stepAside(k);
    enqueue(key, connectionId, libraryId, book, chapterData, origin);
    return 'queued';
  })();
}

function enqueue(
  key: string,
  connectionId: string,
  libraryId: number,
  book: Book,
  chapterData: ChaptersResponse | undefined,
  origin: DownloadOrigin,
) {
  const { entries } = useDownloads.getState();
  const existing = entries[key];
  const manifest: DownloadManifest = {
    book,
    chapters: chapterData ?? existing?.manifest.chapters ?? null,
    // A retry keeps the files the failed attempt finished (runOne skips those still
    // on disk).
    files: existing?.manifest.files ?? [],
    coverUri: null,
    savedAt: new Date().toISOString(),
  };
  const entry: DownloadEntry = {
    connectionId,
    libraryId,
    path: book.rel_path,
    title: book.title,
    status: 'queued',
    progress: 0,
    bytes: 0,
    totalBytes: 0,
    origin,
    manifest,
  };
  useDownloads.setState({ entries: { ...entries, [key]: entry } });
  void persist();
  if (!queue.includes(key)) {
    // The book you start goes next, ahead of keep-ahead's books still waiting (the
    // download running now is off the queue).
    if (origin === 'auto' && running) queue.unshift(key);
    else queue.push(key);
  }
  void runQueue();
}

/** Take a waiting automatic download off the queue for the book you start, without the
 * session's decline mark (the listener didn't cancel it): keep-ahead plans it again. A
 * waiting keep-ahead download has no files yet (keep-ahead never retries a failure). */
function stepAside(key: string) {
  const idx = queue.indexOf(key);
  if (idx >= 0) queue.splice(idx, 1);
  removeEntry(key);
}

/**
 * What a saved entry becomes on launch (`allPresent`: every file it lists is on disk):
 * - a downloaded book stays downloaded;
 * - a failed download, or one the app closed mid-way (still `queued` / `downloading`:
 *   the engines can't resume a transfer, but the files it FINISHED are listed as they
 *   land), stays as a failure keeping those files, so Retry fetches only the rest. One
 *   cut short by the app closing says so (`interrupted`);
 * - anything else is dropped (and its folder deleted by the caller): an entry with no
 *   finished file, or one whose files are no longer all there.
 * The kept share is recomputed from the files, so it is what is really on the device.
 */
export function reviveEntry(e: DownloadEntry, allPresent: boolean): DownloadEntry | null {
  const files = e.manifest.files;
  if (files.length === 0 || !allPresent) return null;
  if (e.status === 'downloaded') return e;
  const of = bookFileSpecs(e.manifest.book, e.manifest.chapters ?? undefined).length;
  const kept = Math.min(1, files.length / Math.max(of, files.length));
  const failure: DownloadFailure =
    e.status === 'error' && e.failure ? { ...e.failure, kept } : { kind: 'interrupted', kept };
  return {
    ...e,
    status: 'error',
    progress: kept,
    bytes: files.reduce((sum, f) => sum + (f.bytes ?? 0), 0),
    error: e.status === 'error' ? e.error : 'Interrupted',
    failure,
  };
}

/**
 * A downloaded book's manifest with the server's `fresh` chapters in place of the saved
 * ones, or null to leave it as it is. A book's chapters can change on the server after
 * it was downloaded (a rescan, a community chapter list fitted onto its audio, the admin
 * switching it back), and offline it plays and lists what the manifest holds. Only the
 * chapters move: when the fresh answer's audio files are not the ones on the device (the
 * same paths in the order the manifest plays them now, `bookFileSpecs`, and the same
 * sizes where both answers know them: a file replaced in place keeps its path), the local
 * audio no longer matches and that is a new download, so nothing changes. The same files
 * in another order are taken only by a start that plays them that way
 * (`adoptStartedChapters`), never from a background answer. Null too when nothing differs.
 */
export function refreshedChapters(
  manifest: DownloadManifest,
  fresh: ChaptersResponse,
): DownloadManifest | null {
  const refresh = chaptersRefresh(manifest, fresh);
  return refresh && !refresh.reordered ? refresh.manifest : null;
}

/** The manifest with `fresh` chapters when they name the device's own files (the same set
 * of paths, the same sizes where both answers know them), and whether they play those
 * files in another order than the manifest's chapters do (`reordered`); else null. */
function chaptersRefresh(
  manifest: DownloadManifest,
  fresh: ChaptersResponse,
): { manifest: DownloadManifest; reordered: boolean } | null {
  // An unchanged refetch hands back the same object (structural sharing): skip the compare.
  if (fresh === manifest.chapters) return null;
  const want = bookFileSpecs(manifest.book, fresh);
  if (want.length !== manifest.files.length) return null;
  // The files in the order the manifest plays them now, with the sizes the download read
  // (0 when only the chapters named the files).
  const read = bookFileSpecs(manifest.book, manifest.chapters ?? undefined);
  const readSize = new Map(read.map((s) => [s.path, s.size]));
  // The device's files, each one named exactly once, in any order.
  const onDisk = manifest.files.map((f) => f.relPath);
  const onDiskSet = new Set(onDisk);
  const onDevice = new Set(onDiskSet);
  for (const s of want) {
    if (!onDevice.delete(s.path)) return null;
    const was = readSize.get(s.path) ?? 0;
    if (was > 0 && s.size > 0 && was !== s.size) return null;
  }
  // The order the manifest plays them in now: its chapters', else (saved chapters that name
  // no file list of their own) the order the download wrote them.
  const playing =
    read.length === onDisk.length && read.every((s) => onDiskSet.has(s.path))
      ? read.map((s) => s.path)
      : onDisk;
  const reordered = want.some((s, i) => s.path !== playing[i]);
  if (!reordered && JSON.stringify(fresh) === JSON.stringify(manifest.chapters)) return null;
  return { manifest: { ...manifest, chapters: fresh }, reordered };
}

/**
 * A start of a downloaded book loaded the engine from `chapters` (`playBook`, once its
 * load landed): the manifest takes them, so a later start, offline or from Android's
 * service (`adoptLoaded`, which gets only a track index), plays the order the engine was
 * given. This is the only way the same files take a new order (server v2.4.0 plays them
 * in natural order, "2-" before "10-"): the chapters carry the order every queue over the
 * download plays them in (`bookFileSpecs`, each file found by its path:
 * `localFromManifest`), and `files` itself never moves, since a file's index there is its
 * name on disk (`fileName`; `relocateEntry` keeps a saved file's own name, `storedName`). A
 * background answer never does it (`refreshedChapters`): JS cannot see a book the Android
 * service or a Cast receiver holds before it is adopted. Chapters naming other files
 * change nothing.
 */
export function adoptStartedChapters(ref: BookRef, chapters: ChaptersResponse): void {
  const entry = downloadedEntryOf(ref);
  const refresh = entry && chaptersRefresh(entry.manifest, chapters);
  // The same order is the background refresh's to take (`startChapterRefresh`): a start's
  // answer can be older (cached) than one the manifest took while it loaded.
  if (!refresh?.reordered) return;
  patchEntry(contentKeyOf(ref), { manifest: refresh.manifest });
  void persist();
}

/**
 * `manifest` with the chapters answer the cache already holds for its book, when
 * `refreshedChapters` takes it. `startChapterRefresh` only sees answers that land while the
 * book is downloaded; this takes one that landed before, while it was downloading or before
 * the launch's `hydrate` read the registry. That answer is the one the download was given
 * or a newer one (the callers read it from the same cache entry).
 */
function withCachedChapters(ref: BookRef, manifest: DownloadManifest): DownloadManifest {
  const cached = queryClient.getQueryData<ChaptersResponse>(
    qk.chapters(ref.connectionId, ref.libraryId, ref.path),
  );
  return (cached && refreshedChapters(manifest, cached)) || manifest;
}

/**
 * Keep downloaded books' chapters in step with the server: every chapters answer the
 * server gives (any screen's fetch, the play and download paths) for a downloaded book
 * replaces its saved copy when `refreshedChapters` allows. The cache already holds that
 * answer, so there is nothing to seed. A queue already playing keeps its chapters until
 * the book is next started. Returns the unsubscribe (started once from the root layout).
 *
 * The answers the cache already holds when it starts are taken too: the web starts it
 * after the first paint (`root-services.web.tsx`), when a screen's answer can have landed
 * already. Native starts it before any fetch, where the cache holds at most the store's
 * own seeds, which are the manifests' chapters and so change nothing.
 */
export function startChapterRefresh(): () => void {
  for (const entry of Object.values(useDownloads.getState().entries)) {
    if (entry.status !== 'downloaded') continue;
    const manifest = withCachedChapters(entry, entry.manifest);
    if (manifest === entry.manifest) continue;
    patchEntry(contentKeyOf(entry), { manifest });
    persistSoon();
  }
  return queryClient.getQueryCache().subscribe((event) => {
    // A server answer only: the store's own seeds (`setQueryData`) are manual.
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const book = chaptersKeyParts(event.query.queryKey);
    const fresh = event.action.data as ChaptersResponse | undefined;
    if (!book || !fresh) return;
    const ref = { connectionId: book.cid, libraryId: book.libraryId, path: book.path };
    const entry = downloadedEntryOf(ref);
    const manifest = entry && refreshedChapters(entry.manifest, fresh);
    if (!manifest) return;
    patchEntry(contentKeyOf(ref), { manifest });
    // A burst of answers (a reconnect's refetches, a search fan-out, the start's own
    // sweep above) saves the registry once, not once per book.
    persistSoon();
  });
}

/** While a download runs, its finished files reach storage at most this often
 * (`persistSoon`); everything else saves at once. */
const PERSIST_EVERY_MS = 2000;
/** A running download's progress reaches the store (and every screen that shows it) at
 * most this often; status changes and completion are never held back. */
const PROGRESS_EVERY_MS = 250;
/** A save `persistSoon` is holding, and the app-state watch that flushes it early. */
let pendingSave: { timer: ReturnType<typeof setTimeout>; watch: { remove: () => void } } | null =
  null;

/** Save the registry now (and drop any save `persistSoon` was holding). */
function persist(): Promise<void> {
  // The launch's read saves once it has merged (`hydrating`): before that the live entries
  // are not the registry, and saving them would write over every saved download.
  if (hydrating) return Promise.resolve();
  if (pendingSave) {
    clearTimeout(pendingSave.timer);
    pendingSave.watch.remove();
    pendingSave = null;
  }
  return setItem(DOWNLOADS_KEY, useDownloads.getState().entries);
}

/** Save the registry within `PERSIST_EVERY_MS`: a book of many files lands one file at
 * a time, and each save writes the whole registry. A failure, completion, cancel or the
 * app leaving the foreground saves at once (`persist`), so the kept-files record of a
 * download the app is closed in the middle of still reaches storage. */
function persistSoon() {
  if (pendingSave) return;
  pendingSave = {
    timer: setTimeout(() => void persist(), PERSIST_EVERY_MS),
    watch: AppState.addEventListener('change', (state) => {
      if (state !== 'active') void persist();
    }),
  };
}

function patchEntry(key: string, patch: Partial<DownloadEntry>) {
  const cur = useDownloads.getState().entries[key];
  if (!cur) return;
  useDownloads.setState({
    entries: { ...useDownloads.getState().entries, [key]: { ...cur, ...patch } },
  });
}

function removeEntry(key: string) {
  const next = { ...useDownloads.getState().entries };
  delete next[key];
  useDownloads.setState({ entries: next });
  void persist();
}

/** Seed a downloaded book's item and chapters for offline reading (`seedQuery`: never
 * over an answer the cache holds, which is the server's own and at least as full - the
 * manifest's book can be the list shape; dated when the download was saved, so an online
 * screen refetches it once stale; kept past `gcTime`, so the book page still opens offline
 * long after launch). */
function seedQueryCache(
  connectionId: string,
  libraryId: number,
  path: string,
  manifest: DownloadManifest,
) {
  const savedAt = Date.parse(manifest.savedAt) || Date.now();
  seedQuery(qk.item(connectionId, libraryId, path), manifest.book, savedAt);
  if (manifest.chapters)
    seedQuery(qk.chapters(connectionId, libraryId, path), manifest.chapters, savedAt);
}

// --- the offline companion (see offline-meta.ts) ----------------------------

/** The downloads whose community metadata this session already tried to keep, by
 * download (its key and completion time, so a book removed and downloaded again tries
 * afresh): one attempt each per launch, so an unreachable server or a down metadata
 * service never turns into a retry storm. The next launch tries again. */
const metaTried = new Set<string>();

/** Whether `entry` is still the downloaded book in the registry (not removed, nor
 * replaced by a new download of it). */
function stillDownloaded(key: string, entry: DownloadEntry): boolean {
  const now = useDownloads.getState().entries[key];
  return now?.status === 'downloaded' && now.manifest.savedAt === entry.manifest.savedAt;
}

/** Keep a downloaded book's community metadata beside its files (best effort, once per
 * launch): read it, save it, mark the manifest and seed the cache. */
async function keepOfflineMeta(key: string): Promise<void> {
  const entry = useDownloads.getState().entries[key];
  if (!entry || entry.status !== 'downloaded' || !engine.writeText) return;
  const attempt = `${key}@${entry.manifest.savedAt}`;
  if (metaTried.has(attempt)) return;
  metaTried.add(attempt);
  const payload = await captureOfflineMeta(entry);
  if (!payload || !stillDownloaded(key, entry)) return;
  if (!(await writeOfflineMeta(entry, payload))) return;
  if (!stillDownloaded(key, entry)) {
    // Removed while it was written: don't leave the file behind (a new download of the
    // book writes its own over it).
    if (!useDownloads.getState().entries[key]) void removeOfflineMeta(entry);
    return;
  }
  const { manifest } = useDownloads.getState().entries[key];
  patchEntry(key, {
    manifest: { ...manifest, meta: { savedAt: new Date(payload.savedAt).toISOString() } },
  });
  // Many books in a row (the launch's fill-in) save the registry once, not once each.
  persistSoon();
  seedOfflineMeta(entry.connectionId, entry.libraryId, entry.path, payload);
  const server = currentServerSnapshot(entry.connectionId);
  if (server) void saveServerSnapshot(entry.connectionId, server);
}

/** A kept copy older than this is read again on a launch that can reach its server, so
 * what a book carries offline follows the community's edits (new recaps, characters). */
const KEPT_META_REFRESH_MS = 7 * 24 * 60 * 60_000;

/** How many kept payloads the launch reads at once. */
const RESTORE_READS_AT_ONCE = 3;

/** On launch: seed the metadata every downloaded book kept, then each such connection's
 * kept `/server` answer where the cache has none (after the books, so a gate it opens
 * finds their data; a file from before the answer had its own key carries it over), then
 * fill in, one book at a time, the downloads that kept none (made before this existed, or
 * whose file is gone or unreadable), then refresh the copies older than a week. That asks
 * only a server with `metadata`, each server's flags once; a failure keeps what the book
 * had. */
async function restoreOfflineMeta(keys: string[]): Promise<void> {
  const downloaded = keys
    .map((key) => [key, useDownloads.getState().entries[key]] as const)
    .filter((pair): pair is readonly [string, DownloadEntry] => pair[1]?.status === 'downloaded');
  const read = await mapLimit(downloaded, RESTORE_READS_AT_ONCE, async ([key, e]) => ({
    key,
    entry: e,
    payload: e.manifest.meta ? await readOfflineMeta(e) : null,
  }));
  // The connections whose books kept their metadata, and the `/server` answer a file
  // from before it had its own key carries (the first such file's).
  const connections = new Set<string>();
  const carried = new Map<string, ServerSnapshot>();
  const missing: string[] = [];
  const old: string[] = [];
  for (const { key, entry, payload } of read) {
    if (!payload) {
      missing.push(key);
      continue;
    }
    seedOfflineMeta(entry.connectionId, entry.libraryId, entry.path, payload);
    connections.add(entry.connectionId);
    if (payload.server && !carried.has(entry.connectionId)) {
      carried.set(entry.connectionId, payload.server);
    }
    if (Date.now() - payload.savedAt > KEPT_META_REFRESH_MS) old.push(key);
  }
  const snapshots = await readServerSnapshots();
  for (const cid of connections) {
    const snapshot = snapshots[cid] ?? carried.get(cid);
    if (!snapshot) continue;
    seedServerSnapshot(cid, snapshot);
    if (!snapshots[cid]) void saveServerSnapshot(cid, snapshot);
  }
  if (missing.length === 0 && old.length === 0) return;

  await whenSessionReady();
  const hasMetadata = new Map<string, Promise<boolean>>();
  for (const key of [...missing, ...old]) {
    const e = useDownloads.getState().entries[key];
    if (!e || e.status !== 'downloaded' || !canMatch(e)) continue;
    let check = hasMetadata.get(e.connectionId);
    if (!check) {
      check = serverHasMetadata(e.connectionId);
      hasMetadata.set(e.connectionId, check);
    }
    if (await check) await keepOfflineMeta(key);
  }
}

/** Run `task` once the launch's first screens are up: when the JS thread is next idle
 * (`requestIdleCallback`, on native and most browsers), else a moment later. */
function afterLaunch(task: () => void) {
  const idle = (
    globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown;
    }
  ).requestIdleCallback;
  if (typeof idle === 'function') idle(task, { timeout: 2000 });
  else setTimeout(task, 250);
}

/**
 * Rebuild a saved entry's local file uris from the *current* storage root. The
 * on-disk filename scheme is owned here (`storedName`, else `fileName`, for audio;
 * `cover.jpg` for the cover, `book.epub` for the ebook), so the (connectionId, libraryId, path, fileName) → live-uri
 * mapping lives here too; `engine.localUri` supplies the container-current absolute uri
 * (native) or the virtual cache url (web). Recomputing from the entry's own connection id
 * is also what carries a download across the identity migration, which rewrites
 * `connectionId` but not the stored uris (and moves the files on native; the web engine
 * finds them under the legacy id, `legacyIdOf`). On iOS an old `<i>.mka` is renamed to
 * `<i>.mp3` on the way (`playableName`). A no-op only for an engine without `localUri`
 * (no offline storage).
 */
async function relocateEntry(e: DownloadEntry): Promise<DownloadEntry> {
  const resolve = engine.localUri;
  if (!resolve) return e;
  const { connectionId, libraryId, path } = e;
  const at = (name: string) => resolve(connectionId, libraryId, path, name);
  const files = await Promise.all(
    e.manifest.files.map(async (f, i) => {
      const name = storedName(i, f.localUri) ?? fileName(i, f.relPath);
      return { ...f, localUri: at(await playableName(i, name, at)) };
    }),
  );
  const coverUri = e.manifest.coverUri ? at(COVER_FILE) : e.manifest.coverUri;
  const ebookUri = e.manifest.ebookUri ? at(EBOOK_FILE) : undefined;
  return { ...e, manifest: { ...e.manifest, files, coverUri, ebookUri } };
}

/**
 * The name a saved file should go by now: on iOS, a `<i>.mka` an older app saved (MP3
 * bytes from a server that remuxes, or raw Matroska iOS can't play under any name) is
 * renamed on disk to the `<i>.mp3` `fileName` gives it today, so it plays after the
 * update. One a launch already renamed before the registry was saved is found under the
 * new name. Anything that fails keeps the old name: the file is never lost. Elsewhere
 * (and for every other name) the name is kept as it is.
 */
async function playableName(
  index: number,
  name: string,
  at: (name: string) => string,
): Promise<string> {
  const want = fileName(index, name);
  if (want === name || !engine.renameFile) return name;
  const from = at(name);
  try {
    if (await engine.fileExists(from)) await engine.renameFile(from, want);
  } catch {
    // the probe below finds the file under whichever name it has now
  }
  // Whatever the rename reported, the file goes by the name it is under now: a move that
  // landed but answered false (or threw) must not leave the entry naming a gone file,
  // which hydrate would drop and delete.
  return !(await engine.fileExists(from)) && (await engine.fileExists(at(want))) ? want : name;
}

/** A downloaded book's cover and ebook, beside its audio (never an audio file's name:
 * those are `<index>[.ext]`). */
const COVER_FILE = 'cover.jpg';
const EBOOK_FILE = 'book.epub';

/**
 * Sanitized destination filename for a file index, keeping its extension, except that on
 * iOS a `.mka` is saved as `.mp3`: a server with ffmpeg serves an MP3-in-Matroska file as
 * a lossless MP3 stream copy at the same url, and AVFoundation picks a local file's type
 * by its extension, so the bytes must not land under `.mka` there (raw Matroska from an
 * older server plays on iOS under no name). Android's Media3 sniffs the bytes and the web
 * plays by Content-Type, so they keep `.mka` and raw Matroska is never mislabelled.
 */
function fileName(index: number, relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  const ext = dot > relPath.lastIndexOf('/') ? relPath.slice(dot) : '';
  return `${index}${Platform.OS === 'ios' && ext.toLowerCase() === '.mka' ? '.mp3' : ext}`;
}

/**
 * The name a saved file already has on disk, read from its stored uri, when it is one
 * `fileName` could have given this index (`<index>` plus an optional extension). Relocation
 * keeps it, so a download saved under an older naming rule (an Android 2.4.x `0.mka`)
 * still resolves; anything else (no stored uri, another shape, a percent-escaped name a
 * `file://` uri carries, which is not the name on disk) falls back to `fileName`.
 */
function storedName(index: number, localUri: string): string | undefined {
  const name = localUri.slice(localUri.lastIndexOf('/') + 1);
  const m = /^(\d+)(\.[^./:?#%]+)?$/.exec(name);
  return m?.[1] === String(index) ? name : undefined;
}

async function runQueue() {
  if (running) return;
  running = true;
  try {
    // Taken off before it runs: the same book queued again while it runs (a cancel, then
    // Download) waits its own turn instead of being taken off with it.
    let key: string | undefined;
    while ((key = queue.shift()) !== undefined) {
      const entry = useDownloads.getState().entries[key];
      if (entry && entry.status !== 'downloaded') await runOne(key);
    }
  } finally {
    running = false;
  }
}

async function runOne(key: string) {
  const entry = useDownloads.getState().entries[key];
  if (!entry) return;
  // Resolve the download's OWN server client, so two servers' queued downloads never
  // race a shared client. A removed connection errors the entry rather than downloading.
  const api = resolveClient(entry.connectionId);
  if (!api) {
    patchEntry(key, {
      status: 'error',
      error: 'Server connection removed',
      failure: { kind: 'removed' },
    });
    void persist();
    return;
  }
  const { connectionId, libraryId, path } = entry;
  const ctrl = new AbortController();
  controllers.set(key, ctrl);
  // Still the book's live run: a cancel or removal stops it (`stopRun`), and the book can
  // be queued again at once, under the same key; this run then leaves the entry alone.
  const live = () => controllers.get(key) === ctrl;
  const patch = (p: Partial<DownloadEntry>) => {
    if (live()) patchEntry(key, p);
  };
  patch({ status: 'downloading', progress: 0, bytes: 0 });
  void persist();

  // The files that finished, so a failure can keep them, and how many there are.
  const files: DownloadedFile[] = [];
  let fileCount = 0;
  try {
    const specs = bookFileSpecs(entry.manifest.book, entry.manifest.chapters ?? undefined);
    fileCount = specs.length;
    // The ebook (Bridge Phase 3b-2) is one more step after the audio, and its size counts in
    // the total: 100% is the whole download, and the bytes kept include it.
    const ebook = entry.manifest.book.ebook;
    const steps = specs.length + (ebook ? 1 : 0);
    const knownTotal = specs.every((s) => s.size > 0)
      ? specs.reduce((sum, s) => sum + s.size, 0) + (ebook?.size ?? 0)
      : 0;

    // The book's extras beside its audio: optional (a failure never fails the audio
    // download, the book carries on without it), but a cancel during one cancels the book.
    const extra = async (
      name: string,
      url: string,
      headers?: Record<string, string>,
      onProgress?: (bytesWritten: number, totalBytes: number) => void,
    ) => {
      try {
        return await engine.downloadFile(
          connectionId,
          libraryId,
          path,
          name,
          url,
          onProgress,
          ctrl.signal,
          headers,
        );
      } catch (e) {
        if (ctrl.signal.aborted) throw e;
        return undefined;
      }
    };
    const coverUri = (await extra(COVER_FILE, api.coverUrl(libraryId, path))) ?? null;

    let priorBytes = 0;
    let lastTick = 0;
    /** A progress tick, at most every PROGRESS_EVERY_MS: `step` steps done (fractional). */
    const tick = (step: number, bytes: number) => {
      const now = Date.now();
      if (now - lastTick < PROGRESS_EVERY_MS) return;
      lastTick = now;
      patch({ bytes, totalBytes: knownTotal, progress: step / steps });
    };
    // Files a failed attempt already finished, by position (the on-disk name is the
    // index, so a file only counts where it was saved).
    const earlier = entry.manifest.files;
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const done = earlier[i];
      if (done?.relPath === s.path && (await engine.fileExists(done.localUri))) {
        files.push(done);
        priorBytes += done.bytes ?? s.size;
        patch({ bytes: priorBytes, totalBytes: knownTotal, progress: (i + 1) / steps });
        continue;
      }
      let curBytes = 0;
      const localUri = await engine.downloadFile(
        connectionId,
        libraryId,
        path,
        fileName(i, s.path),
        api.streamUrl(libraryId, s.path, true),
        (bytesWritten, totalBytes) => {
          curBytes = bytesWritten;
          tick(i + (totalBytes > 0 ? bytesWritten / totalBytes : 0), priorBytes + bytesWritten);
        },
        ctrl.signal,
      );
      priorBytes += curBytes;
      files.push({ relPath: s.path, localUri, bytes: curBytes });
      // List each finished file as it lands, so a download the app is closed in the
      // middle of keeps them across the restart (`reviveEntry`). Files a failed attempt
      // finished further on stay listed in their places (the name on disk is the index).
      const cur = useDownloads.getState().entries[key];
      if (cur && live()) {
        patchEntry(key, {
          bytes: priorBytes,
          totalBytes: knownTotal,
          progress: (i + 1) / steps,
          manifest: { ...cur.manifest, files: [...files, ...earlier.slice(files.length)] },
        });
        persistSoon();
      }
    }

    // The book's ebook, so the reader opens it offline. After the audio: an attempt that
    // fails on the audio never fetches it, so a retry fetches it once. The app reader's
    // cached copy for this size is taken as it is (the reader already fetched the book);
    // else it is fetched, its route taking the Authorization header only, never `?token=`.
    let ebookUri: string | undefined;
    let ebookBytes = 0;
    if (ebook) {
      const cached = engine.copyFile
        ? await cachedEbookUri({ connectionId, libraryId, path, size: ebook.size }).catch(
            () => null,
          )
        : null;
      if (cached && engine.copyFile) {
        ebookUri = await engine
          .copyFile(connectionId, libraryId, path, EBOOK_FILE, cached)
          .catch(() => undefined);
        if (ebookUri) ebookBytes = ebook.size;
      }
      if (!ebookUri) {
        const { url, headers } = api.ebookRequest(libraryId, path);
        ebookUri = await extra(EBOOK_FILE, url, headers, (bytesWritten, totalBytes) => {
          ebookBytes = bytesWritten;
          tick(
            specs.length + (totalBytes > 0 ? bytesWritten / totalBytes : 0),
            priorBytes + bytesWritten,
          );
        });
        // An engine that reported no progress: the server's size stands in.
        if (ebookUri && ebookBytes === 0) ebookBytes = ebook.size;
      }
      if (!ebookUri) ebookBytes = 0;
    }
    const bytes = priorBytes + ebookBytes;

    // With the server's chapters answer when one landed while the files did.
    const manifest = withCachedChapters(entry, {
      ...entry.manifest,
      files,
      coverUri,
      ebookUri,
      savedAt: new Date().toISOString(),
    });

    // Stopped while its last file landed: whoever stopped it removed the book.
    if (!live()) return;

    // Don't claim "downloaded" unless the file can really be played back offline.
    // On web the bytes are cached but only playable once the service worker controls
    // the page; mark an error (keeping the bytes for a retry) so the badge can't lie.
    if (engine.verify && files.length > 0 && !(await engine.verify(files[0].localUri))) {
      patch({
        status: 'error',
        error: 'Saved, but offline playback isn’t ready yet - reload the app, then retry.',
        failure: { kind: 'unservable' },
        progress: 1,
        bytes,
        manifest,
      });
      void persist();
      return;
    }
    if (!live()) return;

    patchEntry(key, { status: 'downloaded', progress: 1, bytes, manifest });
    void persist();
    seedQueryCache(connectionId, libraryId, path, manifest);
    // Keep its community metadata for offline use, after the download and apart from it:
    // a failure there never fails (or holds up) the book.
    keepOfflineMeta(key).catch(() => {});
  } catch (e) {
    // Cancelled only when this download's own signal aborted (`cancel`, `remove`, a removed
    // connection), whatever the error says: Android reports a dropped connection as
    // "Software caused connection abort", which is a failure like any other.
    if (ctrl.signal.aborted) {
      // Whoever stopped it dropped the entry, and the book may be queued again already: only
      // the files go, the transfer having been able to write after the canceller's delete.
      // Awaited, so a new download of the book (it runs after this one) starts clean.
      await engine.removeBook(connectionId, libraryId, path).catch(() => {});
    } else if (live()) {
      // Keep the files that finished: a retry skips them, so a failure 41% through a
      // multi-file book doesn't throw that 41% away. (The one being written is partial,
      // and is written over by the retry.)
      const kept = fileCount > 0 ? files.length / fileCount : 0;
      const failure: DownloadFailure = { ...classifyDownloadError(e), kept };
      const cur = useDownloads.getState().entries[key];
      patchEntry(key, {
        status: 'error',
        error: e instanceof Error ? e.message : 'Download failed',
        failure,
        ...(cur ? { manifest: { ...cur.manifest, files } } : {}),
      });
      void persist();
    }
  } finally {
    if (live()) controllers.delete(key);
  }
}

// Removing a connection purges its downloads: abort any in-flight transfer, delete the
// files, and drop the entries (signing out of an account takes its downloads with it;
// nothing else would ever reach them).
onConnectionRemoved(async (id) => {
  const entries = useDownloads.getState().entries;
  const doomed = Object.entries(entries).filter(([, e]) => e.connectionId === id);
  if (doomed.length === 0) return;
  const next = { ...entries };
  for (const [key] of doomed) {
    stopRun(key);
    delete next[key];
  }
  useDownloads.setState({ entries: next });
  void forgetServerSnapshot(id);
  // The file deletions are independent (and on web each one re-lists the cache), so
  // run them concurrently rather than making removal wait on N sequential scans.
  await Promise.all(doomed.map(([, e]) => engine.removeBook(e.connectionId, e.libraryId, e.path)));
  await persist();
});

// --- selectors -------------------------------------------------------------

export function useDownloadEntry(
  connectionId: string,
  libraryId: number,
  path: string,
): DownloadEntry | undefined {
  return useDownloads((s) => s.entries[downloadKey(connectionId, libraryId, path)]);
}

/** The EPUB a finished download of the book holds (its `manifest.ebookUri`), else
 * undefined. A string, so a download's progress ticks re-render nothing (the reader). */
export function useDownloadedEbook(
  connectionId: string,
  libraryId: number,
  path: string,
): string | undefined {
  return useDownloads((s) => {
    const e = s.entries[downloadKey(connectionId, libraryId, path)];
    return (e?.status === 'downloaded' && e.manifest.ebookUri) || undefined;
  });
}

/** A book's registry entry when it is fully downloaded, else undefined: the non-hook
 * read for the framework-free callers (the player store, the car). */
export function downloadedEntryOf(ref: {
  connectionId: string;
  libraryId: number;
  path: string;
}): DownloadEntry | undefined {
  const e = useDownloads.getState().entries[downloadKey(ref.connectionId, ref.libraryId, ref.path)];
  return e?.status === 'downloaded' ? e : undefined;
}

/** How many fully-downloaded books belong to a connection - the count the removal
 * warnings quote (removing a connection purges its downloads). One definition so the
 * "counts as a download worth warning about" rule can't drift between screens. */
export function downloadedCountFor(entries: Registry, connectionId: string): number {
  return Object.values(entries).filter(
    (e) => e.connectionId === connectionId && e.status === 'downloaded',
  ).length;
}
