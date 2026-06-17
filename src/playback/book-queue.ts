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

/**
 * Build the playable queue for a book. Each distinct audio file becomes one
 * track; chapters are markers laid over the whole-book timeline. A single
 * chaptered m4b yields one track with several chapters; a folder of mp3 parts
 * yields one track per file — both render identically downstream.
 */
export function buildBookQueue(
  api: ApiClient,
  libraryId: number,
  book: Book,
  chapterData?: ChaptersResponse,
): BookQueue {
  // Native engines authenticate via headers; web embeds the token in the URL.
  const headers = Platform.OS === 'web' ? undefined : api.authHeaders();
  const artwork = api.coverUrl(libraryId, book.rel_path);

  const files = chapterData?.files?.length ? chapterData.files : (book.files ?? []);
  const specs =
    files.length > 0
      ? [...files].sort((a, b) => a.seq - b.seq).map((f) => ({ path: f.rel_path, duration: f.duration }))
      : [{ path: book.rel_path, duration: book.duration }];

  const tracks: PlaybackTrack[] = specs.map((s) => ({
    id: `${libraryId}:${s.path}`,
    url: api.streamUrl(libraryId, s.path),
    headers,
    title: book.title,
    album: book.series || book.title,
    artist: book.author || book.narrator || '',
    artwork,
    duration: s.duration > 0 ? s.duration : undefined,
  }));

  const offsets: number[] = [];
  let acc = 0;
  for (const s of specs) {
    offsets.push(acc);
    acc += s.duration > 0 ? s.duration : 0;
  }

  return {
    tracks,
    offsets,
    total: book.duration > 0 ? book.duration : acc,
    chapters: chapterData?.chapters ?? book.chapters ?? [],
  };
}

/** Map a whole-book position to (trackIndex, positionInTrack). */
export function locate(offsets: number[], bookPosition: number): { index: number; positionInTrack: number } {
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
