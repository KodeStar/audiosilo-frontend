import { Accelerometer } from 'expo-sensors';
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
    let last = 0;
    Accelerometer.setUpdateInterval(200);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const force = Math.sqrt(x * x + y * y + z * z);
      if (force > SHAKE_G) {
        const now = Date.now();
        if (now - last > 1000) {
          last = now;
          cancel();
        }
      }
    });
    return () => sub.remove();
  }, [active, cancel]);
}
