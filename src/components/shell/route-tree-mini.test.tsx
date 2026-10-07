import { act } from '@testing-library/react-native';
import { renderRouter, screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { useShellMetrics } from '@/components/shell/shell-metrics';
import { nav, realRouteTree, router } from '@/testing/route-tree';

// The REAL native `(app)` layout and the REAL tab-stack layout over the real route tree,
// NativeTabs swapped for expo-router's JS Tabs (which also keeps visited tabs mounted).
// The floating mini player belongs to the `(app)` layout, once, not to each tab stack.
jest.mock('expo-router/unstable-native-tabs', () => {
  const { Tabs } = jest.requireActual('expo-router');
  const Stub = () => null;
  const NativeTabs = Object.assign(() => <Tabs screenOptions={{ headerShown: false }} />, {
    Trigger: Object.assign(Stub, { Icon: Stub, Label: Stub }),
    BottomAccessory: Stub,
  });
  return { NativeTabs };
});
let mockAccessory = false;
jest.mock('@/components/shell/accessory-support', () => ({
  get ACCESSORY_SUPPORTED() {
    return mockAccessory;
  },
}));
jest.mock('@/components/shell/auth-gate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/components/shell/use-shell-effects', () => ({ useShellEffects: () => {} }));
jest.mock('@/components/shell/phone-header', () => ({ PhoneHeader: () => null }));
// The shell's other chrome (wide-only, or the iOS 26 accessory) has its own suites.
jest.mock('@/components/shell/accessory-player', () => ({ AccessoryPlayer: () => null }));
jest.mock('@/components/shell/docked-player', () => ({ DockedPlayer: () => null }));
jest.mock('@/components/shell/drawer-slot', () => ({ DrawerSlot: () => null }));
jest.mock('@/components/shell/wide-top', () => ({ WideTop: () => null }));
jest.mock('@/components/upnext/up-next-sheet', () => ({ UpNextSheet: () => null }));
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return { usePlayer: create(() => ({ nowPlaying: { title: 'A Christmas Carol' } })) };
});
// (expo-router's testing library swaps reanimated for a mock the overlays can't load.)
jest.mock('@/components/ui/overlay', () => ({
  useRootFrame: () => ({ x: 0, y: 0, width: 400, height: 800 }),
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'phone',
}));
const mockMounts = jest.fn();
jest.mock('@/components/player/mini-player', () => {
  const { useEffect } = jest.requireActual('react');
  const { Text: RNText } = jest.requireActual('react-native');
  const { useShellMetrics: metrics } = jest.requireActual('@/components/shell/shell-metrics');
  function MiniPlayer({ bottomOffset }: { bottomOffset?: number }) {
    useEffect(() => mockMounts(), []);
    return <RNText testID="mini-player">{`bottom ${bottomOffset}`}</RNText>;
  }
  return {
    MiniPlayer,
    // The real gate: nothing until the bar has been measured.
    FloatingMiniPlayer: () => {
      const bar = metrics((s: { edges: { bar?: number } }) => s.edges.bar);
      return bar === undefined ? null : <MiniPlayer bottomOffset={bar} />;
    },
    useMiniPlayerInset: () => 16,
  };
});

/* eslint-disable import/first */
import AppLayout from '@/app/(app)/_layout';
import TabStackLayout, {
  unstable_settings as tabStackSettings,
} from '@/app/(app)/(home,library,search,offline,me)/_layout';
/* eslint-enable import/first */

function tree() {
  const routes = realRouteTree();
  routes['(app)/_layout'] = AppLayout;
  for (const k of Object.keys(routes)) {
    if (k.endsWith('(home,library,search,offline,me)/_layout')) {
      routes[k] = { default: TabStackLayout, unstable_settings: tabStackSettings };
    }
  }
  return routes;
}

beforeEach(() => {
  mockAccessory = false;
  mockMounts.mockClear();
  useShellMetrics.setState({ edges: {} });
});

it('mounts ONE floating mini player across every visited tab and a pushed page', async () => {
  await (renderRouter(tree(), { initialUrl: '/' }) as unknown as Promise<unknown>);
  // Nothing until the native bar has been measured (a tab stack's layout publishes it).
  expect(screen.queryByTestId('mini-player', { includeHiddenElements: true })).toBeNull();
  await act(async () => useShellMetrics.setState({ edges: { bar: 80 } }));

  for (const url of ['/library', '/search', '/downloads', '/settings', '/'] as const) {
    await nav(() => router.navigate(url));
  }
  await nav(() => router.push('/book/1?connection=c&path=x'));
  // Counting the inactive tabs too, which the JS tab navigator keeps mounted but hidden.
  expect(screen.getAllByTestId('mini-player', { includeHiddenElements: true })).toHaveLength(1);
  expect(screen.getByTestId('mini-player')).toHaveTextContent('bottom 80');
  // Never remounted by a tab switch (its entrance would replay).
  expect(mockMounts).toHaveBeenCalledTimes(1);
});

it('floats no card where the iOS 26 tab bar hosts the mini player in its accessory', async () => {
  mockAccessory = true;
  await (renderRouter(tree(), { initialUrl: '/' }) as unknown as Promise<unknown>);
  await act(async () => useShellMetrics.setState({ edges: { bar: 80 } }));
  await nav(() => router.navigate('/library'));
  await nav(() => router.push('/book/1?connection=c&path=x'));
  expect(screen.queryByTestId('mini-player', { includeHiddenElements: true })).toBeNull();
  expect(mockMounts).not.toHaveBeenCalled();
});
