import { create } from 'zustand';

import { resolveClient } from '@/api/connection-clients';
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Book, ChaptersResponse } from '@/api/types';
import { contentKey } from '@/lib/content-key';
import { getItem, setItem } from '@/lib/storage';
import { bookFileSpecs } from '@/playback/book-queue';
import { onConnectionRemoved } from '@/stores/session';

import { engine } from './engine';
import type { DownloadedFile, DownloadEntry, DownloadManifest } from './types';

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

type DownloadsState = {
  entries: Registry;
  hydrated: boolean;
  supported: boolean;
  hydrate: () => Promise<void>;
  download: (
    connectionId: string,
    libraryId: number,
    book: Book,
    chapterData?: ChaptersResponse,
  ) => void;
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
      // Only fully-downloaded books survive a relaunch; our engine can't resume a
      // download interrupted by an app kill, so partials are dropped + cleaned up.
      const present =
        e.status === 'downloaded' &&
        e.manifest.files.length > 0 &&
        (await Promise.all(e.manifest.files.map((f) => engine.fileExists(f.localUri)))).every(
          Boolean,
        );
      // Key on the (now-scoped) connectionId so an adopted legacy entry re-keys.
      const key = downloadKey(e.connectionId, e.libraryId, e.path);
      if (present) {
        cleaned[key] = e;
        seedQueryCache(e.connectionId, e.libraryId, e.path, e.manifest);
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

  download: (connectionId, libraryId, book, chapterData) => {
    if (!engine.supported) return;
    const key = downloadKey(connectionId, libraryId, book.rel_path);
    const existing = get().entries[key];
    if (existing && existing.status !== 'error') return; // already queued/downloading/done

    const manifest: DownloadManifest = {
      book,
      chapters: chapterData ?? null,
      files: [],
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
      manifest,
    };
    set({ entries: { ...get().entries, [key]: entry } });
    void persist();
    if (!queue.includes(key)) queue.push(key);
    void runQueue();
  },

  cancel: (connectionId, libraryId, path) => {
    const key = downloadKey(connectionId, libraryId, path);
    const idx = queue.indexOf(key);
    if (idx >= 0) queue.splice(idx, 1);
    controllers.get(key)?.abort();
    void engine.removeBook(connectionId, libraryId, path);
    removeEntry(key);
  },

  remove: async (connectionId, libraryId, path) => {
    const key = downloadKey(connectionId, libraryId, path);
    const idx = queue.indexOf(key);
    if (idx >= 0) queue.splice(idx, 1);
    controllers.get(key)?.abort();
    await engine.removeBook(connectionId, libraryId, path);
    removeEntry(key);
  },
}));

// --- helpers ---------------------------------------------------------------

function persist(): Promise<void> {
  return setItem(KEY, useDownloads.getState().entries);
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
    patchEntry(key, { status: 'error', error: 'Server connection removed' });
    void persist();
    return;
  }
  const { connectionId, libraryId, path } = entry;
  const ctrl = new AbortController();
  controllers.set(key, ctrl);
  patchEntry(key, { status: 'downloading', progress: 0, bytes: 0 });
  void persist();

  try {
    const specs = bookFileSpecs(entry.manifest.book, entry.manifest.chapters ?? undefined);
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

    const files: DownloadedFile[] = [];
    let priorBytes = 0;
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      let curBytes = 0;
      const localUri = await engine.downloadFile(
        connectionId,
        libraryId,
        path,
        fileName(i, s.path),
        api.streamUrl(libraryId, s.path, true),
        (bytesWritten, totalBytes) => {
          curBytes = bytesWritten;
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
      files.push({ relPath: s.path, localUri });
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
    void engine.removeBook(connectionId, libraryId, path);
    if (isAbort(e)) {
      removeEntry(key); // cancelled - drop the partial entry
    } else {
      patchEntry(key, {
        status: 'error',
        error: e instanceof Error ? e.message : 'Download failed',
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
