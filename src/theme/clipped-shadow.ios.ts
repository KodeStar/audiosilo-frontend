import type { ViewStyle } from 'react-native';

import { useTheme } from '@/theme/theme-provider';

// NativeWind's legacy iOS shadows: see the native-shadow notes in src/global.css.
const LEGACY: Record<'xs' | 'lg', ViewStyle> = {
  xs: {
    shadowColor: '#00000059',
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 1,
    shadowOpacity: 1,
  },
  lg: {
    shadowColor: '#00000059',
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    shadowOpacity: 1,
  },
};

/** `lightOnly` mirrors a `dark:shadow-none` on the frame. */
export function useClippedShadow(size: 'xs' | 'lg', lightOnly: boolean): ViewStyle | undefined {
  const { scheme } = useTheme();
  return lightOnly && scheme === 'dark' ? undefined : LEGACY[size];
}
