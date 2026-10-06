import { hexAlpha, washCss } from '@/lib/cover-tint';

import { type CoverWashProps, useWashLayers } from './cover-wash-model';

/**
 * Web: the wash as CSS radial gradients on one absolutely placed element (see
 * `cover-wash.tsx` for the contract). A plain DOM node, since react-native-web does not
 * pass `backgroundImage` through its style handling.
 */
export function CoverWash({ color, variant, scrim, className }: CoverWashProps) {
  const wash = useWashLayers(color, variant);
  if (!wash) return null;
  const layers = washCss(wash.layers);
  return (
    <div
      aria-hidden
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        backgroundImage: scrim
          ? `linear-gradient(${hexAlpha(wash.background, 0.35)}, ${hexAlpha(wash.background, 0.35)}), ${layers}`
          : layers,
      }}
    />
  );
}
