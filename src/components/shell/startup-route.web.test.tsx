import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { act, renderRouter } from 'expo-router/testing-library';
import { create } from 'zustand';

import { bookHref } from '@/lib/paths';
import { nav, rootRoutes, router } from '@/testing/route-tree';

import { resetStartupQueries } from './startup-queries';
import { useStartupQueries } from './use-startup-queries.web';

const mockServer = jest.fn(async () => ({ capabilities: {} }));
const mockRecent = jest.fn(async () => []);
jest.mock('@/api/provider', () =>
  jest.requireActual('@/testing/api-provider-mock').apiProviderMock({
    c: {
      serverInfo: () => mockServer(),
      libraries: async () => [],
      recentBooks: () => mockRecent(),
    },
  }),
);
jest.mock('@/playback/store', () => ({ usePlayer: { getState: () => ({ nowPlaying: null }) } }));

it('holds the anchored Home through sign-in and opens the book the listener came for', async () => {
  resetStartupQueries();
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const useAuth = create(() => ({ signedIn: false }));
  const home = jest.fn(() => null);
  const book = jest.fn(() => null);
  function AppLayout() {
    const signedIn = useAuth((state) => state.signedIn);
    const ready = useStartupQueries(signedIn);
    return signedIn && ready ? <Stack /> : null;
  }
  const tree = {
    _layout: {
      unstable_settings: { anchor: '(app)' },
      default: () => (
        <QueryClientProvider client={client}>
          <Stack />
        </QueryClientProvider>
      ),
    },
    '(app)/_layout': AppLayout,
    '(app)/index': home,
    '(app)/book/[libraryId]': book,
    'connect/_layout': () => <Stack />,
    'connect/index': () => null,
  };

  await (renderRouter(tree, { initialUrl: '/connect' }) as unknown as Promise<unknown>);
  expect(rootRoutes()).toEqual(['(app)', 'connect']);
  await act(async () => useAuth.setState({ signedIn: true }));
  expect(home).not.toHaveBeenCalled();
  expect(mockServer).not.toHaveBeenCalled();

  await nav(() => router.dismissTo(bookHref('c', 2, 'A/B')));
  expect(mockServer).toHaveBeenCalledTimes(1);
  expect(mockRecent).not.toHaveBeenCalled();
  expect(book).toHaveBeenCalled();
});
