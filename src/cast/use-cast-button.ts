import { useActiveAddress } from '@/api/address-route';
import { qk, useCapability } from '@/api/hooks';
import type { Book, ChaptersResponse } from '@/api/types';
import { useCachedQueryData } from '@/api/use-cached-query-data';
import { usePlayer } from '@/playback/store';
import { useSession } from '@/stores/session';

import { type CastButtonModel, castButtonModel } from './cast-button-model';
import { behindProxy } from './cast-media';
import { useCast } from './cast-state';

/** The Cast button's state for the playing book (its connection's flags and address, its
 * item and chapters as the query cache holds them, the session). */
export function useCastButton(): CastButtonModel {
  const np = usePlayer((s) => s.nowPlaying);
  const cid = np?.connectionId;
  const canCast = useCapability('cast', cid);
  const canTranscode = useCapability('transcode', cid);
  const { url } = useActiveAddress(cid ?? '');
  const proxyHeaders = useSession((s) =>
    cid ? s.connections.find((c) => c.id === cid)?.proxyHeaders : undefined,
  );
  const { supported, status, deviceName } = useCast();
  // Followed, not read once: the button turns on when either lands after the book loaded.
  const book = useCachedQueryData<Book>(np && qk.item(np.connectionId, np.libraryId, np.path));
  const chapters = useCachedQueryData<ChaptersResponse>(
    np && qk.chapters(np.connectionId, np.libraryId, np.path),
  );
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
    proxied: behindProxy(proxyHeaders, url || null),
  });
}
