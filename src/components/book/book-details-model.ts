import type { Book, BookFile, ChaptersResponse } from '@/api/types';
import { codecLabel } from '@/playback/transcode';

import { fileName } from './book-page-model';

/**
 * The Details tab's rules (the prototype's `DetailsPanel`): how this device plays the
 * book, its files with codec, bitrate and length, and where it lives. Pure.
 */

/** Files listed before the rest fold into "and N more files". */
export const FILES_SHOWN = 6;

export type FileRow = {
  key: string;
  /** The file's path inside the book's folder (a disc folder stays). */
  name: string;
  codec: string;
  /** Average kilobits a second, `size * 8 / duration` as the server's admin derives it,
   * or null when either is unknown. */
  kbps: number | null;
  /** Seconds (0 when unknown). */
  duration: number;
};

/** Average kbps of `size` bytes over `duration` seconds, or null when not derivable. */
export function averageKbps(size: number | undefined, duration: number | undefined) {
  if (!size || !duration || size <= 0 || duration <= 0) return null;
  const kbps = Math.round((size * 8) / duration / 1000);
  return kbps > 0 ? kbps : null;
}

/**
 * The book's files: the chapters response's (the full list), else the item's, else the
 * book itself as one file (a single-file book, or a book whose files aren't known yet).
 * The codec is the book's: the server probes one per book.
 */
export function fileRows(
  book: Pick<Book, 'rel_path' | 'size' | 'duration' | 'codec' | 'files'>,
  chapterData?: Pick<ChaptersResponse, 'files' | 'codec'>,
): FileRow[] {
  const codec = codecLabel(chapterData?.codec || book.codec);
  const files: Pick<BookFile, 'rel_path' | 'size' | 'duration'>[] = chapterData?.files?.length
    ? chapterData.files
    : book.files?.length
      ? book.files
      : [{ rel_path: book.rel_path, size: book.size, duration: book.duration }];
  return files.map((f) => ({
    key: f.rel_path,
    name: fileName(f.rel_path, book.rel_path),
    codec,
    kbps: averageKbps(f.size, f.duration),
    duration: Math.max(0, f.duration || 0),
  }));
}

/** The rows to show: the first `FILES_SHOWN` (all once `expanded`), and how many are
 * folded away. */
export function visibleFiles<T>(rows: readonly T[], expanded: boolean) {
  if (expanded || rows.length <= FILES_SHOWN) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, FILES_SHOWN), hidden: rows.length - FILES_SHOWN };
}

/**
 * How this device plays the book: from a download on this device (the original files),
 * converted by the server for this browser (web only, exactly playback's rule:
 * `useNeedsWebTranscode`), or the original file streamed as it is. Native always plays
 * the original.
 */
export type PlaybackMode = 'local' | 'converted' | 'direct';

export function playbackMode(input: { downloaded: boolean; transcoded: boolean }): PlaybackMode {
  if (input.downloaded) return 'local';
  return input.transcoded ? 'converted' : 'direct';
}
