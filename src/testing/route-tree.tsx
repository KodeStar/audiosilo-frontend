import { Stack, Tabs, router } from 'expo-router';
import { store } from 'expo-router/build/global-state/router-store';
import { act } from 'expo-router/testing-library';
import type { ComponentType } from 'react';
import { Text } from 'react-native';

import { TAB_STACK_SETTINGS, tabStackListeners } from '@/components/shell/destinations';

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
 * The REAL `src/app` route tree as an expo-router `renderRouter` context: every file the
 * app ships, with each screen stubbed (its route key as text) and each layout replaced by
 * a plain JS navigator of the same shape - the root and tab stacks by `Stack`, the
 * `(app)` NativeTabs / headless web Tabs by `Tabs`. The tab stacks keep their real
 * `unstable_settings` (the per-tab `initialRouteName`, which decides cold deep links) and
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
        if (!e.name.startsWith('+')) keys.push(path.relative(APP, p).replace(/\.tsx$/, ''));
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
      tree[k] = () => <Tabs screenOptions={{ headerShown: false }} />;
    } else if (k.endsWith('(home,library,search,offline,me)/_layout')) {
      tree[k] = { default: tabStack, unstable_settings: TAB_STACK_SETTINGS };
    } else if (k.endsWith('_layout')) tree[k] = plainStack;
    else tree[k] = () => <Text>{k}</Text>;
  }
  return tree;
}

/** Where the router is now (RNTL 14 broke `renderRouter`'s own helpers: read the store). */
export const routeInfo = () => store.getRouteInfo();

/** Drive the global router inside an awaited act, so the navigation commits first. */
export const nav = (fn: () => void) => act(async () => fn());

export { router };
