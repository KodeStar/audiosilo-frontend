import type { CoverColor } from '@/api/types';
import { coverTint, washLayers, type WashLayer, type WashVariant } from '@/lib/cover-tint';
import { useThemeColors, useThemeScheme } from '@/theme/use-theme-colors';

export type CoverWashProps = {
  /** The book's `cover_color` (absent: no wash is drawn). */
  color?: CoverColor;
  /** `card` (the Now card) or `hero` (a series or book hero). Default `card`. */
  variant?: WashVariant;
};

/** The current theme's wash layers for a cover colour, or null (no wash). */
export function useWashLayers(color: CoverColor | undefined, variant: WashVariant = 'card') {
  const themed = useThemeColors();
  const { scheme } = useThemeScheme();
  const tint = coverTint(color, themed.brand);
  if (!tint) return null;
  return washLayers(tint, scheme, variant) satisfies WashLayer[];
}
