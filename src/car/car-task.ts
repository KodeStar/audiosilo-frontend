import { startAddressRouting } from '@/api/address-runner';
import { bootstrapPlayback } from '@/lib/bootstrap';
import { startPlaceReconcile } from '@/playback/place-reconcile';
import { selectIsTransportLive, usePlayer } from '@/playback/store';

import { isCarConnected } from './car-connection';
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
 * Two app-lifetime controllers the root layout starts in an activity are started here too,
 * since nothing else would run them in this runtime: the address pick (a connection paired on
 * its home address must reach its server from the car, through its away address) and the
 * place reconcile (a book the car started from its snapshot place picks up another device's
 * newer place before its first save). Both are shared starts, so an activity opened later on
 * this runtime doesn't run them twice.
 *
 * None of them is stopped here: the JS runtime outlives the task, and a later car event
 * (a play request, a bookmark) must still find its listeners.
 *
 * Resolves (the task is over) once no car is connected and the player has been idle,
 * nothing playing or buffering, for `CAR_TASK_IDLE_MS`, or at once when the car disconnects
 * while it is idle. A connected car keeps it running even with nothing playing: React Native
 * runs JS timers with no activity resumed only while a task runs, and the car sync's snapshot
 * writes are timers (its lists would stay as they were for the rest of the drive). JS timers
 * may not fire with the phone's screen off, so the idle check also runs on every player
 * change; the service ends the task when it no longer needs JS (`JsRuntime.release`).
 */
export async function runCarTask(): Promise<void> {
  await bootstrapPlayback();
  startAppControllers();
  startCarSync();
  await carSyncReady();
  await untilIdle(CAR_TASK_IDLE_MS);
}

let controllersStarted = false;

/** The address pick and the place reconcile, once per runtime (see `runCarTask`). */
function startAppControllers() {
  if (controllersStarted) return;
  controllersStarted = true;
  startAddressRouting();
  startPlaceReconcile();
}

/** Resolves once no car is connected and the player has not been live (playing or loading)
 * for `ms`, or at once when the car leaves while it is not live. */
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
      if (selectIsTransportLive(usePlayer.getState()) || isCarConnected()) {
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
        else check();
      }),
    );
    check();
  });
}
