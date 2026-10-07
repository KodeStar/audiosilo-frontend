import type { Collection, CollectionItem, UserRef } from '@/api/types';
import type { LayoutClass } from '@/lib/layout';

/** The server's limits on a collection's text (after trimming). */
export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 1000;

/** The narrowest collection card (the prototype's grid minimum). */
const CARD_MIN = 260;

/** A name the server takes: 1-100 characters once trimmed. */
export function validName(name: string): boolean {
  const n = name.trim().length;
  return n > 0 && n <= NAME_MAX;
}

/** Who else a collection involves, as its card and page say it: the people the
 * listener shares it with ("Shared with Sam"), or its owner when it is someone else's
 * ("Shared by Maya"); nothing for a private collection of one's own. */
export type ShareLine =
  { kind: 'sharedWith'; names: string[] } | { kind: 'sharedBy'; name: string } | null;

export function shareLine(c: Collection): ShareLine {
  if (!c.owned) return { kind: 'sharedBy', name: c.owner.username };
  const names = (c.shared_with ?? []).map((u) => u.username);
  return names.length ? { kind: 'sharedWith', names } : null;
}

/** Up to `max` names joined with commas, and how many more there are (Hermes has no
 * `Intl.ListFormat`, so the "and N more" is the caller's string). */
export function nameList(names: readonly string[], max = 2): { names: string; more: number } {
  return { names: names.slice(0, max).join(', '), more: Math.max(0, names.length - max) };
}

/** The index a visible item moves to one place up (-1) or down (+1), or null at an end.
 * It is also the `position` of the move's positioned add: the server places an entry
 * already listed at that index among the OTHER visible rows. */
export function moveIndex(index: number, dir: -1 | 1, length: number): number | null {
  const to = index + dir;
  return to < 0 || to >= length ? null : to;
}

/** Total listening time of the items whose book is indexed (seconds). */
export function totalDuration(items: readonly CollectionItem[]): number {
  return items.reduce((sum, i) => sum + (i.book?.duration ?? 0), 0);
}

/** A share selection with `id` switched. */
export function toggleId(ids: readonly number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** The listener's own collections (the ones they can add to), in the server's order. */
export function ownCollections(list: readonly Collection[] | undefined): Collection[] {
  return (list ?? []).filter((c) => c.owned);
}

/** The ids of the users a collection is shared with (the owner's view). */
export function sharedIds(c: Collection): number[] {
  return (c.shared_with ?? []).map((u: UserRef) => u.id);
}

/** The collections grid for an inner `width`: one card per row on a phone, else as many
 * cards of at least 260 as fit (the prototype's `minmax(260px, 1fr)`), sharing it. */
export function collectionGrid(
  width: number,
  layout: LayoutClass,
): { columns: number; card: number; gap: number } {
  const gap = 18;
  const columns =
    layout === 'phone' ? 1 : Math.max(1, Math.floor((width + gap) / (CARD_MIN + gap)));
  return { columns, card: Math.max(0, Math.floor((width - gap * (columns - 1)) / columns)), gap };
}
