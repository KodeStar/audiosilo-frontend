import { bootstrapPlayback } from '@/lib/bootstrap';
import { selectIsTransportLive, usePlayer } from '@/playback/store';

import { carSyncReady, startCarSync } from './car-controller';
import { carNative } from './car-native';

/** How long the player must stay idle before the task says it is done. */
export const CAR_TASK_IDLE_MS = 30_000;

/**
 * The car's headless task (Android): the playback service booted the JS runtime with no
 * activity (a car asked to play a book native can't start alone, a book it started must save
 * its place, a bookmark was pressed). It runs the launch steps the root layout runs before any
 * screen (`bootstrapPlayback`, the same memoised run, so an activity opened later on this
 * runtime doesn't repeat them; among them the listener's language, for the snapshot's
 * labels), then starts the car sync, which adopts the service's book and adds the pending
 * bookmarks.
 *
 * The car sync is never stopped here: the JS runtime outlives the task, and a later car event
 * (a play request, a bookmark) must still find its listeners.
 *
 * Resolves (the task is over) once the player has been idle, nothing playing or buffering,
 * for `CAR_TASK_IDLE_MS`, or at once when the car disconnects while it is idle. JS timers may
 * not fire with the phone's screen off (Android pauses them), so the idle check also runs on
 * every player change; the service's own task timeout is the backstop.
 */
export async function runCarTask(): Promise<void> {
  await bootstrapPlayback();
  startCarSync();
  await carSyncReady();
  await untilIdle(CAR_TASK_IDLE_MS);
}

/** Resolves once the player has not been live (playing or loading) for `ms`, or at once when
 * the car leaves while it is not live. */
export function untilIdle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let idleSince: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offs: (() => void)[] = [];
    const finish = () => {
      if (timer) clearTimeout(timer);
      for (const off of offs) off();
      resolve();
    };
    const check = () => {
      if (selectIsTransportLive(usePlayer.getState())) {
        idleSince = null;
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      idleSince ??= Date.now();
      const left = idleSince + ms - Date.now();
      if (left <= 0) {
        finish();
        return;
      }
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          check();
        }, left);
      }
    };
    offs.push(
      usePlayer.subscribe(check),
      carNative.onConnection((connected) => {
        if (!connected && !selectIsTransportLive(usePlayer.getState())) finish();
      }),
    );
    check();
  });
}
