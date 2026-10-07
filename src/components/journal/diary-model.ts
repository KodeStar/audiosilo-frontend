import type { TFunction } from 'i18next';

import type { Bookmark, CoverColor } from '@/api/types';
import { contrast } from '@/components/series/spine-colors';
import { contentKey } from '@/lib/content-key';
import { formatClock } from '@/lib/format';
import {
  type ListeningSession,
  type ListeningSpan,
  localDayStart,
  nextDayStart,
} from '@/lib/listening-sessions';
import { driftOffer, type DriftRecord, type DriftRecords } from '@/playback/drift';

import type { Sourced } from './merge-model';

/**
 * The Journal's Diary (STYLEGUIDE section 9, "Sleep": "the next morning in the Journal"):
 * the listening sessions (`@/lib/listening-sessions`, shared with the book page's History
 * tab) grouped by the device's local day, placed on a 24 hour bar by wall clock, labelled
 * with their chapters, and the "Fell asleep" drift-offs. Pure: the screens only render
 * what this decides.
 */

/** One local day of listening. */
export type DiaryDay = {
  /** Local midnight, epoch ms (also the day's identity). */
  start: number;
  /** Wall-clock seconds listened that day. */
  total: number;
  /** The day's sessions, newest first. */
  sessions: ListeningSession[];
  /** Every span of those sessions (the honest picture, for the 24 hour bar). */
  spans: ListeningSpan[];
};

/** Sessions grouped by the local day they started on (a session past midnight belongs
 * to its start day), newest day first. */
export function groupByDay(sessions: readonly ListeningSession[]): DiaryDay[] {
  const byDay = new Map<number, ListeningSession[]>();
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
const BAR_MIN_CONTRAST = 3;

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
type ChapterNamer = (position: number) => string | null;

/**
 * Where a span went in the book: its chapters ("A Bloody, Red Sunset to Bridge Four", one
 * name when it stayed in one chapter) when the book's chapters are known, else its
 * positions ("1:02:03 to 1:23:45").
 */
export function spanRange(
  span: Pick<ListeningSpan, 'from' | 'to'>,
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
  spans: readonly ListeningSpan[],
  drifts: readonly B[],
): Map<string, B> {
  const out = new Map<string, B>();
  if (drifts.length === 0) return out;
  const byBook = new Map<string, ListeningSpan[]>();
  for (const s of spans) {
    const list = byBook.get(s.bookKey);
    if (list) list.push(s);
    else byBook.set(s.bookKey, [s]);
  }
  for (const bm of drifts) {
    const made = Date.parse(bm.created_at);
    if (Number.isNaN(made)) continue;
    let best: { span: ListeningSpan; gap: number } | null = null;
    for (const s of byBook.get(contentKey(bm.connectionId, bm.library_id, bm.path)) ?? []) {
      if (out.has(s.key)) continue;
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
