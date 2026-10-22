import { useQueryClient } from '@tanstack/react-query';

import { useActiveAddress } from '@/api/address-route';
import { qk, useCapability } from '@/api/hooks';
import type { Book, ChaptersResponse } from '@/api/types';
import { usePlayer } from '@/playback/store';

import { type CastButtonModel, castButtonModel } from './cast-button-model';
import { useCast } from './cast-state';

/** The Cast button's state for the playing book (its connection's flags and address, its
 * item and chapters as the query cache holds them, the session). */
export function useCastButton(): CastButtonModel {
  const np = usePlayer((s) => s.nowPlaying);
  const cid = np?.connectionId;
  const canCast = useCapability('cast', cid);
  const canTranscode = useCapability('transcode', cid);
  const { url } = useActiveAddress(cid ?? '');
  const { supported, status, deviceName } = useCast();
  const queryClient = useQueryClient();
  const book = np
    ? queryClient.getQueryData<Book>(qk.item(np.connectionId, np.libraryId, np.path))
    : undefined;
  const chapters = np
    ? queryClient.getQueryData<ChaptersResponse>(
        qk.chapters(np.connectionId, np.libraryId, np.path),
      )
    : undefined;
  return castButtonModel({
    loaded: !!np,
    episode: !!np?.episode,
    supported,
    canCast: cid ? canCast : undefined,
    canTranscode,
    baseUrl: url || null,
    book,
    chapters,
    status,
    deviceName,
  });
}
