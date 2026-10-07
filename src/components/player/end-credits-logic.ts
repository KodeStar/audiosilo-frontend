import type { UpNextBook } from '@/playback/up-next-resolver';

// Pure decision logic for the end-credits (book-finished) screen's auto-play countdown.
// Framework-free so it can be unit-tested directly; the screen wires it to the player
// store, the settings store and a 1s ticker. Two countdown regimes:
//
//   - The finished book is STILL PLAYING (an early arrival - the credits audio is still
//     running). The countdown shows the remaining audio time, but auto-play never fires
//     from here: it waits for the book to actually end (do not start the next book early).
//   - The book is ALREADY OVER (arrived via a natural end, or it ended while this screen
//     was up). A fixed grace countdown runs, then auto-play fires.
//
// A Cancel (`cancelled`) stops auto-play for this visit: the countdown is hidden and the
// Play-next button stays. Auto-play is only ever considered when it is enabled and a next
// book exists.

/** Seconds of grace before auto-play fires once the book is over. */
export const GRACE_SECONDS = 15;

export type EndCreditsInput = {
  /** The `autoPlayNext` setting. */
  autoPlayNext: boolean;
  /** Whether a next book in the series was resolved. */
  hasNext: boolean;
  /** The finished book's audio is still running (arrived before its natural end). */
  stillPlaying: boolean;
  /** Live remaining audio time (whole-book total minus current position), when playing. */
  remainingSeconds: number;
  /** The user cancelled auto-play for this visit. */
  cancelled: boolean;
  /** Seconds elapsed on the grace countdown (only meaningful once the book is over). */
  elapsedGrace: number;
};

export type EndCreditsDecision = {
  /** Show the "Starting in X" countdown + Cancel affordance. */
  showCountdown: boolean;
  /** Seconds remaining until auto-play fires, for the countdown label. */
  countdownSeconds: number;
  /** Auto-play should fire now. */
  fireNext: boolean;
};

const IDLE: EndCreditsDecision = { showCountdown: false, countdownSeconds: 0, fireNext: false };

export function endCreditsDecision(input: EndCreditsInput): EndCreditsDecision {
  const { autoPlayNext, hasNext, stillPlaying, remainingSeconds, cancelled, elapsedGrace } = input;
  // No auto-play at all: nothing to count down, nothing to fire.
  if (!autoPlayNext || !hasNext || cancelled) return IDLE;

  if (stillPlaying) {
    // Count down the remaining audio; the actual start waits for the real end (the
    // ended transition flips `stillPlaying` false and hands over to the grace regime).
    return {
      showCountdown: true,
      countdownSeconds: Math.max(0, remainingSeconds),
      fireNext: false,
    };
  }

  // Book is over: fixed grace, then fire.
  const remaining = Math.max(0, GRACE_SECONDS - elapsedGrace);
  return { showCountdown: true, countdownSeconds: remaining, fireNext: remaining <= 0 };
}

// --- What the credits show -------------------------------------------------------

/** How many listening spans the credits ask for (the server's cap): a book with more
 * reads as "at least" (`partial`). */
export const HISTORY_LIMIT = 500;

type Span = { started_at: string; ended_at: string };

/** A local calendar day ("2026-10-07") of a timestamp, or null when unparseable. */
function localDay(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * This book's own listening from its history: the wall-clock time listened (at the
 * listener's speed, so not the book's length) and on how many days (the device's local
 * days; a span across midnight counts both). `partial` when the history may be cut
 * short (`limit` spans came back).
 */
export function listeningSummary(history: readonly Span[]): {
  seconds: number;
  days: number;
  partial: boolean;
} {
  let seconds = 0;
  const days = new Set<string>();
  for (const h of history) {
    const start = Date.parse(h.started_at);
    const end = Date.parse(h.ended_at);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    seconds += Math.max(0, end - start) / 1000;
    for (const day of [localDay(h.started_at), localDay(h.ended_at)]) if (day) days.add(day);
  }
  return { seconds, days: days.size, partial: history.length >= HISTORY_LIMIT };
}

type FinishedRow = { library_id: number; path: string };

/**
 * The year shelf from this year's stats (`/me/stats?range=year`): the OTHER books
 * finished this year, oldest first and at most `max` of the newest, and which book of
 * the year this one is. The stats may or may not count this book yet (its finished save
 * can land after they were read), so the number is the year's count when the list has
 * it, else one more. Only a finished book has a number (the credits also open for a
 * book still playing).
 */
export function yearShelf<T extends FinishedRow>(
  stats: { totals: { finished: number }; finished_books: readonly T[] },
  book: { libraryId: number; path: string },
  finished: boolean,
  max: number,
): { others: T[]; bookNumber?: number } {
  const same = (b: FinishedRow) => b.library_id === book.libraryId && b.path === book.path;
  const counted = stats.finished_books.some(same);
  const others = stats.finished_books
    .filter((b) => !same(b))
    .slice(0, Math.max(0, max))
    .reverse();
  if (!finished) return { others };
  return { others, bookNumber: counted ? stats.totals.finished : stats.totals.finished + 1 };
}

/** Where the next book will play from: on the device, on its way, or the server. */
export type NextAvailability =
  { kind: 'downloaded' } | { kind: 'downloading'; percent: number } | { kind: 'stream' };

export function nextAvailability(
  entry:
    { status: 'queued' | 'downloading' | 'downloaded' | 'error'; progress: number } | undefined,
): NextAvailability {
  if (entry?.status === 'downloaded') return { kind: 'downloaded' };
  if (entry?.status === 'queued' || entry?.status === 'downloading')
    return { kind: 'downloading', percent: Math.floor(entry.progress * 100) };
  return { kind: 'stream' };
}

/** The Up next card's eyebrow, saying why this book is next: the i18n key (under
 * `player.finished`) and its values. */
export function upNextReason(next: Pick<UpNextBook, 'source' | 'series'>): {
  key: 'fromQueue' | 'fromSeriesBook' | 'fromSeries' | 'nextInSeries' | 'fromFolder';
  values?: { series: string; position?: string };
} {
  if (next.source === 'queue') return { key: 'fromQueue' };
  if (next.source === 'folder') return { key: 'fromFolder' };
  const series = next.series;
  if (series?.position)
    return { key: 'fromSeriesBook', values: { series: series.name, position: series.position } };
  if (series) return { key: 'fromSeries', values: { series: series.name } };
  return { key: 'nextInSeries' };
}

/** How many of the year shelf's spines (`widths`, newest first) fit in `room` points with
 * `gap` after each: the oldest are left off rather than the row overflowing. */
export function spinesThatFit(widths: readonly number[], room: number, gap: number): number {
  let used = 0;
  let count = 0;
  for (const w of widths) {
    used += w + gap;
    if (used > room) break;
    count += 1;
  }
  return count;
}

/**
 * The listener's saved rating of the book at `path`, which the credits' stars show and a
 * re-rate keeps the note of (a PUT replaces the whole rating: sent without the saved
 * note, it erases it). The rating of exactly that path (`exact`), else, for a part or
 * disc of a book (a rate there rates the book, but the GET is exact), their rating of the
 * book holding it among `mine`. Undefined while an answer it needs is still unknown (or
 * the exact one failed): the stars wait rather than risk the note.
 */
export function savedRating<R extends { library_id: number; path: string }>(
  libraryId: number,
  path: string,
  exact: R | null | undefined,
  mine: readonly R[] | undefined,
): R | null | undefined {
  if (exact !== null) return exact;
  if (mine === undefined) return undefined;
  return mine.find((r) => r.library_id === libraryId && path.startsWith(`${r.path}/`)) ?? null;
}
