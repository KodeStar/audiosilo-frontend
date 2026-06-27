import { router } from 'expo-router';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { queryClient } from '@/api/provider';

import { consumeTaskRemoved } from './task-removed';

type ForegroundDeps = {
  /** Refresh server-backed data (refetch active queries). */
  refresh: () => void;
  /** True (once) if the app was swiped away from recents — see task-removed. */
  taskWasRemoved: () => boolean;
  /** Reset navigation to the Home tab. */
  goHome: () => void;
};

/**
 * What to do when the app returns to the foreground. Pure (deps injected) so it can be
 * unit-tested without AppState/router/query-client. Two jobs:
 *  - Always refresh, so anything that errored/emptied while backgrounded (e.g. the
 *    server came back) repopulates and the lists re-render.
 *  - If the user swiped the app away from recents (Android keeps the cached process,
 *    so the next open is a warm resume on the last route, which renders blank), reset
 *    to Home — matching the iOS cold-start behavior. A plain app-switch never sets the
 *    flag, so it keeps its place.
 */
export function handleForeground(deps: ForegroundDeps): void {
  deps.refresh();
  if (deps.taskWasRemoved()) deps.goHome();
}

function goHome(): void {
  try {
    router.dismissAll();
  } catch {
    // No modal/stack to dismiss — fine.
  }
  router.replace('/');
}

/**
 * Wire app-foreground handling. Call once from the root layout.
 *
 * On mount we only refresh and *clear* any stale swipe-away flag — never navigate. A
 * cold start (incl. a fresh React tree after an Activity re-creation) already lands on
 * the correct initial route, which may be a deep-link target (e.g. pairing) we must
 * not clobber; the flag is persisted, so a swipe-away that then killed the process
 * would otherwise force Home on the next unrelated launch.
 *
 * Navigation only happens on a warm resume — a 'background'→'active' transition where
 * the React tree survived — which is exactly the case the user hits: swipe the app
 * away, Android keeps the cached process, reopening warm-resumes the (blank) last
 * route. consumeTaskRemoved clears the flag on read, so it fires at most once.
 */
export function useAppResume(): void {
  useEffect(() => {
    void queryClient.invalidateQueries();
    consumeTaskRemoved();

    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s !== 'active') return;
      handleForeground({
        refresh: () => void queryClient.invalidateQueries(),
        taskWasRemoved: consumeTaskRemoved,
        goHome,
      });
    });
    return () => sub.remove();
  }, []);
}
