// Import the Accelerometer submodule directly rather than the `expo-sensors`
// barrel: the barrel does `import * as Pedometer`, and Pedometer.ts resolves its
// native module at load - which throws "Cannot find native module
// 'ExponentPedometer'" on builds that don't link it, crashing the whole player
// for a sensor we never use.
import Accelerometer from 'expo-sensors/build/Accelerometer';
import type { EventSubscription } from 'expo-modules-core';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { useSettings, type ShakeSensitivity } from '@/stores/settings';

import { selectSleepExtendable, useSleepTimer } from './sleep-timer';

/**
 * Shake detection tuning. A single sample over a threshold is unreliable - it fires
 * on a pocket bump and misses a genuine shake that lands between samples (the same
 * complaint filed against Audiobookshelf:
 * https://github.com/advplyr/audiobookshelf-app/issues/859). So we sample fast and
 * require a short BURST: a few samples over the threshold inside a sliding window.
 *
 * The default bar is deliberately low (1.4g, two samples): the only consequence of a
 * false positive is that the listener gets more listening time, while a false negative
 * means the book stops on someone who was still awake. Bias towards sensitivity.
 */
const SAMPLE_MS = 100;
/** The qualifying samples of one shake must land this close together. */
const WINDOW_MS = 1000;
/** Ignore further shakes for this long after one registers, so a two-second wobble
 * doesn't re-arm the timer several times over. */
const DEBOUNCE_MS = 2000;

/** What one shake has to be: `hits` samples above `thresholdG` (total acceleration, in
 * g) inside `WINDOW_MS`. */
export type ShakeTuning = { thresholdG: number; hits: number };

/**
 * The detector tuning for each sensitivity setting.
 *
 * - `medium` is the tuning the detector shipped with (1.4g, a two-sample burst), so
 *   nobody's shake changes until they choose.
 * - `high` lowers the bar for a listener whose sleepy flick of the wrist was not
 *   counting. A false positive costs only more listening, so this can go low.
 * - `low` is for a listener whose phone shares a bed with a restless partner: a
 *   harder shake held for three samples, which a jolt of the mattress does not make.
 */
export function shakeTuning(sensitivity: ShakeSensitivity): ShakeTuning {
  switch (sensitivity) {
    case 'high':
      return { thresholdG: 1.25, hits: 2 };
    case 'low':
      return { thresholdG: 1.8, hits: 3 };
    case 'medium':
    default:
      return { thresholdG: 1.4, hits: 2 };
  }
}

/**
 * The burst detector, apart from the sensor so it can be tested with plain numbers:
 * feed it each accelerometer sample with its time, and it calls `onShake` once per
 * shake. A burst starts at its first qualifying sample and has `WINDOW_MS` to collect
 * `hits`; a qualifying sample after the window starts a new burst.
 */
export function createShakeDetector(tuning: ShakeTuning, onShake: () => void) {
  let burstStart = 0; // when the current burst's first qualifying sample landed (0: none)
  let count = 0; // qualifying samples in the current burst
  let lastShake = -Infinity; // when we last counted a shake (debounce)
  return (sample: { x: number; y: number; z: number }, now: number) => {
    const { x, y, z } = sample;
    if (Math.sqrt(x * x + y * y + z * z) <= tuning.thresholdG) return;
    if (now - lastShake < DEBOUNCE_MS) return;
    if (count > 0 && now - burstStart <= WINDOW_MS) count += 1;
    else {
      burstStart = now; // start (or restart) the burst window
      count = 1;
    }
    if (count >= tuning.hits) {
      count = 0;
      lastShake = now;
      onShake();
    }
  };
}

/** Whether this device can feel a shake at all: native only, the web has no
 * accelerometer (there the "Keep listening" button is the way). Read at call time. The
 * one rule for the detector, the grace card, the sleep sheet and Settings. */
export function shakeAvailable(): boolean {
  return Platform.OS !== 'web';
}

/**
 * While the sleep timer is extendable - during the fade-out, or the short grace
 * period after it has already paused playback - a shake keeps the listener going:
 * it restores the volume and re-arms the timer at its original setting (and resumes
 * playback if it had stopped).
 *
 * The listener runs ONLY in those two windows, never for the whole timer, and only while
 * the listener has `shakeToExtend` on. That keeps the accelerometer off for the other 29
 * minutes of a 30-minute timer, and it means a shake outside the windows can't do
 * anything unexpected.
 *
 * Native only - the web has no accelerometer, so the grace card's and the sheet's
 * "Keep listening" button is the equivalent there (and is offered on native too).
 */
export function useShakeToExtend() {
  const extendable = useSleepTimer(selectSleepExtendable);
  const keepListening = useSleepTimer((s) => s.keepListening);
  const enabled = useSettings((s) => s.shakeToExtend);
  const sensitivity = useSettings((s) => s.shakeSensitivity);

  useEffect(() => {
    if (!extendable || !enabled || !shakeAvailable()) return;
    let sub: EventSubscription | undefined;
    // Shake-to-extend is a nice-to-have: if the accelerometer native module is
    // unavailable in this build, degrade to a no-op rather than crash the player.
    try {
      const detect = createShakeDetector(shakeTuning(sensitivity), keepListening);
      Accelerometer.setUpdateInterval(SAMPLE_MS);
      sub = Accelerometer.addListener((sample) => detect(sample, Date.now()));
    } catch {
      // sensor unavailable - shake-to-extend disabled
    }
    return () => sub?.remove();
  }, [extendable, enabled, sensitivity, keepListening]);
}
