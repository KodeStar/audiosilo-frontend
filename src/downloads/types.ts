import type { Book, ChaptersResponse } from '@/api/types';

export type DownloadStatus = 'queued' | 'downloading' | 'downloaded' | 'error';

/** A downloaded audio file: the book-relative path mapped to its local file:// uri. */
export type DownloadedFile = { relPath: string; localUri: string };

/**
 * Offline source of truth for a downloaded book - everything the playback layer
 * needs to build the queue and render the player with no network: the book +
 * chapters metadata, the local audio files (in play order), and a local cover.
 */
export type DownloadManifest = {
  book: Book;
  chapters: ChaptersResponse | null;
  files: DownloadedFile[];
  coverUri: string | null;
  savedAt: string;
};

export type DownloadEntry = {
  libraryId: number;
  path: string;
  title: string;
  status: DownloadStatus;
  /** 0..1 aggregate across the book's files. */
  progress: number;
  /** Bytes written so far (approximate while in flight). */
  bytes: number;
  /** Total bytes when known (sum of file sizes), else 0. */
  totalBytes: number;
  error?: string;
  manifest: DownloadManifest;
};

export type DownloadProgressCb = (bytesWritten: number, totalBytes: number) => void;

/**
 * Platform-agnostic file storage for downloads. Implemented with
 * `expo-file-system` on native and the Cache API + service worker on web
 * (`engine.web.ts`, gated on a controlling SW via `supported`/`probe`). Metro
 * resolves the engine per platform like `src/playback/service.*`.
 */
export interface DownloadEngine {
  readonly supported: boolean;
  /** Download `url` into the book's directory as `fileName`; returns the local uri. */
  downloadFile(
    libraryId: number,
    path: string,
    fileName: string,
    url: string,
    onProgress?: DownloadProgressCb,
    signal?: AbortSignal,
  ): Promise<string>;
  /** Whether a previously downloaded local file still exists on disk. */
  fileExists(localUri: string): Promise<boolean>;
  /**
   * Whether a just-downloaded file can actually be *played back offline* right now -
   * stronger than `fileExists`. On web, having bytes in the cache isn't enough: the
   * service worker has to be controlling the page to serve them, so this exercises
   * the real offline path. Omitted where presence implies playability (native disk).
   */
  verify?(localUri: string): Promise<boolean>;
  /**
   * Whether offline playback works *at all* in this environment - a self-test that
   * needs no real download (web: round-trips a throwaway file through the service
   * worker). Lets the UI hide downloads up front rather than only failing after one.
   * Omitted where `supported` already implies it (native).
   */
  probe?(): Promise<boolean>;
  /**
   * The *current* absolute uri for a stored file, recomputed from the live storage
   * root. Native only: the app's document-container path can change between
   * installs/launches (notably across dev rebuilds), so a `localUri` persisted at
   * download time goes stale even though the file is still on disk at the same
   * relative location. Hydrate re-resolves through this so downloads survive a
   * container-path change instead of being dropped (and deleted). Omitted on web,
   * where downloads are keyed by stable cache URLs, not container paths.
   */
  localUri?(libraryId: number, path: string, fileName: string): string;
  /** Delete a book's directory and all its files. */
  removeBook(libraryId: number, path: string): Promise<void>;
  /** Total bytes used by all downloads. */
  totalBytesUsed(): Promise<number>;
}
