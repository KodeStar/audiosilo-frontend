import { act, fireEvent, render, screen } from '@testing-library/react-native';

const mockRouter = { push: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => ({ coverUrl: () => 'https://s/cover', authHeaders: () => ({}) }),
  useApis: () => [
    { connection: { id: 'a', name: 'Home Library' } },
    { connection: { id: 'b', name: "Maya's Shelf" } },
  ],
}));
let mockCaps: { browse_people?: boolean; collections?: boolean } | undefined = {
  browse_people: true,
  collections: true,
};
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({ data: { capabilities: {} } }),
  useCapability: (flag: 'browse_people' | 'collections') =>
    mockCaps === undefined ? undefined : !!mockCaps[flag],
  useAuthors: () => ({ data: { people: [{}, {}, {}], unknown: 0 } }),
  useNarrators: () => ({ data: undefined }),
  useSeriesList: () => ({ data: [{}, {}] }),
  useCollections: () => ({ data: [{}] }),
  useAllProgressAll: () => ({ progress: [], isLoading: false, error: null }),
}));
jest.mock('@/components/library/use-selected-library', () => ({
  useSelectedLibrary: () => ({
    selection: { connectionId: 'a', libraryId: 1 },
    library: { id: 1, name: 'Books' },
    groups: [{ libraries: [{ id: 1 }, { id: 2 }] }],
    isLoading: false,
  }),
}));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'desktop',
}));

const source = { connectionId: 'a', connectionName: 'Home Library', libraryId: 1 };
const idle = () => ({ supported: true, isLoading: false, isError: false, retry: jest.fn() });
type Results = Record<string, unknown>;
const empty = (): Results => ({
  books: [],
  booksState: idle(),
  series: [],
  authors: [],
  narrators: [],
  peopleState: idle(),
  characters: { hits: [], total: 0, hidden: 0, attributions: [] },
  charactersState: idle(),
  settled: true,
  total: 0,
});
let mockResults: Results = empty();
const mockUseSearch = jest.fn((_q: string) => mockResults);
jest.mock('./use-search', () => ({ useSearch: (q: string) => mockUseSearch(q) }));

/* eslint-disable import/first */
import { useRecentSearches, useSearchStore } from '@/stores/search';
import { useSession } from '@/stores/session';

import { SearchScreen } from './search-screen';
/* eslint-enable import/first */

async function type(text: string) {
  await fireEvent.changeText(screen.getByTestId('search-input'), text);
  await act(async () => {
    jest.advanceTimersByTime(350);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockCaps = { browse_people: true, collections: true };
  mockResults = empty();
  useSearchStore.setState({ query: '' });
  useRecentSearches.setState({ recent: [] });
  useSession.setState({ defaultConnectionId: 'a' });
});
afterEach(() => jest.useRealTimers());

describe('SearchScreen, nothing typed', () => {
  it('offers the recent searches and the Browse cards with the library counts', async () => {
    useRecentSearches.setState({ recent: ['kaladin'] });
    await render(<SearchScreen />);
    expect(screen.getByText('Recent searches')).toBeTruthy();
    expect(screen.getByText('In Books')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Authors, 3' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Series, 2' })).toBeTruthy();
    // Narrators still loading: named without a count.
    expect(screen.getByRole('button', { name: 'Narrators' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collections, 1' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Series, 2' }));
    expect(mockRouter.navigate).toHaveBeenCalledWith({
      pathname: '/library',
      params: { mode: 'series' },
    });

    await fireEvent.press(screen.getByRole('button', { name: 'Search for kaladin' }));
    expect(useSearchStore.getState().query).toBe('kaladin');
  });

  it('leaves out cards the server lacks, prompts with nothing to offer, and waits for /server', async () => {
    mockCaps = { browse_people: false, collections: false };
    await render(<SearchScreen />);
    expect(screen.getByText('Find your next listen')).toBeTruthy();
    expect(screen.queryByText('Browse')).toBeNull();

    mockCaps = undefined;
    await render(<SearchScreen />);
    expect(screen.queryByText('Find your next listen')).toBeNull();
    expect(screen.queryByText('Browse')).toBeNull();
  });

  it('clears the recent searches', async () => {
    useRecentSearches.setState({ recent: ['kaladin', 'amos'] });
    await render(<SearchScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Clear recent searches' }));
    expect(useRecentSearches.getState().recent).toEqual([]);
  });
});

describe('SearchScreen, results', () => {
  it('groups books, series, people and met characters, and only counts the others', async () => {
    mockResults = {
      ...empty(),
      books: [
        {
          connectionId: 'a',
          connectionName: 'Home Library',
          library_id: 1,
          rel_path: "Expanse/Caliban's War",
          title: "Caliban's War",
          author: 'James S. A. Corey',
          also: [{ connectionId: 'b', connectionName: "Maya's Shelf" }],
        },
      ],
      series: [
        {
          name: 'The Expanse',
          author: 'James S. A. Corey',
          books: 4,
          duration: 1,
          positions: [],
          source,
          also: [],
        },
      ],
      authors: [{ name: 'James S. A. Corey', books: 4, duration: 1, source, also: [] }],
      characters: {
        hits: [
          {
            key: 'k',
            name: 'Praxidike Meng',
            role: 'supporting',
            bookTitle: "Caliban's War",
            connectionId: 'a',
            libraryId: 1,
            path: "Expanse/Caliban's War",
          },
        ],
        total: 1,
        hidden: 2,
        attributions: [
          {
            credit: 'AudioSilo Meta contributors',
            license: 'CC BY-SA 4.0',
            license_url: '',
            source_url: '',
          },
        ],
      },
      total: 4,
    };
    await render(<SearchScreen />);
    await type('  meng ');
    expect(mockUseSearch).toHaveBeenLastCalledWith('meng');
    expect(
      screen.getByText('4 results for "meng" across Home Library + Maya\'s Shelf'),
    ).toBeTruthy();

    await fireEvent(screen.getByTestId('search-books'), 'layout', {
      nativeEvent: { layout: { width: 900 } },
    });
    expect(
      screen.getByRole('button', { name: "Caliban's War, Also on Maya's Shelf" }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'The Expanse, Series, 4 books · James S. A. Corey, Home Library',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'James S. A. Corey, Author, 4 books, Home Library' }),
    ).toBeTruthy();
    expect(screen.getByText("Only people you've already met")).toBeTruthy();
    expect(
      screen.getByText('2 more match after your place in the book, hidden to avoid spoilers.'),
    ).toBeTruthy();
    expect(screen.getByText('AudioSilo Meta contributors · CC BY-SA 4.0')).toBeTruthy();

    // Opening a result opens the book and keeps the search.
    await fireEvent.press(
      screen.getByRole('button', { name: "Praxidike Meng, Supporting · Caliban's War" }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/book/[libraryId]',
      params: { libraryId: '1', connection: 'a', path: "Expanse/Caliban's War" },
    });
    expect(useRecentSearches.getState().recent).toEqual(['meng']);
  });

  it('says when nothing matches, once every group has answered', async () => {
    mockResults = { ...empty(), settled: false };
    await render(<SearchScreen />);
    await type('zebra');
    expect(screen.getByText('Searching')).toBeTruthy();
    expect(screen.queryByText('Nothing called "zebra" on your servers')).toBeNull();

    mockResults = empty();
    await type('zebras');
    expect(screen.getByText('Nothing called "zebras" on your servers')).toBeTruthy();
  });

  it("shows a group's failure with Retry, without hiding the others", async () => {
    const retry = jest.fn();
    mockResults = {
      ...empty(),
      authors: [{ name: 'Jim Butcher', books: 7, duration: 1, source, also: [] }],
      charactersState: { supported: true, isLoading: false, isError: true, retry },
      total: 1,
    };
    await render(<SearchScreen />);
    await type('jim');
    expect(screen.getByText('Jim Butcher')).toBeTruthy();
    expect(screen.getByText("Characters couldn't be checked just now.")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });
});
