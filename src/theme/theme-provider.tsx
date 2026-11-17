import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold';
import { BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque/700Bold';
import { Figtree_400Regular } from '@expo-google-fonts/figtree/400Regular';
import { Figtree_500Medium } from '@expo-google-fonts/figtree/500Medium';
import { Figtree_600SemiBold } from '@expo-google-fonts/figtree/600SemiBold';
import { Figtree_700Bold } from '@expo-google-fonts/figtree/700Bold';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { Uniwind, useUniwind } from 'uniwind';

import { getItem, setItem } from '@/lib/storage';
import { migrateStorage } from '@/lib/storage-migration';
import {
  applyHighContrast,
  HIGH_CONTRAST_STORAGE_KEY,
  highContrastActive,
  restoredHighContrast,
  themeColors,
} from '@/theme/high-contrast';
import { readOsHighContrast, watchOsHighContrast } from '@/theme/os-contrast';
import { restoredSchemePref, type SchemePref, THEME_STORAGE_KEY } from '@/theme/scheme-pref';
import { ThemeColorsProvider } from '@/theme/use-theme-colors';

import '@/global.css';

void SplashScreen.preventAutoHideAsync();

export type { SchemePref };

/**
 * The Stacks fonts, one family per weight (React Native has no font fallback or
 * synthetic weights). The keys are the family names the `font-*` tokens in
 * src/global.css name; only the weights a token uses are imported, so only those are
 * bundled. These gate first paint (the splash stays up until they load). Web: the static
 * HTML carries their `@font-face` rules (`StaticFonts`), which expo-font counts as loaded,
 * so there they gate nothing and the browser shows the text as the preloaded files land.
 */
export const FONTS = {
  Figtree_400Regular,
  Figtree_500Medium,
  Figtree_600SemiBold,
  Figtree_700Bold,
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
};

/** Loaded alongside, WITHOUT holding first paint: mono is a minor role (paths, codes),
 * and until it arrives the text shows in the system font (web: the `ui-monospace` stack). */
const DEFERRED_FONTS = { JetBrainsMono_500Medium };

type ThemeContextValue = {
  /** User preference, including "system". */
  pref: SchemePref;
  /** Resolved scheme actually in effect. */
  scheme: 'light' | 'dark';
  setPref: (p: SchemePref) => void;
  /** Flip to the other explicit scheme (light <-> dark) from the resolved one. */
  toggleScheme: () => void;
  /** The high-contrast colours are in effect (the OS asks, or the switch is on). */
  highContrast: boolean;
  /** The OS asks for more contrast (iOS Increase Contrast, Android high contrast text,
   * web `prefers-contrast: more`). */
  osHighContrast: boolean;
  /** Settings > Appearance > High contrast: on forces it; off follows the OS. */
  highContrastPref: boolean;
  setHighContrastPref: (on: boolean) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Loads the Stacks fonts, restores the persisted color-scheme preference, and keeps the
 * splash screen up until both are ready. A font that fails to load does not hold the
 * splash: the text falls back to the system font. The preference is read only after the
 * launch storage migration (`migrateStorage`), which writes the default when none is
 * stored (a new install follows the OS, an existing one that never chose stays dark).
 *
 * The scheme lives in Uniwind alone: `Uniwind.setTheme` drives every themed colour token
 * and `dark:` class (and, for light/dark, React Native's `Appearance`, so native
 * dialogs match), and `'system'` re-enables Uniwind's adaptive mode, which follows the
 * OS. `useUniwind` reports the RESOLVED theme (light or dark, never 'system') and
 * whether adaptive mode is on, re-rendering on either change; `pref` and `scheme` are
 * derived from those.
 *
 * High contrast lays the tokens.json `highContrast` sets over both schemes' theme
 * variables (`applyHighContrast`) while the OS asks for more contrast or the persisted
 * switch is on; it is restored with the theme, before first paint, and the OS setting
 * is watched for changes. Light / Dark / System work the same either way.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme, hasAdaptiveThemes } = useUniwind();
  const [hydrated, setHydrated] = useState(false);
  const [highContrastPref, setHighContrastPrefState] = useState(false);
  const [osHighContrast, setOsHighContrast] = useState(false);
  const highContrast = highContrastActive(osHighContrast, highContrastPref);
  // The OS setting as the watcher last reported it (null: not since launch). A change in
  // the moments before the launch read lands is newer than that read, so it wins (fe#305).
  const watchedOs = useRef<boolean | null>(null);
  const [fontsLoaded, fontError] = useFonts(FONTS);
  const fontsReady = fontsLoaded || !!fontError;
  useFonts(DEFERRED_FONTS);

  useEffect(() => {
    let active = true;
    void migrateStorage()
      // A failed migration must not stop the theme read (the root layout reports it).
      .catch(() => undefined)
      .then(() =>
        Promise.all([
          // A failed read must not wedge first paint (render is gated on `hydrated`);
          // Uniwind then follows the OS until the user picks a theme.
          getItem<unknown>(THEME_STORAGE_KEY).then(restoredSchemePref, () => null),
          getItem<unknown>(HIGH_CONTRAST_STORAGE_KEY).then(restoredHighContrast, () => false),
          readOsHighContrast(),
        ]),
      )
      .then(([scheme, pref, os]) => {
        if (!active) return;
        // The theme first: a failure applying high contrast (caught below) must not cost
        // the stored theme.
        if (scheme) Uniwind.setTheme(scheme);
        // Before first paint, so a high-contrast launch never shows the normal colours;
        // and before the states, so a failed write leaves plain normal contrast (with the
        // states set, the effect below would repeat the write outside the catch).
        const osNow = watchedOs.current ?? os;
        applyHighContrast(highContrastActive(osNow, pref));
        setHighContrastPrefState(pref);
        setOsHighContrast(osNow);
      })
      .catch(() => undefined)
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

  useEffect(
    () =>
      watchOsHighContrast((on) => {
        watchedOs.current = on;
        setOsHighContrast(on);
      }),
    [],
  );

  useEffect(() => {
    if (hydrated) applyHighContrast(highContrast);
  }, [hydrated, highContrast]);

  // Keep the web document backdrop in sync with the resolved scheme. The static
  // shell (+html.tsx) paints the OS scheme's background before mount; this corrects it
  // for an explicit pick and ensures the browser back-swipe gesture reveals the themed
  // colour, not white.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const bg = themeColors(theme, highContrast).background;
    document.documentElement.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
  }, [theme, highContrast]);

  const setPref = (p: SchemePref) => {
    Uniwind.setTheme(p);
    void setItem(THEME_STORAGE_KEY, p);
  };
  const toggleScheme = () => setPref(theme === 'dark' ? 'light' : 'dark');
  const setHighContrastPref = (on: boolean) => {
    setHighContrastPrefState(on);
    void setItem(HIGH_CONTRAST_STORAGE_KEY, on);
  };

  if (!fontsReady || !hydrated) return null;

  const pref: SchemePref = hasAdaptiveThemes ? 'system' : theme;
  return (
    <ThemeContext.Provider
      value={{
        pref,
        scheme: theme,
        setPref,
        toggleScheme,
        highContrast,
        osHighContrast,
        highContrastPref,
        setHighContrastPref,
      }}
    >
      <ThemeColorsProvider highContrast={highContrast}>{children}</ThemeColorsProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
