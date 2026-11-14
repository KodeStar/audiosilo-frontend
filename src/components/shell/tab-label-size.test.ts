import { TAB_LABEL_BASE_SP, TAB_LABEL_MAX_SCALE, tabLabelFontSize } from './tab-label-size';

/** What Android draws: the sp value times the font scale. */
const drawn = (scale: number) => tabLabelFontSize(scale) * scale;

describe('tabLabelFontSize', () => {
  it('follows the text size up to the cap', () => {
    expect(drawn(1)).toBeCloseTo(TAB_LABEL_BASE_SP, 2);
    expect(drawn(1.15)).toBeCloseTo(TAB_LABEL_BASE_SP * 1.15, 2);
    expect(drawn(TAB_LABEL_MAX_SCALE)).toBeCloseTo(TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE, 2);
  });

  it('stops growing past the cap (Android 2.0 draws what 1.3 does)', () => {
    expect(drawn(2)).toBeCloseTo(TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE, 2);
    expect(drawn(3.12)).toBeCloseTo(TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE, 2);
  });

  it('is a different value at every scale, so a live change is applied', () => {
    const values = [0.85, 1, 1.15, 1.3, 1.5, 2].map(tabLabelFontSize);
    expect(new Set(values).size).toBe(values.length);
  });
});
