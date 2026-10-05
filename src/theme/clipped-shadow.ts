import { Platform, type ViewStyle } from 'react-native';
import { useUniwind } from 'uniwind';

/**
 * The legacy iOS shadow NativeWind gave `shadow-xs` / `shadow-lg` (its compiled
 * output, see the native-shadow notes in src/global.css).
 */
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

/**
 * iOS `style` for a shadowed, `overflow-hidden` cover frame (pair it with the
 * `ios-clipped-shadow` class, which turns the CSS box-shadow off on iOS).
 *
 * Uniwind draws `shadow-*` as a box-shadow, which iOS paints OUTSIDE a clipping view.
 * NativeWind used the legacy shadow props instead, which `overflow-hidden` clips to
 * the view's bounds - leaving only the sliver of shadow that shows through the
 * frame's translucent hairline border. That is what these frames have always looked
 * like on iOS, and the legacy props are the only way to reproduce it (Uniwind cannot
 * emit `shadowOffset`), so this returns them as an inline style. Android and web get
 * `undefined` and keep the class-driven shadow. `lightOnly` mirrors a
 * `dark:shadow-none` on the same element.
 */
export function useClippedShadow(
  size: 'xs' | 'lg',
  { lightOnly = false }: { lightOnly?: boolean } = {},
): ViewStyle | undefined {
  const { theme } = useUniwind();
  if (Platform.OS !== 'ios') return undefined;
  if (lightOnly && theme === 'dark') return undefined;
  return LEGACY[size];
}
