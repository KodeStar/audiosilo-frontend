import {
  Roboto_300Light,
  Roboto_400Regular,
  Roboto_500Medium,
  Roboto_600SemiBold,
  Roboto_700Bold,
  useFonts,
} from '@expo-google-fonts/roboto';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'nativewind';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { getItem, setItem } from '@/lib/storage';
import { colors } from '@/theme/tokens';

import '@/global.css';

void SplashScreen.preventAutoHideAsync();

export type SchemePref = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'audiosilo.theme';

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
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { colorScheme, setColorScheme } = useColorScheme();
  const [pref, setPrefState] = useState<SchemePref>('dark');
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
    void getItem<SchemePref>(STORAGE_KEY).then((saved) => {
      if (!active) return;
      const next = saved ?? 'dark';
      setPrefState(next);
      setColorScheme(next);
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [setColorScheme]);

  useEffect(() => {
    if (fontsLoaded && hydrated) void SplashScreen.hideAsync();
  }, [fontsLoaded, hydrated]);

  // Keep the web document backdrop in sync with the resolved scheme. The static
  // shell (+html.tsx) paints dark before mount; this corrects it for light theme
  // and ensures the browser back-swipe gesture reveals the themed color, not white.
  const resolved = colorScheme ?? 'dark';
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const bg = resolved === 'dark' ? colors.dark.bg : colors.light.bg;
    document.documentElement.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
  }, [resolved]);

  const setPref = (p: SchemePref) => {
    setPrefState(p);
    setColorScheme(p);
    void setItem(STORAGE_KEY, p);
  };

  if (!fontsLoaded || !hydrated) return null;

  return (
    <ThemeContext.Provider value={{ pref, scheme: colorScheme ?? 'dark', setPref }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
