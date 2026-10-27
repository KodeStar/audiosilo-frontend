import * as Network from 'expo-network';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/**
 * Whether the device itself has a network (CONNECT-15): the browser's `navigator.onLine`
 * on the web, the system's network state in the app. With a network, a server that doesn't
 * answer is that server's trouble, and the chrome names it ("Hearthside isn't answering");
 * without one, the device is offline. Unknown counts as online (an iOS reachability not
 * yet known, a probe that failed, a test), so the server is named rather than the device
 * blamed.
 */
export function useDeviceOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (
        typeof window === 'undefined' ||
        typeof navigator === 'undefined' ||
        typeof window.addEventListener !== 'function'
      )
        return;
      const update = () => setOnline(navigator.onLine !== false);
      update();
      window.addEventListener('online', update);
      window.addEventListener('offline', update);
      return () => {
        window.removeEventListener('online', update);
        window.removeEventListener('offline', update);
      };
    }
    let live = true;
    const apply = (s: Network.NetworkState | undefined) => {
      if (live && s) setOnline(s.isConnected !== false && s.isInternetReachable !== false);
    };
    let sub: { remove: () => void } | undefined;
    try {
      Promise.resolve(Network.getNetworkStateAsync()).then(apply, () => undefined);
      sub = Network.addNetworkStateListener(apply);
    } catch {
      // No network module (a test, a platform without one): stay "online".
    }
    return () => {
      live = false;
      if (typeof sub?.remove === 'function') sub.remove();
    };
  }, []);
  return online;
}
