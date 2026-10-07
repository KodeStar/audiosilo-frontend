import { store } from 'expo-router/build/global-state/router-store';

/** A navigation state, as much of it as the root-stack reads below use. */
export type NavState = { index?: number; routes: { name: string; state?: NavState }[] };

/** The root stack's route that holds the app shell (the tabs and their pages). The root
 * routes over it are the full player and the credits (`src/app/_layout.tsx`). */
const SHELL = '(app)';

/** The root stack, found down the focused chain (expo-router wraps it in `__root`): the
 * first stack that holds the shell. */
function rootStack(state: NavState | undefined): NavState | null {
  for (let s = state; s;) {
    if (s.routes.some((r) => r.name === SHELL)) return s;
    s = s.routes[s.index ?? s.routes.length - 1]?.state;
  }
  return null;
}

/** The root stack's top route (`player`, `finished`, `(app)`...), or null. */
export function topRootRoute(state: NavState | undefined): string | null {
  const root = rootStack(state);
  return root?.routes[root.index ?? root.routes.length - 1]?.name ?? null;
}

/**
 * Where the app shell sits under the root stack's top: how many root routes are `above`
 * it (the full player, the credits; 0 while a shell page is on top) and its active `tab`
 * (null before the shell has a tab state, as under a cold deep link). Null with no shell.
 */
export function shellUnderTop(
  state: NavState | undefined,
): { above: number; tab: string | null } | null {
  const root = rootStack(state);
  if (!root) return null;
  const top = root.index ?? root.routes.length - 1;
  let shell = top;
  while (shell >= 0 && root.routes[shell].name !== SHELL) shell--;
  if (shell < 0) return null;
  const tabs = root.routes[shell].state;
  const tab = tabs ? (tabs.routes[tabs.index ?? 0]?.name ?? null) : null;
  return { above: top - shell, tab };
}

/**
 * The router's navigation state NOW, read at call time without subscribing (a press
 * handler deciding where to go must not re-render its component on every navigation).
 * Through expo-router's store (no public non-hook read exists; the route-tree tests pin
 * it). Undefined before the navigator is ready.
 */
export function currentNavState(): NavState | undefined {
  try {
    const ref = store.navigationRef;
    if (ref?.isReady()) return ref.getRootState() as NavState;
    return (store.state as NavState | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}
