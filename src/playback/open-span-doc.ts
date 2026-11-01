import type { ListeningStart } from '@/api/types';
import { isRecord } from '@/lib/storage-keys';

/**
 * The stored open span document (`audiosilo.listeningOpenSpan`), read by the outbox and by
 * the pending counts in `progress-sync.ts` (a leaf, so neither imports the other for it).
 */

/** One end of a span: whole-book seconds, and the audio file (rel path) and seconds in it. */
export type SpanEnd = { pos: number; file?: string; filePos?: number };

/** A span being played (store.ts keeps it in memory, and it is stored every few seconds). */
export type OpenSpan = {
  connectionId: string;
  libraryId: number;
  path: string;
  from: SpanEnd;
  to: SpanEnd;
  /** The device's length of the book (0 = unknown). */
  duration: number;
  speed: number;
  /** ISO, device clock. */
  startedAt: string;
  endedAt: string;
  start: ListeningStart;
  /** The version acknowledged when the span opened (absent: none known, last write wins). */
  baseVersion?: number;
  /** The id its `listen` event takes, chosen when it opened: a span closed twice (a kill
   * between the outbox write and the clear, the web's `pagehide` send and the next
   * launch's recovery) is one event, the server's `duplicate` the second time. */
  id?: string;
};

/** A stored open span: whose it is (the tab or app launch that plays it) and when it was
 * last stored (ms, device clock). Both absent on a span stored before W2. */
export type StoredSpan = OpenSpan & { owner?: string; keptAt?: number };

const isPos = (n: unknown): n is number => Number.isFinite(n);

/** Whether `v` is a stored span with a place (JSON keeps NaN as null). */
export function isSpan(v: unknown): v is StoredSpan {
  return (
    isRecord(v) &&
    typeof v.connectionId === 'string' &&
    typeof v.libraryId === 'number' &&
    typeof v.path === 'string' &&
    isRecord(v.from) &&
    isPos(v.from.pos) &&
    isRecord(v.to) &&
    isPos(v.to.pos) &&
    typeof v.startedAt === 'string' &&
    typeof v.endedAt === 'string'
  );
}

/** The spans in the stored document: a list, one per tab playing (W2), or the one span
 * stored before (a bare object), or none. */
export function storedSpans(raw: unknown): StoredSpan[] {
  if (Array.isArray(raw)) return raw.filter(isSpan);
  return isSpan(raw) ? [raw] : [];
}
