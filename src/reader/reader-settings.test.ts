import { FONT_SCALES, loadFontScale, saveFontScale, stepFontScale } from './reader-settings';

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
