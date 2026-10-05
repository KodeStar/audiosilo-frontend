import type { ViewStyle } from 'react-native';

/** iOS only (`clipped-shadow.ios.ts`; see the native-shadow notes in src/global.css). */
export function useClippedShadow(_size: 'xs' | 'lg', _lightOnly: boolean): ViewStyle | undefined {
  return undefined;
}
