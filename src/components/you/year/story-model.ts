/**
 * The story's rules (STYLEGUIDE section 6 "Story bars", section 8 "Year in listening"),
 * pure: each card shows for `CARD_MS` and then the next one comes up, unless the story is
 * held (a screen reader, a share in progress, a finger or pointer on the card, the
 * keyboard focus in it: `useStoryStage`) or still (reduced motion). The last card stays up. Next on the last card goes
 * back to the first; previous on the first restarts it.
 */

/** How long a card shows before the next one (the guide's 6 s story bars). */
export const CARD_MS = 6000;

/** `index` kept inside a story of `count` cards (0 for an empty one). */
export function clampCard(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), count - 1);
}

/** The card a tap moves to: next wraps from the last card to the first; previous stops
 * at the first. */
export function stepCard(index: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  const at = clampCard(index, count);
  if (delta === 1) return at === count - 1 ? 0 : at + 1;
  return Math.max(0, at - 1);
}
