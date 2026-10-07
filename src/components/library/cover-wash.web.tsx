import { washCss } from '@/lib/cover-tint';

import { type CoverWashProps, useWashLayers } from './cover-wash-model';

/**
 * Web: the wash as CSS radial gradients on one absolutely placed element (see
 * `cover-wash.tsx` for the contract). A plain DOM node, since react-native-web does not
 * pass `backgroundImage` through its style handling.
 */
export function CoverWash({ color, variant }: CoverWashProps) {
  const layers = useWashLayers(color, variant);
  if (!layers) return null;
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        backgroundImage: washCss(layers),
      }}
    />
  );
}
