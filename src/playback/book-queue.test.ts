import type { ApiClient } from '@/api/client';
import type { Book, Chapter, ChaptersResponse } from '@/api/types';

import {
  bookFileSpecs,
  buildBookQueue,
  buildChapterClips,
  chapterAt,
  chapterCountdowns,
  type FileSpec,
  locate,
  synthesizeChapters,
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

  it('maps chapter book_offsets by file_path, robust to non-sequential file_index', () => {
    // No explicit files list: tracks derive from the distinct chapter file_paths in
    // first-seen order [p2, p1] → offsets [0, 50]. The chapters carry file_index
    // values that DON'T match that track order, so a correct build must locate each
    // chapter's offset by its file_path (its real track), not by file_index — keying
    // by file_index here would place the p2 chapter on p1's offset and vice-versa.
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
    // distinctFilesFromChapters order: p2 first (seen first), then p1.
    expect(q.tracks.map((t) => t.url)).toEqual(['stream:2:p2.mp3', 'stream:2:p1.mp3']);
    expect(q.offsets).toEqual([0, 50]); // p2 dur=50 at 0, p1 starts at 50
    // chapter in p2.mp3 (track 0, offset 0) at in-file start 5 → 5
    expect(q.chapters[0].book_offset).toBe(5);
    // chapter in p1.mp3 (track 1, offset 50) at in-file start 0 → 50
    expect(q.chapters[1].book_offset).toBe(50);
  });

  it('uses local file uris and drops headers when the book is downloaded', () => {
    const book = makeBook({ rel_path: 'A/single.m4b', duration: 50 });
    const q = buildBookQueue(fakeApi, 2, book, undefined, {
      files: new Map([['A/single.m4b', 'file:///local/a.m4b']]),
    });
    expect(q.tracks[0].url).toBe('file:///local/a.m4b');
    expect(q.tracks[0].headers).toBeUndefined();
  });

  it('synthesizes virtual chapters for a long chapterless single file, without native clips', () => {
    const book = makeBook({ rel_path: 'big.mp3', duration: 5400 }); // 90 min, no chapters
    const q = buildBookQueue(fakeApi, 2, book);
    expect(q.offsets).toEqual([0]); // still one track/file
    expect(q.chapters.map((c) => c.book_offset)).toEqual([0, 1800, 3600]); // 30-min blocks
    expect(q.chapters.every((c) => c.file_path === 'big.mp3')).toBe(true);
    expect(q.total).toBe(5400);
    expect(q.syntheticChapters).toBe(true);
    // The key native-safety assertion: synthetic chapters never become clips, so the
    // native engine still plays one whole-file item (today's behavior).
    expect(q.chapterClips).toEqual([]);
  });

  it('does not synthesize for a short single file', () => {
    const book = makeBook({ rel_path: 'small.mp3', duration: 600 }); // 10 min < threshold
    const q = buildBookQueue(fakeApi, 2, book);
    expect(q.chapters).toEqual([]);
    expect(q.chapterClips).toEqual([]);
    expect(q.syntheticChapters).toBe(false);
  });

  it('synthesizes over a lone whole-book chapter on a long single file', () => {
    const book = makeBook({ rel_path: 'A/single.m4b', duration: 5400 });
    const chapterData: ChaptersResponse = {
      library_id: 2,
      path: 'A/single.m4b',
      duration: 5400,
      is_folder: false,
      files: [{ rel_path: 'A/single.m4b', seq: 1, duration: 5400, format: 'm4b', size: 0 }],
      chapters: [chapter({ index: 0, file_path: 'A/single.m4b', start: 0, end: 5400 })],
    };
    const q = buildBookQueue(fakeApi, 2, book, chapterData);
    expect(q.chapters).toHaveLength(3);
    expect(q.chapters.every((c) => c.file_path === 'A/single.m4b')).toBe(true);
    expect(q.syntheticChapters).toBe(true);
    expect(q.chapterClips).toEqual([]); // input had ≤1 real chapter → no clips
  });

  it('leaves a real multi-chapter m4b untouched (real chapters + real clips)', () => {
    const book = makeBook({ rel_path: 'A/single.m4b', duration: 5400 });
    const chapterData: ChaptersResponse = {
      library_id: 2,
      path: 'A/single.m4b',
      duration: 5400,
      is_folder: false,
      files: [{ rel_path: 'A/single.m4b', seq: 1, duration: 5400, format: 'm4b', size: 0 }],
      chapters: [
        chapter({ index: 0, title: 'One', file_path: 'A/single.m4b', start: 0, end: 1800 }),
        chapter({ index: 1, title: 'Two', file_path: 'A/single.m4b', start: 1800, end: 3600 }),
        chapter({ index: 2, title: 'Three', file_path: 'A/single.m4b', start: 3600, end: 5400 }),
      ],
    };
    const q = buildBookQueue(fakeApi, 2, book, chapterData);
    expect(q.chapters.map((c) => c.title)).toEqual(['One', 'Two', 'Three']);
    expect(q.syntheticChapters).toBe(false);
    expect(q.chapterClips).toHaveLength(3);
  });

  it('does not synthesize for a multi-file book with no chapters (offsets are the boundaries)', () => {
    const book = makeBook({
      rel_path: 'A/Book',
      is_folder: true,
      files: [
        { rel_path: 'A/Book/01.mp3', seq: 1, duration: 1800, format: 'mp3', size: 5 },
        { rel_path: 'A/Book/02.mp3', seq: 2, duration: 1800, format: 'mp3', size: 5 },
      ],
    });
    const q = buildBookQueue(fakeApi, 2, book);
    expect(q.chapters).toEqual([]);
    expect(q.offsets).toEqual([0, 1800]); // per-file boundaries already navigable
    expect(q.chapterClips).toEqual([]);
    expect(q.syntheticChapters).toBe(false);
  });

  it('honors a custom interval when synthesizing', () => {
    const book = makeBook({ rel_path: 'big.mp3', duration: 5400 });
    const q = buildBookQueue(fakeApi, 2, book, undefined, undefined, 900); // 15-min blocks
    expect(q.chapters.map((c) => c.book_offset)).toEqual([0, 900, 1800, 2700, 3600, 4500]);
    expect(q.syntheticChapters).toBe(true);
  });
});

describe('buildChapterClips', () => {
  const spec = (path: string, duration = 0): FileSpec => ({ path, duration, size: 0 });

  it('returns [] for 0 or 1 chapters (engine falls back to one item per file)', () => {
    expect(buildChapterClips([spec('a.m4b')], [])).toEqual([]);
    expect(buildChapterClips([spec('a.m4b')], [chapter({ file_path: 'a.m4b' })])).toEqual([]);
  });

  it('splits a single-file m4b into per-chapter clips; last clips to end of file', () => {
    const specs = [spec('a.m4b', 300)];
    const chapters = [
      chapter({ index: 0, file_path: 'a.m4b', start: 0, end: 100 }),
      chapter({ index: 1, file_path: 'a.m4b', start: 100, end: 200 }),
      chapter({ index: 2, file_path: 'a.m4b', start: 200, end: 300 }),
    ];
    expect(buildChapterClips(specs, chapters)).toEqual([
      { fileIndex: 0, startInFile: 0, endInFile: 100, title: 'ch' },
      { fileIndex: 0, startInFile: 100, endInFile: 200, title: 'ch' },
      { fileIndex: 0, startInFile: 200, endInFile: 0, title: 'ch' }, // last in file → to end
    ]);
  });

  it('maps one-chapter-per-file books to a whole-file clip each (endInFile=0)', () => {
    const specs = [spec('p1.mp3', 60), spec('p2.mp3', 90)];
    const chapters = [
      chapter({ index: 0, file_path: 'p1.mp3', start: 0, end: 60 }),
      chapter({ index: 1, file_index: 1, file_path: 'p2.mp3', start: 0, end: 90 }),
    ];
    expect(buildChapterClips(specs, chapters)).toEqual([
      { fileIndex: 0, startInFile: 0, endInFile: 0, title: 'ch' },
      { fileIndex: 1, startInFile: 0, endInFile: 0, title: 'ch' },
    ]);
  });

  it('handles multi-file books with embedded chapters (last chapter in each file → to end)', () => {
    const specs = [spec('p1.m4b', 200), spec('p2.m4b', 200)];
    const chapters = [
      chapter({ index: 0, file_path: 'p1.m4b', start: 0, end: 100 }),
      chapter({ index: 1, file_path: 'p1.m4b', start: 100, end: 200 }),
      chapter({ index: 2, file_index: 1, file_path: 'p2.m4b', start: 0, end: 120 }),
      chapter({ index: 3, file_index: 1, file_path: 'p2.m4b', start: 120, end: 200 }),
    ];
    expect(buildChapterClips(specs, chapters)).toEqual([
      { fileIndex: 0, startInFile: 0, endInFile: 100, title: 'ch' },
      { fileIndex: 0, startInFile: 100, endInFile: 0, title: 'ch' }, // last in p1 → to end
      { fileIndex: 1, startInFile: 0, endInFile: 120, title: 'ch' },
      { fileIndex: 1, startInFile: 120, endInFile: 0, title: 'ch' }, // last in p2 → to end
    ]);
  });

  it('resolves fileIndex by file_path even when file_index is non-sequential', () => {
    // tracks order [p2, p1]; chapters carry file_index that does NOT match.
    const specs = [spec('p2.mp3', 50), spec('p1.mp3', 30)];
    const chapters = [
      chapter({ index: 0, file_index: 1, file_path: 'p2.mp3', start: 0, end: 50 }),
      chapter({ index: 1, file_index: 0, file_path: 'p1.mp3', start: 0, end: 30 }),
    ];
    expect(buildChapterClips(specs, chapters).map((c) => c.fileIndex)).toEqual([0, 1]);
  });

  it('falls back to [] if any chapter cannot be mapped to a file (avoids a broken queue)', () => {
    const specs = [spec('a.m4b', 100)];
    const chapters = [
      chapter({ index: 0, file_path: 'a.m4b', start: 0, end: 50 }),
      chapter({ index: 1, file_index: 9, file_path: 'ghost.m4b', start: 50, end: 100 }),
    ];
    expect(buildChapterClips(specs, chapters)).toEqual([]);
  });

  it('buildBookQueue exposes chapterClips consistent with chapters', () => {
    const book = makeBook({ rel_path: 'A/single.m4b', duration: 200 });
    const chapterData: ChaptersResponse = {
      library_id: 2,
      path: 'A/single.m4b',
      duration: 200,
      is_folder: false,
      files: [{ rel_path: 'A/single.m4b', seq: 1, duration: 200, format: 'm4b', size: 0 }],
      chapters: [
        chapter({ index: 0, file_path: 'A/single.m4b', start: 0, end: 100 }),
        chapter({ index: 1, file_path: 'A/single.m4b', start: 100, end: 200 }),
      ],
    };
    const q = buildBookQueue(fakeApi, 2, book, chapterData);
    expect(q.chapterClips).toEqual([
      { fileIndex: 0, startInFile: 0, endInFile: 100, title: 'ch' },
      { fileIndex: 0, startInFile: 100, endInFile: 0, title: 'ch' },
    ]);
  });
});

describe('synthesizeChapters', () => {
  it('splits a long file into evenly-spaced blocks (title empty → "Chapter N" fallback)', () => {
    const out = synthesizeChapters('big.mp3', 5400, 1800); // 90 min / 30 min = 3
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.start)).toEqual([0, 1800, 3600]);
    expect(out.map((c) => c.end)).toEqual([1800, 3600, 5400]);
    expect(out.map((c) => c.book_offset)).toEqual([0, 1800, 3600]);
    expect(out.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(
      out.every((c) => c.title === '' && c.file_index === 0 && c.file_path === 'big.mp3'),
    ).toBe(true);
  });

  it('clamps the final block to total with no zero-length trailing chapter', () => {
    const out = synthesizeChapters('big.mp3', 5401, 1800); // just over 3 blocks
    expect(out).toHaveLength(4);
    expect(out[3].start).toBe(5400);
    expect(out[3].end).toBe(5401);
  });

  it('produces no empty trailing chapter on an exact multiple', () => {
    const out = synthesizeChapters('big.mp3', 3600, 1800); // exactly 2 blocks
    expect(out).toHaveLength(2);
    expect(out[1].end).toBe(3600);
  });

  it('returns [] below the 1.5× interval threshold', () => {
    expect(synthesizeChapters('big.mp3', 2000, 1800)).toEqual([]); // < 2700
    expect(synthesizeChapters('big.mp3', 0, 1800)).toEqual([]);
  });

  it('uses the default 30-minute interval when none is given', () => {
    expect(synthesizeChapters('big.mp3', 5400)).toHaveLength(3);
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

  it('scales untilEnd by the playback rate (wall-clock), leaving endPosition alone', () => {
    const out = chapterCountdowns(chapters, 90, undefined, 2);
    expect(out[0].endPosition).toBe(200); // content position — unchanged by rate
    expect(out[0].untilEnd).toBe(55); // (200 - 90) / 2
    expect(out[1].untilEnd).toBe(115); // (320 - 90) / 2
  });

  it('applies rate to the maxSeconds window so it counts real listening time', () => {
    // 20 × 10min content. At 1x the hour window keeps 7; at 2x an hour of real time
    // spans 2h of content, so more chapters fit — the window is wall-clock.
    const at1x = chapterCountdowns(evenChapters(20, 600), 0, { minCount: 5, maxSeconds: 3600 }, 1);
    const at2x = chapterCountdowns(evenChapters(20, 600), 0, { minCount: 5, maxSeconds: 3600 }, 2);
    expect(at1x).toHaveLength(7);
    expect(at2x).toHaveLength(13); // ch ending at 13×600=7800s content = 3900s real, first past the hour
    expect(at2x[12].untilEnd).toBe(3900);
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
