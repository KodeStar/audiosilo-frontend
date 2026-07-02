// Import the Accelerometer submodule directly rather than the `expo-sensors`
// barrel: the barrel does `import * as Pedometer`, and Pedometer.ts resolves its
// native module at load - which throws "Cannot find native module
// 'ExponentPedometer'" on builds that don't link it, crashing the whole player
// for a sensor we never use.
import Accelerometer from 'expo-sensors/build/Accelerometer';
import type { EventSubscription } from 'expo-modules-core';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { useSleepTimer } from './sleep-timer';

const SHAKE_G = 1.8; // total acceleration (g) that counts as a shake

/** While a sleep timer is active, a shake cancels it (native only). */
export function useShakeToCancel() {
  const active = useSleepTimer((s) => s.active);
  const cancel = useSleepTimer((s) => s.cancel);

  useEffect(() => {
    if (!active || Platform.OS === 'web') return;
    let sub: EventSubscription | undefined;
    // Shake-to-cancel is a nice-to-have: if the accelerometer native module is
    // unavailable in this build, degrade to a no-op rather than crash the player.
    try {
      let last = 0;
      Accelerometer.setUpdateInterval(200);
      sub = Accelerometer.addListener(({ x, y, z }) => {
        const force = Math.sqrt(x * x + y * y + z * z);
        if (force > SHAKE_G) {
          const now = Date.now();
          if (now - last > 1000) {
            last = now;
            cancel();
          }
        }
      });
    } catch {
      // sensor unavailable - shake-to-cancel disabled
    }
    return () => sub?.remove();
  }, [active, cancel]);
}
