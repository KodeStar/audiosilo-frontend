import { create } from 'zustand';

import type { ApiClient } from '@/api/client';
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Book, ChaptersResponse } from '@/api/types';
import { getItem, setItem } from '@/lib/storage';
import { bookFileSpecs } from '@/playback/book-queue';

import { engine } from './engine';
import type { DownloadedFile, DownloadEntry, DownloadManifest } from './types';

const KEY = 'audiosilo.downloads';

export const downloadKey = (libraryId: number, path: string) => `${libraryId}:${path}`;

type Registry = Record<string, DownloadEntry>;

// Module-level orchestration (mirrors src/playback/store.ts): one book downloads
// at a time; further requests wait in `queue`.
let apiRef: ApiClient | null = null;
let running = false;
const queue: string[] = [];
const controllers = new Map<string, AbortController>();

type DownloadsState = {
  entries: Registry;
  hydrated: boolean;
  supported: boolean;
  hydrate: () => Promise<void>;
  download: (api: ApiClient, libraryId: number, book: Book, chapterData?: ChaptersResponse) => void;
  cancel: (libraryId: number, path: string) => void;
  remove: (libraryId: number, path: string) => Promise<void>;
};

export const useDownloads = create<DownloadsState>()((set, get) => ({
  entries: {},
  hydrated: false,
  supported: engine.supported,

  hydrate: async () => {
    const saved = (await getItem<Registry>(KEY)) ?? {};
    const cleaned: Registry = {};
    for (const [key, e] of Object.entries(saved)) {
      // Only fully-downloaded books survive a relaunch; our engine can't resume a
      // download interrupted by an app kill, so partials are dropped + cleaned up.
      const present =
        e.status === 'downloaded' &&
        e.manifest.files.length > 0 &&
        (await Promise.all(e.manifest.files.map((f) => engine.fileExists(f.localUri)))).every(
          Boolean,
        );
      if (present) {
        cleaned[key] = e;
        seedQueryCache(e.manifest, e.libraryId, e.path);
      } else {
        void engine.removeBook(e.libraryId, e.path);
      }
    }
    set({ entries: cleaned, hydrated: true, supported: engine.supported });
    await persist();

    // On web, having the Cache API isn't enough — offline files only play if the
    // service worker is actually controlling the page and serving them. Probe the
    // real path (no real download needed) and downgrade `supported` if it can't, so
    // the UI hides downloads instead of offering ones that won't play offline.
    if (engine.supported && engine.probe) {
      const servable = await engine.probe();
      if (servable !== useDownloads.getState().supported) set({ supported: servable });
    }
  },

  download: (api, libraryId, book, chapterData) => {
    if (!engine.supported) return;
    apiRef = api;
    const key = downloadKey(libraryId, book.rel_path);
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

  cancel: (libraryId, path) => {
    const key = downloadKey(libraryId, path);
    const idx = queue.indexOf(key);
    if (idx >= 0) queue.splice(idx, 1);
    controllers.get(key)?.abort();
    void engine.removeBook(libraryId, path);
    removeEntry(key);
  },

  remove: async (libraryId, path) => {
    const key = downloadKey(libraryId, path);
    const idx = queue.indexOf(key);
    if (idx >= 0) queue.splice(idx, 1);
    controllers.get(key)?.abort();
    await engine.removeBook(libraryId, path);
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

function seedQueryCache(manifest: DownloadManifest, libraryId: number, path: string) {
  queryClient.setQueryData(qk.item(libraryId, path), manifest.book);
  if (manifest.chapters) queryClient.setQueryData(qk.chapters(libraryId, path), manifest.chapters);
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
  if (!entry || !apiRef) return;
  const api = apiRef;
  const { libraryId, path } = entry;
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
        libraryId,
        path,
        'cover.jpg',
        api.coverUrl(libraryId, path),
        undefined,
        ctrl.signal,
      );
    } catch (e) {
      if (isAbort(e)) throw e; // a cancel during cover download still cancels the book
      // otherwise the cover is optional — carry on without it
    }

    const files: DownloadedFile[] = [];
    let priorBytes = 0;
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      let curBytes = 0;
      const localUri = await engine.downloadFile(
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
        error: 'Saved, but offline playback isn’t ready yet — reload the app, then retry.',
        progress: 1,
        bytes: priorBytes,
        manifest,
      });
      void persist();
      return;
    }

    patchEntry(key, { status: 'downloaded', progress: 1, bytes: priorBytes, manifest });
    void persist();
    seedQueryCache(manifest, libraryId, path);
  } catch (e) {
    void engine.removeBook(libraryId, path);
    if (isAbort(e)) {
      removeEntry(key); // cancelled — drop the partial entry
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

// --- selectors -------------------------------------------------------------

export function useDownloadEntry(libraryId: number, path: string): DownloadEntry | undefined {
  return useDownloads((s) => s.entries[downloadKey(libraryId, path)]);
}
