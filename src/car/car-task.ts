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
 * its place, a bookmark was pressed). It starts the car's stack (`startCarStack`), waits for
 * the car sync's first steps, then resolves (the task is over) once no car is connected and
 * the player has been idle, nothing playing or buffering, for `CAR_TASK_IDLE_MS`, or at once
 * when the car disconnects while it is idle. A connected car keeps it running even with
 * nothing playing: React Native runs JS timers with no activity resumed only while a task
 * runs, and the car sync's snapshot writes are timers (its lists would stay as they were for
 * the rest of the drive). JS timers may not fire with the phone's screen off, so the idle
 * check also runs on every player change; the service ends the task when it no longer needs
 * JS (`JsRuntime.release`).
 */
export async function runCarTask(): Promise<void> {
  await startCarStack();
  await carSyncReady();
  await untilIdle(CAR_TASK_IDLE_MS);
}

let carWork: Promise<void> | null = null;

/**
 * iOS: the car's work without the React tree (`register-car-task.ios.ts` calls it when a car
 * connects). A CarPlay-first launch runs React Native in a parking window that never gets a
 * layout pass, so expo-router's SafeAreaProvider (no initial metrics on native) never hears
 * its insets and renders nothing: the root layout, and every launch step and controller it
 * starts, never runs until the phone app opens. So this starts the car's stack once per
 * runtime, as Android's headless task does. The connect itself reaches the car sync through
 * `isCarConnected()` (the iOS listener records it; a sync starting while a car is connected
 * runs its connect path).
 */
export function startCarWork(): Promise<void> {
  carWork ??= startCarStack();
  return carWork;
}

/**
 * What a car needs with no screen, on both platforms: the launch steps the root layout runs
 * before any screen (`bootstrapPlayback`, among them the listener's language for the
 * snapshot's labels), the address pick (a connection paired on its home address must reach
 * its server from the car, through its away address), the place reconcile (a book the car
 * started from its snapshot place picks up another device's newer place before its first
 * save) and the car sync. All are shared starts, so the root layout's own later starts add
 * nothing; none is stopped, since the JS runtime outlives the car's work and a later car
 * event (a play request, a bookmark) must still find its listeners.
 */
async function startCarStack(): Promise<void> {
  await bootstrapPlayback();
  startAppControllers();
  startCarSync();
}

let controllersStarted = false;

/** The address pick and the place reconcile, once per runtime. */
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
