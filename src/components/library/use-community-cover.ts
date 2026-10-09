import { useCallback } from 'react';
import { Platform } from 'react-native';

import { useCapability } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';

import { type CommunityCoverFor, communityCoverSource } from './community-cover';

/** `communityCoverSource` for the community covers of the book at
 * (`libraryId`, `path`) on `connectionId`, the book its `/meta` was asked for. */
export function useCommunityCover(
  connectionId: string | undefined,
  libraryId: number,
  path: string,
): CommunityCoverFor {
  const api = useOptionalApi(connectionId);
  const proxied = useCapability('meta_covers', connectionId);
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
