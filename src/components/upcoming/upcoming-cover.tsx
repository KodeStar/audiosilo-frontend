import { useState } from 'react';
import { PixelRatio, View } from 'react-native';

import { useCapability } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { coverSizeFor } from '@/components/library/book-cover';
import { GhostCover } from '@/components/library/ghost-cover';
import { CoverImage } from '@/components/ui/cover-image';
import { railPositionLabel } from '@/lib/series-position';
import type { SourcedUpcomingItem } from '@/lib/upcoming';

/**
 * An upcoming item's cover (Track U3): the ghost cover (STYLEGUIDE section 8: the book is
 * on none of the listener's servers), with the work's real community cover drawn over it
 * once its server serves one (`GET /me/upcoming/cover`). The ghost stays underneath, so it shows
 * while the image loads, and alone when there is none or it fails to load. Sized like the
 * ghost (square, `width`).
 */
export function UpcomingCover({ item, width }: { item: SourcedUpcomingItem; width: number }) {
  const api = useOptionalApi(item.connectionId);
  const covers = useCapability('upcoming_covers', item.connectionId);
  // From the item's own server (the connection whose row won the merge), only when it serves
  // covers (`upcoming_covers === true`, never while unknown) and the item has a `cover_url`.
  // The device never contacts the cover's host (the web player's CSP would refuse it anyway).
  const uri =
    covers === true && api && item.work.cover_url
      ? api.upcomingCoverUrl(item.work.id, { size: coverSizeFor(width, PixelRatio.get()) ?? 640 })
      : null;
  // The URI that failed (not a flag), so a recycled tile's next item starts afresh.
  const [failed, setFailed] = useState<string | null>(null);
  const ghost = (
    <GhostCover
      title={item.work.title}
      position={railPositionLabel(item.series.position)}
      width={width}
    />
  );
  if (!uri || failed === uri) return ghost;
  return (
    <View style={{ width, height: width }}>
      {ghost}
      <View
        pointerEvents="none"
        aria-hidden
        className="absolute inset-0 overflow-hidden rounded-cover"
      >
        <CoverImage
          source={{ uri, headers: api?.authHeaders() }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={150}
          recyclingKey={uri}
          onError={() => setFailed(uri)}
          testID="upcoming-cover-image"
        />
      </View>
    </View>
  );
}
