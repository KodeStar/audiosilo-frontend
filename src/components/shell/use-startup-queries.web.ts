import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { useApis } from '@/api/provider';
import { appPath } from '@/lib/base-url';
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
  // A regex, not `URLSearchParams` (jest's jsdom here lacks it). Read as written, never
  // decoded: the modes are plain words, and `decodeURIComponent` throws on a malformed
  // escape (`?mode=%E0`), which in the gate's render would take the app down on every render.
  const mode = /[?&]mode=([^&]*)/.exec(search)?.[1];
  return startPage(appPath(pathname), mode ?? null);
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
  // commits its spinner. Only the first call asks, and builds the list (a render thrown away
  // asks nothing more).
  if (open) {
    startStartupQueries(client, () =>
      startupQueries(openedOn(), apis, useLibrarySelection.getState().selection),
    );
  }
  return useSyncExternalStore(
    subscribeStartupQueries,
    startupQueriesSettled,
    startupQueriesSettled,
  );
}
