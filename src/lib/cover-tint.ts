import type { CoverColor } from '@/api/types';

/**
 * The cover-derived colour wash (STYLEGUIDE section 3, "Cover-derived colour"): two
 * radial gradients of a book's cover colours at the theme's `--wash` strength, laid
 * over the page/card surface, behind the Now card, the series hero and later the book
 * hero and full player. Pure, so both renderers (CSS on web, SVG on native) and the
 * tests share one geometry.
 */

const HEX = /^#[0-9a-f]{6}$/i;

/** The two colours a wash is made of: `tint` (the cover's dominant colour) and `accent`
 * (its vibrant colour, or the brand pink when the server sent none). */
export type CoverTint = { tint: string; accent: string };

/**
 * A book's wash colours from its `cover_color`, or null when it has none (an older
 * server, or art the server has not thumbnailed yet): then there is no wash at all,
 * never a made-up one. `accent` falls back to `brand` when the cover has no usable
 * vibrant colour (the server omits it below 4.5:1). Malformed colours count as absent.
 */
export function coverTint(color: CoverColor | undefined, brand: string): CoverTint | null {
  if (!color || !HEX.test(color.bg)) return null;
  return { tint: color.bg, accent: color.accent && HEX.test(color.accent) ? color.accent : brand };
}

/** `--wash`: how strongly the cover colour tints a surface (STYLEGUIDE section 3). */
export const WASH_STRENGTH = { light: 0.3, dark: 0.42 } as const;

/** `#rrggbb` at an opacity, as `rgba(...)`. */
export function hexAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** One radial layer: an ellipse centred at (`cx`, `cy`) with radii (`rx`, `ry`), all
 * fractions of the box, fading from `color` at `opacity` to nothing at `fade` of the
 * radius. */
export type WashLayer = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  color: string;
  opacity: number;
  fade: number;
};

/** Where the wash sits: `card` (the Now card: dominant from the top left, vibrant from
 * the bottom right) or `hero` (a page hero: both from the top). */
export type WashVariant = 'card' | 'hero';

/** The wash's two layers for a tint, theme and variant (the prototype's gradients). */
export function washLayers(
  tint: CoverTint,
  scheme: 'light' | 'dark',
  variant: WashVariant = 'card',
): WashLayer[] {
  const wash = WASH_STRENGTH[scheme];
  return variant === 'card'
    ? [
        { cx: 0, cy: 0, rx: 0.7, ry: 1.2, color: tint.tint, opacity: wash, fade: 0.7 },
        { cx: 1, cy: 1, rx: 0.6, ry: 1, color: tint.accent, opacity: wash * 0.55, fade: 0.7 },
      ]
    : [
        { cx: 0.15, cy: 0, rx: 0.6, ry: 1, color: tint.tint, opacity: wash, fade: 0.7 },
        { cx: 0.9, cy: 0.1, rx: 0.5, ry: 0.8, color: tint.accent, opacity: wash * 0.6, fade: 0.7 },
      ];
}

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** The layers as a CSS `background-image` (web). */
export function washCss(layers: WashLayer[]): string {
  return layers
    .map(
      (l) =>
        `radial-gradient(${pct(l.rx)} ${pct(l.ry)} at ${pct(l.cx)} ${pct(l.cy)}, ` +
        `${hexAlpha(l.color, l.opacity)}, transparent ${pct(l.fade)})`,
    )
    .join(', ');
}
