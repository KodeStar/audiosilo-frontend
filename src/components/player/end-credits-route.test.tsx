// The screen loads first: importing expo-router's testing library re-mocks reanimated
// with an empty module, which the screen's overlays and skeletons cannot load against.
import FinishedScreen from '@/app/finished';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { store } from 'expo-router/build/global-state/router-store';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { finishedHref } from '@/lib/paths';
import { currentNavState, topRootRoute } from '@/lib/root-stack';
import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

// The credits' View details, pressed on the REAL `/finished` screen over the real route
// tree: the book's page opens in the ONE app shell under the credits, in the tab the
// listener was on. A `router.replace` from this root route stacked a second `(app)` shell
// (two docks, two sheet hosts, every shortcut firing twice).

jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
// No API client: nothing resolves an Up next (the end-of-series card) or loads history.
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => null,
  useCid: (id?: string) => id || 'c',
  ConnectionScope: ({ children }: { children: unknown }) => children,
}));
jest.mock('@/api/hooks', () => {
  const { CapabilityError, historyQuery } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    historyQuery,
    useCapability: () => undefined,
    useBook: () => ({ data: { title: 'The Way of Kings', author: 'Brandon Sanderson' } }),
    useBookMeta: () => ({ data: undefined }),
    useBookProgress: () => ({ data: undefined }),
    useMyStats: () => ({ data: undefined, isLoading: false }),
    useAllProgressAll: () => ({ progress: [] }),
    useRating: () => ({ data: null }),
    useMyRatings: () => ({ data: [], isError: false }),
    useSetRating: () => ({ mutateAsync: jest.fn(), isPending: false }),
  };
});
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    selectBookPosition: () => 0,
    usePlayer: create(() => ({ nowPlaying: null, snapshot: { state: 'idle' }, rate: 1 })),
  };
});

type Route = { name: string; state?: { index?: number; routes: Route[] } };
/** The root stack's routes (under expo-router's `__root`). */
const rootRoutes = () =>
  ((store.state?.routes[0] as Route | undefined)?.state?.routes ?? []).map((r) => r.name);
/** The routes of the shell's `tab` stack. */
const tabStack = (tab: string) => {
  const shell = (store.state?.routes[0] as Route).state!.routes[0];
  const stack = shell.state?.routes.find((r) => r.name === tab);
  return (stack?.state?.routes ?? []).map((r) => r.name);
};

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

async function mount(initialUrl: string) {
  const routes = realRouteTree();
  routes.finished = () => (
    <QueryClientProvider client={queryClient}>
      <FinishedScreen />
    </QueryClientProvider>
  );
  await (renderRouter(routes, { initialUrl }) as unknown as Promise<unknown>);
}

it('opens the book page from the credits in the one shell underneath, and Back returns', async () => {
  await mount('/search');
  await nav(() => router.push(finishedHref('c', 1, 'Sanderson/The Way of Kings')));
  expect(topRootRoute(currentNavState())).toBe('finished');

  await nav(() => fireEvent.press(screen.getByText('View details')));
  expect(rootRoutes()).toEqual(['(app)']);
  expect(routeInfo().segments.slice(0, 2)).toEqual(['(app)', '(search)']);
  expect(tabStack('(search)')).toEqual(['search', 'book/[libraryId]']);
  expect(routeInfo().params).toMatchObject({
    connection: 'c',
    libraryId: '1',
    path: 'Sanderson/The Way of Kings',
  });

  // Back returns to the page the credits were opened over.
  await nav(() => router.back());
  expect(rootRoutes()).toEqual(['(app)']);
  expect(routeInfo().pathname).toBe('/search');
});
