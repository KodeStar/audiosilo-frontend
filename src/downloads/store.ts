import { AppState, Platform } from 'react-native';
import { create } from 'zustand';

import { resolveClient } from '@/api/connection-clients';
import { chaptersQuery, itemQuery, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Book, ChaptersResponse } from '@/api/types';
import { contentKey } from '@/lib/content-key';
import { getItem, setItem } from '@/lib/storage';
import { bookFileSpecs } from '@/playback/book-queue';
import { webTranscodeFromCache } from '@/playback/transcode-capability';
import { onConnectionRemoved } from '@/stores/session';

import { engine } from './engine';
import { estimateBytes, pendingBytes, roomLeft } from './keep-ahead';
import { classifyDownloadError } from './failure';
import type {
  DownloadedFile,
  DownloadEntry,
  DownloadFailure,
  DownloadManifest,
  DownloadOrigin,
  DownloadOutcome,
  StorageEstimate,
} from './types';

const KEY = 'audiosilo.downloads';

export const downloadKey = contentKey;

type Registry = Record<string, DownloadEntry>;

// Module-level orchestration (mirrors src/playback/store.ts): one book downloads at a
// time; further requests wait in `queue`. The client is resolved per entry at run time
// (see runOne), so queued downloads from different servers each use their own server's
// client - the old single module-level apiRef raced two-server downloads.
let running = false;
const queue: string[] = [];
const controllers = new Map<string, AbortController>();

// Books whose download was cancelled or removed in this session (by the listener, or by
// "remove a download when you finish the book"). Automatic downloads skip them, so a
// book someone just removed is never fetched again behind their back; the listener
// downloading it again clears the mark. Session-only on purpose: memory, not storage.
const declined = new Set<string>();

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
    const saved = (await getItem<Registry>(KEY)) ?? {};
    const cleaned: Registry = {};
    for (const raw of Object.values(saved)) {
      // Re-resolve stored file uris against the live storage root first: the app's
      // document-container path can change between installs/launches (notably dev
      // rebuilds), which leaves the persisted absolute uris stale even though the
      // files are still on disk. Without this the existence check below fails and
      // the book is dropped *and deleted* - the download vanishes after a rebuild.
      const e = relocateEntry(raw);
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
      if (revived) {
        cleaned[key] = revived;
        if (revived.status === 'downloaded') {
          seedQueryCache(e.connectionId, e.libraryId, e.path, e.manifest);
        }
      } else {
        void engine.removeBook(e.connectionId, e.libraryId, e.path);
      }
    }
    // Merge, don't overwrite: a download() firing during hydrate's async window (session
    // wait, per-book file moves, fileExists probes) adds a live entry that a blind
    // set(cleaned) - built from the stale start-of-hydrate snapshot - would clobber. Keep
    // any live entry this hydrate didn't produce; the hydrated/on-disk version wins on a
    // key collision.
    const merged: Registry = { ...cleaned };
    for (const [key, entry] of Object.entries(get().entries)) {
      if (!(key in merged)) merged[key] = entry;
    }
    set({ entries: merged, hydrated: true, supported: engine.supported });
    await persist();

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
    const idx = queue.indexOf(key);
    if (idx >= 0) queue.splice(idx, 1);
    controllers.get(key)?.abort();
    void engine.removeBook(connectionId, libraryId, path);
    removeEntry(key);
  },

  remove: async (connectionId, libraryId, path) => {
    const key = downloadKey(connectionId, libraryId, path);
    declined.add(key);
    const idx = queue.indexOf(key);
    if (idx >= 0) queue.splice(idx, 1);
    controllers.get(key)?.abort();
    await engine.removeBook(connectionId, libraryId, path);
    removeEntry(key);
  },
}));

// --- helpers ---------------------------------------------------------------

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
    // The book you start goes next, ahead of keep-ahead's books still waiting (queue[0]
    // is the download running now).
    if (origin === 'auto' && running) queue.splice(1, 0, key);
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
  if (pendingSave) {
    clearTimeout(pendingSave.timer);
    pendingSave.watch.remove();
    pendingSave = null;
  }
  return setItem(KEY, useDownloads.getState().entries);
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

function seedQueryCache(
  connectionId: string,
  libraryId: number,
  path: string,
  manifest: DownloadManifest,
) {
  queryClient.setQueryData(qk.item(connectionId, libraryId, path), manifest.book);
  if (manifest.chapters)
    queryClient.setQueryData(qk.chapters(connectionId, libraryId, path), manifest.chapters);
}

/**
 * Rebuild a saved entry's local file uris from the *current* storage root. The
 * on-disk filename scheme is owned here (`fileName` for audio, `cover.jpg` for the
 * cover), so the (connectionId, libraryId, path, fileName) → live-uri mapping lives
 * here too; `engine.localUri` supplies the container-current absolute uri. A no-op
 * when the engine has no `localUri` (web), where uris are stable cache keys, not paths.
 */
function relocateEntry(e: DownloadEntry): DownloadEntry {
  const resolve = engine.localUri;
  if (!resolve) return e;
  const { connectionId, libraryId, path } = e;
  const files = e.manifest.files.map((f, i) => ({
    ...f,
    localUri: resolve(connectionId, libraryId, path, fileName(i, f.relPath)),
  }));
  const coverUri = e.manifest.coverUri
    ? resolve(connectionId, libraryId, path, 'cover.jpg')
    : e.manifest.coverUri;
  return { ...e, manifest: { ...e.manifest, files, coverUri } };
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));
}

/** Sanitized destination filename for a file index, keeping its extension. */
function fileName(index: number, relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  const ext = dot > relPath.lastIndexOf('/') ? relPath.slice(dot) : '';
  return `${index}${ext}`;
}

async function runQueue() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const key = queue[0];
      const entry = useDownloads.getState().entries[key];
      if (entry && entry.status !== 'downloaded') await runOne(key);
      // re-check: cancel() may have shifted it already
      if (queue[0] === key) queue.shift();
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
  patchEntry(key, { status: 'downloading', progress: 0, bytes: 0 });
  void persist();

  // The files that finished, so a failure can keep them, and how many there are.
  const files: DownloadedFile[] = [];
  let fileCount = 0;
  try {
    const specs = bookFileSpecs(entry.manifest.book, entry.manifest.chapters ?? undefined);
    fileCount = specs.length;
    const knownTotal = specs.every((s) => s.size > 0)
      ? specs.reduce((sum, s) => sum + s.size, 0)
      : 0;

    let coverUri: string | null = null;
    try {
      coverUri = await engine.downloadFile(
        connectionId,
        libraryId,
        path,
        'cover.jpg',
        api.coverUrl(libraryId, path),
        undefined,
        ctrl.signal,
      );
    } catch (e) {
      if (isAbort(e)) throw e; // a cancel during cover download still cancels the book
      // otherwise the cover is optional - carry on without it
    }

    let priorBytes = 0;
    let lastTick = 0;
    // Files a failed attempt already finished, by position (the on-disk name is the
    // index, so a file only counts where it was saved).
    const earlier = entry.manifest.files;
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const done = earlier[i];
      if (done?.relPath === s.path && (await engine.fileExists(done.localUri))) {
        files.push(done);
        priorBytes += done.bytes ?? s.size;
        patchEntry(key, {
          bytes: priorBytes,
          totalBytes: knownTotal,
          progress: (i + 1) / specs.length,
        });
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
          const now = Date.now();
          if (now - lastTick < PROGRESS_EVERY_MS) return;
          lastTick = now;
          const curFrac = totalBytes > 0 ? bytesWritten / totalBytes : 0;
          patchEntry(key, {
            bytes: priorBytes + bytesWritten,
            totalBytes: knownTotal,
            progress: (i + curFrac) / specs.length,
          });
        },
        ctrl.signal,
      );
      priorBytes += curBytes;
      files.push({ relPath: s.path, localUri, bytes: curBytes });
      // List each finished file as it lands, so a download the app is closed in the
      // middle of keeps them across the restart (`reviveEntry`). Files a failed attempt
      // finished further on stay listed in their places (the name on disk is the index).
      const cur = useDownloads.getState().entries[key];
      if (cur) {
        patchEntry(key, {
          bytes: priorBytes,
          totalBytes: knownTotal,
          progress: (i + 1) / specs.length,
          manifest: { ...cur.manifest, files: [...files, ...earlier.slice(files.length)] },
        });
        persistSoon();
      }
    }

    const manifest: DownloadManifest = {
      ...entry.manifest,
      files,
      coverUri,
      savedAt: new Date().toISOString(),
    };

    // Don't claim "downloaded" unless the file can really be played back offline.
    // On web the bytes are cached but only playable once the service worker controls
    // the page; mark an error (keeping the bytes for a retry) so the badge can't lie.
    if (engine.verify && files.length > 0 && !(await engine.verify(files[0].localUri))) {
      patchEntry(key, {
        status: 'error',
        error: 'Saved, but offline playback isn’t ready yet - reload the app, then retry.',
        failure: { kind: 'unservable' },
        progress: 1,
        bytes: priorBytes,
        manifest,
      });
      void persist();
      return;
    }

    patchEntry(key, { status: 'downloaded', progress: 1, bytes: priorBytes, manifest });
    void persist();
    seedQueryCache(connectionId, libraryId, path, manifest);
  } catch (e) {
    if (isAbort(e)) {
      void engine.removeBook(connectionId, libraryId, path);
      removeEntry(key); // cancelled - drop the partial entry
    } else {
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
    controllers.delete(key);
  }
}

// Removing a connection purges its downloads: abort any in-flight transfer, delete the
// files, and drop the entries. Re-adding the server mints a new id, so these are
// otherwise unreachable forever.
onConnectionRemoved(async (id) => {
  const entries = useDownloads.getState().entries;
  const doomed = Object.entries(entries).filter(([, e]) => e.connectionId === id);
  if (doomed.length === 0) return;
  const next = { ...entries };
  for (const [key] of doomed) {
    const idx = queue.indexOf(key);
    if (idx >= 0) queue.splice(idx, 1);
    controllers.get(key)?.abort();
    delete next[key];
  }
  useDownloads.setState({ entries: next });
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

/** How many fully-downloaded books belong to a connection - the count the removal
 * warnings quote (removing a connection purges its downloads). One definition so the
 * "counts as a download worth warning about" rule can't drift between screens. */
export function downloadedCountFor(entries: Registry, connectionId: string): number {
  return Object.values(entries).filter(
    (e) => e.connectionId === connectionId && e.status === 'downloaded',
  ).length;
}
