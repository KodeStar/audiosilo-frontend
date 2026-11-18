/**
 * How "Mark as finished" outside the player reaches a server (fe#208): on a server that
 * takes listening events (Sync v2, `listening_sync`) as a `finish` event through the
 * player's store, which closes the book's open span first so the span goes before it
 * (server#359), and queues it offline; else the caller's legacy PUT save.
 *
 * The store registers itself here as it loads (`setFinishRecorder`): the API hooks and the
 * book page can't import the store (it imports them). Nothing registered: the PUT path.
 */
import { isServerAwayError } from '@/api/client';

import type { Withdrawal } from './listening-outbox';
import type { ProgressSave } from './progress-sync';

export type FinishRef = {
  connectionId: string;
  libraryId: number;
  path: string;
  /** The place the book is finished at (its end) and its length, for this device's mirror. */
  position: number;
  duration: number;
  playback_speed?: number;
};

/** The save that records `ref` finished at its end, by `deviceId` at `at`: the PUT path's
 * body and the event path's mirror record alike. */
export function finishedSave(ref: FinishRef, deviceId: string, at: string): ProgressSave {
  return {
    connectionId: ref.connectionId,
    libraryId: ref.libraryId,
    path: ref.path,
    position: ref.position,
    duration: ref.duration,
    finished: true,
    playback_speed: ref.playback_speed && ref.playback_speed > 0 ? ref.playback_speed : 1,
    device_id: deviceId,
    updated_at: at,
  };
}

/** The book a Mark as finished is for. */
type FinishBook = Pick<FinishRef, 'connectionId' | 'libraryId' | 'path'>;

type FinishRecorder = {
  /** Whether `connectionId`'s server takes the finish as an event. */
  takesEvent: (connectionId: string) => boolean;
  /** `connectionId`'s sign-in (`connectionGeneration`): a write for it after an await is
   * made only while it is still the same one. */
  generation: (connectionId: string) => number;
  /** The book is being marked finished: when it is the loaded one (or one starting), it
   * stops and unloads; resolves once its place is saved, with that place (else undefined). */
  leave: (ref: FinishBook) => Promise<number | undefined>;
  /** The finish the book was left for failed: it is loaded again, paused at the place it
   * was left at, when nothing was loaded since. */
  reload: (ref: FinishBook) => Promise<void>;
  /** Record the finish as an event; resolves once it waits in the outbox. */
  record: (ref: FinishRef) => Promise<void>;
  /** Take the book's not-yet-sent finish events back (one being sent is waited for). */
  withdraw: (connectionId: string, libraryId: number, path: string) => Promise<Withdrawal>;
  /** An undone finish leaves this device: its record goes back to the place before it
   * (`ref.position`), unfinished; nothing when `connectionId` was signed out since `since`. */
  unrecord: (ref: UndoRef, since: number) => Promise<void>;
  /** A finish that never reached the server was taken back: this device's record goes back
   * to the one before it, the place the server still holds, when its mirror holds the
   * finish's record carrying that place (decided as it is changed). Resolves whether it did. */
  restoreBefore: (ref: FinishBook, since: number) => Promise<boolean>;
};

/** The book an Undo unfinishes, and the place it goes back to. */
export type UndoRef = Pick<FinishRef, 'connectionId' | 'libraryId' | 'path' | 'position'> & {
  /** Mark as not finished, not the Undo of a Mark: this device's record goes to `position`,
   * never to the one before a finish marked earlier (kept for that finish's Undo, it may be
   * long out of date). Unless that finish never reached the server (`undoFinish`). */
  atPosition?: boolean;
};

let recorder: FinishRecorder | null = null;

/** The store's recorder (`src/playback/store.ts`). */
export function setFinishRecorder(next: FinishRecorder | null): void {
  recorder = next;
}

/** Whether a Mark as finished on `connectionId` goes as a `finish` event. */
export function finishTakesEvent(connectionId: string): boolean {
  return recorder?.takesEvent(connectionId) ?? false;
}

/** A Mark as finished outside the player, before it is recorded by any route: the loaded
 * book stops and unloads when it is this one (fe#258), its span closed ahead of the finish.
 * Resolves once its place is saved, so the finish is recorded after it, with that place
 * (whole-book seconds: where an Undo goes back to); undefined when none was saved. */
export async function leaveFinishedBook(ref: FinishBook): Promise<number | undefined> {
  return recorder?.leave(ref);
}

/** The finish (or the progress edit marking it finished) the book was left for
 * (`leaveFinishedBook`) failed: the book it unloaded is loaded again, paused where it was,
 * so a failure leaves the player as it found it. Nothing when another book was loaded
 * since. */
export async function reloadLeftBook(ref: FinishBook): Promise<void> {
  // A load that fails shows in the player as any start's does; the caller has said why.
  await recorder?.reload(ref).catch(() => undefined);
}

/** Record a finish as a `finish` event when its server takes one; false when it does not
 * (the caller saves it by PUT). */
export async function recordFinishEvent(ref: FinishRef): Promise<boolean> {
  if (!recorder?.takesEvent(ref.connectionId)) return false;
  await recorder.record(ref);
  return true;
}

/** How an Undo of a Mark as finished ended (`undoFinish`): the book is unfinished, or the
 * finish may be on a server that looks down, so it could not be undone (fe#258); also when
 * its edit found the server away (`isServerAwayError`), the finish kept. */
export type UndoOutcome = 'undone' | 'unreachable';

/**
 * Undo a Mark as finished with `edit` (the progress edit that unfinishes the book, at
 * `ref.position`; it rejects when it fails): the book's finish event still waiting in the
 * outbox is taken back first, since sent after the edit it would finish the book again. A
 * finish that never reached the server (offline) needs no edit: taken back, this device's
 * record goes back to the place before and the Undo is done (an edit offline fails, and
 * putting the finish back sent it on reconnect); for Mark as not finished too (`atPosition`),
 * whose own place the server would never get, when this device knows the place before. Else
 * the edit (a finish the server has, or may have: `Withdrawal.unsent`), and an edit that
 * failed puts the finish back and rejects, or resolves `unreachable` when it found the
 * server away (`isServerAwayError`).
 * One a request carried with no answer, while its server looks down, is not undone at all
 * (`unreachable`): the server may hold it and no edit can reach it. A withdrawal that
 * failed (storage refused it) rejects with no edit: the finish still waits, and sent after
 * the edit it would finish the book again. After the edit this device's record goes back
 * too: the edit's answer only reaches the query caches, and the record the finish wrote
 * (finished, at the book's end) would start the book again at 0 on the next offline Play,
 * a restart that then replaces the place the Undo restored on the server.
 */
export async function undoFinish(ref: UndoRef, edit: () => Promise<unknown>): Promise<UndoOutcome> {
  const r = recorder;
  if (!r) return (await editReached(edit)) ? 'undone' : 'unreachable';
  const since = r.generation(ref.connectionId);
  const taken = await r.withdraw(ref.connectionId, ref.libraryId, ref.path);
  if (taken.unreachable) return 'unreachable';
  // Never reached the server, which still holds the place before: back there, no edit.
  // Where this device does not know that place (a reload, another tab's finish), the Undo of
  // a Mark goes to its own place, no edit either; Mark as not finished takes the edit.
  if (taken.unsent) {
    if (await r.restoreBefore(ref, since).catch(() => false)) return 'undone';
    if (!ref.atPosition) {
      await r.unrecord(ref, since).catch(() => undefined);
      return 'undone';
    }
  }
  let reached: boolean;
  try {
    reached = await editReached(edit);
  } catch (e) {
    await taken.restore().catch(() => undefined);
    throw e;
  }
  if (!reached) {
    await taken.restore().catch(() => undefined);
    return 'unreachable';
  }
  await r.unrecord(ref, since).catch(() => undefined);
  return 'undone';
}

/** Run the Undo's `edit`: false when it failed for its server being away
 * (`isServerAwayError`: the first edit after the server died, before reachability noticed,
 * says `unreachable` as the next would, with its Try again); another failure rejects. */
async function editReached(edit: () => Promise<unknown>): Promise<boolean> {
  try {
    await edit();
    return true;
  } catch (e) {
    if (isServerAwayError(e)) return false;
    throw e;
  }
}
