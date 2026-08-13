import { withinAutoSleepWindow } from '@/lib/hhmm';
import type { AutoSleepType } from '@/stores/settings';

import type { SleepEndReason } from './sleep-timer';

/**
 * The auto sleep timer's per-book memory: the books the listener has **cancelled** a
 * timer on this session. Never auto-arm for one of them again. Silently putting back a
 * timer someone has just dismissed is the worst outcome this feature has, so this is
 * the rule that never bends - and it applies whoever armed the cancelled timer, so
 * cancelling your own manual one keeps auto sleep out too.
 *
 * ## Why blocking is ALL it remembers
 *
 * The other thing the memory has to know - "a timer is standing for this book right
 * now, so nothing may arm a second one" - is not memory at all: the timer store answers
 * it live, as `phase !== 'idle'`, and answers it better. A remembered copy of it was
 * only ever as good as the bookkeeping that maintained it, and it could go stale in a
 * way the live reading cannot (marking the book that is PLAYING when a timer belonging
 * to a different book goes live would retire the wrong one, for the whole session).
 * The controller therefore gates on the store, and remembers only what the store cannot
 * know: which books the listener has said no on.
 *
 * ## Why "ran out" does not mean "no more timers tonight"
 *
 * This memory used to be a single spent flag, marked when a timer was armed and never
 * cleared. It prevented nagging, but it also meant that once an automatic timer had
 * fired and finished, pressing play again inside the window got you nothing at all - a
 * listener woken at 3am was unprotected for the rest of the night, which is precisely
 * what the feature exists to prevent. Listen Audiobook Player's "Auto Sleep" and Smart
 * AudioBook Player's sleep schedule both arm on EVERY play inside the window, and are
 * structurally immune to it. Pressing play at 3am is the listener saying they are still
 * listening; only their cancel says the opposite.
 *
 * It is a SET of book keys, not one slot. "For the rest of the session" is a promise a
 * single slot cannot keep: A -> B -> A wiped A's record and handed the listener a
 * second automatic timer on the very book they had cancelled one for. Insertion-ordered
 * and capped (see `MAX_REMEMBERED_BOOKS`) because it lives for the process lifetime.
 */
export type AutoSleepMemory = ReadonlySet<string>;

/**
 * How many books the memory keeps. Far more than a night's listening (the point is to
 * cover a whole session), small enough that the retained strings are free. Evicting the
 * oldest is the safe direction: the worst case is that a book blocked 50 books ago
 * could get another automatic timer.
 */
export const MAX_REMEMBERED_BOOKS = 50;

export const EMPTY_AUTO_SLEEP_MEMORY: AutoSleepMemory = new Set<string>();

/**
 * May auto sleep arm for this book right now, as far as the memory is concerned?
 * False for a blocked book (for the session). Nothing loaded is never armable.
 *
 * This is only the memory's half of the question - the caller also has to check that no
 * timer is standing (`phase !== 'idle'`), which is the live half.
 */
export function canAutoSleepArm(memory: AutoSleepMemory, bookKey: string | null): boolean {
  return bookKey !== null && !memory.has(bookKey);
}

/**
 * Fold the end of a book's timer in. The timer store hands over the reason explicitly,
 * so this never has to guess (see `SleepEndReason`):
 * - `cancelled` blocks the book for the session;
 * - `expired` changes nothing - it ran its course, so the book stays armable and a
 *   later play edge may give it a fresh timer.
 *
 * A blocked book is never unblocked: a later timer of the listener's OWN running out on
 * it says nothing about the cancellation they made earlier.
 *
 * Returns the SAME set when nothing changed, so a caller can compare identities.
 */
export function recordAutoSleepOutcome(
  memory: AutoSleepMemory,
  bookKey: string | null,
  reason: SleepEndReason,
): AutoSleepMemory {
  if (bookKey === null || reason !== 'cancelled' || memory.has(bookKey)) return memory;
  const next = new Set(memory);
  next.add(bookKey);
  // Insertion-ordered, so the first key is the oldest.
  if (next.size > MAX_REMEMBERED_BOOKS) {
    const oldest = next.values().next().value;
    if (oldest !== undefined) next.delete(oldest);
  }
  return next;
}

export type AutoSleepInput = {
  /** The `autoSleepTimer` setting. */
  enabled: boolean;
  /** Window bounds, local wall-clock "HH:MM". */
  from: string;
  until: string;
  /** What an auto-armed timer should do. */
  type: AutoSleepType;
  /** Now, for the window test (injected so this stays pure). */
  now: Date;
  /** Identity of the book that just started playing; null when nothing is loaded. */
  bookKey: string | null;
  /** The session's per-book memory. The caller owns recording into it (it has to - it
   * also has to store the result), so this is read as-is. */
  memory: AutoSleepMemory;
};

export type AutoSleepDecision =
  | { arm: 'none' }
  | { arm: 'chapter' }
  | { arm: 'duration'; minutes: number };

const NONE: AutoSleepDecision = { arm: 'none' };

/**
 * Should playback that just started be given an automatic sleep timer, and which one?
 * Pure: the caller detects the transition into `playing`, feeds the settings, the clock
 * and its per-book memory in, and acts on the answer.
 *
 * "A timer is already live, whoever armed it" is deliberately NOT asked here - the
 * caller has to enforce that against the live timer store before it gets this far (see
 * `auto-sleep-controller.ts`). Restating it as an input would be a second, always-false
 * copy of a rule enforced somewhere else.
 */
export function decideAutoSleep(input: AutoSleepInput): AutoSleepDecision {
  if (!input.enabled || !input.bookKey) return NONE;
  // Blocked for the session by a cancellation.
  if (!canAutoSleepArm(input.memory, input.bookKey)) return NONE;
  if (!withinAutoSleepWindow(input.from, input.until, input.now)) return NONE;
  if (input.type === 'chapter') return { arm: 'chapter' };
  const minutes = Number(input.type);
  // A corrupt persisted value that isn't a positive number arms nothing at all,
  // rather than a nonsense timer.
  return Number.isFinite(minutes) && minutes > 0 ? { arm: 'duration', minutes } : NONE;
}
