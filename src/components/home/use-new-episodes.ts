import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';

import { latestEpisodesQuery, myPodcastsQuery, useLibrariesAll } from '@/api/hooks';
import { useApiRegistry } from '@/api/provider';
import { isPodcastLibrary } from '@/lib/library-kind';
import type { Connection } from '@/stores/session';

import {
  type FollowedShow,
  NEW_EPISODES_PER_SHOW,
  newEpisodes,
  recentShows,
} from './new-episodes-model';

/**
 * Home's New episodes (Bridge Phase 2d-1): the shows the listener follows on each of
 * their servers that lists a podcast library (`GET /me/podcasts`), the few that
 * published lately (`recentShows`), and each one's newest episodes (one page each,
 * cached five minutes). `skip` holds the content keys already started or finished.
 * Also returns, per server, its first podcast library (the rail's All shows opens it).
 */
export function useNewEpisodes(
  connections: readonly Connection[],
  skip: ReadonlySet<string>,
  limit: number,
) {
  const { clients } = useApiRegistry();
  const { groups } = useLibrariesAll();
  const ids = new Set(connections.map((c) => c.id));
  const podcastLibraries = new Map<string, number>();
  for (const g of groups) {
    if (!ids.has(g.connectionId)) continue;
    const lib = g.libraries.find(isPodcastLibrary);
    if (lib) podcastLibraries.set(g.connectionId, lib.id);
  }
  const cids = [...podcastLibraries.keys()];
  const mine = useQueries({
    queries: cids.map((cid) => myPodcastsQuery(cid, clients.get(cid))),
  });
  // Counted from when Home opened (a long-open Home keeps its picks steady).
  const [now] = useState(() => new Date());
  const followed: FollowedShow[] = cids.flatMap((cid, i) =>
    (mine[i]?.data?.shows ?? []).map((show) => ({ connectionId: cid, show })),
  );
  const shows = recentShows(followed, now);
  const latest = useQueries({
    queries: shows.map(({ connectionId, show }) =>
      latestEpisodesQuery(
        connectionId,
        clients.get(connectionId),
        show.library_id,
        show.path,
        NEW_EPISODES_PER_SHOW,
      ),
    ),
  });
  const items = newEpisodes(
    shows.map((s, i) => ({
      ...s,
      episodes: latest[i]?.data?.episodes ?? [],
    })),
    skip,
    now,
    limit,
  );
  return { items, podcastLibraries };
}
