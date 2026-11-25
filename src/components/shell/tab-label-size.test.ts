import {
  TAB_LABEL_BASE_SP,
  TAB_LABEL_MAX_SCALE,
  tabLabelDrawnDp,
  tabLabelFontSize,
} from './tab-label-size';

// A Pixel's slot (a fifth of the window) at the default and the largest display size.
const DEFAULT_SLOT = 411 / 5;
const MAX_SLOT = 320 / 5;
// The audit's 165 px Downloads label at density 2.625 and the default 12 sp.
const DOWNLOADS_WIDTH = 165 / 2.625;

/** What Android draws: the sp value times the font scale. */
const drawn = (scale: number, slot = DEFAULT_SLOT, width = 40) =>
  tabLabelFontSize(scale, slot, width) * scale;

describe('tab label size', () => {
  it('follows the text size up to the cap where the names fit', () => {
    expect(drawn(1)).toBeCloseTo(TAB_LABEL_BASE_SP, 2);
    expect(drawn(1.15)).toBeCloseTo(TAB_LABEL_BASE_SP * 1.15, 2);
    expect(drawn(2)).toBeCloseTo(TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE, 2);
    expect(drawn(3.12)).toBeCloseTo(TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE, 2);
  });

  it('fits the measured Downloads width as the slot narrows', () => {
    const roomy = tabLabelDrawnDp(2, DEFAULT_SLOT, DOWNLOADS_WIDTH);
    expect(roomy).toBeGreaterThan(TAB_LABEL_BASE_SP);
    expect(tabLabelDrawnDp(2, MAX_SLOT, DOWNLOADS_WIDTH)).toBeLessThan(roomy);
    expect(
      (drawn(2, MAX_SLOT, DOWNLOADS_WIDTH) * DOWNLOADS_WIDTH) / TAB_LABEL_BASE_SP,
    ).toBeLessThan(MAX_SLOT);
  });

  it.each([DEFAULT_SLOT, 390 / 5, MAX_SLOT])(
    'fits Téléchargements into a %i dp slot at default and large text',
    (slot) => {
      // A long translation, or a wider OEM font, can exceed the slot at 12 sp.
      const measuredWidth = 98;
      for (const scale of [0.85, 1, 1.3, 2]) {
        const size = drawn(scale, slot, measuredWidth);
        expect(size).toBeLessThan(TAB_LABEL_BASE_SP);
        expect((size * measuredWidth) / TAB_LABEL_BASE_SP).toBeLessThan(slot);
      }
    },
  );

  it('is a different value at every scale and display size, so a live change is applied', () => {
    // Unmeasured labels (0): the drawn size is the same in both slots, only the sliver differs.
    const values = [0.85, 1, 1.15, 1.3, 1.5, 2].flatMap((s) => [
      tabLabelFontSize(s, MAX_SLOT, 0),
      tabLabelFontSize(s, DEFAULT_SLOT, 0),
    ]);
    expect(new Set(values).size).toBe(values.length);
    // As react-native-screens compares them (32-bit floats): a Pixel's display size steps at
    // the default text size draw the same 12 dp, and must still be different values.
    const steps = [411, 392, 373, 345, 320].map((w) => Math.fround(tabLabelFontSize(1, w / 5, 0)));
    expect(new Set(steps).size).toBe(steps.length);
    // The sliver never shows: under 0.001 sp.
    expect(tabLabelFontSize(2, MAX_SLOT, 98) * 2 - tabLabelDrawnDp(2, MAX_SLOT, 98)).toBeLessThan(
      0.002,
    );
  });

  it('ignores a slot not yet measured', () => {
    expect(tabLabelDrawnDp(2, DEFAULT_SLOT, 0)).toBeCloseTo(
      TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE,
    );
    expect(tabLabelDrawnDp(2, 0, DOWNLOADS_WIDTH)).toBeCloseTo(
      TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE,
    );
  });
});
