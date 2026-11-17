import { useEffect, useMemo, useState } from 'react';

import { useTheme } from '@/theme/theme-provider';
import { themeColors } from '@/theme/high-contrast';
import { colors } from '@/theme/tokens';

import type { ReaderTheme } from './protocol';
import {
  loadFontScale,
  loadReaderTheme,
  type ReaderThemeChoice,
  saveReaderTheme,
} from './reader-settings';

/**
 * The colours a reader surface draws the book in, for the device's reader theme: the app's
 * card colours for the app's scheme (`follow`) or the scheme chosen, and for `black` a pure
 * black page under the dark scheme's text (its read-along highlight the dark one).
 */
export function readerThemeOf(
  choice: ReaderThemeChoice,
  appScheme: 'light' | 'dark',
  highContrast: boolean,
): ReaderTheme {
  const scheme = choice === 'follow' ? appScheme : choice === 'light' ? 'light' : 'dark';
  const palette = themeColors(scheme, highContrast);
  return {
    scheme,
    // Black: a pure black page, so an OLED screen lights only the text.
    background: choice === 'black' ? colors.black : palette.card,
    foreground: palette.foreground,
  };
}

/** The reader surfaces mounted now: a theme chosen on one (the reader's menu) shows on the
 * other too (the companion's Text tab, mounted under the reader on a tablet or desktop),
 * which would otherwise keep the colours it read when it mounted. */
const themeWatchers = new Set<(choice: ReaderThemeChoice) => void>();

/**
 * How a reader surface (the full-screen reader, the companion's Text tab) draws the book:
 * the device's reader theme (`readerThemeOf`) and its saved text size (null until both are
 * read, so the reader opens at the right size and colours).
 */
export function useReaderAppearance(): {
  theme: ReaderTheme;
  themeChoice: ReaderThemeChoice;
  /** Shows and saves another reader theme. */
  chooseTheme: (choice: ReaderThemeChoice) => void;
  fontScale: number | null;
  setFontScale: (scale: number) => void;
} {
  const { scheme, highContrast } = useTheme();
  const [themeChoice, setThemeChoice] = useState<ReaderThemeChoice>('follow');
  const theme = useMemo(
    () => readerThemeOf(themeChoice, scheme, highContrast),
    [themeChoice, scheme, highContrast],
  );
  const [fontScale, setFontScale] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([loadReaderTheme(), loadFontScale()]).then(([choice, scale]) => {
      if (!live) return;
      setThemeChoice(choice);
      setFontScale(scale);
    });
    themeWatchers.add(setThemeChoice);
    return () => {
      live = false;
      themeWatchers.delete(setThemeChoice);
    };
  }, []);
  const chooseTheme = (choice: ReaderThemeChoice) => {
    setThemeChoice(choice);
    for (const show of themeWatchers) show(choice);
    void saveReaderTheme(choice);
  };
  return { theme, themeChoice, chooseTheme, fontScale, setFontScale };
}
