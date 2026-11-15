import { BUNDLED_CATALOGS, CATALOG_LOADERS } from '@/i18n/catalogs';

import {
  TAB_LABEL_BASE_SP,
  TAB_LABEL_EM_PER_CHAR,
  TAB_LABEL_MAX_SCALE,
  tabLabelDrawnDp,
  tabLabelFontSize,
} from './tab-label-size';

// A Pixel's slot (a fifth of the window) at the default and the largest display size.
const DEFAULT_SLOT = 411 / 5;
const MAX_SLOT = 320 / 5;
const DOWNLOADS = 'Downloads'.length;

/** What Android draws: the sp value times the font scale. */
const drawn = (scale: number, slot = DEFAULT_SLOT, longest = 6) =>
  tabLabelFontSize(scale, slot, longest) * scale;

describe('tab label size', () => {
  it('follows the text size up to the cap where the names fit', () => {
    expect(drawn(1)).toBeCloseTo(TAB_LABEL_BASE_SP, 2);
    expect(drawn(1.15)).toBeCloseTo(TAB_LABEL_BASE_SP * 1.15, 2);
    expect(drawn(2)).toBeCloseTo(TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE, 2);
    expect(drawn(3.12)).toBeCloseTo(TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE, 2);
  });

  it('grows "Downloads" only as far as its slot allows', () => {
    // Default display: most of the growth (82 dp / (9 x 0.62 em) = 14.7 dp).
    const roomy = tabLabelDrawnDp(2, DEFAULT_SLOT, DOWNLOADS);
    expect(roomy).toBeGreaterThan(14);
    expect(roomy).toBeLessThanOrEqual(TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE);
    // Largest display: cut ("Downl...") at 15.6 dp, and at the default size "Downloads"
    // (9 x 0.57 em x 12 = 62 dp) only just fits its 64 dp slot, so it does not grow.
    expect(tabLabelDrawnDp(2, MAX_SLOT, DOWNLOADS)).toBe(TAB_LABEL_BASE_SP);
  });

  it('never draws smaller than the default size, even for a name that never fits', () => {
    const fr = 'Téléchargements'.length;
    expect(tabLabelDrawnDp(2, MAX_SLOT, fr)).toBe(TAB_LABEL_BASE_SP);
    // A smaller system text size is still followed down.
    expect(tabLabelDrawnDp(0.85, MAX_SLOT, fr)).toBeCloseTo(TAB_LABEL_BASE_SP * 0.85, 5);
  });

  // Every shipped language's longest tab name: no larger than fits the largest display's
  // slot, never smaller than the default size.
  const catalogs = {
    ...BUNDLED_CATALOGS,
    ...Object.fromEntries(Object.entries(CATALOG_LOADERS).map(([code, load]) => [code, load()])),
  };
  const longestNames = Object.entries(catalogs).map(([code, { nav }]) => {
    const names = [nav.home, nav.library, nav.search, nav.downloads, nav.me];
    return [code, names.reduce((a, b) => (b.length > a.length ? b : a))] as const;
  });
  it.each(longestNames)('keeps %s %s within its slot at 2.0 on the largest display', (_, name) => {
    const size = tabLabelDrawnDp(2, MAX_SLOT, name.length);
    expect(size).toBeGreaterThanOrEqual(TAB_LABEL_BASE_SP);
    if (size > TAB_LABEL_BASE_SP) {
      expect(size * name.length * TAB_LABEL_EM_PER_CHAR).toBeLessThanOrEqual(MAX_SLOT + 1e-9);
    }
  });

  it('is a different value at every scale and display size, so a live change is applied', () => {
    const values = [0.85, 1, 1.15, 1.3, 1.5, 2].flatMap((s) => [
      tabLabelFontSize(s, MAX_SLOT, 15),
      tabLabelFontSize(s, DEFAULT_SLOT, 15),
    ]);
    expect(new Set(values).size).toBe(values.length);
    // As react-native-screens compares them (32-bit floats): a Pixel's display size steps at
    // the default text size draw the same 12 dp, and must still be different values.
    const steps = [411, 392, 373, 345, 320].map((w) => Math.fround(tabLabelFontSize(1, w / 5, 9)));
    expect(new Set(steps).size).toBe(steps.length);
    // The sliver never shows: under 0.001 sp.
    expect(tabLabelFontSize(2, MAX_SLOT, 15) * 2 - TAB_LABEL_BASE_SP).toBeLessThan(0.002);
  });

  it('ignores a slot not yet measured', () => {
    expect(tabLabelDrawnDp(2, 0, DOWNLOADS)).toBeCloseTo(TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE);
  });
});
