// Import the Accelerometer submodule directly rather than the `expo-sensors`
// barrel: the barrel does `import * as Pedometer`, and Pedometer.ts resolves its
// native module at load - which throws "Cannot find native module
// 'ExponentPedometer'" on builds that don't link it, crashing the whole player
// for a sensor we never use.
import Accelerometer from 'expo-sensors/build/Accelerometer';
import type { EventSubscription } from 'expo-modules-core';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { selectSleepExtendable, useSleepTimer } from './sleep-timer';

/**
 * Shake detection tuning. A single sample over a threshold is unreliable - it fires
 * on a pocket bump and misses a genuine shake that lands between samples (the same
 * complaint filed against Audiobookshelf:
 * https://github.com/advplyr/audiobookshelf-app/issues/859). So we sample fast and
 * require a short BURST: two samples over the threshold inside a sliding window.
 *
 * The bar is deliberately low (1.4g, two samples): the only consequence of a false
 * positive is that the listener gets more listening time, while a false negative
 * means the book stops on someone who was still awake. Bias towards sensitivity.
 */
const SAMPLE_MS = 100;
/** Total acceleration (g) a sample must exceed to count towards a shake. */
const SHAKE_G = 1.4;
/** Two qualifying samples this close together read as one deliberate shake. */
const WINDOW_MS = 1000;
/** Ignore further shakes for this long after one registers, so a two-second wobble
 * doesn't re-arm the timer several times over. */
const DEBOUNCE_MS = 2000;

/**
 * While the sleep timer is extendable - during the fade-out, or the short grace
 * period after it has already paused playback - a shake keeps the listener going:
 * it restores the volume and re-arms the timer at its original setting (and resumes
 * playback if it had stopped).
 *
 * The listener runs ONLY in those two windows, never for the whole timer. That keeps
 * the accelerometer off for the other 29 minutes of a 30-minute timer, and it means
 * a shake outside the windows can't do anything unexpected.
 *
 * Native only - the web has no accelerometer, so the sheet's explicit "keep
 * listening" button is the equivalent there (and is offered on native too).
 */
export function useShakeToExtend() {
  const extendable = useSleepTimer(selectSleepExtendable);
  const keepListening = useSleepTimer((s) => s.keepListening);

  useEffect(() => {
    if (!extendable || Platform.OS === 'web') return;
    let sub: EventSubscription | undefined;
    // Shake-to-extend is a nice-to-have: if the accelerometer native module is
    // unavailable in this build, degrade to a no-op rather than crash the player.
    try {
      let firstHit = 0; // when the current burst's first qualifying sample landed
      let lastShake = 0; // when we last counted a shake (debounce)
      Accelerometer.setUpdateInterval(SAMPLE_MS);
      sub = Accelerometer.addListener(({ x, y, z }) => {
        const force = Math.sqrt(x * x + y * y + z * z);
        if (force <= SHAKE_G) return;
        const now = Date.now();
        if (now - lastShake < DEBOUNCE_MS) return;
        if (firstHit && now - firstHit <= WINDOW_MS) {
          firstHit = 0;
          lastShake = now;
          keepListening();
        } else {
          firstHit = now; // start (or restart) the burst window
        }
      });
    } catch {
      // sensor unavailable - shake-to-extend disabled
    }
    return () => sub?.remove();
  }, [extendable, keepListening]);
}
