import { colors } from './tokens';

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('button label contrast (WCAG AA, 4.5:1 for 14 px text)', () => {
  it.each(['light', 'dark'] as const)('the %s destructive button', (theme) => {
    // White on the dark theme's coral was 3.2:1: "Sign out device" read pale.
    const t = colors[theme];
    expect(contrast(t.destructiveForeground, t.destructive)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['light', 'dark'] as const)('the %s ink (default) button', (theme) => {
    const t = colors[theme];
    expect(contrast(t.primaryForeground, t.primary)).toBeGreaterThanOrEqual(4.5);
  });
});
