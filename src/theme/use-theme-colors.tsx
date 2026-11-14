import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { ScopedTheme, Uniwind, useUniwind } from 'uniwind';

import { themeColors } from '@/theme/high-contrast';
import type { ThemeColors } from '@/theme/tokens';

type Resolved = { scheme: 'light' | 'dark'; highContrast: boolean };

const ThemeColorsContext = createContext<Resolved | null>(null);

const schemeOf = (theme: string): 'light' | 'dark' => (theme === 'dark' ? 'dark' : 'light');

/**
 * Holds the ONE `useUniwind` subscription the themed colours need, and hands the resolved
 * theme (and whether high contrast is on) down by context: `useThemeColors` sits in every
 * Icon of every row, so a store subscription per consumer would be hundreds of listeners
 * for one value. ThemeProvider renders it around the app.
 */
export function ThemeColorsProvider({
  highContrast = false,
  children,
}: {
  highContrast?: boolean;
  children: ReactNode;
}) {
  const scheme = schemeOf(useUniwind().theme);
  // A stable value: every Icon reads this context.
  const value = useMemo(() => ({ scheme, highContrast }), [scheme, highContrast]);
  return <ThemeColorsContext.Provider value={value}>{children}</ThemeColorsContext.Provider>;
}

/**
 * Uniwind's `ScopedTheme` (a subtree in a fixed theme: Home's dark Previously on card)
 * that also hands that theme's colours to `useThemeColors` below it, so colour props
 * follow the scope as classes do: a light-mode spinner on a dark-scope primary button
 * was near-white on near-white. High contrast carries into the scope.
 */
export function ScopedThemeColors({
  theme,
  children,
}: {
  theme: 'light' | 'dark';
  children: ReactNode;
}) {
  const { highContrast } = useThemeScheme();
  const value = useMemo(() => ({ scheme: theme, highContrast }), [theme, highContrast]);
  return (
    <ScopedTheme theme={theme}>
      <ThemeColorsContext.Provider value={value}>{children}</ThemeColorsContext.Provider>
    </ScopedTheme>
  );
}

/** The resolved scheme (and high contrast) here: the app's, or a `ScopedThemeColors`'.
 * Outside the provider (an isolated test render) it reads the current theme once. */
export function useThemeScheme(): Resolved {
  return (
    useContext(ThemeColorsContext) ?? {
      scheme: schemeOf(Uniwind.currentTheme),
      highContrast: false,
    }
  );
}

/**
 * The current theme's semantic colours (`colors.light` / `colors.dark` from the
 * generated tokens, or their high-contrast sets) for native props that take a colour
 * string rather than a className: Icon/svg fills, ActivityIndicator, TextInput
 * placeholders, StatusBar, the navigation theme. Follows the resolved Uniwind theme
 * (from `ThemeColorsProvider`), so it re-renders when the theme changes. Prefer a
 * className (`text-brand`, `bg-card`) wherever the component takes one.
 */
export function useThemeColors(): ThemeColors {
  const { scheme, highContrast } = useThemeScheme();
  return themeColors(scheme, highContrast);
}
