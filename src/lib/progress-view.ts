/**
 * Progress-bar fraction + remaining seconds for a book from its current position
 * and total duration (both in seconds). Guards an unknown/zero duration (fraction
 * 0) and clamps the fraction to [0,1]. Pure so the home card can substitute the
 * live player position for the currently-playing book without branching logic in
 * the component.
 */
export function progressFractionRemaining(
  position: number,
  duration: number,
): { fraction: number; remaining: number } {
  const fraction = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const remaining = Math.max(0, duration - position);
  return { fraction, remaining };
}
