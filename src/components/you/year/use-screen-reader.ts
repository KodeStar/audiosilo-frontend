import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Whether VoiceOver or TalkBack is on (iOS and Android), so the story stops moving by
 * itself for someone who listens to each card. Always false on the web, where
 * react-native-web can't tell and answers true for everyone; there the story holds while
 * the keyboard focus is in it instead.
 */
export function useScreenReaderEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let alive = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((v) => {
        if (alive) setOn(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  return on;
}
