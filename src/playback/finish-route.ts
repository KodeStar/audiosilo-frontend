/**
 * How "Mark as finished" outside the player reaches a server (fe#208): on a server that
 * takes listening events (Sync v2, `listening_sync`) as a `finish` event through the
 * player's store, which closes the book's open span first so the span goes before it
 * (server#359), and queues it offline; else the caller's legacy PUT save.
 *
 * The store registers itself here as it loads (`setFinishRecorder`): the API hooks and the
 * book page can't import the store (it imports them). Nothing registered: the PUT path.
 */
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

/** Record a finish as a `finish` event when its server takes one; false when it does not
 * (the caller saves it by PUT). */
export async function recordFinishEvent(ref: FinishRef): Promise<boolean> {
  if (!recorder?.takesEvent(ref.connectionId)) return false;
  await recorder.record(ref);
  return true;
}
