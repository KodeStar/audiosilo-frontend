import { useCallback } from 'react';
import { Platform } from 'react-native';

import { useServerInfo } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';

import { type CommunityCoverFor, communityCoverSource } from './community-cover';

/** `communityCoverSource` for the community covers of the book at
 * (`libraryId`, `path`) on `connectionId`, the book its `/meta` was asked for. A server
 * whose `/server` can't be read can't serve a cover either, so it counts as one without
 * `meta_covers`: native loads a kept envelope's covers directly, as it always has. */
export function useCommunityCover(
  connectionId: string | undefined,
  libraryId: number,
  path: string,
): CommunityCoverFor {
  const api = useOptionalApi(connectionId);
  const info = useServerInfo(connectionId);
  const caps = info.data?.capabilities;
  const proxied = caps ? !!caps.meta_covers : info.isError ? false : undefined;
  return useCallback(
    (coverUrl, size) =>
      communityCoverSource({
        coverUrl,
        size,
        proxied,
        web: Platform.OS === 'web',
        api,
        libraryId,
        path,
      }),
    [api, proxied, libraryId, path],
  );
}
