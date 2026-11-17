import { setItem } from '@/lib/storage';

import {
  FONT_SCALES,
  loadFontScale,
  loadReaderTheme,
  saveFontScale,
  saveReaderTheme,
  stepFontScale,
} from './reader-settings';
import { readerThemeOf } from './use-reader-appearance';

// The app's theme (the provider pulls in the stylesheet): `readerThemeOf` is given the scheme.
jest.mock('@/theme/theme-provider', () => ({}));

describe('stepFontScale', () => {
  it('steps one size up and down', () => {
    expect(stepFontScale(1, 1)).toBe(1.1);
    expect(stepFontScale(1, -1)).toBe(0.9);
  });

  it('holds at the ends', () => {
    expect(stepFontScale(FONT_SCALES[0], -1)).toBe(FONT_SCALES[0]);
    expect(stepFontScale(FONT_SCALES.at(-1)!, 1)).toBe(FONT_SCALES.at(-1));
  });
});

describe('the saved text size', () => {
  it('is 1 when none is saved, and what was saved after', async () => {
    expect(await loadFontScale()).toBe(1);
    await saveFontScale(1.25);
    expect(await loadFontScale()).toBe(1.25);
  });
});

describe('the saved reader theme (fe#246)', () => {
  it('follows the app when none (or an unknown one) is saved, and is what was saved after', async () => {
    expect(await loadReaderTheme()).toBe('follow');
    await setItem('audiosilo.readerTheme', 'sepia');
    expect(await loadReaderTheme()).toBe('follow');
    await saveReaderTheme('black');
    expect(await loadReaderTheme()).toBe('black');
  });
});

describe('readerThemeOf', () => {
  it("follows the app's scheme, its card under its text", () => {
    expect(readerThemeOf('follow', 'dark', false)).toEqual({
      scheme: 'dark',
      background: '#10172b',
      foreground: '#e7ebf4',
    });
    expect(readerThemeOf('follow', 'light', false).scheme).toBe('light');
  });

  it('takes the scheme chosen over the app', () => {
    expect(readerThemeOf('light', 'dark', false)).toEqual({
      scheme: 'light',
      background: '#ffffff',
      foreground: '#121c36',
    });
    expect(readerThemeOf('dark', 'light', false).scheme).toBe('dark');
  });

  it("is a pure black page under the dark scheme's text for black, high contrast too", () => {
    expect(readerThemeOf('black', 'light', false)).toEqual({
      scheme: 'dark',
      background: '#000000',
      foreground: '#e7ebf4',
    });
    expect(readerThemeOf('black', 'light', true)).toEqual({
      scheme: 'dark',
      background: '#000000',
      foreground: '#f4f6fb',
    });
  });
});
