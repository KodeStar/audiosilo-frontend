import { serialQueue } from '@/lib/serial-queue';
import { getItem, setItem } from '@/lib/storage';

/**
 * Drift-offs: the nights a sleep timer stopped a book the listener had fallen asleep to
 * (`FellAsleep` in `sleep-timer.ts`). One small record per book, so the next time that
 * book plays the app can ask "You drifted off around 23:41. Jump back 4 minutes?" and
 * take the listener back to the last moment they were provably awake.
 *
 * Pure rules plus a tiny AsyncStorage document; `drift-controller.ts` wires them to the
 * timer and the player. Keyed by `contentKey(connectionId, libraryId, path)`, so two
 * servers' "library 1 / Book" never share a record (CLAUDE.md, "Path is identity, scoped
 * by connection"). Stale records age out (`DRIFT_TTL_MS`) and the document is capped, so
 * a removed server's entries need no purge of their own.
 */

/** The storage key of the drift document. */
export const DRIFT_STORAGE_KEY = 'audiosilo.driftOffs';

/** How long a drift-off is worth offering: tonight's, and tomorrow night's play still
 * remembers it; anything older is a different evening. */
export const DRIFT_TTL_MS = 36 * 60 * 60 * 1000;

/** Books remembered at most (newest kept). */
const MAX_RECORDS = 20;

/** The jump back is only offered for a gap this size (content seconds): under a minute
 * is not worth a prompt, over an hour is not a nap the listener would want replayed
 * (they were more likely listening and simply did not touch the phone). */
const MIN_GAP_SECONDS = 60;
const MAX_GAP_SECONDS = 60 * 60;

/** The book must start playing this close (content seconds) to where the timer stopped
 * it - otherwise the listener has already moved, and "jump back N minutes" would be
 * measured from somewhere they no longer are. Generous enough for auto-rewind and a
 * position synced from another device a little earlier. */
const RESUME_SLACK_SECONDS = 5 * 60;

export type DriftRecord = {
  /** Epoch ms of the listener's last touch of the player before the timer fired. */
  touchAt: number;
  /** Whole-book position (seconds) of that touch: where "Jump back" goes. */
  touchPosition: number;
  /** Whole-book position (seconds) where the timer stopped playback. */
  stoppedAt: number;
  /** Epoch ms the drift-off was recorded (the grace window closing). */
  recordedAt: number;
};

export type DriftRecords = Record<string, DriftRecord>;

function isRecord(value: unknown): value is DriftRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    Number.isFinite(r.touchAt) &&
    Number.isFinite(r.touchPosition) &&
    Number.isFinite(r.stoppedAt) &&
    Number.isFinite(r.recordedAt)
  );
}

/** The stored document read back: anything malformed dropped, anything older than
 * `DRIFT_TTL_MS` dropped, the newest `MAX_RECORDS` kept. */
export function pruneDrifts(raw: unknown, now: number): DriftRecords {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const live = Object.entries(raw as Record<string, unknown>)
    .filter((e): e is [string, DriftRecord] => isRecord(e[1]))
    .filter(([, r]) => now - r.recordedAt <= DRIFT_TTL_MS && r.recordedAt <= now)
    .sort(([, a], [, b]) => b.recordedAt - a.recordedAt)
    .slice(0, MAX_RECORDS);
  return Object.fromEntries(live);
}

/** What the prompt offers: the jump target, the minutes it says, and the clock time of
 * the last touch. */
export type DriftOffer = { jumpTo: number; minutes: number; touchAt: number };

/**
 * Should playback of this book, starting now at `position`, offer the jump back? Null
 * unless the record is still fresh, the gap between the last touch and the stop is
 * 1-60 content minutes, and the book is starting near where the timer stopped it. The
 * minutes in the copy are that content gap, rounded.
 */
export function driftOffer(record: DriftRecord, now: number, position: number): DriftOffer | null {
  if (now - record.recordedAt > DRIFT_TTL_MS || record.recordedAt > now) return null;
  const gap = record.stoppedAt - record.touchPosition;
  if (gap < MIN_GAP_SECONDS || gap > MAX_GAP_SECONDS) return null;
  if (Math.abs(position - record.stoppedAt) > RESUME_SLACK_SECONDS) return null;
  return {
    jumpTo: record.touchPosition,
    minutes: Math.max(1, Math.round(gap / 60)),
    touchAt: record.touchAt,
  };
}

/** Every read-modify-write of the document runs in turn, so a save and a take started
 * together can never drop each other's change. */
const serial = serialQueue();

async function readAll(now: number): Promise<DriftRecords> {
  return pruneDrifts(await getItem<unknown>(DRIFT_STORAGE_KEY), now);
}

/** Remember a drift-off for a book (replacing an older one). */
export function saveDrift(bookKey: string, record: DriftRecord): Promise<void> {
  return serial(async () => {
    const all = await readAll(record.recordedAt);
    all[bookKey] = record;
    await setItem(DRIFT_STORAGE_KEY, pruneDrifts(all, record.recordedAt));
  });
}

/** Read AND forget a book's drift-off (it is offered once). Null when there is none. */
export function takeDrift(bookKey: string, now: number): Promise<DriftRecord | null> {
  return serial(async () => {
    const all = await readAll(now);
    const record = all[bookKey] ?? null;
    if (record) {
      delete all[bookKey];
      await setItem(DRIFT_STORAGE_KEY, all);
    }
    return record;
  });
}
