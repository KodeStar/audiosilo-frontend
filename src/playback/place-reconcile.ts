import { t } from 'i18next';

import { resolveClient } from '@/api/connection-clients';
import { isReachable, onReconnect } from '@/api/reachability';
import type { Progress } from '@/api/types';
import { toast } from '@/components/ui/toast';
import { formatClock } from '@/lib/format';
import { onForeground, whenActive } from '@/lib/when-active';

import { selectUndoFor, undoJump, useJumpUndo } from './jump-undo';
import { getDeviceId, readMirror, type ProgressSave } from './progress-sync';
import {
  holdSaves,
  localMoveCount,
  onPickedUpAgain,
  selectBookKey,
  selectBookPosition,
  usePlayer,
} from './store';

/**
 * Picking a loaded book up again where ANOTHER device left it. A book this device holds loaded resumes from its engine's place on every
 * Play (a press, the lock screen, earbuds): nothing asks the server. If another device (or
 * the other AudioSilo app on the same phone, which keeps its own engine, mirror and queue)
 * played on meanwhile, the listener heard the old place AND this device's next save, newer
 * by the clock, overwrote the other one on the server (last-write-wins).
 *
 * So when the loaded book is picked up again, ask the server first:
 * - the app comes to the foreground, or the book's server comes back, while the book is
 *   loaded and settled (`paused`/`ready`): never while it has been playing on;
 * - the book plays again after `LONG_PAUSE_MS` of pause, from anywhere (`onPickedUpAgain`,
 *   called before the play's first save): the engine is already playing, so the move comes
 *   as early as the answer does.
 * While the check is out the store holds its saves (`holdSaves`), so the stale place is
 * never written; the hold ends with the check, or by itself after 5 seconds.
 *
 * It moves only when the server's record was written by another device (`device_id`, which
 * the server stores per record), is newer than anything this device knows for the book
 * (the durable mirror holds every save of this device, queued or not, and every record it
 * read), is not finished, and is more than `MOVE_THRESHOLD_S` from the engine's place. A
 * seek of the listener's own while the check was out wins (`localMoveCount`). The move is
 * the store's `seekBook` (the resume floor, the undo chip's detection), and a toast says
 * what happened with Undo.
 *
 * A finished record moves nothing: like `playBook`, its position is not a place to resume
 * (it is the end), and restarting a book the listener is in the middle of here would be
 * worse. This device's next save then records the book unfinished again.
 */

/** A smaller difference is not worth moving the listener (auto-rewind is up to 30 s). */
export const MOVE_THRESHOLD_S = 30;
/** How long the server has to answer. */
export const CHECK_TIMEOUT_MS = 5_000;

const timeOf = (iso: string | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Where to move the loaded book, or null to stay. Pure. `mirror` is this device's newest
 * knowledge of the book (its own saves, queued or synced, and records it read).
 */
export function placeToMoveTo(input: {
  server: Progress | null;
  deviceId: string;
  mirror: Pick<ProgressSave, 'updated_at'> | null;
  enginePosition: number;
}): number | null {
  const { server, deviceId, mirror, enginePosition } = input;
  if (!server || server.finished || !(server.position > 0)) return null;
  if (!server.device_id || server.device_id === deviceId) return null;
  if (mirror && timeOf(server.updated_at) <= timeOf(mirror.updated_at)) return null;
  if (Math.abs(server.position - enginePosition) <= MOVE_THRESHOLD_S) return null;
  return server.position;
}

let checking = false;

/** The checks' triggers, by name (tests). */
export type ReconcileReason = 'foreground' | 'reconnect' | 'picked-up';

/** Ask the server about the loaded book and move it if another device moved on. Never
 * throws; resolves once the check is over (moved, stayed, or gave up). */
export async function reconcileLoadedPlace(reason: ReconcileReason): Promise<void> {
  if (checking) return;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  const bookKey = selectBookKey(player);
  if (!np || !bookKey || player.loadingBook || np.queue.total <= 0) return;
  const { state } = player.snapshot;
  // Only a book being picked up again: never one that has been playing on.
  if (reason === 'picked-up' ? state !== 'playing' : state !== 'paused' && state !== 'ready') {
    return;
  }
  const client = resolveClient(np.connectionId);
  // Offline (a downloaded book with its server away): nothing to ask; saves go on.
  if (!client || !isReachable(np.connectionId)) return;

  checking = true;
  const release = holdSaves();
  const moves = localMoveCount();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS);
  let moved = false;
  try {
    const [server, deviceId, mirror] = await Promise.all([
      client.getProgress(np.libraryId, np.path, abort.signal),
      getDeviceId(),
      readMirror(np.connectionId, np.libraryId, np.path),
    ]);
    const now = usePlayer.getState();
    // Another book, or the listener moved meanwhile: theirs wins.
    if (selectBookKey(now) !== bookKey || localMoveCount() !== moves || abort.signal.aborted) {
      return;
    }
    const from = selectBookPosition(now);
    const to = placeToMoveTo({ server, deviceId, mirror, enginePosition: from });
    if (to === null) return;
    moved = true;
    await now.seekBook(to);
    tell(bookKey, from, to);
  } catch {
    // Unreachable, refused or too slow: stay where the engine is; the saves go on.
  } finally {
    clearTimeout(timer);
    checking = false;
    // After a move the other device's place is already saved, and the engine may not
    // have reported the move yet: the next save comes from the engine itself.
    release({ flush: !moved });
  }
}

/** "Picked up your place from another device: Chapter 12, 1:02:13" with Undo, shown
 * once the app is in front (a lock-screen play moves the book in the background). */
function tell(bookKey: string, from: number, to: number) {
  whenActive(() => {
    const player = usePlayer.getState();
    if (selectBookKey(player) !== bookKey || !player.nowPlaying) return;
    const chapters = player.nowPlaying.queue.chapters;
    let index = -1;
    for (let i = 0; i < chapters.length; i++) if (to >= chapters[i].book_offset) index = i;
    const time = formatClock(to);
    toast({
      title: t('player.placeMoved.title'),
      description:
        chapters.length > 1 && index >= 0
          ? t('player.placeMoved.chapterAt', { chapter: index + 1, time })
          : t('player.placeMoved.at', { time }),
      action: { label: t('player.placeMoved.undo'), onPress: () => undoMove(bookKey, from) },
    });
  });
}

/** Back to where this device was. Through the undo chip's own undo when the move made
 * one (so going back makes no new chip), else a plain seek; saves then go on from there. */
export function undoMove(bookKey: string, from: number): void {
  const player = usePlayer.getState();
  if (selectBookKey(player) !== bookKey) return;
  const chip = selectUndoFor(bookKey)(useJumpUndo.getState());
  if (chip && Math.abs(chip.from - from) <= 5 && undoJump() !== null) return;
  void player.seekBook(from);
}

/** Start the triggers for the life of the app (root layout). Returns the teardown. */
export function startPlaceReconcile(): () => void {
  const stops: (() => void)[] = [];
  stops.push(onPickedUpAgain(() => void reconcileLoadedPlace('picked-up')));
  stops.push(onForeground(() => void reconcileLoadedPlace('foreground')));
  stops.push(
    onReconnect((cid) => {
      if (usePlayer.getState().nowPlaying?.connectionId === cid) {
        void reconcileLoadedPlace('reconnect');
      }
    }),
  );
  return () => {
    for (const stop of stops) stop();
  };
}
