import type { Chapter } from '@/api/types';
import i18n from '@/i18n';
import { formatDuration, formatRecordDate, formatSpeed } from '@/lib/format';

import {
  bookFacts,
  BODY_COLUMNS_MIN,
  bookPageLayout,
  chapterList,
  fileName,
  heroEyebrow,
  listeningFigures,
  placeLine,
  primaryAction,
  primaryLabel,
  rowAt,
  startedAt,
  timelineStarts,
  titleScale,
} from './book-page-model';

const t = i18n.t.bind(i18n);

const chapter = (index: number, start: number, end: number, title = ''): Chapter => ({
  index,
  title,
  file_index: 0,
  file_path: 'A/B/book.m4b',
  start,
  end,
  book_offset: start,
});

describe('bookPageLayout', () => {
  it('stacks on a phone, the cover at most 230 and 64% of the page', () => {
    expect(bookPageLayout('phone', 0)).toMatchObject({ heroSide: false, cover: 230, columns: 1 });
    expect(bookPageLayout('phone', 400).cover).toBe(230);
    expect(bookPageLayout('phone', 320).cover).toBe(205);
    expect(bookPageLayout('phone', 400)).toMatchObject({ title: 'sm', roomy: false });
  });

  it('lays a desktop out by its MEASURED width (the Up next drawer takes up to 480)', () => {
    // 1024 less a 480 drawer: phone-narrow.
    expect(bookPageLayout('desktop', 544)).toMatchObject({ heroSide: false, columns: 1 });
    // 1024 less a 360 drawer: the cover beside the text, the aside under the hero.
    expect(bookPageLayout('desktop', 664)).toMatchObject({
      heroSide: true,
      cover: 220,
      title: 'md',
      columns: 1,
      roomy: true,
    });
    expect(bookPageLayout('desktop', 1376)).toMatchObject({
      heroSide: true,
      cover: 300,
      title: 'lg',
      columns: 2,
      aside: 340,
    });
    expect(bookPageLayout('desktop', 960)).toMatchObject({ columns: 2, aside: 300 });
  });

  it('trusts the class before the first measure', () => {
    expect(bookPageLayout('desktop', 0)).toMatchObject({ heroSide: true, columns: 2 });
    expect(bookPageLayout('tablet', 0)).toMatchObject({ heroSide: true, columns: 1 });
  });

  // The web pass at 834: the 220 cover hung below the title's top. The desktop's 300
  // cover is taller than the text, which rests on its foot (the prototype).
  it('levels a tablet cover with the text top, a desktop one with its foot', () => {
    expect(bookPageLayout('tablet', 834).heroAlign).toBe('start');
    expect(bookPageLayout('desktop', 1376).heroAlign).toBe('end');
  });

  // The web pass at 834: About and Your listening sat above the tabs, pushing them to
  // y ~990. A 300 aside beside a 440 tab column fits from 828.
  it('takes the aside as a column once it fits beside a 440 tab column', () => {
    expect(BODY_COLUMNS_MIN).toBe(828);
    expect(bookPageLayout('tablet', 834)).toMatchObject({ cover: 220, columns: 2, aside: 300 });
    expect(bookPageLayout('tablet', 827)).toMatchObject({ columns: 1 });
    expect(bookPageLayout('desktop', 828)).toMatchObject({ columns: 2 });
    // A phone keeps its order whatever it measures.
    expect(bookPageLayout('phone', 900)).toMatchObject({ columns: 1 });
  });
});

describe('titleScale', () => {
  it('steps a long title down one size, CJK counted by character', () => {
    expect(titleScale('lg', 'The Way of Kings')).toBe('lg');
    const long = 'The Extraordinarily Long Title of a Book That Never Seems to End';
    expect(titleScale('lg', long)).toBe('md');
    expect(titleScale('sm', long)).toBe('xs');
    expect(titleScale('md', '三体')).toBe('md');
  });
});

describe('primaryAction', () => {
  it('pauses while this book plays, whatever its progress', () => {
    const a = primaryAction({ status: 'progress', loaded: true, live: true, chapter: 3 });
    expect(a).toEqual({ kind: 'pause' });
    expect(primaryLabel(t, a)).toBe('Pause');
  });

  it('resumes a book in progress at its chapter: "Resume chapter N", not Listen', () => {
    const a = primaryAction({ status: 'progress', loaded: false, live: false, chapter: 23 });
    expect(primaryLabel(t, a)).toBe('Resume chapter 23');
    // A chapterless book (or the place before chapter 1) just resumes.
    expect(primaryLabel(t, primaryAction({ status: 'progress', loaded: false, live: false }))).toBe(
      'Resume',
    );
  });

  it('resumes the loaded book while it is paused, even one the server calls finished', () => {
    const a = primaryAction({ status: 'finished', loaded: true, live: false, chapter: 2 });
    expect(primaryLabel(t, a)).toBe('Resume chapter 2');
  });

  it('starts a new book, offers a finished one again, and waits for an unknown one', () => {
    expect(primaryLabel(t, primaryAction({ status: 'new', loaded: false, live: false }))).toBe(
      'Start listening',
    );
    expect(primaryLabel(t, primaryAction({ status: 'finished', loaded: false, live: false }))).toBe(
      'Listen again',
    );
    expect(primaryLabel(t, primaryAction({ status: undefined, loaded: false, live: false }))).toBe(
      'Listen',
    );
  });
});

describe('chapterList', () => {
  const base = { chapterStarts: [], total: 0, interval: 1800, bookPath: 'A/B' };

  it('lists the real chapters at their corrected starts', () => {
    const chapters = [chapter(0, 0, 600, 'Prelude'), chapter(1, 600, 1500)];
    const list = chapterList({
      ...base,
      chapters,
      files: [{ rel_path: 'A/B/book.m4b', duration: 1500 }],
      chapterStarts: [0, 610],
      total: 1500,
    });
    expect(list.kind).toBe('chapters');
    expect(list.rows.map((r) => [r.title, r.start, r.length, r.jump])).toEqual([
      ['Prelude', 0, 600, { position: 0 }],
      ['', 610, 900, { position: 610 }],
    ]);
  });

  it("splits one long chapterless file into the player's parts", () => {
    const list = chapterList({
      ...base,
      chapters: [],
      files: [{ rel_path: 'A/B/book.mp3', duration: 4 * 3600 }],
      total: 4 * 3600,
    });
    expect(list.kind).toBe('parts');
    expect(list.rows).toHaveLength(8);
    expect(list.rows[1]).toMatchObject({ start: 1800, length: 1800, jump: { position: 1800 } });
    // A lone whole-book chapter is no chapters at all (as the player sees it).
    const lone = chapterList({
      ...base,
      chapters: [chapter(0, 0, 4 * 3600, 'Book')],
      files: [{ rel_path: 'A/B/book.mp3', duration: 4 * 3600 }],
      total: 4 * 3600,
    });
    expect(lone.kind).toBe('parts');
  });

  it('lists a short single file and a multi-file book by file, disc folders kept', () => {
    const short = chapterList({
      ...base,
      chapters: [],
      files: [{ rel_path: 'A/B/book.mp3', duration: 1200 }],
      total: 1200,
    });
    expect(short).toMatchObject({
      kind: 'files',
      rows: [{ title: 'book.mp3', jump: { track: 0 } }],
    });
    const discs = chapterList({
      ...base,
      chapters: [],
      files: [
        { rel_path: 'A/B/Disc 1/01.mp3', duration: 100 },
        { rel_path: 'A/B/Disc 2/01.mp3', duration: 200 },
      ],
      total: 300,
    });
    expect(discs.rows.map((r) => [r.title, r.start, r.jump])).toEqual([
      ['Disc 1/01.mp3', 0, { track: 0 }],
      ['Disc 2/01.mp3', 100, { track: 1 }],
    ]);
  });

  it('has no timeline past a file of unknown length', () => {
    const list = chapterList({
      ...base,
      chapters: [],
      files: [
        { rel_path: 'A/B/1.mp3', duration: 0 },
        { rel_path: 'A/B/2.mp3', duration: 100 },
      ],
    });
    expect(timelineStarts(list.rows)).toEqual([]);
  });
});

describe('fileName', () => {
  it('names a file inside the book folder by its path there, else by its leaf', () => {
    expect(fileName('A/B/Disc 1/01.mp3', 'A/B')).toBe('Disc 1/01.mp3');
    expect(fileName('A/B.m4b', 'A/B.m4b')).toBe('B.m4b');
    expect(fileName('X/y.mp3', 'A/B')).toBe('y.mp3');
  });
});

describe('the place in the list', () => {
  const rows = chapterList({
    chapters: [chapter(0, 0, 100), chapter(1, 100, 200), chapter(2, 200, 300)],
    files: [{ rel_path: 'A/B/book.m4b', duration: 300 }],
    chapterStarts: [0, 100, 200],
    total: 300,
    interval: 1800,
    bookPath: 'A/B',
  }).rows;

  it('finds the row holding a place, the first one before any start', () => {
    expect(rowAt(rows, 150)).toBe(1);
    expect(rowAt(rows, 0)).toBe(0);
    expect(rowAt(rows, 100)).toBe(1);
    expect(rowAt(rows, 299)).toBe(2);
    expect(rowAt(rows, 400)).toBe(2);
    expect(rowAt([], 150)).toBe(-1);
  });

  it('never reaches a file after one of unknown length', () => {
    const files = chapterList({
      chapters: [],
      files: [
        { rel_path: 'A/B/1.mp3', duration: 100 },
        { rel_path: 'A/B/2.mp3', duration: 0 },
        { rel_path: 'A/B/3.mp3', duration: 100 },
      ],
      chapterStarts: [],
      total: 200,
      interval: 1800,
      bookPath: 'A/B',
    }).rows;
    expect(rowAt(files, 150)).toBe(1);
  });

  it('says "Chapter 2 of 3", or "Part 2 of 3" for parts, and nothing for files', () => {
    expect(placeLine(t, 'chapters', 1, 3)).toBe('Chapter 2 of 3');
    expect(placeLine(t, 'parts', 1, 3)).toBe('Part 2 of 3');
    expect(placeLine(t, 'files', 1, 3)).toBe('');
    expect(placeLine(t, 'chapters', -1, 3)).toBe('');
  });
});

describe('heroEyebrow', () => {
  it('names the series and the book in it, which opens the series', () => {
    expect(heroEyebrow(t, { series: 'Stormlight', series_index: 1 }, 'Fiction', 'Home')).toEqual({
      text: 'Stormlight · Book 1',
      series: 'Stormlight',
    });
    expect(heroEyebrow(t, { series: 'Stormlight', series_index: 0 }, 'Fiction', 'Home').text).toBe(
      'Stormlight',
    );
  });

  it('else says where the book lives', () => {
    expect(heroEyebrow(t, { series: '', series_index: 0 }, 'Fiction', 'Home')).toEqual({
      text: 'Fiction · Home',
    });
  });
});

describe('bookFacts', () => {
  const list = (n: number) => ({
    kind: 'chapters' as const,
    rows: Array.from({ length: n }, (_, i) => ({
      key: `${i}`,
      index: i,
      title: '',
      start: i,
      length: 1,
      jump: {},
    })),
  });
  const book = {
    duration: 45.5 * 3600,
    format: 'm4b',
    size: 1.3 * 1024 ** 3,
    codec: 'aac',
    published: '2010-08-31',
  };

  it('says the length, chapters, files, year and where, as the prototype does', () => {
    const facts = bookFacts(t, {
      book,
      list: list(81),
      interval: 1800,
      fileCount: 1,
      publisher: 'Macmillan Audio',
      serverName: 'Hearthside',
      libraryName: 'Fiction',
    });
    expect(facts.map((f) => f.text)).toEqual([
      '45h 30m',
      '81 chapters',
      'AAC · M4B · 1.3 GB',
      '2010 · Macmillan Audio',
      'Hearthside › Fiction',
    ]);
  });

  it('counts parts and files, and leaves out what is unknown', () => {
    const facts = bookFacts(t, {
      book: { ...book, format: 'mp3', codec: 'mp3', published: undefined, size: 0 },
      list: { kind: 'parts', rows: list(12).rows },
      interval: 1800,
      fileCount: 24,
      serverName: 'Home',
      libraryName: '',
    });
    expect(facts.map((f) => f.text)).toEqual([
      '45h 30m',
      '12 parts of 30 min',
      'MP3 · 24 MP3 files',
      'Home',
    ]);
    // One chapter is no chapter list worth counting.
    expect(
      bookFacts(t, {
        book,
        list: list(1),
        interval: 1800,
        fileCount: 1,
        serverName: '',
        libraryName: '',
      }).map((f) => f.key),
    ).not.toContain('chapters');
  });
});

describe('Your listening', () => {
  const now = new Date(2026, 9, 7);
  const spans = [
    { started_at: '2026-10-01T20:00:00Z', ended_at: '2026-10-01T21:30:00Z' },
    { started_at: '2026-10-02T20:00:00Z', ended_at: '2026-10-02T20:10:00Z' },
    { started_at: 'nonsense', ended_at: '2026-10-02T20:10:00Z' },
  ];

  it('has nothing to say for a book not started', () => {
    expect(listeningFigures({ started: false, finished: false, speed: 1, now })).toBeNull();
  });

  it('adds up the history spans and names the speed and the start', () => {
    const figures = listeningFigures({
      started: true,
      finished: false,
      history: spans,
      speed: 1.25,
      now,
    });
    expect(figures).toEqual({
      started: formatRecordDate(new Date('2026-10-01T20:00:00Z'), now),
      finished: undefined,
      speed: formatSpeed(1.25),
      listened: formatDuration(100 * 60),
    });
  });

  it('leaves out a figure it does not know: seconds of history, a finish not dated', () => {
    const short = [{ started_at: '2026-10-01T20:00:00Z', ended_at: '2026-10-01T20:00:30Z' }];
    expect(
      listeningFigures({ started: true, finished: false, history: short, speed: 1, now })?.listened,
    ).toBeUndefined();
    const finished = listeningFigures({
      started: false,
      finished: true,
      progress: { started_at: undefined, finished_at: '2024-09-14T09:00:00Z' },
      speed: 1,
      now,
    });
    expect(finished).toMatchObject({ started: undefined, listened: undefined });
    expect(finished?.finished).toBe(formatRecordDate(new Date('2024-09-14T09:00:00Z'), now));
    expect(
      listeningFigures({
        started: true,
        finished: false,
        progress: { finished_at: '2024-09-14T09:00:00Z' },
        speed: 1,
        now,
      })?.finished,
    ).toBeUndefined();
  });

  it("takes the server's start date, else the earliest span", () => {
    const spans = [{ started_at: '2026-09-20T10:00:00Z' }, { started_at: '2026-09-14T10:00:00Z' }];
    expect(startedAt('2026-09-01T00:00:00Z', spans)?.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(startedAt(undefined, spans)?.toISOString()).toBe('2026-09-14T10:00:00.000Z');
    expect(startedAt(undefined, [])).toBeNull();
  });
});
