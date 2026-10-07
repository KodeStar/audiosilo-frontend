import type { TFunction } from 'i18next';

import type { Book, BookFile, Bookmark, Chapter, HistoryEntry } from '@/api/types';
import { chapterStartsOf } from '@/components/library/meta-gating';
import { chapterLabel } from '@/lib/chapter-label';
import { contentKey } from '@/lib/content-key';
import { formatClock } from '@/lib/format';
import { driftOffer, type DriftRecord, type DriftRecords } from '@/playback/drift';

import type { Sourced } from './merge-model';

/**
 * The Journal's Diary (STYLEGUIDE section 9, "Sleep": "the next morning in the Journal")
 * and the book page's History tab: listening spans grouped by the device's local day,
 * placed on a 24 hour bar by wall clock, labelled with their chapters, and the "Fell
 * asleep" drift-offs. Pure: the screens only render what this decides.
 *
 * What a span does NOT carry, and so is never shown: the speed and the device (the
 * history row has neither; inventing them would be a lie).
 */

/** A listening span, with its server and times parsed. */
export type DiarySpan = {
  /** Unique across servers. */
  key: string;
  connectionId: string;
  connectionName: string;
  libraryId: number;
  path: string;
  /** The book's list shape, when the server sent it (`annotations` servers). */
  book?: Book;
  /** Wall-clock start and end, epoch ms. */
  start: number;
  end: number;
  /** Whole-book positions (seconds) at the start and the end. */
  from: number;
  to: number;
};

/** A history row as a span; null when its times can't be read. */
export function toSpan(row: Sourced<HistoryEntry>): DiarySpan | null {
  const start = Date.parse(row.started_at);
  const end = Date.parse(row.ended_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return {
    key: `${row.connectionId}\n${row.id}`,
    connectionId: row.connectionId,
    connectionName: row.connectionName,
    libraryId: row.library_id,
    path: row.path,
    book: row.book,
    start,
    end: Math.max(start, end),
    from: row.from_pos,
    to: row.to_pos,
  };
}

/** The span's book key (connection, library, path). */
export const spanBookKey = (s: Pick<DiarySpan, 'connectionId' | 'libraryId' | 'path'>) =>
  contentKey(s.connectionId, s.libraryId, s.path);

/** Wall-clock seconds the span lasted. */
export const spanSeconds = (s: Pick<DiarySpan, 'start' | 'end'>) =>
  Math.max(0, (s.end - s.start) / 1000);

/** The span's length in whole minutes for "21:12, 21 min" (at least 1). */
export const spanMinutes = (s: Pick<DiarySpan, 'start' | 'end'>) =>
  Math.max(1, Math.round(spanSeconds(s) / 60));

/** A span ending this close (content seconds) to the book's end finished it. */
export const FINISH_SLACK_S = 30;

/** Whether the span reached the end of its book (only knowable with the book's length). */
export function reachedEnd(span: Pick<DiarySpan, 'to' | 'book'>): boolean {
  const duration = span.book?.duration ?? 0;
  return duration > 0 && span.to >= duration - FINISH_SLACK_S;
}

// --- Days --------------------------------------------------------------------------

/** Local midnight of the day holding `ms`. */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The next local midnight after the day starting at `dayStart` (DST-safe). */
function nextDayStart(dayStart: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** One local day of listening. */
export type DiaryDay = {
  /** Local midnight, epoch ms (also the day's identity). */
  start: number;
  /** Wall-clock seconds listened that day. */
  total: number;
  /** The day's spans, newest first. */
  spans: DiarySpan[];
};

/** Spans grouped by the local day they started on, newest day first, each day's spans
 * newest first. */
export function groupByDay(spans: readonly DiarySpan[]): DiaryDay[] {
  const byDay = new Map<number, DiarySpan[]>();
  for (const s of spans) {
    const day = localDayStart(s.start);
    const list = byDay.get(day);
    if (list) list.push(s);
    else byDay.set(day, [s]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => b - a)
    .map(([start, list]) => ({
      start,
      spans: [...list].sort((a, b) => b.start - a.start),
      total: list.reduce((sum, s) => sum + spanSeconds(s), 0),
    }));
}

/** How a day is named: Today, Yesterday, its weekday within the last week, else its date. */
export type DayName = 'today' | 'yesterday' | 'weekday' | 'date';

export function dayName(dayStart: number, now: number): DayName {
  const today = localDayStart(now);
  if (dayStart >= today) return 'today';
  const yesterday = localDayStart(today - 1);
  if (dayStart >= yesterday) return 'yesterday';
  // Six days back still has a weekday nobody can mistake for next week's.
  let weekAgo = today;
  for (let i = 0; i < 6; i++) weekAgo = localDayStart(weekAgo - 1);
  return dayStart >= weekAgo ? 'weekday' : 'date';
}

/** Where a span sits on its day's 24 hour bar, as fractions of the day. */
export type DayBar = {
  key: string;
  left: number;
  width: number;
  /** The book's cover accent (`cover_color.accent`, else its dominant colour). */
  color?: string;
};

/** The narrowest a span is drawn (fraction of the day), so a 2 minute span still shows. */
export const MIN_BAR_WIDTH = 0.012;

/** The day's spans on its bar, by wall clock: a span running past midnight is cut there. */
export function dayBars(day: DiaryDay): DayBar[] {
  const end = nextDayStart(day.start);
  const length = end - day.start;
  return day.spans
    .map((s) => {
      const from = Math.max(day.start, Math.min(s.start, end));
      const to = Math.max(from, Math.min(s.end, end));
      const left = (from - day.start) / length;
      const width = Math.max(MIN_BAR_WIDTH, (to - from) / length);
      return {
        key: s.key,
        left: Math.min(left, 1 - MIN_BAR_WIDTH),
        width: Math.min(width, 1 - Math.min(left, 1 - MIN_BAR_WIDTH)),
        color: s.book?.cover_color?.accent ?? s.book?.cover_color?.bg,
      };
    })
    .sort((a, b) => a.left - b.left);
}

// --- Chapters ----------------------------------------------------------------------

/** A book's chapters with their corrected whole-book starts (`chapterStartsOf`, as the
 * book page reads them). */
export type ChapterIndex = { chapters: Chapter[]; starts: number[] };

export function chapterIndexOf(
  chapters: Chapter[] | undefined,
  files: Pick<BookFile, 'rel_path' | 'duration'>[] | undefined,
): ChapterIndex | null {
  if (!chapters || chapters.length === 0) return null;
  return { chapters, starts: chapterStartsOf(chapters, files ?? []) };
}

/** The chapter holding a whole-book position (the first one before its start). */
export function chapterAtPosition(index: ChapterIndex, position: number): Chapter {
  let i = 0;
  for (let n = 0; n < index.starts.length; n++) {
    if (position >= index.starts[n]) i = n;
    else break;
  }
  return index.chapters[i];
}

/** The chapter's name as every surface shows it (`chapterLabel`: its title, prettified
 * when it is a filename, else "Chapter 23"). */
export function chapterName(index: ChapterIndex, position: number, t: TFunction): string {
  return chapterLabel(chapterAtPosition(index, position), t);
}

/**
 * Where a span went in the book: its chapters ("A Bloody, Red Sunset to Bridge Four", one
 * name when it stayed in one chapter) when the book's chapters are known, else
 * its positions ("1:02:03 to 1:23:45").
 */
export function spanRange(
  span: Pick<DiarySpan, 'from' | 'to'>,
  index: ChapterIndex | null,
  t: TFunction,
): string {
  if (index) {
    const from = chapterName(index, span.from, t);
    const to = chapterName(index, span.to, t);
    return from === to ? from : t('journal.diary.range', { from, to });
  }
  return t('journal.diary.range', { from: formatClock(span.from), to: formatClock(span.to) });
}

// --- Drift-offs --------------------------------------------------------------------

/** The sleep timer's bookmark follows the span it ended: made this long after it at most. */
const DRIFT_AFTER_MS = 15 * 60 * 1000;
/** ... and never much before it (clocks of the device and the server can differ). */
const DRIFT_BEFORE_MS = 2 * 60 * 1000;
/** The bookmark sits where playback stopped: this close to the span's end position. */
const DRIFT_POSITION_SLACK_S = 5 * 60;

/**
 * Pair each "Fell asleep" bookmark with the span it ended: the same book, made just
 * after that span ended, near its end position. The closest span in time wins; a span
 * gets at most one. Keyed by span key.
 */
export function matchDrifts<B extends Sourced<Bookmark>>(
  spans: readonly DiarySpan[],
  drifts: readonly B[],
): Map<string, B> {
  const out = new Map<string, B>();
  for (const bm of drifts) {
    const made = Date.parse(bm.created_at);
    if (Number.isNaN(made)) continue;
    const key = contentKey(bm.connectionId, bm.library_id, bm.path);
    let best: { span: DiarySpan; gap: number } | null = null;
    for (const s of spans) {
      if (out.has(s.key) || spanBookKey(s) !== key) continue;
      const gap = made - s.end;
      if (gap > DRIFT_AFTER_MS || gap < -DRIFT_BEFORE_MS) continue;
      if (Math.abs(bm.position - s.to) > DRIFT_POSITION_SLACK_S) continue;
      if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { span: s, gap };
    }
    if (best) out.set(best.span.key, bm);
  }
  return out;
}

/** What a drift-off's strip offers. With this device's drift record still kept (the
 * book has not played since): "Jump back N minutes" to the last moment the listener was
 * provably awake. Without it: play from the bookmark, where the timer stopped. */
export type DriftStrip =
  | { kind: 'jumpBack'; minutes: number; position: number; at: number }
  | { kind: 'resume'; position: number; at: number };

/** The record a drift bookmark was made with: the same book, the same stop. */
const RECORD_POSITION_SLACK_S = 60;

export function driftStrip(
  bookmark: Sourced<Bookmark>,
  records: DriftRecords,
  now: number,
): DriftStrip {
  const record: DriftRecord | undefined =
    records[contentKey(bookmark.connectionId, bookmark.library_id, bookmark.path)];
  const offer =
    record && Math.abs(record.stoppedAt - bookmark.position) <= RECORD_POSITION_SLACK_S
      ? driftOffer(record, now, record.stoppedAt)
      : null;
  if (offer) {
    return { kind: 'jumpBack', minutes: offer.minutes, position: offer.jumpTo, at: offer.touchAt };
  }
  const made = Date.parse(bookmark.created_at);
  return { kind: 'resume', position: bookmark.position, at: Number.isNaN(made) ? now : made };
}
