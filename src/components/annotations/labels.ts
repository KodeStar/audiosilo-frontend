import type { TFunction } from 'i18next';

import { type BookmarkLabel, isBookmarkLabel } from '@/api/bookmark-labels';

/** The translation key naming each label the player knows (a label on the wire is a
 * machine key, never display text). */
const LABEL_KEY = {
  quote: 'annotations.labels.quote',
  favourite: 'annotations.labels.favourite',
  relisten: 'annotations.labels.relisten',
  funny: 'annotations.labels.funny',
  question: 'annotations.labels.question',
  fell_asleep: 'annotations.labels.fell_asleep',
} as const satisfies Record<BookmarkLabel, string>;

/**
 * A bookmark label's name in the listener's language ("Re-listen" for `relisten`), or
 * null for no label (`''`, absent on an older server) and for a key this player does not
 * know (a newer client may store others; the server checks only the shape).
 */
export function labelText(t: TFunction, key: string | undefined): string | null {
  return isBookmarkLabel(key) ? t(LABEL_KEY[key]) : null;
}

/**
 * The label picker's next value: one label or none, so tapping the chosen label again
 * clears it (`''`), and tapping another replaces it. A label the picker does not offer
 * (the sleep timer's `fell_asleep`, a newer client's key) is replaced the same way.
 */
export function toggleLabel(current: string, picked: BookmarkLabel): string {
  return current === picked ? '' : picked;
}
