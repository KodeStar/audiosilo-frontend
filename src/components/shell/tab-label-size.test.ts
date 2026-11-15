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
    // Default display: the whole growth fits.
    expect(tabLabelDrawnDp(2, DEFAULT_SLOT, DOWNLOADS)).toBeCloseTo(
      TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE,
    );
    // Largest display: cut ("Downl...") at 15.6 dp, so it grows less, with a margin.
    const tight = tabLabelDrawnDp(2, MAX_SLOT, DOWNLOADS);
    expect(tight).toBeGreaterThan(TAB_LABEL_BASE_SP);
    expect(tight).toBeLessThan(15);
  });

  it('never draws smaller than the default size, even for a name that never fits', () => {
    const fr = 'Téléchargements'.length;
    expect(tabLabelDrawnDp(2, MAX_SLOT, fr)).toBe(TAB_LABEL_BASE_SP);
    // A smaller system text size is still followed down.
    expect(tabLabelDrawnDp(0.85, MAX_SLOT, fr)).toBeCloseTo(TAB_LABEL_BASE_SP * 0.85, 5);
  });

  // Every shipped language's longest tab name (de, en/it, fr, es, pt): no larger than fits
  // the largest display's slot, never smaller than the default size.
  it.each([
    'Bibliothek',
    'Downloads',
    'Bibliothèque',
    'Biblioteca',
    'Téléchargements',
    'Transferências',
  ])('keeps %s within its slot at 2.0 on the largest display', (name) => {
    const size = tabLabelDrawnDp(2, MAX_SLOT, name.length);
    expect(size).toBeGreaterThanOrEqual(TAB_LABEL_BASE_SP);
    if (size > TAB_LABEL_BASE_SP) {
      expect(size * name.length * TAB_LABEL_EM_PER_CHAR).toBeLessThanOrEqual(MAX_SLOT + 1e-9);
    }
  });

  it('is a different value at every scale, so a live change is applied', () => {
    const values = [0.85, 1, 1.15, 1.3, 1.5, 2].map((s) => tabLabelFontSize(s, MAX_SLOT, 9));
    expect(new Set(values).size).toBe(values.length);
  });

  it('ignores a slot not yet measured', () => {
    expect(tabLabelDrawnDp(2, 0, DOWNLOADS)).toBeCloseTo(TAB_LABEL_BASE_SP * TAB_LABEL_MAX_SCALE);
  });
});
