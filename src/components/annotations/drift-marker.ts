import { FELL_ASLEEP_LABEL } from '@/api/bookmark-labels';
import type { Bookmark } from '@/api/types';
import { resources, SUPPORTED_CODES } from '@/i18n';

/**
 * The sleep timer's automatic note in every language the app speaks. The note is
 * translated when the bookmark is made (`drift-controller.ts`) and stored as text, so a
 * bookmark made in German reads "Eingeschlafen" whatever the language is today.
 */
const FELL_ASLEEP_NOTES: ReadonlySet<string> = new Set(
  SUPPORTED_CODES.map((code) =>
    resources[code].translation.player.sleepTimer.fellAsleepNote.trim(),
  ),
);

/** Whether `note` is the sleep timer's automatic "Fell asleep" note, in any of the six
 * languages (surrounding spaces ignored). */
export function isFellAsleepNote(note: string | undefined): boolean {
  return !!note && FELL_ASLEEP_NOTES.has(note.trim());
}

/**
 * Whether a bookmark is the sleep timer's "Fell asleep" marker: labelled `fell_asleep`
 * (a server with `annotations`), or, with no label at all (an older server, or a
 * bookmark made before labels), carrying the timer's automatic note in any language. A
 * bookmark with another label is the listener's own, whatever its note says.
 */
export function isDriftBookmark(bookmark: Pick<Bookmark, 'label' | 'note'>): boolean {
  if (bookmark.label === FELL_ASLEEP_LABEL) return true;
  if (bookmark.label) return false;
  return isFellAsleepNote(bookmark.note);
}

/**
 * The note a bookmark row shows: its own text, or `''` for a drift marker whose note is
 * still the timer's automatic one (the row says where the listener drifted off instead,
 * in today's language). A drift marker the listener wrote a note on shows that note.
 */
export function shownNote(bookmark: Pick<Bookmark, 'label' | 'note'>): string {
  if (isDriftBookmark(bookmark) && isFellAsleepNote(bookmark.note)) return '';
  return bookmark.note.trim();
}
