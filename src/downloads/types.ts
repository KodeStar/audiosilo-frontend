import type { Book, ChaptersResponse } from '@/api/types';

export type DownloadStatus = 'queued' | 'downloading' | 'downloaded' | 'error';

/** A downloaded audio file: the book-relative path mapped to its local file:// uri. */
export type DownloadedFile = { relPath: string; localUri: string };

/**
 * Offline source of truth for a downloaded book — everything the playback layer
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
 * `expo-file-system` on native; a no-op (`supported: false`) on web until the M4
 * service worker lands. Metro resolves the engine per platform like
 * `src/playback/service.*`.
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
  /** Delete a book's directory and all its files. */
  removeBook(libraryId: number, path: string): Promise<void>;
  /** Total bytes used by all downloads. */
  totalBytesUsed(): Promise<number>;
}
