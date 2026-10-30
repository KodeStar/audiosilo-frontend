import { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { useReachability } from '@/api/reachability';
import { useDownloads } from '@/downloads/store';
import { contentKeyOf } from '@/lib/content-key';
import { useDeviceOnline } from '@/lib/device-online';

import { type BookAt, playableHere } from './home-model';

/** Whether a book can start here now (`playableHere`): online with its server answering,
 * or downloaded. Redraws as the network, a server or the set of downloaded books changes,
 * never on a running download's ticks. */
export function usePlayableHere(): (at: BookAt) => boolean {
  const deviceOnline = useDeviceOnline();
  const online = useReachability((s) => s.online);
  // Until the launch has read the registry no book reads as downloaded, so none is called
  // unplayable for it meanwhile.
  const hydrated = useDownloads((s) => s.hydrated);
  const downloaded = useDownloads(
    useShallow((s) =>
      Object.keys(s.entries).filter((key) => s.entries[key].status === 'downloaded'),
    ),
  );
  const downloadedKeys = useMemo(() => new Set(downloaded), [downloaded]);
  return useCallback(
    (at: BookAt) =>
      playableHere(at, {
        // The browser's flag means no network at all. The app's also reads false on a
        // network with no internet (Android's validation) while a server on that network
        // answers: there the book's server's own flag decides, as it does for the player.
        deviceOnline: Platform.OS !== 'web' || deviceOnline,
        online,
        downloaded: (book) => !hydrated || downloadedKeys.has(contentKeyOf(book)),
      }),
    [deviceOnline, online, hydrated, downloadedKeys],
  );
}
