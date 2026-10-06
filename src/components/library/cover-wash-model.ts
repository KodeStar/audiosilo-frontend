import type { CoverColor } from '@/api/types';
import { coverTint, washLayers, type WashLayer, type WashVariant } from '@/lib/cover-tint';
import { colors } from '@/theme/tokens';
import { useThemeColors } from '@/theme/use-theme-colors';

export type CoverWashProps = {
  /** The book's `cover_color` (absent: no wash is drawn). */
  color?: CoverColor;
  /** `card` (the Now card) or `hero` (a series or book hero). Default `card`. */
  variant?: WashVariant;
  /** Lay the page background over the wash at 35%, for a surface dense with text. */
  scrim?: boolean;
  /** Layout classes; the wash fills its parent absolutely by default. */
  className?: string;
};

/** The current theme's wash layers for a cover colour, or null (no wash). */
export function useWashLayers(color: CoverColor | undefined, variant: WashVariant = 'card') {
  const themed = useThemeColors();
  const tint = coverTint(color, themed.brand);
  if (!tint) return null;
  return {
    layers: washLayers(tint, themed === colors.dark ? 'dark' : 'light', variant),
    background: themed.background,
  } satisfies { layers: WashLayer[]; background: string };
}
