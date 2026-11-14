import { colors, type ThemeColors } from './tokens';

type Token = keyof ThemeColors;

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

/** `fg` at `alpha` over `bg` (both #rrggbb), as the eye sees it: `text-x/70` on a fill. */
function over(fg: string, bg: string, alpha: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(channel(fg, i) * alpha + channel(bg, i) * (1 - alpha))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * Text on its surfaces: WCAG AA 1.4.3, 4.5:1. Each [text, surfaces it sits on]. The
 * surfaces are the page (`background`), `card`, `popover` and the fills the text is
 * drawn on (`muted`, `secondary`, `accent`, the status softs, the solid fills).
 */
const TEXT: [Token, Token[]][] = [
  ['foreground', ['background', 'card', 'popover', 'muted', 'secondary', 'accent']],
  ['cardForeground', ['card']],
  ['popoverForeground', ['popover']],
  ['mutedForeground', ['background', 'card', 'popover', 'muted', 'secondary', 'accent']],
  ['subtleForeground', ['background', 'card', 'popover', 'muted']],
  ['primaryForeground', ['primary']],
  ['secondaryForeground', ['secondary']],
  ['accentForeground', ['accent']],
  ['brandInk', ['background', 'card', 'brandSoft']],
  ['brandForeground', ['brand']],
  ['destructive', ['background', 'card', 'destructiveSoft']],
  ['destructiveForeground', ['destructive']],
  // The finished flag's check on a solid success fill (cover tiles, spines).
  ['successForeground', ['success']],
  ['success', ['background', 'card', 'successSoft']],
  ['warning', ['background', 'card', 'warningSoft']],
  ['info', ['background', 'card', 'infoSoft']],
  ['community', ['background', 'card', 'communitySoft']],
];

/**
 * Non-text: WCAG AA 1.4.11, 3:1 against what is next to them. The field outline, the
 * strong border (outline buttons, chips, the switch off, a check box), the focus ring,
 * and the brand fill (progress, playhead) on the page AND on the slider and progress
 * track: the fill against the track carries the value, so the track stays light (it may
 * sit under 3:1 on the page; high contrast outlines it in `input`, held to 4.5:1 below).
 * The plain `border` is a decorative divider in the normal sets (high contrast raises it).
 */
const NON_TEXT: [Token, Token[]][] = [
  ['input', ['background', 'card']],
  ['borderStrong', ['background', 'card']],
  ['ring', ['background', 'card']],
  ['brand', ['background', 'card', 'track']],
  // The slider's ink fill (`tone="ink"`, `primary`).
  ['primary', ['track']],
];

/** Faded text the app draws on a solid fill (`text-primary-foreground/70` and up: the
 * seek tooltip's book time, a selected option's caption, a selected chip's count). */
const FADED: [Token, Token, number][] = [['primaryForeground', 'primary', 0.7]];

/** Pairs one scheme's components draw that the other's don't: dark lifts a segmented
 * control's selected segment to `secondary` (`toggle-group.tsx`), with its count in subtle
 * text; light keeps it on `card`. */
const TEXT_DARK: [Token, Token[]][] = [['subtleForeground', ['secondary']]];

const DARK_TEXT = [...TEXT, ...TEXT_DARK];

/** Each set with the text pairs its scheme draws. */
const SETS: [string, ThemeColors, [Token, Token[]][]][] = [
  ['light', colors.light, TEXT],
  ['dark', colors.dark, DARK_TEXT],
  ['high-contrast light', colors.highContrast.light, TEXT],
  ['high-contrast dark', colors.highContrast.dark, DARK_TEXT],
];

const pairs = (list: [Token, Token[]][]) =>
  list.flatMap(([fg, surfaces]) => surfaces.map((bg) => [fg, bg] as const));

describe.each(SETS)('the %s colours', (_name, t, text) => {
  it.each(pairs(text))('text %s on %s meets 4.5:1', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(pairs(NON_TEXT))('%s on %s meets 3:1', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
  });

  it.each(FADED)('%s on %s at %s alpha meets 4.5:1', (fg, bg, alpha) => {
    expect(contrast(over(t[fg], t[bg], alpha), t[bg])).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each(['light', 'dark'] as const)('high contrast over the normal %s colours', (scheme) => {
  const normal = colors[scheme];
  const high = colors.highContrast[scheme];

  it('keeps the layout colours (surfaces and the brand) as they are', () => {
    for (const k of ['background', 'card', 'popover', 'primary', 'brand', 'muted'] as const) {
      expect(high[k]).toBe(normal[k]);
    }
  });

  it.each(pairs(TEXT))('never weakens text %s on %s', (fg, bg) => {
    expect(contrast(high[fg], high[bg])).toBeGreaterThanOrEqual(contrast(normal[fg], normal[bg]));
  });

  it('makes muted and subtle text AAA (7:1) on the page and on cards', () => {
    for (const fg of ['mutedForeground', 'subtleForeground'] as const) {
      for (const bg of ['background', 'card'] as const) {
        expect(contrast(high[fg], high[bg])).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it('makes the plain border 3:1 and the strong border and field outline 4.5:1', () => {
    for (const bg of ['background', 'card'] as const) {
      expect(contrast(high.border, high[bg])).toBeGreaterThanOrEqual(3);
      expect(contrast(high.borderStrong, high[bg])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(high.input, high[bg])).toBeGreaterThanOrEqual(4.5);
    }
  });
});
