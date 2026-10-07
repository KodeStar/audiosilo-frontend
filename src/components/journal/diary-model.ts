import type { TFunction } from 'i18next';

import type { Book, Bookmark, CoverColor, HistoryEntry } from '@/api/types';
import { contrast } from '@/components/series/spine-colors';
import { contentKey } from '@/lib/content-key';
import { formatClock } from '@/lib/format';
import { driftOffer, type DriftRecord, type DriftRecords } from '@/playback/drift';

import type { Sourced } from './merge-model';

/**
 * The Journal's Diary (STYLEGUIDE section 9, "Sleep": "the next morning in the Journal")
 * and the book page's History tab: listening spans joined into sessions, grouped by the
 * device's local day,
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

// --- Sessions ----------------------------------------------------------------------

/** The longest pause (wall clock) inside one listening session. */
export const SESSION_GAP_MS = 10 * 60 * 1000;
/** How far (content seconds) the next span may start from where the last one ended and
 * still continue it; further is a seek, which starts a new session. */
export const SESSION_POSITION_SLACK_S = 120;

/**
 * A listening session: consecutive spans of one book on one server (the server records a
 * span per pause, so one evening of listening is many small spans). It carries the span
 * fields of the whole session (`start`/`from` of the first span, `end`/`to` of the last,
 * the key of the first) so it reads like one span; `spans` keeps the parts, oldest first.
 */
export type DiarySession = DiarySpan & {
  spans: DiarySpan[];
  /** Wall-clock seconds actually listened (the spans' sum, without the pauses). */
  listened: number;
};

/** Whether `next` continues `last` (same book and server, a pause under
 * `SESSION_GAP_MS`, picking up within `SESSION_POSITION_SLACK_S` of where it stopped). */
function continues(last: DiarySpan, next: DiarySpan): boolean {
  return (
    spanBookKey(last) === spanBookKey(next) &&
    next.start - last.end < SESSION_GAP_MS &&
    Math.abs(next.from - last.to) <= SESSION_POSITION_SLACK_S
  );
}

function toSession(parts: DiarySpan[]): DiarySession {
  const first = parts[0];
  const last = parts[parts.length - 1];
  return {
    ...first,
    book: parts.find((p) => p.book)?.book,
    end: last.end,
    to: last.to,
    spans: parts,
    listened: parts.reduce((sum, p) => sum + spanSeconds(p), 0),
  };
}

/**
 * The spans as sessions, newest first. Spans are walked in time order across every
 * book and server; a span joins the session before it only when it `continues` the very
 * span before it in time, so another book listened to in between ends the session.
 */
export function groupSessions(spans: readonly DiarySpan[]): DiarySession[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const sessions: DiarySpan[][] = [];
  for (const s of sorted) {
    const current = sessions[sessions.length - 1];
    if (current && continues(current[current.length - 1], s)) current.push(s);
    else sessions.push([s]);
  }
  return sessions.map(toSession).sort((a, b) => b.start - a.start);
}

/** The session's listened length in whole minutes (at least 1). */
export const sessionMinutes = (s: Pick<DiarySession, 'listened'>) =>
  Math.max(1, Math.round(s.listened / 60));

/** Whether any span of the session reached the end of the book (`book` overrides the
 * spans' own, for an older server whose rows carry none). */
export const sessionFinished = (s: Pick<DiarySession, 'spans' | 'book'>, book = s.book) =>
  s.spans.some((p) => reachedEnd({ to: p.to, book }));

/** One local day of listening. */
export type DiaryDay = {
  /** Local midnight, epoch ms (also the day's identity). */
  start: number;
  /** Wall-clock seconds listened that day. */
  total: number;
  /** The day's sessions, newest first. */
  sessions: DiarySession[];
  /** Every span of those sessions (the honest picture, for the 24 hour bar). */
  spans: DiarySpan[];
};

/** Sessions grouped by the local day they started on (a session past midnight belongs
 * to its start day), newest day first. */
export function groupByDay(sessions: readonly DiarySession[]): DiaryDay[] {
  const byDay = new Map<number, DiarySession[]>();
  for (const s of sessions) {
    const day = localDayStart(s.start);
    const list = byDay.get(day);
    if (list) list.push(s);
    else byDay.set(day, [s]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => b - a)
    .map(([start, list]) => ({
      start,
      sessions: [...list].sort((a, b) => b.start - a.start),
      spans: list.flatMap((s) => s.spans),
      total: list.reduce((sum, s) => sum + s.listened, 0),
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
  /** The book's cover colours, for `barColor` (absent: none known). */
  cover?: CoverColor;
};

/** The least contrast a span keeps against the bar's track (WCAG's 3:1 for a graphical
 * object). */
export const BAR_MIN_CONTRAST = 3;

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A span's colour on its day's bar (pure): the book's cover accent, else its dominant
 * colour, whichever stands off the theme's `track` (`muted`) best, but only at
 * `BAR_MIN_CONTRAST` or more; a cover whose colours both sink into the track (a dark
 * maroon accent on the dark theme's ink) and a book without cover colours get `fallback`
 * (a theme token that does).
 */
export function barColor(cover: CoverColor | undefined, track: string, fallback: string): string {
  const candidates = [cover?.accent, cover?.bg].filter((c): c is string => !!c && HEX.test(c));
  let best: string | undefined;
  let bestContrast = 0;
  for (const c of candidates) {
    const ratio = contrast(c, track);
    if (ratio > bestContrast) [best, bestContrast] = [c, ratio];
  }
  return best && bestContrast >= BAR_MIN_CONTRAST ? best : fallback;
}

/** The narrowest a span is drawn (fraction of the day), so a 2 minute span still shows. */
export const MIN_BAR_WIDTH = 0.012;

/** The day's spans on its bar, by wall clock: a span running past midnight is cut there,
 * and a span of a session that started the day before midnight but itself starts after it
 * is not on this day's bar. */
export function dayBars(day: Pick<DiaryDay, 'start' | 'spans'>): DayBar[] {
  const end = nextDayStart(day.start);
  const length = end - day.start;
  return day.spans
    .filter((s) => s.start < end)
    .map((s) => {
      const from = Math.max(day.start, Math.min(s.start, end));
      const to = Math.max(from, Math.min(s.end, end));
      const left = (from - day.start) / length;
      const width = Math.max(MIN_BAR_WIDTH, (to - from) / length);
      return {
        key: s.key,
        left: Math.min(left, 1 - MIN_BAR_WIDTH),
        width: Math.min(width, 1 - Math.min(left, 1 - MIN_BAR_WIDTH)),
        cover: s.book?.cover_color,
      };
    })
    .sort((a, b) => a.left - b.left);
}

// --- Chapters ----------------------------------------------------------------------

/** Names the chapter at a whole-book position, null when the book's chapters are not
 * known (`chapterNamer` from `@/components/annotations`). */
export type ChapterNamer = (position: number) => string | null;

/**
 * Where a span went in the book: its chapters ("A Bloody, Red Sunset to Bridge Four", one
 * name when it stayed in one chapter) when the book's chapters are known, else its
 * positions ("1:02:03 to 1:23:45").
 */
export function spanRange(
  span: Pick<DiarySpan, 'from' | 'to'>,
  nameAt: ChapterNamer,
  t: TFunction,
): string {
  const from = nameAt(span.from);
  const to = nameAt(span.to);
  if (from && to) return from === to ? from : t('journal.diary.range', { from, to });
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
 * Pair each "Fell asleep" bookmark with the span (or session: its end is its last span's)
 * it ended: the same book, made just after it ended, near its end position. The closest
 * in time wins; each gets at most one. Keyed by span (session) key.
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
