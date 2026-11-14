import { useEffect, useMemo, useState } from 'react';

import { useTheme } from '@/theme/theme-provider';
import { themeColors } from '@/theme/high-contrast';

import type { ReaderTheme } from './protocol';
import { loadFontScale } from './reader-settings';

/**
 * How a reader surface (the full-screen reader, the companion's Text tab) draws the book:
 * the app's card colours for its scheme, and the device's saved text size (null until it
 * is read, so the reader opens at the right size).
 */
export function useReaderAppearance(): {
  theme: ReaderTheme;
  fontScale: number | null;
  setFontScale: (scale: number) => void;
} {
  const { scheme, highContrast } = useTheme();
  const palette = themeColors(scheme, highContrast);
  const theme = useMemo<ReaderTheme>(
    () => ({ scheme, background: palette.card, foreground: palette.foreground }),
    [scheme, palette],
  );
  const [fontScale, setFontScale] = useState<number | null>(null);
  useEffect(() => {
    void loadFontScale().then(setFontScale);
  }, []);
  return { theme, fontScale, setFontScale };
}
