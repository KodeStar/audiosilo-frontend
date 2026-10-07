import type { CoverColor } from '@/api/types';
import { clothColor } from '@/lib/monogram';

/**
 * A spine's colours (STYLEGUIDE section 8, "Spine": "in the cover's palette"): the body
 * is the cover's dominant colour, the two bands its vibrant one, the type whichever of
 * ink or white reads best on the body. A book whose cover the server hasn't read yet
 * (or an older server) gets a deterministic deep colour from its title instead, so a
 * shelf never shows a row of identical grey spines and a spine keeps its colour between
 * visits. These are content colours (like cover art), not theme tokens.
 */
export type SpinePalette = { body: string; band: string; ink: string };

const INK = '#121c36';
const WHITE = '#ffffff';
const HEX = /^#[0-9a-f]{6}$/i;

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function spinePalette(color: CoverColor | undefined, title: string): SpinePalette {
  const body = color && HEX.test(color.bg) ? color.bg.toLowerCase() : clothColor(title);
  const ink = contrast(body, WHITE) >= contrast(body, INK) ? WHITE : INK;
  // The vibrant colour makes the bands when it stands off the body; otherwise the type
  // colour does (drawn translucent by the spine).
  const accent = color?.accent && HEX.test(color.accent) ? color.accent.toLowerCase() : undefined;
  const band = accent && contrast(accent, body) >= 1.8 ? accent : ink;
  return { body, band, ink };
}
