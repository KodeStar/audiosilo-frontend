import type { TFunction } from 'i18next';

import type { HouseListening, HouseListeningRow } from '@/api/types';
import { bookTitle } from '@/lib/paths';

/**
 * "Listening in the house" (player redesign Phase 8, STYLEGUIDE section 1 "A household,
 * not a user"): the pure rules behind the Home row, the book page's "In the house" card
 * and their copy. The server already answers one row per other person who shares, newest
 * first, and an empty list unless the caller shares too (reciprocal); these rules only
 * decide what the player shows of it.
 */

/** What a row says about when: the server's `playing` / `paused`, or for `recent` the
 * local calendar day of the newest save (today, yesterday, or earlier for a clock that
 * disagrees with the server's 24 hours). */
export type HouseWhen = 'playing' | 'paused' | 'today' | 'yesterday' | 'earlier';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local calendar days from `iso` to `now` (0 = the same day, 1 = yesterday); null for a
 * time that doesn't parse. A save "in the future" (a clock ahead of ours) counts as today.
 * Calendar days, not 24-hour spans: 23:50 last night is yesterday at 00:10. Hermes has no
 * `Intl.RelativeTimeFormat`, so the words come from our own strings. */
export function daysAgo(iso: string, now: number): number | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const startOf = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  // Rounded: a day across a daylight-saving change is 23 or 25 hours long.
  return Math.max(0, Math.round((startOf(now) - startOf(at)) / DAY_MS));
}

/** When a housemate was on their book, for the state line. */
export function houseWhen(
  row: Pick<HouseListeningRow, 'state' | 'updated_at'>,
  now: number,
): HouseWhen {
  if (row.state === 'playing' || row.state === 'paused') return row.state;
  const days = daysAgo(row.updated_at, now);
  if (days === null || days === 0) return 'today';
  return days === 1 ? 'yesterday' : 'earlier';
}

/** The rows to show from one server's answer: none while the caller doesn't share (the
 * answer is empty then anyway, but a cached answer can outlive the caller turning sharing
 * off), one per person (the first, newest, wins), in the server's newest-first order. */
export function visibleRows(
  house: HouseListening | undefined,
  sharing: boolean,
): HouseListeningRow[] {
  if (!sharing || !house?.sharing) return [];
  const seen = new Set<number>();
  return house.listening.filter((r) => {
    if (seen.has(r.user_id)) return false;
    seen.add(r.user_id);
    return true;
  });
}

/** The housemates on ONE book (path is identity: the library and the book's path). */
export function rowsForBook(
  rows: readonly HouseListeningRow[],
  libraryId: number,
  path: string,
): HouseListeningRow[] {
  return rows.filter((r) => r.library_id === libraryId && r.path === path);
}

/** A row's stable key within its server's section. */
export const houseRowKey = (r: HouseListeningRow) => `${r.user_id}`;

/** The chapter as a row names it: its title, else "Chapter N" when only the index is
 * known (a chapter titled "Track 01"), else nothing (a single-chapter book). */
export function chapterName(
  row: Pick<HouseListeningRow, 'chapter' | 'chapter_index'>,
  t: TFunction,
): string | null {
  if (row.chapter) return row.chapter;
  if (row.chapter_index !== null && row.chapter_index >= 0) {
    return t('house.chapterN', { n: row.chapter_index + 1 });
  }
  return null;
}

export type HouseCopy = {
  /** The book's title (the server's, else the path's last segment). */
  title: string;
  /** "Listening now", "Paused", "Earlier today", "Yesterday". */
  when: string;
  /** The chapter, when the row names one. */
  chapter: string | null;
  /** The visible state line: "Listening now · Chapter 4". */
  line: string;
  /** One sentence for a screen reader: "sam is listening to Unsouled, Chapter 4". */
  label: string;
};

/** Everything a row says, in the listener's language. */
export function houseCopy(row: HouseListeningRow, now: number, t: TFunction): HouseCopy {
  const title = bookTitle(row.title, row.path);
  const when = houseWhen(row, now);
  const chapter = chapterName(row, t);
  const whenText = t(`house.when.${when}`);
  const sentence = t(`house.label.${when}`, { name: row.username, title });
  return {
    title,
    when: whenText,
    chapter,
    line: chapter ? t('house.line', { when: whenText, chapter }) : whenText,
    label: chapter ? t('house.label.withChapter', { sentence, chapter }) : sentence,
  };
}

/** The Home row's grid (the prototype's `.house-row`): cards at least 250 wide, 12 apart. */
const HOUSE_CARD_MIN = 250;
export const HOUSE_GAP = 12;

/** How many cards fit across the row's measured `width`: one on a phone, and one until
 * the row is measured. */
export function houseColumns(width: number, phone: boolean): number {
  if (phone || width <= 0) return 1;
  return Math.max(1, Math.floor((width + HOUSE_GAP) / (HOUSE_CARD_MIN + HOUSE_GAP)));
}

/** Each card's width in a row `width` wide (floored, so rounding never wraps the last
 * card), or undefined (full width) until the row is measured. */
export function houseCardWidth(width: number, phone: boolean): number | undefined {
  if (width <= 0) return undefined;
  const columns = houseColumns(width, phone);
  return Math.floor((width - HOUSE_GAP * (columns - 1)) / columns);
}
