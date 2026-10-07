import type { Book, HistoryEntry } from '@/api/types';
import { contentKey } from '@/lib/content-key';

/**
 * Listening history as sessions (the Journal's Diary and a book's History tab read the
 * same rules, so the two agree): the server records a span per pause, so spans are joined
 * into sessions, placed on the device's local days and named Today, Yesterday... Pure.
 *
 * What a span does NOT carry, and so is never shown: the speed and the device (the
 * history row has neither; inventing them would be a lie).
 */

/** A listening span, with its server and times parsed. */
export type ListeningSpan = {
  /** Unique across servers. */
  key: string;
  /** The book's content key (connection, library, path), computed once. */
  bookKey: string;
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

/** A history row as a span (`connectionName` may be '' where no server is named); null
 * when its times can't be read. */
export function toSpan(
  row: HistoryEntry & { connectionId: string; connectionName: string },
): ListeningSpan | null {
  const start = Date.parse(row.started_at);
  const end = Date.parse(row.ended_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return {
    key: `${row.connectionId}\n${row.id}`,
    bookKey: contentKey(row.connectionId, row.library_id, row.path),
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

/** Wall-clock seconds the span lasted. */
const spanSeconds = (s: Pick<ListeningSpan, 'start' | 'end'>) =>
  Math.max(0, (s.end - s.start) / 1000);

/** A span ending this close (content seconds) to the book's end finished it. */
const FINISH_SLACK_S = 30;

/** Whether the span reached the end of its book (only knowable with the book's length). */
export function reachedEnd(span: Pick<ListeningSpan, 'to' | 'book'>): boolean {
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
export function nextDayStart(dayStart: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** How a day is named: Today, Yesterday, its weekday within the last week, else its date.
 * `today` is the local midnight of today (or any time today). */
export function dayName(
  dayStart: number,
  today: number,
): 'today' | 'yesterday' | 'weekday' | 'date' {
  const midnight = localDayStart(today);
  if (dayStart >= midnight) return 'today';
  const yesterday = localDayStart(midnight - 1);
  if (dayStart >= yesterday) return 'yesterday';
  // Six days back still has a weekday nobody can mistake for next week's.
  let weekAgo = midnight;
  for (let i = 0; i < 6; i++) weekAgo = localDayStart(weekAgo - 1);
  return dayStart >= weekAgo ? 'weekday' : 'date';
}

// --- Sessions ----------------------------------------------------------------------

/** The longest pause (wall clock) inside one listening session. */
export const SESSION_GAP_MS = 10 * 60 * 1000;
/** How far (content seconds) the next span may start from where the last one ended and
 * still continue it; further is a seek, which starts a new session. */
const SESSION_POSITION_SLACK_S = 120;

/**
 * A listening session: consecutive spans of one book on one server (the server records a
 * span per pause, so one evening of listening is many small spans). It carries the span
 * fields of the whole session (`start`/`from` of the first span, `end`/`to` of the last,
 * the key of the first) so it reads like one span; `spans` keeps the parts, oldest first.
 */
export type ListeningSession = ListeningSpan & {
  spans: ListeningSpan[];
  /** Wall-clock seconds actually listened (the spans' sum, without the pauses). */
  listened: number;
};

/** Whether `next` continues `last` (same book and server, a pause under
 * `SESSION_GAP_MS`, picking up within `SESSION_POSITION_SLACK_S` of where it stopped). */
function continues(last: ListeningSpan, next: ListeningSpan): boolean {
  return (
    last.bookKey === next.bookKey &&
    next.start - last.end < SESSION_GAP_MS &&
    Math.abs(next.from - last.to) <= SESSION_POSITION_SLACK_S
  );
}

function toSession(parts: ListeningSpan[]): ListeningSession {
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
export function groupSessions(spans: readonly ListeningSpan[]): ListeningSession[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const sessions: ListeningSpan[][] = [];
  for (const s of sorted) {
    const current = sessions[sessions.length - 1];
    if (current && continues(current[current.length - 1], s)) current.push(s);
    else sessions.push([s]);
  }
  return sessions.map(toSession).sort((a, b) => b.start - a.start);
}

/** The session's listened length in whole minutes (at least 1). */
export const sessionMinutes = (s: Pick<ListeningSession, 'listened'>) =>
  Math.max(1, Math.round(s.listened / 60));

/** Whether any span of the session reached the end of the book (`book` overrides the
 * spans' own, for an older server whose rows carry none). */
export const sessionFinished = (s: Pick<ListeningSession, 'spans' | 'book'>, book = s.book) =>
  s.spans.some((p) => reachedEnd({ to: p.to, book }));
