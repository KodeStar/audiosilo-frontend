/**
 * The bookmark labels the player knows (capability `annotations`). A label is a machine
 * key on the wire, never display text: the UI names it through `t()`. Pure, so any
 * screen (and the sleep timer) can import it.
 */

import type { BookmarkLabel } from './types';

export type { BookmarkLabel };

/** The label of the sleep timer's automatic "Fell asleep" bookmark. Not offered to the
 * listener as a choice. */
export const FELL_ASLEEP_LABEL = 'fell_asleep' satisfies BookmarkLabel;

/** The labels a listener picks from, in the order the picker shows them. */
export const PICKABLE_BOOKMARK_LABELS: readonly BookmarkLabel[] = [
  'quote',
  'favourite',
  'relisten',
  'funny',
  'question',
];

const KNOWN: ReadonlySet<string> = new Set<string>([
  ...PICKABLE_BOOKMARK_LABELS,
  FELL_ASLEEP_LABEL,
]);

/** Whether a stored label is one this player knows. A bookmark can carry a key a newer
 * client made (the server checks only its shape), and `''` means no label: show neither
 * as a known label. */
export function isBookmarkLabel(label: string | undefined): label is BookmarkLabel {
  return label !== undefined && KNOWN.has(label);
}
