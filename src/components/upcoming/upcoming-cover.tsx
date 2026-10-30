import { useState } from 'react';
import { PixelRatio, Platform, View } from 'react-native';

import type { ApiClient } from '@/api/client';
import { useCapability } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import type { CoverSize } from '@/api/types';
import { coverSizeFor } from '@/components/library/book-cover';
import { GhostCover } from '@/components/library/ghost-cover';
import { CoverImage } from '@/components/ui/cover-image';
import { railPositionLabel } from '@/lib/series-position';
import type { SourcedUpcomingItem } from '@/lib/upcoming';

/**
 * Where an upcoming item's cover loads from: the item's own server (the connection whose
 * row won the merge), through `GET /me/upcoming/cover` (`client.upcomingCoverUrl`), only
 * when that server serves them (`upcoming_covers === true`, never while unknown) and the
 * item has a `cover_url`. Otherwise null: the ghost cover. The device never contacts the
 * cover's host (the web player's CSP would refuse it anyway).
 */
export function upcomingCoverUri(opts: {
  item: Pick<SourcedUpcomingItem, 'work'>;
  covers: boolean | undefined;
  api: ApiClient | null;
  size: CoverSize;
}): string | null {
  const { item, covers, api, size } = opts;
  if (covers !== true || !api || !item.work.cover_url) return null;
  return api.upcomingCoverUrl(item.work.id, { size });
}

/**
 * An upcoming item's cover (Track U3): the ghost cover (STYLEGUIDE section 8: the book is
 * on none of the listener's servers), with the work's real community cover drawn over it
 * once its server serves one (`upcomingCoverUri`). The ghost stays underneath, so it shows
 * while the image loads, and alone when there is none or it fails to load. Sized like the
 * ghost (square, `width`).
 */
export function UpcomingCover({ item, width }: { item: SourcedUpcomingItem; width: number }) {
  const api = useOptionalApi(item.connectionId);
  const covers = useCapability('upcoming_covers', item.connectionId);
  const uri = upcomingCoverUri({
    item,
    covers,
    api,
    size: coverSizeFor(width, PixelRatio.get()) ?? 640,
  });
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
          source={Platform.OS === 'web' ? uri : { uri, headers: api?.authHeaders() }}
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
