import { createContext, useContext, type ReactNode } from 'react';
import { ScopedTheme, Uniwind, useUniwind } from 'uniwind';

import { colors, type ThemeColors } from '@/theme/tokens';

const ThemeColorsContext = createContext<ThemeColors | null>(null);

const forTheme = (theme: string): ThemeColors => (theme === 'dark' ? colors.dark : colors.light);

/**
 * Holds the ONE `useUniwind` subscription the themed colours need, and hands the resolved
 * theme's colours down by context: `useThemeColors` sits in every Icon of every row, so a
 * store subscription per consumer would be hundreds of listeners for one value.
 * ThemeProvider renders it around the app.
 */
export function ThemeColorsProvider({ children }: { children: ReactNode }) {
  const { theme } = useUniwind();
  return (
    <ThemeColorsContext.Provider value={forTheme(theme)}>{children}</ThemeColorsContext.Provider>
  );
}

/**
 * Uniwind's `ScopedTheme` (a subtree in a fixed theme: Home's dark Previously on card)
 * that also hands that theme's colours to `useThemeColors` below it, so colour props
 * follow the scope as classes do: a light-mode spinner on a dark-scope primary button
 * was near-white on near-white.
 */
export function ScopedThemeColors({
  theme,
  children,
}: {
  theme: 'light' | 'dark';
  children: ReactNode;
}) {
  return (
    <ScopedTheme theme={theme}>
      <ThemeColorsContext.Provider value={forTheme(theme)}>{children}</ThemeColorsContext.Provider>
    </ScopedTheme>
  );
}

/**
 * The current theme's semantic colours (`colors.light` / `colors.dark` from the
 * generated tokens) for native props that take a colour string rather than a className:
 * Icon/svg fills, ActivityIndicator, TextInput placeholders, StatusBar, the navigation
 * theme. Follows the resolved Uniwind theme (from `ThemeColorsProvider`), so it
 * re-renders when the theme changes. Outside the provider (an isolated test render) it
 * reads the current theme once. Prefer a className (`text-brand`, `bg-card`) wherever
 * the component takes one.
 */
export function useThemeColors(): ThemeColors {
  return useContext(ThemeColorsContext) ?? forTheme(Uniwind.currentTheme);
}
