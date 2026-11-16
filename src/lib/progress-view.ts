import type { Progress } from '@/api/types';

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

/** A book the listener has started and not finished: Home's Continue listening shelf and
 * the palette's Continue listening group. */
export function isInProgress(p: { finished: boolean; position: number }): boolean {
  return !p.finished && p.position > 0;
}

/** Whole percent heard of a 0..1 fraction: rounded down, and 100 only once finished, so
 * an almost-done book reads 99%. Every screen that shows a listening percent uses it. */
export function percentOf(fraction: number, finished = false): number {
  if (finished) return 100;
  return Math.min(99, Math.max(0, Math.floor(fraction * 100)));
}

/** {@link percentOf} from a position and a total (an unknown total reads 0%). */
export function percentHeard(position: number, total: number, finished: boolean): number {
  if (finished) return 100;
  return total > 0 ? percentOf(position / total) : 0;
}

/** A saved place as a row reads it (`savedProgressView`). */
export type SavedProgressView = {
  /** 0..1 listened (1 once finished). */
  fraction: number;
  started: boolean;
  finished: boolean;
  updatedAt?: string;
};

/** A saved place as a row reads it: how far through (1 once finished; the row's own
 * `duration`, else `fallbackDuration`, the book's), whether it is started and finished, and
 * when it was saved. Nothing saved is not started. */
export function savedProgressView(
  p: Pick<Progress, 'position' | 'duration' | 'finished' | 'updated_at'> | undefined,
  fallbackDuration: number,
): SavedProgressView {
  if (!p) return { fraction: 0, started: false, finished: false };
  const total = p.duration > 0 ? p.duration : fallbackDuration;
  const fraction = p.finished ? 1 : progressFractionRemaining(p.position, total).fraction;
  return { fraction, started: p.position > 0, finished: p.finished, updatedAt: p.updated_at };
}
