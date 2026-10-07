import { contentKeyOf } from '@/lib/content-key';
import type { KeepAhead } from '@/stores/settings';

import type { DownloadStatus, StorageEstimate } from './types';

/**
 * "Keep the next books ready": the pure rules. Given what comes after the book that is
 * loaded (the Up next queue, then the series), what is already on the device and the
 * room left, decide which books to download now. The controller
 * (`keep-ahead-controller.ts`) gathers the inputs and acts on the plan; everything that
 * decides lives here so it is tested without a device.
 *
 * It downloads on its own, so every rule leans towards doing less:
 * - only the next `count` books (the WINDOW) are considered, never further;
 * - the network rule is the listener's `autoDownloadNext` (never / on Wi-Fi / always);
 * - a book cancelled or removed this session (`declined`) is not fetched again, and it
 *   keeps its place in the window (the planner does not reach past it for another);
 * - a failed download is left for the listener to retry, in its place too;
 * - a finished book is not "ahead", so it neither counts nor downloads;
 * - downloads start in window order and stop at the first that would eat into the
 *   reserve of free space (`reserveBytes`); with no way to know the room, one book
 *   downloads at a time (the controller plans again when it finishes).
 */

/** A book after the current one, from the queue or the series. */
export type AheadBook = {
  connectionId: string;
  libraryId: number;
  path: string;
  title: string;
  /** Bytes when known (`Book.size`), else 0. */
  size: number;
  /** Seconds when known, else 0. */
  duration: number;
  source: 'queue' | 'series';
};

/** What the network rule allows right now: `never` (automatic downloads are off),
 * `metered` (On Wi-Fi, and this is not Wi-Fi), or `allowed`. */
export type NetworkGate = 'allowed' | 'metered' | 'never';

/** One book of the window and what keeping it ready means right now. */
export type SlotState =
  /** On the device. */
  | 'ready'
  /** Queued or downloading already. */
  | 'active'
  /** Download it now. */
  | 'start'
  /** Cancelled or removed this session: left alone. */
  | 'declined'
  /** A download failed: the listener retries it from Downloads. */
  | 'failed'
  /** Waiting for Wi-Fi (`metered`). */
  | 'waiting'
  /** Would leave less than the reserve free. */
  | 'no-space'
  /** The room isn't knowable, so it waits for the download before it to finish. */
  | 'later';

export type KeepAheadSlot = { book: AheadBook; state: SlotState };

/** The plan's summary for the Downloads page:
 * - `off`: the setting is off; `never`: automatic downloads are off;
 * - `idle`: nothing is loaded, or nothing comes after it;
 * - `waiting` (for Wi-Fi), `no-space`, `working` (something is downloading or starting);
 * - `failed`: a download of the window stopped (the listener retries it);
 * - `ready`: the rest of the window is on the device (declined books aside);
 * - `declined`: every book of the window was cancelled or removed this session. */
export type KeepAheadStatus =
  'off' | 'never' | 'idle' | 'waiting' | 'no-space' | 'working' | 'failed' | 'declined' | 'ready';

export type KeepAheadPlan = {
  status: KeepAheadStatus;
  slots: KeepAheadSlot[];
  /** The books to download now, in order. */
  start: AheadBook[];
};

/** About 128 kbps: a fair upper guess for an audiobook whose size the list doesn't give. */
const BYTES_PER_SECOND = 16_000;
/** When neither size nor length is known, assume a long book. */
const UNKNOWN_BOOK_BYTES = 1024 ** 3;

/** What downloading a book will take, erring high. */
export function estimateBytes(book: { size: number; duration: number }): number {
  if (book.size > 0) return book.size;
  if (book.duration > 0) return Math.ceil(book.duration * BYTES_PER_SECOND);
  return UNKNOWN_BOOK_BYTES;
}

/** Free space automatic downloads always leave: 1 GB or a tenth of the room, whichever
 * is more. */
export function reserveBytes(capacity: number): number {
  return Math.max(1024 ** 3, Math.ceil(capacity * 0.1));
}

/** The bytes automatic downloads may still add (free space, minus what queued downloads
 * will write, minus the reserve; below zero when the reserve is already eaten into), or
 * null when the room is not knowable. Keep-ahead's plan and the playback store's download
 * of the book you start both obey it. */
export function roomLeft(storage: StorageEstimate | null, pending: number): number | null {
  return storage ? storage.free - pending - reserveBytes(storage.capacity) : null;
}

/** Bytes the registry's queued and in-flight downloads still have to write. */
export function pendingBytes(
  entries: Iterable<{
    status: DownloadStatus;
    bytes: number;
    totalBytes: number;
    manifest: { book: { size: number; duration: number } };
  }>,
): number {
  let sum = 0;
  for (const e of entries) {
    if (e.status !== 'queued' && e.status !== 'downloading') continue;
    const total = e.totalBytes > 0 ? e.totalBytes : estimateBytes(e.manifest.book);
    sum += Math.max(0, total - e.bytes);
  }
  return sum;
}

/** The next `count` books after `current`: the queue first, then the series, without
 * the current book, finished books or repeats. */
export function aheadWindow(opts: {
  count: number;
  current: { connectionId: string; libraryId: number; path: string };
  queue: readonly AheadBook[];
  series: readonly AheadBook[];
  finished: ReadonlySet<string>;
}): AheadBook[] {
  const seen = new Set([contentKeyOf(opts.current)]);
  const out: AheadBook[] = [];
  for (const book of [...opts.queue, ...opts.series]) {
    if (out.length >= opts.count) break;
    const key = contentKeyOf(book);
    if (seen.has(key) || opts.finished.has(key)) continue;
    seen.add(key);
    out.push(book);
  }
  return out;
}

export type KeepAheadInput = {
  count: KeepAhead;
  network: NetworkGate;
  /** The window (`aheadWindow`); empty when nothing is loaded. */
  window: readonly AheadBook[];
  /** The registry's status per `contentKeyOf`. */
  entries: ReadonlyMap<string, DownloadStatus>;
  declined: ReadonlySet<string>;
  /** Null when the room is not knowable. */
  storage: StorageEstimate | null;
  /** `pendingBytes` of the registry. */
  pending: number;
};

/** What the plan says it is doing, by the first slot state found in this order. */
const STATUS_BY_STATE: [SlotState[], KeepAheadStatus][] = [
  [['start', 'active', 'later'], 'working'],
  [['no-space'], 'no-space'],
  [['waiting'], 'waiting'],
  [['failed'], 'failed'],
  [['ready'], 'ready'],
];

function planStatus(slots: readonly KeepAheadSlot[]): KeepAheadStatus {
  const found = STATUS_BY_STATE.find(([states]) => slots.some((s) => states.includes(s.state)));
  return found ? found[1] : 'declined';
}

/** Decide what keeping the window ready means now (see the module comment). */
export function planKeepAhead(input: KeepAheadInput): KeepAheadPlan {
  if (input.count === 0) return { status: 'off', slots: [], start: [] };
  if (input.network === 'never') return { status: 'never', slots: [], start: [] };
  if (input.window.length === 0) return { status: 'idle', slots: [], start: [] };

  let room = roomLeft(input.storage, input.pending);
  // Unknown room: one at a time.
  let unknownBudget = input.window.some((b) => {
    const status = input.entries.get(contentKeyOf(b));
    return status === 'queued' || status === 'downloading';
  })
    ? 0
    : 1;
  let blocked = false;
  const slots: KeepAheadSlot[] = input.window.map((book) => {
    const key = contentKeyOf(book);
    const status = input.entries.get(key);
    if (status === 'downloaded') return { book, state: 'ready' };
    if (status === 'queued' || status === 'downloading') return { book, state: 'active' };
    if (status === 'error') return { book, state: 'failed' };
    if (input.declined.has(key)) return { book, state: 'declined' };
    if (input.network === 'metered') return { book, state: 'waiting' };
    // In window order: once one doesn't fit, none after it starts either.
    if (room === null) {
      if (unknownBudget === 0) return { book, state: 'later' };
      unknownBudget -= 1;
      return { book, state: 'start' };
    }
    if (blocked) return { book, state: 'no-space' };
    const need = estimateBytes(book);
    if (need > room) {
      blocked = true;
      return { book, state: 'no-space' };
    }
    room -= need;
    return { book, state: 'start' };
  });

  const start = slots.filter((s) => s.state === 'start').map((s) => s.book);
  return { status: planStatus(slots), slots, start };
}
