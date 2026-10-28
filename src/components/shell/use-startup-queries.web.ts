import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { useApis } from '@/api/provider';
import { BASE_URL } from '@/lib/base-url';
import { useLibrarySelection } from '@/stores/library-selection';

import {
  startPage,
  startStartupQueries,
  startupQueries,
  startupQueriesSettled,
  subscribeStartupQueries,
} from './startup-queries';

/** The page this load opened on, from the address (the base path off). */
function openedOn() {
  const { pathname, search } = window.location;
  const path =
    BASE_URL && pathname.startsWith(BASE_URL) ? pathname.slice(BASE_URL.length) : pathname;
  const mode = /[?&]mode=([^&]*)/.exec(search)?.[1];
  return startPage(path, mode === undefined ? null : decodeURIComponent(mode));
}

/**
 * For the gate: whether the first screen may mount, once `open` (signed in, the person
 * known). The first time it is open the page's first answers are asked (`startupQueries`,
 * for the page the load opened on), and this is false until they are in or
 * `STARTUP_WAIT_MS` has passed; true for good after that.
 */
export function useStartupQueries(open: boolean): boolean {
  const client = useQueryClient();
  const apis = useApis();
  // Asked in render, the moment the gate opens, so the answers are on their way while it
  // commits its spinner. Only the first call asks (a render thrown away asks nothing more).
  if (open) {
    const { selection } = useLibrarySelection.getState();
    startStartupQueries(client, startupQueries(openedOn(), apis, selection));
  }
  return useSyncExternalStore(
    subscribeStartupQueries,
    startupQueriesSettled,
    startupQueriesSettled,
  );
}
