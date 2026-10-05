import { useUniwind } from 'uniwind';

import { colors, type ThemeColors } from '@/theme/tokens';

/**
 * The current theme's semantic colours (`colors.light` / `colors.dark` from the
 * generated tokens) for native props that take a colour string rather than a className:
 * Icon/svg fills, ActivityIndicator, TextInput placeholders, StatusBar, the navigation
 * theme. Follows the resolved Uniwind theme, so it re-renders when the theme changes.
 * Prefer a className (`text-brand`, `bg-card`) wherever the component takes one.
 */
export function useThemeColors(): ThemeColors {
  const { theme } = useUniwind();
  return theme === 'dark' ? colors.dark : colors.light;
}
