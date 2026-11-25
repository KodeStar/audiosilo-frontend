/**
 * @jest-environment ./src/testing/jsdom-environment.js
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

let mockPathname = '/';
let mockRoot = '(app)';
let mockMode: string | string[] | undefined;
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  useSegments: () => [mockRoot],
  useGlobalSearchParams: () => ({ mode: mockMode }),
}));
jest.mock('@/playback/store', () => ({ usePlayer: { getState: () => ({ nowPlaying: null }) } }));

// One server, answering when the test says (the page is `/`: Home).
let release!: () => void;
const gate = new Promise<void>((r) => (release = r));
const answer =
  <T,>(value: T) =>
  async () => {
    await gate;
    return value;
  };
const mockClient = {
  serverInfo: jest.fn(answer({ version: 'x', capabilities: {} })),
  libraries: jest.fn(answer([{ id: 1, name: 'Books' }])),
  allProgress: jest.fn(answer([])),
  recentBooks: jest.fn(answer([{ path: 'A/B' }])),
  favourites: jest.fn(answer([])),
};
jest.mock('@/api/provider', () =>
  // `require` because a jest.mock factory is hoisted above every import; the methods call
  // through, as `mockClient` is only defined once the module body runs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({
    c: {
      serverInfo: () => mockClient.serverInfo(),
      libraries: () => mockClient.libraries(),
      allProgress: () => mockClient.allProgress(),
      recentBooks: () => mockClient.recentBooks(),
      favourites: () => mockClient.favourites(),
    },
  }),
);

/* eslint-disable import/first */
import { qk, RECENT_LIMIT } from '@/api/hooks';

import { resetStartupQueries } from './startup-queries';
import { useStartupQueries } from './use-startup-queries.web';
/* eslint-enable import/first */

beforeEach(() => {
  resetStartupQueries();
  jest.clearAllMocks();
  mockPathname = '/';
  mockRoot = '(app)';
  mockMode = undefined;
});

function setup() {
  // No gc timers (jsdom keeps the 5-minute default), which would hold the test run open.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

it('holds the first screen until its answers are in, which land under the screens own keys', async () => {
  const { client, wrapper } = setup();
  const { result, rerender } = await renderHook(
    ({ open }: { open: boolean }) => useStartupQueries(open),
    {
      wrapper,
      initialProps: { open: false },
    },
  );
  // Not open yet (the session or the person still loading): nothing asked.
  expect(result.current).toBe(true);
  expect(mockClient.serverInfo).not.toHaveBeenCalled();

  await rerender({ open: true });
  expect(result.current).toBe(false);
  expect(mockClient.recentBooks).toHaveBeenCalledTimes(1);

  await act(async () => release());
  expect(result.current).toBe(true);
  expect(client.getQueryData(qk.recent('c', RECENT_LIMIT))).toEqual([{ path: 'A/B' }]);
  expect(client.getQueryData(qk.server('c'))).toEqual({ version: 'x', capabilities: {} });

  // Opening again (a later sign-in, a re-render) asks nothing more.
  await rerender({ open: false });
  await rerender({ open: true });
  expect(result.current).toBe(true);
  expect(mockClient.recentBooks).toHaveBeenCalledTimes(1);
});

it('saves the wait for Home after a sign-in on the same page load', async () => {
  const { wrapper } = setup();
  mockPathname = '/connect/ready';
  mockRoot = 'connect';
  window.history.replaceState({}, '', '/web/connect/ready');
  try {
    const { result, rerender } = await renderHook(
      ({ open }: { open: boolean }) => useStartupQueries(open),
      { wrapper, initialProps: { open: false } },
    );
    await rerender({ open: true });
    expect(result.current).toBe(false); // The anchored Home must not mount behind Connect.
    expect(mockClient.serverInfo).not.toHaveBeenCalled();

    mockPathname = '/';
    mockRoot = '(app)';
    await rerender({ open: true });
    expect(mockClient.recentBooks).toHaveBeenCalledTimes(1);
  } finally {
    window.history.replaceState({}, '', '/');
  }
});

it.each([
  { mode: ['authors', 'books'], books: false },
  { mode: '%E0', books: true },
])('uses the selected Library mode $mode', async ({ mode, books }) => {
  mockPathname = '/library';
  mockMode = mode;
  const { wrapper } = setup();
  await renderHook(() => useStartupQueries(true), { wrapper });
  expect(mockClient.serverInfo).toHaveBeenCalledTimes(1);
  expect(mockClient.allProgress).toHaveBeenCalledTimes(books ? 1 : 0);
  expect(mockClient.recentBooks).not.toHaveBeenCalled();
});

it('mounts the shell for a cold link to the full player', async () => {
  mockPathname = '/player';
  mockRoot = 'player';
  const { wrapper } = setup();
  const { result } = await renderHook(() => useStartupQueries(true), { wrapper });
  await act(async () => release());
  expect(result.current).toBe(true);
  expect(mockClient.serverInfo).toHaveBeenCalledTimes(1);
  expect(mockClient.recentBooks).not.toHaveBeenCalled();
});
