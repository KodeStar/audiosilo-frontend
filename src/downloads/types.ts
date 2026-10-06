import type { Book, ChaptersResponse } from '@/api/types';

export type DownloadStatus = 'queued' | 'downloading' | 'downloaded' | 'error';

/** A downloaded audio file: the book-relative path mapped to its local file:// uri.
 * `bytes` is what was written (absent on entries saved before it was recorded). */
export type DownloadedFile = { relPath: string; localUri: string; bytes?: number };

/** Why a download stopped (`classifyDownloadError`), so the UI can say what went wrong
 * in the reader's language instead of echoing an engine message.
 * - `network`: the server stopped answering mid-transfer (or never answered);
 * - `server`: it answered with an HTTP error (`status`);
 * - `storage`: this device or browser ran out of room;
 * - `unservable`: saved, but the web service worker can't play it offline yet;
 * - `removed`: the server's connection was removed while it waited;
 * - `interrupted`: the app closed (or was killed) before it finished;
 * - `unknown`: anything else. */
export type DownloadFailure = {
  kind: 'network' | 'server' | 'storage' | 'unservable' | 'removed' | 'interrupted' | 'unknown';
  status?: number;
  /** The share of the book (0..1) whose files finished before it stopped: they stay on
   * the device (across a restart, while every one of them is still there), and a retry
   * skips them. */
  kept?: number;
};

/** Who asked for a download: the listener (a button, or starting the book with automatic
 * downloads on) or "Keep the next books ready". Shown on the Downloads page. */
export type DownloadOrigin = 'listener' | 'keep-ahead';

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
  /** Which server this download belongs to (the server's stable id). Scopes the
   * on-disk location and the registry key. */
  connectionId: string;
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
  /** The classified reason for an `error` status (absent on older saved entries). */
  failure?: DownloadFailure;
  /** Absent means `listener`. */
  origin?: DownloadOrigin;
  manifest: DownloadManifest;
};

/** Room for downloads where it is knowable. Native: the device's disk (`free`, and the
 * `capacity` of the disk). Web: the origin's quota from `navigator.storage.estimate()`
 * (`capacity` = the quota, `free` = quota minus everything this site stores; other
 * apps' use is not knowable there). */
export type StorageEstimate = {
  scope: 'device' | 'browser';
  capacity: number;
  free: number;
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
    connectionId: string,
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
   * The *current* uri for a stored file, recomputed from (connectionId, libraryId,
   * path, fileName). Native: the app's document-container path can change between
   * installs/launches (notably across dev rebuilds), so a `localUri` persisted at
   * download time goes stale even though the file is still on disk at the same
   * relative location; hydrate re-resolves through this so downloads survive a
   * container-path change instead of being dropped (and deleted). Web: the virtual
   * cache url is stable, but an entry adopted into a connection on hydrate is re-keyed
   * under a new prefix, so recomputing here lets it pick up its new url.
   */
  localUri?(connectionId: string, libraryId: number, path: string, fileName: string): string;
  /** Delete a book's directory and all its files. */
  removeBook(connectionId: string, libraryId: number, path: string): Promise<void>;
  /**
   * Delete EVERY downloaded file, across every connection. Used once by the
   * storage-version reset: the pre-scoping on-disk layout has no `<connectionId>`
   * segment, so `removeBook` can't locate those files - without a wholesale wipe they
   * would orphan on disk (and keep inflating `totalBytesUsed`) forever.
   */
  clearAll?(): Promise<void>;
  /** Total bytes used by all downloads. */
  totalBytesUsed(): Promise<number>;
  /** How much room there is (see {@link StorageEstimate}), or null when the platform
   * can't say. */
  storageEstimate(): Promise<StorageEstimate | null>;
}
