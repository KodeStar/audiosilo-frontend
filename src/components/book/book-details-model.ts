import type { TFunction } from 'i18next';

import type { Book, BookFile, ChaptersResponse } from '@/api/types';
import type { MatchedBookMeta } from '@/components/library/book-meta';
import { bitrateKbps } from '@/lib/format';
import { codecLabel } from '@/playback/transcode';

import { fileName } from './book-page-model';

/**
 * The Details tab's rules (the prototype's `DetailsPanel`): how this device plays the
 * book, its files with codec, bitrate and length, and where it lives; and the aside's
 * About card. Pure.
 */

/** Files listed before the rest fold into "and N more files". */
export const FILES_SHOWN = 6;

export type FileRow = {
  key: string;
  /** The file's path inside the book's folder (a disc folder stays). */
  name: string;
  codec: string;
  /** Average kilobits a second (`bitrateKbps`), or null when not derivable. */
  kbps: number | null;
  /** Seconds (0 when unknown). */
  duration: number;
};

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
    kbps: bitrateKbps(f.size, f.duration),
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

/** What the About card says (`aboutContent`). */
export type AboutContent = {
  /** Never empty: an undescribed book still reads complete. */
  text: string;
  /** The text is the community's (CC BY-SA), which needs the attribution beside it. */
  community: boolean;
  /** The production facts the community or the server knows, in words. */
  details: { label: string; value: string }[];
};

/**
 * The About card's content: the community's description, else the server's own (the
 * admin-edited value), else the work's core description, else a sentence naming who
 * wrote and reads the book; then the production facts (publisher, release, first
 * published, abridged), each only when known.
 */
export function aboutContent(
  book: Pick<Book, 'title' | 'author' | 'narrator' | 'description' | 'published'>,
  meta: MatchedBookMeta | undefined,
  t: TFunction,
): AboutContent {
  const shared = meta?.work.community_description?.text?.trim();
  const own = book.description?.trim() || meta?.work.description?.trim();
  const text =
    shared ||
    own ||
    (book.author && book.narrator
      ? t('book.about.fallbackBoth', {
          title: book.title,
          author: book.author,
          narrator: book.narrator,
        })
      : book.author
        ? t('book.about.fallbackAuthor', { title: book.title, author: book.author })
        : t('book.about.none'));
  const recording = meta?.recording;
  const details: AboutContent['details'] = [];
  if (recording?.publisher)
    details.push({ label: t('book.meta.publisher'), value: recording.publisher });
  const released = recording?.release_date || book.published;
  if (released) details.push({ label: t('book.meta.released'), value: released });
  if (meta?.work.first_published)
    details.push({ label: t('book.meta.firstPublished'), value: meta.work.first_published });
  if (typeof recording?.abridged === 'boolean')
    details.push({
      label: t('book.meta.abridged'),
      value: recording.abridged ? t('book.about.yes') : t('book.about.no'),
    });
  return { text, community: !!shared, details };
}
