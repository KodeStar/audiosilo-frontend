import { store } from 'expo-router/build/global-state/router-store';

/** A navigation state, as much of it as the root-stack reads below use (`key`: the
 * navigator's, which an action can target). */
export type NavState = { key?: string; index?: number; routes: NavRoute[] };
export type NavRoute = { name: string; params?: object; state?: NavState };

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

/** The route on screen: the end of the focused chain (a shell page such as
 * `book/[libraryId]` with its params, or a root route over the shell), or null. */
export function focusedRoute(state: NavState | undefined): NavRoute | null {
  let route: NavRoute | null = null;
  let s = state;
  while (s) {
    route = s.routes[s.index ?? s.routes.length - 1] ?? null;
    s = route?.state;
  }
  return route;
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

/** The stack state of tab `tab` (its routes, its navigator key), anywhere in `state`. */
function tabStackState(state: NavState | undefined, tab: string): NavState | null {
  for (const r of state?.routes ?? []) {
    if (r.name === tab) return r.state ?? null;
    const found = tabStackState(r.state, tab);
    if (found) return found;
  }
  return null;
}

/**
 * Pop tab `tab`'s stack back to its root, which keeps the root's own params (Library's
 * mode, the You hub's section). Any tab, by its stack's key, not only the focused one.
 * The way back to a tab root: a navigate to the root's href is a push in this router, so
 * it stacked a second copy of the root over the pages. Nothing when the stack holds only
 * its root (or the router isn't ready).
 */
export function popTabToRoot(tab: string, state: NavState | undefined = currentNavState()) {
  const stack = tabStackState(state, tab);
  if (stack?.key && stack.routes.length > 1) {
    store.navigationRef.dispatch({ type: 'POP_TO_TOP', target: stack.key });
  }
}
