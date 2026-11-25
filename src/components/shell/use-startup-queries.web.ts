import { useQueryClient } from '@tanstack/react-query';
import { useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { useApis, useCid } from '@/api/provider';
import { queueConnectionId } from '@/components/upnext/up-next-model';
import { firstParam } from '@/lib/paths';
import { usePlayer } from '@/playback/store';
import { useLibrarySelection } from '@/stores/library-selection';

import {
  startPage,
  startStartupQueries,
  startupQueries,
  startupQueriesComplete,
  subscribeStartupQueries,
} from './startup-queries';

/** Let the first signed-in app page mount once its queries settle or the wait expires. */
export function useStartupQueries(open: boolean): boolean {
  const client = useQueryClient();
  const apis = useApis();
  const defaultCid = useCid();
  const [root] = useSegments();
  const pathname = usePathname();
  const { mode } = useGlobalSearchParams<{ mode?: string | string[] }>();
  // Connect, demo and profile choice lead to another page. Keep the anchored Home from
  // mounting beneath them. A direct link to a player or reader modal still needs the shell.
  if (open && root && root !== 'connect' && root !== 'demo' && root !== 'profiles') {
    startStartupQueries(client, () => {
      const queueCid = queueConnectionId(
        usePlayer.getState().nowPlaying?.connectionId,
        defaultCid,
        apis.map(({ connection }) => connection),
      );
      return startupQueries(
        startPage(pathname, firstParam(mode)),
        apis,
        useLibrarySelection.getState().selection,
        defaultCid,
        queueCid,
      );
    });
  }
  const complete = useSyncExternalStore(
    subscribeStartupQueries,
    startupQueriesComplete,
    startupQueriesComplete,
  );
  return !open || complete;
}
