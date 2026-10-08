import type { TFunction } from 'i18next';

import type { Book, BookFile, Chapter, History, Progress } from '@/api/types';
import { chapterIndexAt } from '@/components/home/now-card-model';
import type { BookStatus } from '@/components/library/books/books-view';
import { listeningSummary } from '@/components/player/end-credits-logic';
import type { IconName } from '@/components/ui/icon';
import { contradictedTitle, resumeChapterLabel } from '@/lib/chapter-label';
import { formatBytes, formatDuration, formatRecordDate, formatSpeed } from '@/lib/format';
import type { LayoutClass } from '@/lib/layout';
import { type BookPlace, pathLeaf } from '@/lib/paths';
import { yearOf } from '@/lib/published';
import { synthesizeChapters } from '@/playback/book-queue';
import { codecLabel } from '@/playback/transcode';

/**
 * The book page's rules (STYLEGUIDE section 8 and the Stacks prototype's `Book()`), pure
 * so the screen only draws: the layout by the page's MEASURED width, the primary action,
 * the hero's eyebrow and facts, the chapter list (real chapters, the player's 30-minute
 * parts for a chapterless file, or the files), and the Your listening figures.
 */

// --- Layout ----------------------------------------------------------------------

/** The narrowest page whose hero puts the cover beside the text (else stacked). */
const HERO_SIDE_MIN = 600;
/** The body's side padding (web `px-6`, the larger of web and native), its column gap
 * (`gap-10`), the aside's narrowest width and the narrowest tab column worth having
 * beside it (a chapter row with its start time and length). */
const BODY_PAD = 24;
const BODY_GAP = 40;
const ASIDE_MIN = 300;
const TAB_COLUMN_MIN = 440;
/** The narrowest page whose body takes the aside as a right-hand column: where a 300
 * aside fits beside a tab column of at least 440 (828; an 834 tablet already does). */
export const BODY_COLUMNS_MIN = BODY_PAD * 2 + TAB_COLUMN_MIN + BODY_GAP + ASIDE_MIN;
/** The narrowest page that takes the desktop's 300 cover and 52 title. */
const HERO_LARGE_MIN = 1100;
/** The narrowest page whose aside is 340 wide (else 300). */
const ASIDE_WIDE_MIN = 1200;

export type TitleScale = 'lg' | 'md' | 'sm' | 'xs';

export type BookPageLayout = {
  /** The cover beside the hero's text (tablet and desktop), else above it (phone). */
  heroSide: boolean;
  /** How the side-by-side cover sits against the text: `end` (the desktop's 300 cover,
   * taller than the text, which then rests on its foot as in the prototype) or `start`
   * (the 220 cover, shorter than the text, level with its top; centred or bottom-aligned
   * it left a gap above it while the title started higher). */
  heroAlign: 'start' | 'end';
  /** The hero cover's width, points. */
  cover: number;
  /** The title's size step (see `TITLE_CLASS` in the hero). */
  title: TitleScale;
  /** The aside as a right-hand column (`aside` wide), else between hero and tabs. */
  columns: 1 | 2;
  aside: 300 | 340;
  /** Wide enough for the chapter rows' start times and the files table's columns. */
  roomy: boolean;
};

/**
 * The page's layout for the window's class and the page's MEASURED width (0: not
 * measured yet, which trusts the class). The Up next drawer takes 300-480 of a desktop,
 * so a 1024 window can leave the page phone-narrow; a phone is always the phone's.
 */
export function bookPageLayout(layout: LayoutClass, width: number): BookPageLayout {
  const w = width > 0 ? width : layout === 'desktop' ? 1280 : layout === 'tablet' ? 768 : 0;
  const phone = layout === 'phone' || w < HERO_SIDE_MIN;
  if (phone) {
    return {
      heroSide: false,
      heroAlign: 'start',
      cover: w > 0 ? Math.min(230, Math.round(w * 0.64)) : 230,
      title: 'sm',
      columns: 1,
      aside: 300,
      roomy: false,
    };
  }
  const large = w >= HERO_LARGE_MIN;
  return {
    heroSide: true,
    heroAlign: large ? 'end' : 'start',
    cover: large ? 300 : 220,
    title: large ? 'lg' : 'md',
    columns: w >= BODY_COLUMNS_MIN ? 2 : 1,
    aside: w >= ASIDE_WIDE_MIN ? 340 : 300,
    roomy: true,
  };
}

/** A title this long steps the display size down one, so it doesn't fill the hero. */
const LONG_TITLE = 48;

/** The title's size step: the layout's, one smaller for a long title. */
export function titleScale(scale: TitleScale, title: string): TitleScale {
  if ([...title].length <= LONG_TITLE) return scale;
  return scale === 'lg' ? 'md' : scale === 'md' ? 'sm' : 'xs';
}

// --- Primary action --------------------------------------------------------------

export type PrimaryAction =
  | { kind: 'pause' }
  | { kind: 'resume'; chapter?: number; title?: string }
  | { kind: 'start' }
  | { kind: 'again' }
  /** The listener's progress is not known yet: a neutral word, no promise. */
  | { kind: 'listen' };

/**
 * The hero's primary button: Pause while this book plays, Resume chapter N for a book in
 * progress (or loaded and paused), Listen again once finished, Start listening for a
 * new one; "Listen" while the saved progress is still unknown. `chapter` is the real
 * chapter the listener is in (undefined for a chapterless book or one before chapter 1).
 */
export function primaryAction(input: {
  status: BookStatus | undefined;
  loaded: boolean;
  live: boolean;
  chapter?: number;
  /** That chapter's own title (`contradictedTitle`: "Chapter 10" as the 11th chapter). */
  chapterTitle?: string;
}): PrimaryAction {
  const { status, loaded, live, chapter, chapterTitle } = input;
  if (loaded && live) return { kind: 'pause' };
  if (loaded || status === 'progress') return { kind: 'resume', chapter, title: chapterTitle };
  if (status === 'finished') return { kind: 'again' };
  if (status === 'new') return { kind: 'start' };
  return { kind: 'listen' };
}

/** The primary button's words. */
export function primaryLabel(t: TFunction, action: PrimaryAction): string {
  switch (action.kind) {
    case 'pause':
      return t('book.hero.pause');
    case 'resume':
      return action.chapter
        ? resumeChapterLabel(t, { number: action.chapter, title: action.title ?? '' }, 'book')
        : t('book.hero.resume');
    case 'again':
      return t('book.hero.again');
    case 'start':
      return t('book.hero.start');
    case 'listen':
      return t('book.listen');
  }
}

// --- Chapter list ----------------------------------------------------------------

export type ListKind = 'chapters' | 'parts' | 'files';

/** Where a row (or a tap on the timeline) starts the book (`BookPlace`). */
export type Jump = BookPlace;

export type ListRow = {
  key: string;
  /** 0-based; the row's number is `index + 1`. */
  index: number;
  /** The chapter's own title ('' for a part, the file's name for a file). */
  title: string;
  /** Whole-book start, seconds (NaN for a file after one of unknown length). */
  start: number;
  /** Seconds (0 when unknown). */
  length: number;
  jump: Jump;
};

export type ChapterList = { kind: ListKind; rows: ListRow[] };

/** A file's name as the book shows it: its path inside the book's folder (a disc
 * folder stays), else its leaf. */
export function fileName(relPath: string, bookPath: string): string {
  const prefix = bookPath ? `${bookPath.replace(/\/+$/, '')}/` : '';
  return prefix && relPath.startsWith(prefix) ? relPath.slice(prefix.length) : pathLeaf(relPath);
}

/**
 * The Chapters tab's rows, the same units the player navigates (book-queue):
 * - the real chapters, at their CORRECTED whole-book starts (`chapterStarts`, recomputed
 *   from the file durations);
 * - for one long file with no real chapters (none, or a lone whole-book one), the
 *   player's evenly spaced parts (`synthesizeChapters`, the listener's part length);
 * - else the files, each starting its track.
 */
export function chapterList(input: {
  chapters: readonly Chapter[];
  files: readonly Pick<BookFile, 'rel_path' | 'duration'>[];
  chapterStarts: readonly number[];
  /** The book's length, seconds. */
  total: number;
  /** The part length setting (`virtualChapterInterval`), seconds. */
  interval: number;
  bookPath: string;
}): ChapterList {
  const { chapters, files, chapterStarts, total, interval, bookPath } = input;
  if (files.length <= 1 && chapters.length <= 1 && total > 0) {
    const parts = synthesizeChapters(files[0]?.rel_path ?? bookPath, total, interval);
    if (parts.length > 0) {
      return {
        kind: 'parts',
        rows: parts.map((p) => ({
          key: `p${p.index}`,
          index: p.index,
          title: '',
          start: p.start,
          length: p.end - p.start,
          jump: { position: p.start },
        })),
      };
    }
  }
  if (chapters.length > 0) {
    return {
      kind: 'chapters',
      rows: chapters.map((c, i) => {
        const start = chapterStarts[i] ?? c.book_offset;
        return {
          key: `c${c.index}`,
          index: i,
          title: c.title,
          start,
          length: Math.max(0, c.end - c.start),
          jump: { position: start },
        };
      }),
    };
  }
  let at = 0;
  return {
    kind: 'files',
    rows: files.map((f, i) => {
      const start = at;
      at = f.duration > 0 ? at + f.duration : NaN;
      return {
        key: f.rel_path,
        index: i,
        title: fileName(f.rel_path, bookPath),
        start,
        length: Math.max(0, f.duration),
        jump: { track: i },
      };
    }),
  };
}

/** The rows' starts for the whole-book timeline, or none when one is unknown (a file of
 * unknown length): the timeline can't place what comes after it. */
export function timelineStarts(rows: readonly ListRow[]): number[] {
  return rows.every((r) => Number.isFinite(r.start)) ? rows.map((r) => r.start) : [];
}

/** The row holding `position` (the chapter it is in; the first row before any start),
 * or -1 when there are no rows. A start after a file of unknown length (NaN) is never
 * reached. */
export function rowAt(rows: readonly ListRow[], position: number): number {
  return rows.length === 0
    ? -1
    : chapterIndexAt(
        rows.map((r) => r.start),
        position,
      );
}

/** "Chapter 23 of 81" / "Part 3 of 12", or '' for files or a book not started. A
 * chapter whose `title` contradicts its number names itself: "Chapter 10 · 11 of 25". */
export function placeLine(
  t: TFunction,
  kind: ListKind,
  current: number,
  count: number,
  title = '',
): string {
  if (current < 0 || count < 2) return '';
  if (kind === 'chapters') {
    const titled = contradictedTitle({ number: current + 1, title });
    return titled
      ? t('book.hero.titledOf', { title: titled, chapter: current + 1, total: count })
      : t('book.hero.chapterOf', { chapter: current + 1, total: count });
  }
  if (kind === 'parts') return t('book.hero.partOf', { part: current + 1, total: count });
  return '';
}

// --- Hero text -------------------------------------------------------------------

/** The hero's eyebrow: the series and the book's number in it (a link to the series
 * page), else where the book lives. */
export function heroEyebrow(
  t: TFunction,
  book: Pick<Book, 'series' | 'series_index'>,
  libraryName: string,
  serverName: string,
): { text: string; series?: string } {
  if (book.series) {
    return {
      text: book.series_index
        ? t('book.hero.seriesBook', { series: book.series, position: book.series_index })
        : book.series,
      series: book.series,
    };
  }
  return { text: [libraryName, serverName].filter(Boolean).join(' · ') };
}

export type Fact = { key: string; icon: IconName; text: string };

/**
 * The hero's facts row: length, chapters (or parts), what the files are (codec, format,
 * how many, size), when it was published (and by whom, when the community knows), and
 * where it lives. A fact the book doesn't know is left out, never shown as "unknown".
 */
export function bookFacts(
  t: TFunction,
  input: {
    book: Pick<Book, 'duration' | 'format' | 'size' | 'codec' | 'published'>;
    list: ChapterList;
    /** The part length, seconds (for "12 parts of 30 min"). */
    interval: number;
    fileCount: number;
    codec?: string;
    publisher?: string;
    serverName: string;
    libraryName: string;
  },
): Fact[] {
  const { book, list, interval, fileCount, publisher, serverName, libraryName } = input;
  const out: Fact[] = [];
  const length = formatDuration(book.duration);
  if (length) out.push({ key: 'length', icon: 'clock', text: length });
  if (list.kind === 'chapters' && list.rows.length > 1) {
    out.push({
      key: 'chapters',
      icon: 'list',
      text: t('book.hero.chapters', { count: list.rows.length }),
    });
  } else if (list.kind === 'parts') {
    out.push({
      key: 'chapters',
      icon: 'list',
      text: t('book.hero.parts', {
        count: list.rows.length,
        minutes: Math.round(interval / 60),
      }),
    });
  }
  const codec = codecLabel(input.codec || book.codec);
  const format = (book.format ?? '').trim().toUpperCase();
  const files =
    fileCount > 1
      ? t('book.hero.files', { count: fileCount, format: format || codec })
      : format && format !== codec
        ? format
        : '';
  const size = book.size > 0 ? formatBytes(book.size) : '';
  const audio = [codec, files, size].filter(Boolean).join(' · ');
  if (audio) out.push({ key: 'audio', icon: 'hard-drive', text: audio });
  const year = [yearOf(book.published), publisher].filter(Boolean).join(' · ');
  if (year) out.push({ key: 'published', icon: 'book', text: year });
  const where = [serverName, libraryName].filter(Boolean).join(' › ');
  if (where) out.push({ key: 'where', icon: 'server', text: where });
  return out;
}

// --- Your listening --------------------------------------------------------------

/** When the listener started the book: the server's `started_at` when it has one (a
 * `progress_edit` server), else the earliest history span. */
export function startedAt(
  progressStarted: string | undefined,
  history: readonly Pick<History, 'started_at'>[] | undefined,
): Date | null {
  const own = progressStarted ? Date.parse(progressStarted) : NaN;
  if (Number.isFinite(own)) return new Date(own);
  let first = Infinity;
  for (const h of history ?? []) {
    const at = Date.parse(h.started_at);
    if (Number.isFinite(at) && at < first) first = at;
  }
  return Number.isFinite(first) ? new Date(first) : null;
}

/** Your listening's figures, already in words; a figure the page doesn't know honestly
 * is absent (never made up). */
export type ListeningFigures = {
  started?: string;
  finished?: string;
  speed?: string;
  listened?: string;
};

/** The listened figure shows from a minute up (a few seconds of history is noise). */
const LISTENED_MIN_S = 60;

/**
 * Your listening, from what this book's own records say, nothing estimated: when it was
 * started (`startedAt`) and finished, at what speed, and how long was spent listening
 * (the history's wall-clock time, `listeningSummary`). Null for a book not started.
 */
export function listeningFigures(input: {
  started: boolean;
  finished: boolean;
  progress?: Pick<Progress, 'started_at' | 'finished_at'>;
  history?: readonly Pick<History, 'started_at' | 'ended_at'>[];
  speed: number;
  now: Date;
}): ListeningFigures | null {
  const { started, finished, progress, history, speed, now } = input;
  if (!started && !finished) return null;
  const startDate = startedAt(progress?.started_at, history);
  const finishedAt = finished && progress?.finished_at ? new Date(progress.finished_at) : null;
  const listened = history ? listeningSummary(history).seconds : 0;
  return {
    started: startDate ? formatRecordDate(startDate, now) : undefined,
    finished:
      finishedAt && Number.isFinite(finishedAt.getTime())
        ? formatRecordDate(finishedAt, now)
        : undefined,
    speed: formatSpeed(speed),
    listened: listened >= LISTENED_MIN_S ? formatDuration(listened) : undefined,
  };
}
