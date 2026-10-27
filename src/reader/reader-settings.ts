import { getItem, setItem } from '@/lib/storage';

/** The reader's text size on this device (a per-device preference, not synced). */
const FONT_SCALE_KEY = 'audiosilo.readerFontScale';

/** The text sizes A- and A+ step through: 1 is the book's own size. */
export const FONT_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8] as const;

/** The size one step smaller (`-1`) or larger (`1`) than `scale` (one of `FONT_SCALES`,
 * as `loadFontScale` returns), held at the ends. */
export function stepFontScale(scale: number, direction: -1 | 1): number {
  const i = (FONT_SCALES as readonly number[]).indexOf(scale) + direction;
  return FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, i))];
}

/** The saved text size, 1 when none (or an unreadable one) is saved. */
export async function loadFontScale(): Promise<number> {
  const saved = await getItem<unknown>(FONT_SCALE_KEY);
  return typeof saved === 'number' && (FONT_SCALES as readonly number[]).includes(saved)
    ? saved
    : 1;
}

export async function saveFontScale(scale: number): Promise<void> {
  await setItem(FONT_SCALE_KEY, scale);
}
