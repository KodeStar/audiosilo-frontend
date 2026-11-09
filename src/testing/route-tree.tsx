import { Stack, Tabs, router } from 'expo-router';
import { getRouteInfoFromState } from 'expo-router/build/global-state/getRouteInfoFromState';
import { act } from 'expo-router/testing-library';
import type { ComponentType } from 'react';
import { Text } from 'react-native';

import { TAB_STACK_SETTINGS, TABS, tabStackListeners } from '@/components/shell/destinations';
import { currentNavState } from '@/lib/root-stack';
import { navigationRef } from '@/lib/router-ref';

// Node's fs/path, typed by hand: the app's tsconfig carries no Node types.
type DirEntry = { name: string; isDirectory: () => boolean };
const fs = jest.requireActual<{
  readdirSync: (dir: string, options: { withFileTypes: true }) => DirEntry[];
}>('fs');
const path = jest.requireActual<{
  join: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
}>('path');

// Jest runs from the repo root (`npm test`).
const APP = path.join(process.cwd(), 'src', 'app');

type RouteModule = ComponentType | { default: ComponentType; unstable_settings?: unknown };

/**
 * expo-router's JS `Tabs` standing in for the shell's tab navigator, its five tabs
 * declared as the real shells declare them (NativeTabs triggers, the web's `TabTrigger`s):
 * since expo-router 58 a tab navigator shows only the screens its layout declares.
 */
export function JsTabs() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      {TABS.map((d) => (
        <Tabs.Screen key={d.name} name={d.name} />
      ))}
    </Tabs>
  );
}

/**
 * The REAL `src/app` route tree as an expo-router `renderRouter` context: every file the
 * app ships, with each screen stubbed (its route key as text) and each layout replaced by
 * a plain JS navigator of the same shape - the root and tab stacks by `Stack`, the
 * `(app)` NativeTabs / headless web Tabs by `Tabs`. The tab stacks keep their real
 * `unstable_settings` (the per-tab `anchor`, which decides cold deep links) and
 * their real `screenListeners`.
 * A route file moved or renamed under `src/app` changes this tree, so the navigation
 * tests below run against what ships rather than a hand-copied list.
 */
export function realRouteTree(): Record<string, RouteModule> {
  const keys: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      // Platform variants (`_layout.web.tsx`) share their route with the base file.
      else if (/\.tsx$/.test(e.name) && !/\.(web|native|ios|android)\.tsx$/.test(e.name)) {
        // `+not-found` is a route (any address without a page); `+html` and `+native-intent` are not.
        if (!e.name.startsWith('+') || e.name === '+not-found.tsx')
          keys.push(path.relative(APP, p).replace(/\.tsx$/, ''));
      }
    }
  };
  walk(APP);
  keys.sort();
  const plainStack = () => <Stack screenOptions={{ headerShown: false }} />;
  // The tab stacks keep their real listeners (the cold-link param cleanup).
  const tabStack = () => (
    <Stack screenOptions={{ headerShown: false }} screenListeners={tabStackListeners} />
  );
  const tree: Record<string, RouteModule> = {};
  for (const k of keys) {
    // The root keeps its real `anchor`: `(app)` always sits at the bottom of the root stack.
    if (k === '_layout') tree[k] = { default: plainStack, unstable_settings: { anchor: '(app)' } };
    else if (k === '(app)/_layout') {
      tree[k] = JsTabs;
    } else if (k.endsWith('(home,library,search,offline,me)/_layout')) {
      tree[k] = { default: tabStack, unstable_settings: TAB_STACK_SETTINGS };
    } else if (k.endsWith('_layout')) tree[k] = plainStack;
    else tree[k] = () => <Text>{k}</Text>;
  }
  return tree;
}

/** The router's whole navigation state now (expo-router's `__root` route first), or
 * undefined before it is ready: the app's own reader (`root-stack.ts`). */
export const rootState = currentNavState;

const names = (routes: { name: string }[] | undefined): string[] =>
  (routes ?? []).map((r) => r.name);

/** The root stack's route names (under expo-router's `__root`). */
export const rootRoutes = (): string[] => names(rootState()?.routes[0]?.state?.routes);

/** The route names on root route `parent`'s stack (`connect`), empty before it has a state. */
export const stackRoutes = (parent: string): string[] =>
  names(rootState()?.routes[0]?.state?.routes.find((r) => r.name === parent)?.state?.routes);

/** The route names on the shell's `tab` stack (`(me)`), empty before it has a state. */
export const tabStack = (tab: string): string[] =>
  names(
    rootState()
      ?.routes[0]?.state?.routes.find((r) => r.name === '(app)')
      ?.state?.routes.find((r) => r.name === tab)?.state?.routes,
  );

/** Where the router is now: its route info, read off the container the way the router's
 * own testing library does (`renderRouter`'s helpers sit on a result the tests drop). */
export const routeInfo = () => getRouteInfoFromState(navigationRef.getRootState());

/** Drive the global router inside an awaited act, so the navigation commits first. */
export const nav = (fn: () => void) => act(async () => fn());

export { navigationRef, router };
