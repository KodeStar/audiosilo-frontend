import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold';
import { BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque/700Bold';
import { BricolageGrotesque_800ExtraBold } from '@expo-google-fonts/bricolage-grotesque/800ExtraBold';
import { Figtree_400Regular } from '@expo-google-fonts/figtree/400Regular';
import { Figtree_500Medium } from '@expo-google-fonts/figtree/500Medium';
import { Figtree_600SemiBold } from '@expo-google-fonts/figtree/600SemiBold';
import { Figtree_700Bold } from '@expo-google-fonts/figtree/700Bold';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { Uniwind, useUniwind } from 'uniwind';

import { getItem, setItem } from '@/lib/storage';
import { hasExistingInstall } from '@/stores/session';
import { initialSchemePref, type SchemePref } from '@/theme/scheme-pref';
import { colors } from '@/theme/tokens';

import '@/global.css';

void SplashScreen.preventAutoHideAsync();

export type { SchemePref };
const STORAGE_KEY = 'audiosilo.theme';

/**
 * The Stacks fonts, one family per weight (React Native has no font fallback or
 * synthetic weights). The keys are the family names the `font-*` tokens in
 * src/global.css name; only the weights a token uses are imported, so only those are
 * bundled.
 */
const FONTS = {
  Figtree_400Regular,
  Figtree_500Medium,
  Figtree_600SemiBold,
  Figtree_700Bold,
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
  BricolageGrotesque_800ExtraBold,
  JetBrainsMono_500Medium,
};

type ThemeContextValue = {
  /** User preference, including "system". */
  pref: SchemePref;
  /** Resolved scheme actually in effect. */
  scheme: 'light' | 'dark';
  setPref: (p: SchemePref) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Loads the Stacks fonts, restores the persisted color-scheme preference (a new install
 * follows the OS, an existing one that never chose stays dark: `initialSchemePref`), and
 * keeps the splash screen up until both are ready. A font that fails to load does not
 * hold the splash: the text falls back to the system font.
 *
 * The scheme lives in Uniwind alone: `Uniwind.setTheme` drives every themed colour token
 * and `dark:` class (and, for light/dark, React Native's `Appearance`, so native
 * dialogs match), and `'system'` re-enables Uniwind's adaptive mode, which follows the
 * OS. `useUniwind` reports the RESOLVED theme (light or dark, never 'system') and
 * whether adaptive mode is on, re-rendering on either change; `pref` and `scheme` are
 * derived from those.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme, hasAdaptiveThemes } = useUniwind();
  const [hydrated, setHydrated] = useState(false);
  const [fontsLoaded, fontError] = useFonts(FONTS);
  const fontsReady = fontsLoaded || !!fontError;

  useEffect(() => {
    let active = true;
    // Both reads are issued synchronously here, and this effect runs before the root
    // layout's (a child's effects run first), so the install signal is read before
    // resetStaleStorage can change the session keys.
    void Promise.all([getItem<unknown>(STORAGE_KEY), hasExistingInstall()])
      .then(([saved, existing]) => {
        if (!active) return;
        const { pref, persist } = initialSchemePref(saved, existing);
        Uniwind.setTheme(pref);
        if (persist) void setItem(STORAGE_KEY, pref);
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
    if (fontsReady && hydrated) void SplashScreen.hideAsync();
  }, [fontsReady, hydrated]);

  // Keep the web document backdrop in sync with the resolved scheme. The static
  // shell (+html.tsx) paints the OS scheme's background before mount; this corrects it
  // for an explicit pick and ensures the browser back-swipe gesture reveals the themed
  // colour, not white.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const bg = theme === 'dark' ? colors.dark.background : colors.light.background;
    document.documentElement.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
  }, [theme]);

  const setPref = (p: SchemePref) => {
    Uniwind.setTheme(p);
    void setItem(STORAGE_KEY, p);
  };

  if (!fontsReady || !hydrated) return null;

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
