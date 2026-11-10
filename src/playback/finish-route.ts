/**
 * How "Mark as finished" outside the player reaches a server (fe#208): on a server that
 * takes listening events (Sync v2, `listening_sync`) as a `finish` event through the
 * player's store, which closes the book's open span first so the span goes before it
 * (server#359), and queues it offline; else the caller's legacy PUT save.
 *
 * The store registers itself here as it loads (`setFinishRecorder`): the API hooks and the
 * book page can't import the store (it imports them). Nothing registered: the PUT path.
 */
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

type FinishRecorder = {
  /** Whether `connectionId`'s server takes the finish as an event. */
  takesEvent: (connectionId: string) => boolean;
  /** Record the finish as an event; resolves once it waits in the outbox. */
  record: (ref: FinishRef) => Promise<void>;
  /** Take the book's not-yet-sent finish events back (one being sent is waited for). */
  withdraw: (connectionId: string, libraryId: number, path: string) => Promise<Withdrawal>;
  /** A finish that never left this device is undone here: its record goes back to the
   * place before it (`ref.position`), unfinished. */
  unrecord: (ref: UndoRef) => Promise<void>;
};

/** The book an Undo unfinishes, and the place it goes back to. */
export type UndoRef = Pick<FinishRef, 'connectionId' | 'libraryId' | 'path' | 'position'>;

let recorder: FinishRecorder | null = null;

/** The store's recorder (`src/playback/store.ts`). */
export function setFinishRecorder(next: FinishRecorder | null): void {
  recorder = next;
}

/** Whether a Mark as finished on `connectionId` goes as a `finish` event. */
export function finishTakesEvent(connectionId: string): boolean {
  return recorder?.takesEvent(connectionId) ?? false;
}

/** Record a finish as a `finish` event when its server takes one; false when it does not
 * (the caller saves it by PUT). */
export async function recordFinishEvent(ref: FinishRef): Promise<boolean> {
  if (!recorder?.takesEvent(ref.connectionId)) return false;
  await recorder.record(ref);
  return true;
}

/**
 * Undo a Mark as finished with `edit` (the progress edit that unfinishes the book, at
 * `ref.position`): the book's finish event still waiting in the outbox is taken back first,
 * since sent after the edit it would finish the book again. A finish that never reached the
 * server (offline) needs no edit: taken back, this device's record goes back to the place
 * before and the Undo is done (an edit offline fails, and putting the finish back sent it on
 * reconnect). Else the edit (a finish the server has, or may have: `Withdrawal.unsent`), and
 * an edit that failed puts the finish back. Resolves to whether the book is unfinished.
 */
export async function undoFinish(ref: UndoRef, edit: () => Promise<boolean>): Promise<boolean> {
  const r = recorder;
  if (!r) return edit();
  // A withdrawal that failed still lets the Undo's edit through (nothing was taken back).
  const taken = await r.withdraw(ref.connectionId, ref.libraryId, ref.path).catch(() => null);
  if (taken?.unsent) {
    await r.unrecord(ref).catch(() => undefined);
    return true;
  }
  const ok = await edit();
  if (!ok) await taken?.restore().catch(() => undefined);
  return ok;
}
