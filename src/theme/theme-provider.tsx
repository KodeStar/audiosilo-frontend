import {
  Roboto_300Light,
  Roboto_400Regular,
  Roboto_500Medium,
  Roboto_600SemiBold,
  Roboto_700Bold,
  useFonts,
} from '@expo-google-fonts/roboto';
import * as SplashScreen from 'expo-splash-screen';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { Uniwind, useUniwind } from 'uniwind';

import { getItem, setItem } from '@/lib/storage';
import { colors } from '@/theme/tokens';

import '@/global.css';

void SplashScreen.preventAutoHideAsync();

export type SchemePref = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'audiosilo.theme';
const SCHEME_PREFS: readonly SchemePref[] = ['light', 'dark', 'system'];

/** Only a pref this build knows may reach `Uniwind.setTheme`, which throws on any other
 * name - a corrupt or foreign stored value must not keep the app on the splash screen. */
const isSchemePref = (value: unknown): value is SchemePref =>
  SCHEME_PREFS.includes(value as SchemePref);

type ThemeContextValue = {
  /** User preference, including "system". */
  pref: SchemePref;
  /** Resolved scheme actually in effect. */
  scheme: 'light' | 'dark';
  setPref: (p: SchemePref) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Loads Roboto, restores the persisted color-scheme preference (dark-mode-first,
 * matching the old client), and keeps the splash screen up until both are ready.
 *
 * The scheme lives in Uniwind alone: `Uniwind.setTheme` drives every `dark:` class
 * (and, for light/dark, React Native's `Appearance`, so native dialogs match), and
 * `'system'` re-enables Uniwind's adaptive mode, which follows the OS. `useUniwind`
 * reports the RESOLVED theme (light or dark, never 'system') and whether adaptive mode
 * is on, re-rendering on either change; `pref` and `scheme` are derived from those.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme, hasAdaptiveThemes } = useUniwind();
  const [hydrated, setHydrated] = useState(false);

  const [fontsLoaded] = useFonts({
    Roboto_300Light,
    Roboto_400Regular,
    Roboto_500Medium,
    Roboto_600SemiBold,
    Roboto_700Bold,
  });

  useEffect(() => {
    let active = true;
    void getItem<unknown>(STORAGE_KEY)
      .then((saved) => {
        if (active) Uniwind.setTheme(isSchemePref(saved) ? saved : 'dark');
      })
      .catch(() => {
        // Restoring the theme must not wedge first paint (render is gated on
        // `hydrated`); Uniwind then follows the OS until the user picks a theme.
      })
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (fontsLoaded && hydrated) void SplashScreen.hideAsync();
  }, [fontsLoaded, hydrated]);

  // Keep the web document backdrop in sync with the resolved scheme. The static
  // shell (+html.tsx) paints dark before mount; this corrects it for light theme
  // and ensures the browser back-swipe gesture reveals the themed color, not white.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const bg = theme === 'dark' ? colors.dark.bg : colors.light.bg;
    document.documentElement.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
  }, [theme]);

  const setPref = (p: SchemePref) => {
    Uniwind.setTheme(p);
    void setItem(STORAGE_KEY, p);
  };

  if (!fontsLoaded || !hydrated) return null;

  const pref: SchemePref = hasAdaptiveThemes ? 'system' : theme;
  return (
    <ThemeContext.Provider value={{ pref, scheme: theme, setPref }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
