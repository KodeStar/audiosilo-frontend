import { useCallback, useMemo } from 'react';
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
        // No network at all, in the browser and in the app alike (`useDeviceOnline`: a
        // network with no internet still counts, so a server on it decides by its own
        // flag). With none, nothing but a download plays, whatever a server's flag still
        // says (the app holds its requests then, so none fails and marks it down).
        deviceOnline,
        online,
        downloaded: (book) => !hydrated || downloadedKeys.has(contentKeyOf(book)),
      }),
    [deviceOnline, online, hydrated, downloadedKeys],
  );
}
