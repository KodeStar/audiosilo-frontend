import { View } from 'react-native';

import { useOptionalApi } from '@/api/provider';
import { CoverImage } from '@/components/ui/cover-image';
import { Icon } from '@/components/ui/icon';
import { useThemeColors } from '@/theme/use-theme-colors';

import { useArtworkRetry } from './artwork-retry';

/**
 * A directory result's artwork (Bridge Phase 2d-2), from this server's proxy with the
 * media token (`discoveryArtworkUrl`; never the directory's own image host). No artwork,
 * or one that keeps failing, is the microphone placeholder. A failed load (the server
 * fetches uncached images a few at a time, so some get 429 / 503) mounts the image again
 * with the same URL when `useArtworkRetry` says (the server's `Retry-After` when it is
 * busy). Rows mount as the list windows them in, so artwork loads lazily.
 */
export function DiscoveryArtwork({
  connectionId,
  artworkUrl,
  size,
}: {
  connectionId: string;
  artworkUrl: string | null;
  size: number;
}) {
  const themed = useThemeColors();
  const uri = useOptionalApi(connectionId)?.discoveryArtworkUrl(artworkUrl) ?? null;
  // Another URL (a later search's row with the same key, a new media token) starts over.
  const { failed, tries, onError } = useArtworkRetry(connectionId, uri);
  return (
    <View
      className="items-center justify-center overflow-hidden rounded-lg bg-muted"
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {uri && !failed ? (
        <CoverImage
          // A new key per try: the same URL mounted again is a new request.
          key={`${uri}#${tries}`}
          testID="discovery-artwork-image"
          source={{ uri }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={150}
          onError={onError}
        />
      ) : (
        <Icon name="microphone" size={Math.round(size * 0.36)} color={themed.subtleForeground} />
      )}
    </View>
  );
}
