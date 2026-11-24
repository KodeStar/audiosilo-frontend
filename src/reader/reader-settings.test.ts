import { setItem } from '@/lib/storage';

import {
  FONT_SCALES,
  loadAutoHide,
  loadFontScale,
  loadReaderTheme,
  saveAutoHide,
  saveFontScale,
  saveReaderTheme,
  stepFontScale,
} from './reader-settings';

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

describe('the saved top bar auto-hide (fe#246)', () => {
  it('is on when none (or an unreadable one) is saved, and what was saved after', async () => {
    expect(await loadAutoHide()).toBe(true);
    await setItem('audiosilo.readerAutoHide', 'no');
    expect(await loadAutoHide()).toBe(true);
    await saveAutoHide(false);
    expect(await loadAutoHide()).toBe(false);
    await saveAutoHide(true);
    expect(await loadAutoHide()).toBe(true);
  });
});
