import type { BookRef, NextBook, Progress, QueueEntry } from '@/api/types';
import type { ShortcutKey } from '@/lib/keyboard';
import { percentHeard } from '@/lib/progress-view';

/**
 * The pure rules behind Up next (the desktop drawer and the tablet/phone sheet): which
 * server's queue is shown, the drawer's width, reordering, the Q shortcut, the drag
 * payload a cover carries, the time queued and the "Continue the series and more" picks.
 */

/** The desktop drawer's width range and default (STYLEGUIDE section 8, "Up next"). */
export const DRAWER_MIN = 300;
export const DRAWER_MAX = 480;
export const DRAWER_DEFAULT = 360;

/** A drawer width the drawer can take (300-480; anything unusable is the default). */
export function clampDrawerWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return DRAWER_DEFAULT;
  return Math.round(Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, width)));
}

/**
 * Whose queue Up next shows: the loaded book's server (so "Play now" and the series
 * picks talk to the server the listener is on), else the default server, else the
 * first. A loaded book whose connection has since been removed falls through.
 */
export function queueConnectionId(
  loaded: string | undefined,
  defaultId: string | null,
  connections: readonly { id: string }[],
): string | undefined {
  const has = (id: string | null | undefined): id is string =>
    !!id && connections.some((c) => c.id === id);
  if (has(loaded)) return loaded;
  if (has(defaultId)) return defaultId;
  return connections[0]?.id;
}

/** A queue entry's identity in the list (its own stored path, never a DB id). */
export function entryKey(e: BookRef): string {
  return `${e.library_id}\u0000${e.path}`;
}

/** `list` with the item at `from` moved to `to` (both in range), as the server orders
 * it after a positioned add: `to` is the item's final index. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/** Where a row dragged `dy` points from `from` lands, rows being `rowHeight` apart.
 * A worklet: the reorder gesture calls it on the UI thread. */
export function dragTarget(from: number, dy: number, rowHeight: number, count: number): number {
  'worklet';
  if (count <= 0 || rowHeight <= 0) return from;
  return Math.min(count - 1, Math.max(0, from + Math.round(dy / rowHeight)));
}

/** How far row `index` is pushed aside while row `from` is dragged to `to` (in rows:
 * -1 up, 1 down, 0 stays). A worklet, like `dragTarget`. */
export function dragShift(index: number, from: number, to: number): number {
  'worklet';
  if (from < 0 || index === from) return 0;
  if (from < to && index > from && index <= to) return -1;
  if (from > to && index < from && index >= to) return 1;
  return 0;
}

/** The move a key press asks of a focused queue row: ArrowUp/ArrowDown on its grip, or
 * with Alt (Option) anywhere in the row. Null when the key is not a move or the row is
 * already at that end. */
export function keyMove(
  key: { key: string; altKey: boolean },
  onGrip: boolean,
  index: number,
  count: number,
): number | null {
  if (key.key !== 'ArrowUp' && key.key !== 'ArrowDown') return null;
  if (!onGrip && !key.altKey) return null;
  const to = key.key === 'ArrowUp' ? index - 1 : index + 1;
  return to < 0 || to >= count ? null : to;
}

/** Q toggles Up next (STYLEGUIDE section 11): a bare Q, never while typing in a field
 * (`editable`) and never with a modifier (Cmd+Q quits the browser). */
export function isUpNextShortcut(e: ShortcutKey, editable: boolean): boolean {
  if (editable || e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key === 'q' || e.key === 'Q';
}

/** The data a cover carries when dragged onto Up next (web desktop). */
export type BookDragPayload = { connectionId: string; libraryId: number; path: string };

/** The drag's own data type, so the drop zone reacts only to a book. */
export const BOOK_DRAG_TYPE = 'application/x-audiosilo-book';

export function serializeDragPayload(p: BookDragPayload): string {
  return JSON.stringify(p);
}

/** A dropped book, or null for anything else (a link, text, a file, a malformed one). */
export function parseDragPayload(raw: string | null | undefined): BookDragPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (
      v &&
      typeof v.connectionId === 'string' &&
      v.connectionId &&
      typeof v.libraryId === 'number' &&
      Number.isSafeInteger(v.libraryId) &&
      typeof v.path === 'string' &&
      v.path
    ) {
      return { connectionId: v.connectionId, libraryId: v.libraryId, path: v.path };
    }
  } catch {
    // not ours
  }
  return null;
}

/** Whether a dragged book can go on the queue shown: only one of the same server. */
export function canDrop(payload: BookDragPayload, queueConnection: string) {
  return payload.connectionId === queueConnection ? ('ok' as const) : ('other-server' as const);
}

/** The listener's saved place in each book of one server, keyed like the queue. */
export type ProgressIndex = ReadonlyMap<
  string,
  Pick<Progress, 'position' | 'duration' | 'finished'>
>;

export function progressIndex(
  rows: readonly Pick<Progress, 'library_id' | 'path' | 'position' | 'duration' | 'finished'>[],
): ProgressIndex {
  return new Map(rows.map((p) => [entryKey(p), p]));
}

/** Where the listener is in a queued book: finished, a percentage, or not started. */
export type EntryState =
  { kind: 'finished' } | { kind: 'progress'; percent: number } | { kind: 'new' };

export function entryState(
  progress: Pick<Progress, 'position' | 'duration' | 'finished'> | undefined,
): EntryState {
  if (!progress) return { kind: 'new' };
  if (progress.finished) return { kind: 'finished' };
  if (progress.position <= 0 || progress.duration <= 0) return { kind: 'new' };
  return { kind: 'progress', percent: percentHeard(progress.position, progress.duration, false) };
}

/** Listening time left across the queue (seconds, at 1x): each book's length less the
 * listener's place in it; a finished book counts nothing, an unindexed one too. */
export function queuedSeconds(entries: readonly QueueEntry[], progress: ProgressIndex): number {
  let total = 0;
  for (const e of entries) {
    const duration = e.book?.duration ?? 0;
    const p = progress.get(entryKey(e));
    if (p?.finished) continue;
    total += Math.max(0, duration - (p ? Math.min(p.position, duration) : 0));
  }
  return total;
}

/** One "Continue the series and more" row. */
export type Suggestion =
  | { kind: 'next'; ref: BookRef; series: string }
  | { kind: 'progress'; ref: BookRef; percent: number }
  | { kind: 'ghost'; title: string; position: string; workId: string };

/**
 * What to offer under the queue, in order: the book after the loaded one (`next`, from
 * the server's `next_book` answer), then books in progress on this server, newest first,
 * then the community rail's next work when this server couldn't place it (a ghost). Never the loaded book, nor one
 * already queued, nor the same book twice; at most `limit` rows.
 */
export function pickSuggestions({
  next,
  current,
  queued,
  inProgress,
  limit = 4,
}: {
  next: NextBook | undefined;
  current: BookRef | undefined;
  queued: readonly QueueEntry[];
  /** This server's saved progress, newest first. */
  inProgress: readonly Pick<
    Progress,
    'library_id' | 'path' | 'position' | 'duration' | 'finished'
  >[];
  limit?: number;
}): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set(queued.map(entryKey));
  if (current) seen.add(entryKey(current));
  // A queued part path names its book: compare the way `findQueued` does.
  const taken = (ref: BookRef) =>
    seen.has(entryKey(ref)) ||
    queued.some((q) => q.library_id === ref.library_id && ref.path.startsWith(`${q.path}/`));

  if (next?.next && !taken(next.next)) {
    out.push({ kind: 'next', ref: next.next, series: next.book?.series ?? '' });
    seen.add(entryKey(next.next));
  }
  // The rail's next work that this server couldn't place: shown last, as a ghost.
  const ghost: Suggestion | null =
    next?.work && !next.work.local
      ? {
          kind: 'ghost',
          title: next.work.title,
          position: next.work.position,
          workId: next.work.id,
        }
      : null;
  const room = limit - (ghost ? 1 : 0);
  for (const p of inProgress) {
    if (out.length >= room) break;
    if (p.finished || p.position <= 0 || taken(p)) continue;
    const state = entryState(p);
    out.push({
      kind: 'progress',
      ref: { library_id: p.library_id, path: p.path },
      percent: state.kind === 'progress' ? state.percent : 0,
    });
    seen.add(entryKey(p));
  }
  if (ghost) out.push(ghost);
  return out.slice(0, limit);
}
