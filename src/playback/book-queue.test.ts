import type { ApiClient } from '@/api/client';
import type { Book, Chapter, ChaptersResponse } from '@/api/types';

import {
  bookFileSpecs,
  buildBookQueue,
  chapterAt,
  chapterCountdowns,
  locate,
  toBookPosition,
} from '@/playback/book-queue';

// A fake client exposing only what the queue builder calls.
const fakeApi = {
  coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
  streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
  authHeaders: () => ({ Authorization: 'Bearer x' }),
} as unknown as ApiClient;

function makeBook(p: Partial<Book>): Book {
  return {
    id: 1,
    library_id: 2,
    rel_path: 'x',
    is_folder: false,
    title: 'T',
    author: 'A',
    series: '',
    series_index: 0,
    narrator: '',
    duration: 0,
    format: 'mp3',
    size: 0,
    ...p,
  };
}

function chapter(p: Partial<Chapter>): Chapter {
  return {
    index: 0,
    title: 'ch',
    file_index: 0,
    file_path: 'f',
    start: 0,
    end: 0,
    book_offset: 0,
    ...p,
  };
}

describe('bookFileSpecs', () => {
  it('prefers the explicit file list, sorted by seq', () => {
    const book = makeBook({
      rel_path: 'A/Book',
      is_folder: true,
      files: [
        { rel_path: 'A/Book/02.mp3', seq: 2, duration: 100, format: 'mp3', size: 10 },
        { rel_path: 'A/Book/01.mp3', seq: 1, duration: 60, format: 'mp3', size: 5 },
      ],
    });
    expect(bookFileSpecs(book).map((s) => s.path)).toEqual(['A/Book/01.mp3', 'A/Book/02.mp3']);
  });

  it('falls back to the distinct files referenced by chapters', () => {
    const book = makeBook({
      files: [],
      chapters: [
        chapter({ index: 0, file_path: 'p1.mp3', end: 30 }),
        chapter({ index: 1, file_index: 1, file_path: 'p2.mp3', end: 50 }),
      ],
    });
    expect(bookFileSpecs(book)).toEqual([
      { path: 'p1.mp3', duration: 30, size: 0 },
      { path: 'p2.mp3', duration: 50, size: 0 },
    ]);
  });

  it('falls back to the book path itself (never a folder)', () => {
    const book = makeBook({ rel_path: 'solo.m4b', duration: 42, size: 7 });
    expect(bookFileSpecs(book)).toEqual([{ path: 'solo.m4b', duration: 42, size: 7 }]);
  });
});

describe('buildBookQueue', () => {
  it('lays multiple files onto one whole-book timeline', () => {
    const book = makeBook({
      rel_path: 'A/Book',
      is_folder: true,
      files: [
        { rel_path: 'A/Book/01.mp3', seq: 1, duration: 60, format: 'mp3', size: 5 },
        { rel_path: 'A/Book/02.mp3', seq: 2, duration: 100, format: 'mp3', size: 10 },
      ],
    });
    const q = buildBookQueue(fakeApi, 2, book);
    expect(q.tracks.map((t) => t.url)).toEqual([
      'stream:2:A/Book/01.mp3',
      'stream:2:A/Book/02.mp3',
    ]);
    expect(q.offsets).toEqual([0, 60]);
    expect(q.total).toBe(160);
    // Native (default jest-expo Platform.OS = ios) attaches auth headers.
    expect(q.tracks[0].headers).toEqual({ Authorization: 'Bearer x' });
  });

  it('recomputes each chapter book_offset from track offsets (server returns 0)', () => {
    const book = makeBook({ rel_path: 'A/single.m4b', duration: 200 });
    const chapterData: ChaptersResponse = {
      library_id: 2,
      path: 'A/single.m4b',
      duration: 200,
      is_folder: false,
      files: [{ rel_path: 'A/single.m4b', seq: 1, duration: 200, format: 'm4b', size: 0 }],
      chapters: [
        chapter({ index: 0, file_path: 'A/single.m4b', start: 0, end: 100, book_offset: 0 }),
        chapter({ index: 1, file_path: 'A/single.m4b', start: 100, end: 200, book_offset: 0 }),
      ],
    };
    const q = buildBookQueue(fakeApi, 2, book, chapterData);
    expect(q.offsets).toEqual([0]); // single file
    expect(q.chapters[1].book_offset).toBe(100);
    expect(q.total).toBe(200);
  });

  it('maps chapter book_offsets via trackOffset(file_index), not chapter order', () => {
    // No explicit files list: tracks derive from the distinct chapter file_paths in
    // first-seen order [p1, p2] → offsets [0, 30]. The chapters arrive with
    // NON-sequential file_index values, so a correct build must key each offset off
    // file_index (not the chapter's position in the array).
    const book = makeBook({
      rel_path: 'A/Book',
      is_folder: true,
      files: [],
      chapters: [
        chapter({ index: 0, file_index: 1, file_path: 'p2.mp3', start: 5, end: 50 }),
        chapter({ index: 1, file_index: 0, file_path: 'p1.mp3', start: 0, end: 30 }),
      ],
    });
    const q = buildBookQueue(fakeApi, 2, book);
    // distinctFilesFromChapters order: p2 first (file_index 1), then p1 (file_index 0).
    expect(q.tracks.map((t) => t.url)).toEqual(['stream:2:p2.mp3', 'stream:2:p1.mp3']);
    expect(q.offsets).toEqual([0, 50]); // p2 dur=50, p1 starts at 50
    // chapter file_index 1 → trackOffset(1)=50, + start 5 = 55
    expect(q.chapters[0].book_offset).toBe(55);
    // chapter file_index 0 → trackOffset(0)=0, + start 0 = 0
    expect(q.chapters[1].book_offset).toBe(0);
  });

  it('uses local file uris and drops headers when the book is downloaded', () => {
    const book = makeBook({ rel_path: 'A/single.m4b', duration: 50 });
    const q = buildBookQueue(fakeApi, 2, book, undefined, {
      files: new Map([['A/single.m4b', 'file:///local/a.m4b']]),
    });
    expect(q.tracks[0].url).toBe('file:///local/a.m4b');
    expect(q.tracks[0].headers).toBeUndefined();
  });
});

describe('timeline math', () => {
  const offsets = [0, 60, 160];

  it('locate / toBookPosition round-trips across tracks', () => {
    expect(locate(offsets, 0)).toEqual({ index: 0, positionInTrack: 0 });
    expect(locate(offsets, 70)).toEqual({ index: 1, positionInTrack: 10 });
    expect(locate(offsets, 500)).toEqual({ index: 2, positionInTrack: 340 });
    expect(toBookPosition(offsets, 1, 10)).toBe(70);
  });

  it('chapterAt finds the active chapter and clamps below the first', () => {
    const chapters = [
      chapter({ index: 0, book_offset: 0 }),
      chapter({ index: 1, book_offset: 50 }),
    ];
    expect(chapterAt(chapters, 75)?.index).toBe(1);
    expect(chapterAt(chapters, -5)?.index).toBe(0);
    expect(chapterAt([], 10)).toBeNull();
  });
});

describe('chapterCountdowns', () => {
  const chapters = [
    chapter({ index: 0, book_offset: 0, start: 0, end: 60 }),
    chapter({ index: 1, book_offset: 60, start: 60, end: 200 }),
    chapter({ index: 2, book_offset: 200, start: 200, end: 320 }),
  ];

  it('lists the current chapter first, then the rest, with time until each end', () => {
    const out = chapterCountdowns(chapters, 90);
    expect(out.map((c) => c.chapter.index)).toEqual([1, 2]);
    expect(out[0].endPosition).toBe(200);
    expect(out[0].untilEnd).toBe(110); // 200 - 90
    expect(out[1].untilEnd).toBe(230); // 320 - 90
  });

  it('starts at the first chapter when before the first offset', () => {
    const out = chapterCountdowns(chapters, 0);
    expect(out.map((c) => c.chapter.index)).toEqual([0, 1, 2]);
    expect(out[0].untilEnd).toBe(60);
  });

  it('returns [] when there are no chapters', () => {
    expect(chapterCountdowns([], 10)).toEqual([]);
  });

  // Build N back-to-back chapters of `len` seconds each, from offset 0.
  const evenChapters = (n: number, len: number) =>
    Array.from({ length: n }, (_, i) =>
      chapter({ index: i, book_offset: i * len, start: i * len, end: (i + 1) * len }),
    );

  it('keeps chapters through the one that crosses maxSeconds (inclusive)', () => {
    // 12 × 10min: countdowns 10,20,…,120min. First over 60min is the 70-min one.
    const out = chapterCountdowns(evenChapters(12, 600), 0, { minCount: 5, maxSeconds: 3600 });
    expect(out).toHaveLength(7);
    expect(out[6].untilEnd).toBe(4200); // 70 min — the chapter that crosses the hour
  });

  it('never shows fewer than minCount even when the hour is reached sooner', () => {
    // 10 × 20min: 20,40,60,80,… — the hour is crossed at the 4th, but min is 5.
    const out = chapterCountdowns(evenChapters(10, 1200), 0, { minCount: 5, maxSeconds: 3600 });
    expect(out).toHaveLength(5);
  });

  it('keeps every chapter when none reach maxSeconds', () => {
    const out = chapterCountdowns(evenChapters(3, 600), 0, { minCount: 5, maxSeconds: 3600 });
    expect(out).toHaveLength(3);
  });
});
