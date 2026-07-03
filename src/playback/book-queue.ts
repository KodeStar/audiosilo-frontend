import { Platform } from 'react-native';

import type { ApiClient } from '@/api/client';
import type { Book, Chapter, ChaptersResponse } from '@/api/types';

import { wallClockSeconds } from './rate';
import type { PlaybackChapter, PlaybackTrack } from './types';

export type BookQueue = {
  tracks: PlaybackTrack[];
  /** Whole-book-timeline start (seconds) of each track. */
  offsets: number[];
  /** Total book duration (seconds). */
  total: number;
  chapters: Chapter[];
  /** Per-chapter clips for the native engine's lock-screen chapter controls; `[]`
   * when the book has 0/1 chapters (the engine then plays one item per file). */
  chapterClips: PlaybackChapter[];
  /** True when `chapters` are evenly-spaced markers synthesized for a long,
   * chapterless single file (so prev/next-chapter and the seek bar work). These are
   * deliberately NOT fed to `buildChapterClips`, so `chapterClips` stays `[]` and
   * native playback is unchanged; a native-parity follow-up must opt in explicitly. */
  syntheticChapters: boolean;
};

/** Default chapter length (seconds) used to synthesize markers for a long,
 * chapterless single-file book. Overridable per call (a user setting). */
export const DEFAULT_VIRTUAL_CHAPTER_INTERVAL = 30 * 60;

/** One distinct audio file of a book, in play order. */
export type FileSpec = { path: string; duration: number; size: number };

/**
 * The distinct audio files that make up a book, in play order - the single
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
 * Whole-book start offset (seconds) of a chapter: the summed duration of the
 * files that precede it plus its in-file `start`. Located by `file_path` (with a
 * `file_index` fallback) so a non-sequential `file_index` can't misplace a
 * chapter. Shared by the playback queue and the book screen's chapter list so
 * both agree on the timeline (the server's `book_offset` is unreliable for some
 * on-demand-indexed books - it comes back 0 for every chapter).
 */
export function chapterBookOffset(
  files: { path: string; duration: number }[],
  ch: { file_index: number; file_path: string; start: number },
): number {
  const byPath = files.findIndex((f) => f.path === ch.file_path);
  // Fall back to `file_index` only when it's a real index; an out-of-range index
  // (stale chapter metadata that also fails the path match) would otherwise sum
  // EVERY file's duration and roughly double the book's computed length - degrade
  // to 0 preceding files instead, as the old `offsets[file_index] ?? 0` did.
  const inRange = ch.file_index >= 0 && ch.file_index < files.length;
  const upto = byPath >= 0 ? byPath : inRange ? ch.file_index : 0;
  let acc = 0;
  for (let i = 0; i < upto && i < files.length; i++) {
    acc += files[i].duration > 0 ? files[i].duration : 0;
  }
  return acc + ch.start;
}

/** Index of the file a chapter plays from, within `specs`. Resolves by `file_path`
 * first (a non-sequential `file_index` can't misplace it), falling back to a valid
 * `file_index`; -1 when neither maps. */
function fileIndexOf(specs: FileSpec[], ch: Chapter): number {
  const byPath = specs.findIndex((s) => s.path === ch.file_path);
  if (byPath >= 0) return byPath;
  return ch.file_index >= 0 && ch.file_index < specs.length ? ch.file_index : -1;
}

/**
 * Per-chapter clips for the native engine to turn into clipped media items, so the
 * Android lock screen gets a chapter-relative scrubber and prev/next-chapter buttons.
 * Each chapter maps to `(fileIndex, [startInFile, endInFile])`; the LAST chapter in a
 * file clips "to end" (`endInFile = 0`) so an inaccurate final `end` can't cut off the
 * file's tail. Returns `[]` when there are 0 or 1 chapters (the engine then plays one
 * item per file - today's behavior), or if any chapter can't be mapped to a file (so a
 * partial/broken clip queue never strands playback - fall back to file mode).
 */
export function buildChapterClips(specs: FileSpec[], chapters: Chapter[]): PlaybackChapter[] {
  if (chapters.length <= 1) return [];
  // Resolve each chapter's file once up front - the loop needs both a chapter's index
  // and the next one's, so looking up inline would scan the specs twice per chapter.
  const fileIndices = chapters.map((ch) => fileIndexOf(specs, ch));
  const clips: PlaybackChapter[] = [];
  const coveredFiles = new Set<number>();
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const fileIndex = fileIndices[i];
    if (fileIndex < 0) return []; // unmappable chapter → safe fallback to file mode
    const lastInFile = i + 1 >= chapters.length || fileIndices[i + 1] !== fileIndex;
    // A non-final in-file chapter with a non-positive span has unusable clip bounds:
    // endInFile <= 0 is read by the native layer as "to end of file", so this clip
    // would swallow the rest of the file and the following clips would replay it. Bad
    // metadata like this → bail to safe file mode rather than a broken clip queue.
    if (!lastInFile && ch.end <= ch.start) return [];
    clips.push({
      fileIndex,
      startInFile: Math.max(0, ch.start),
      endInFile: lastInFile ? 0 : Math.max(0, ch.end),
      title: ch.title,
    });
    coveredFiles.add(fileIndex);
  }
  // Every file must be covered by at least one chapter. An uncovered file's positions
  // would fall through the native fileToItem fallback into a different file's clip, so
  // a specs/chapters mismatch → safe file mode.
  if (coveredFiles.size !== specs.length) return [];
  return clips;
}

/**
 * Evenly-spaced virtual chapters for a long, chapterless single-file book, so
 * prev/next-chapter and the chapter-relative seek bar have somewhere to go. Returns
 * `ceil(total / interval)` chapters over the one file; the last ends exactly at
 * `total` (the `ceil` + `min` avoids a zero-length trailing chapter on an exact
 * multiple). Returns `[]` below `interval * 1.5` (splitting adds no value) - callers
 * also gate, but self-guarding keeps this directly testable. `title: ''` renders as
 * "Chapter N" via the existing i18n fallback. These are never passed to
 * `buildChapterClips`, so they don't change native playback (see `BookQueue`).
 */
export function synthesizeChapters(
  filePath: string,
  total: number,
  interval: number = DEFAULT_VIRTUAL_CHAPTER_INTERVAL,
): Chapter[] {
  if (interval <= 0 || total <= interval * 1.5) return [];
  const count = Math.ceil(total / interval);
  const chapters: Chapter[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * interval;
    chapters.push({
      index: i,
      title: '',
      file_index: 0,
      file_path: filePath,
      start,
      end: Math.min(start + interval, total),
      book_offset: start,
    });
  }
  return chapters;
}

/**
 * Build the playable queue for a book. Each distinct audio file becomes one
 * track; chapters are markers laid over the whole-book timeline. A single
 * chaptered m4b yields one track with several chapters; a folder of mp3 parts
 * yields one track per file - both render identically downstream. When `local`
 * is supplied (the book is downloaded), each file's track points at its local
 * `file://` uri instead of the server stream.
 *
 * A long single file with no real chapters gets evenly-spaced synthetic chapters
 * (`virtualChapterInterval`, default 30 min) so chapter navigation works; those
 * synthetic chapters are kept out of `chapterClips` so native playback is unchanged.
 */
export function buildBookQueue(
  api: ApiClient,
  libraryId: number,
  book: Book,
  chapterData?: ChaptersResponse,
  local?: { files: Map<string, string>; artwork?: string },
  virtualChapterInterval: number = DEFAULT_VIRTUAL_CHAPTER_INTERVAL,
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

  // Recompute each chapter's whole-book offset from our own file durations +
  // the in-file start (see chapterBookOffset). The server's book_offset is
  // unreliable for some on-demand indexed books (comes back 0 for every
  // chapter), which otherwise makes chapter detection resolve to the last one.
  const chapters: Chapter[] = rawChapters.map((ch) => ({
    ...ch,
    book_offset: chapterBookOffset(specs, ch),
  }));

  // total: prefer the book duration, else the summed file durations, else the
  // furthest chapter end on the book timeline (handles duration === 0 metadata).
  const furthestEnd = chapters.reduce(
    (max, ch) => Math.max(max, ch.book_offset + Math.max(0, ch.end - ch.start)),
    0,
  );
  const total = Math.max(book.duration > 0 ? book.duration : 0, acc, furthestEnd);

  // Clips come from the REAL chapters (empty/singleton here → `[]`); computing them
  // before synthesizing is what keeps native playback unchanged for these books.
  const chapterClips = buildChapterClips(specs, chapters);

  // A long single file with no usable chapters (0, or a lone whole-book chapter) has
  // one segment boundary at 0 → nowhere to skip forward, and "back" restarts. Overlay
  // evenly-spaced virtual chapters so navigation works. `synthesizeChapters` owns the
  // "long enough to bother" threshold, so `syntheticChapters` is derived from whether it
  // actually produced any - one source of truth (no threshold to keep in sync), and the
  // flag can never claim markers that don't exist (e.g. a 0/negative interval). Multi-
  // file books already have per-file offsets as boundaries, so they're left alone.
  const synthetic =
    specs.length === 1 && chapters.length <= 1
      ? synthesizeChapters(specs[0].path, total, virtualChapterInterval)
      : [];
  const finalChapters = synthetic.length > 0 ? synthetic : chapters;

  return {
    tracks,
    offsets,
    total,
    chapters: finalChapters,
    chapterClips,
    syntheticChapters: synthetic.length > 0,
  };
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

export type ChapterCountdown = {
  chapter: Chapter;
  /** Whole-book position (seconds) of this chapter's end. */
  endPosition: number;
  /** Wall-clock seconds from `bookPosition` until this chapter's end, i.e.
   * content-seconds remaining divided by the playback `rate`. */
  untilEnd: number;
};

/**
 * The current chapter and the ones after it, each annotated with the whole-book
 * position of its end and the time from `bookPosition` until that end - drives
 * the sleep timer's "end of chapter" picker. The first entry is always the
 * current chapter (the time left in it). Returns [] when there are no chapters.
 *
 * `untilEnd` is wall-clock time, so `rate` (the current playback speed) scales it:
 * at 2x, an hour of content is 30 minutes of real listening. This keeps the
 * countdowns - and the `maxSeconds` window - honest about how long until sleep.
 *
 * `limit` bounds how many options to show so the list spans a useful range of
 * upcoming chapters: keep chapters until one's countdown passes `maxSeconds`
 * (that chapter is the last kept, so the list always crosses the threshold rather
 * than stopping just short), but never fewer than `minCount`.
 */
export function chapterCountdowns(
  chapters: Chapter[],
  bookPosition: number,
  limit?: { minCount: number; maxSeconds: number },
  rate = 1,
): ChapterCountdown[] {
  if (chapters.length === 0) return [];
  const current = chapterAt(chapters, bookPosition);
  const from = current ? chapters.indexOf(current) : 0;
  const list = chapters.slice(Math.max(0, from)).map((ch) => {
    const endPosition = ch.book_offset + Math.max(0, ch.end - ch.start);
    return {
      chapter: ch,
      endPosition,
      untilEnd: wallClockSeconds(endPosition - bookPosition, rate),
    };
  });
  if (!limit) return list;
  // First chapter whose countdown passes the threshold, kept inclusively as the
  // last entry; if none pass, keep them all. Then never show fewer than minCount.
  const firstOver = list.findIndex((c) => c.untilEnd > limit.maxSeconds);
  const count = Math.max(limit.minCount, firstOver < 0 ? list.length : firstOver + 1);
  return list.slice(0, count);
}
