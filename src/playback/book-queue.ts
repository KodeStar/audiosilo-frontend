import { Platform } from 'react-native';

import type { ApiClient } from '@/api/client';
import type { Book, Chapter, ChaptersResponse } from '@/api/types';

import type { PlaybackTrack } from './types';

export type BookQueue = {
  tracks: PlaybackTrack[];
  /** Whole-book-timeline start (seconds) of each track. */
  offsets: number[];
  /** Total book duration (seconds). */
  total: number;
  chapters: Chapter[];
};

/** One distinct audio file of a book, in play order. */
export type FileSpec = { path: string; duration: number; size: number };

/**
 * The distinct audio files that make up a book, in play order — the single
 * source of truth for both playback (`buildBookQueue`) and offline downloads, so
 * download order ≡ play order. Prefers an explicit file list; falls back to the
 * files referenced by the chapters; finally the book path itself. This must never
 * resolve to a folder path.
 */
export function bookFileSpecs(book: Book, chapterData?: ChaptersResponse): FileSpec[] {
  const files = chapterData?.files?.length ? chapterData.files : (book.files ?? []);
  if (files.length > 0) {
    return [...files]
      .sort((a, b) => a.seq - b.seq)
      .map((f) => ({ path: f.rel_path, duration: f.duration, size: f.size }));
  }
  const rawChapters = chapterData?.chapters ?? book.chapters ?? [];
  if (rawChapters.length > 0) {
    return distinctFilesFromChapters(rawChapters).map((s) => ({ ...s, size: 0 }));
  }
  return [{ path: book.rel_path, duration: book.duration, size: book.size }];
}

/**
 * Build the playable queue for a book. Each distinct audio file becomes one
 * track; chapters are markers laid over the whole-book timeline. A single
 * chaptered m4b yields one track with several chapters; a folder of mp3 parts
 * yields one track per file — both render identically downstream. When `local`
 * is supplied (the book is downloaded), each file's track points at its local
 * `file://` uri instead of the server stream.
 */
export function buildBookQueue(
  api: ApiClient,
  libraryId: number,
  book: Book,
  chapterData?: ChaptersResponse,
  local?: { files: Map<string, string>; artwork?: string },
): BookQueue {
  // Native engines authenticate via headers; web embeds the token in the URL.
  const headers = Platform.OS === 'web' ? undefined : api.authHeaders();
  const artwork = local?.artwork ?? api.coverUrl(libraryId, book.rel_path);

  const rawChapters = chapterData?.chapters ?? book.chapters ?? [];
  const specs = bookFileSpecs(book, chapterData);

  const tracks: PlaybackTrack[] = specs.map((s) => {
    const localUri = local?.files.get(s.path);
    return {
      id: `${libraryId}:${s.path}`,
      url: localUri ?? api.streamUrl(libraryId, s.path),
      headers: localUri ? undefined : headers,
      title: book.title,
      album: book.series || book.title,
      artist: book.author || book.narrator || '',
      artwork,
      duration: s.duration > 0 ? s.duration : undefined,
    };
  });

  const offsets: number[] = [];
  let acc = 0;
  for (const s of specs) {
    offsets.push(acc);
    acc += s.duration > 0 ? s.duration : 0;
  }

  // Recompute each chapter's whole-book offset from our own track offsets + the
  // in-file start. The server's book_offset is unreliable for some on-demand
  // indexed books (comes back 0 for every chapter), which otherwise makes
  // chapter detection always resolve to the last chapter.
  const trackOffset = (fileIndex: number) => offsets[fileIndex] ?? 0;
  const chapters: Chapter[] = rawChapters.map((ch) => ({
    ...ch,
    book_offset: trackOffset(ch.file_index) + ch.start,
  }));

  // total: prefer the book duration, else the summed file durations, else the
  // furthest chapter end on the book timeline (handles duration === 0 metadata).
  const furthestEnd = chapters.reduce(
    (max, ch) => Math.max(max, trackOffset(ch.file_index) + ch.end),
    0,
  );
  const total = Math.max(book.duration > 0 ? book.duration : 0, acc, furthestEnd);

  return { tracks, offsets, total, chapters };
}

/** Distinct audio files referenced by a book's chapters, in play order, with a
 * per-file duration estimated from the largest chapter end within it. */
function distinctFilesFromChapters(chapters: Chapter[]): { path: string; duration: number }[] {
  const order: string[] = [];
  const durations = new Map<string, number>();
  for (const ch of chapters) {
    if (!order.includes(ch.file_path)) order.push(ch.file_path);
    durations.set(ch.file_path, Math.max(durations.get(ch.file_path) ?? 0, ch.end));
  }
  return order.map((path) => ({ path, duration: durations.get(path) ?? 0 }));
}

/** Map a whole-book position to (trackIndex, positionInTrack). */
export function locate(
  offsets: number[],
  bookPosition: number,
): { index: number; positionInTrack: number } {
  let index = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (bookPosition >= offsets[i]) index = i;
    else break;
  }
  return { index, positionInTrack: Math.max(0, bookPosition - (offsets[index] ?? 0)) };
}

/** Map (trackIndex, positionInTrack) back to a whole-book position. */
export function toBookPosition(offsets: number[], index: number, positionInTrack: number): number {
  return (offsets[index] ?? 0) + positionInTrack;
}

/** The chapter active at a given whole-book position. */
export function chapterAt(chapters: Chapter[], bookPosition: number): Chapter | null {
  let current: Chapter | null = null;
  for (const ch of chapters) {
    if (bookPosition >= ch.book_offset) current = ch;
    else break;
  }
  return current ?? chapters[0] ?? null;
}
