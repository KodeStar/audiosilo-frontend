import { act, fireEvent, screen } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

// --- router -------------------------------------------------------------------------
const mockDispatch = jest.fn();
const mockRouter = { navigate: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({
  useSegments: () => ['(app)', '(home)'],
  useNavigationContainerRef: () => ({ dispatch: mockDispatch }),
  get router() {
    return mockRouter;
  },
}));

jest.mock('@/lib/layout', () => ({ useLayout: () => 'desktop' }));
jest.mock('@/downloads/engine', () => ({ engine: { supported: true } }));
jest.mock('@/api/provider', () => ({
  useApi: () => ({ coverUrl: () => 'https://x/cover', authHeaders: () => ({}) }),
  useApis: () => [{ connection: { id: 'c1', name: 'Hearthside' } }],
}));

const mockSetPref = jest.fn();
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({
    scheme: 'light',
    pref: 'light',
    setPref: mockSetPref,
    // The provider's toggle, over the mocked setPref.
    toggleScheme: () => mockSetPref('dark'),
  }),
}));

const mockHolmes = {
  connectionId: 'c1',
  connectionName: 'Hearthside',
  library_id: 1,
  rel_path: 'Doyle/The Adventures of Sherlock Holmes',
  title: 'The Adventures of Sherlock Holmes',
  author: 'Arthur Conan Doyle',
};
const mockHound = {
  ...mockHolmes,
  rel_path: 'Doyle/The Hound',
  title: 'The Hound of the Baskervilles',
};
const mockSource = { connectionId: 'c1', connectionName: 'Hearthside', libraryId: 1 };
const mockIdle = { supported: true, isLoading: false, isError: false, retry: jest.fn() };
// The search model has its own tests (search-model.test.ts): here, what it hands over.
const mockSearch = jest.fn((q: string, _opts?: unknown) => {
  const lower = q.toLowerCase();
  const holmes = lower.includes('holmes');
  const dresden = lower.includes('dres');
  return {
    books: holmes
      ? [
          { ...mockHolmes, also: [] },
          { ...mockHound, also: [] },
        ]
      : [],
    booksState: mockIdle,
    series: dresden
      ? [
          {
            name: 'The Dresden Files',
            author: 'Jim Butcher',
            books: 4,
            duration: 1,
            positions: [],
            source: mockSource,
            also: [],
          },
        ]
      : [],
    authors: holmes
      ? [{ name: 'Sherlock Holmes Society', books: 2, duration: 1, source: mockSource, also: [] }]
      : [],
    narrators: [],
    peopleState: mockIdle,
    characters: dresden
      ? {
          hits: [
            {
              key: 'k1',
              name: 'Harry Dresden',
              role: 'protagonist',
              bookTitle: 'Storm Front',
              connectionId: 'c1',
              libraryId: 1,
              path: 'Butcher/Storm Front',
            },
          ],
          total: 1,
          hidden: 2,
          attributions: [],
        }
      : { hits: [], total: 0, hidden: 0, attributions: [] },
    charactersState: mockIdle,
    settled: true,
    total: 0,
  };
});
jest.mock('@/components/search/use-search', () => ({
  useSearch: (q: string, opts: unknown) => mockSearch(q, opts),
}));

const mockProgressOptions = jest.fn();
jest.mock('@/api/hooks', () => ({
  // One server, libraries unnamed: no source line (useSourceLabeller has its own tests).
  useSourceLabeller: () => () => undefined,
  useAllProgressAll: (options: unknown) => ({
    _: mockProgressOptions(options),
    progress: [
      {
        connectionId: 'c1',
        connectionName: 'Hearthside',
        library_id: 1,
        path: 'Carroll/Alice',
        position: 300,
        duration: 1200,
        finished: false,
        updated_at: '2026-10-05T10:00:00Z',
      },
    ],
    isLoading: false,
    error: null,
  }),
}));

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

const mockStartDuration = jest.fn();
const mockStartChapterTimer = jest.fn();
jest.mock('@/playback/sleep-timer', () => ({
  useSleepTimer: {
    getState: () => ({
      startDuration: mockStartDuration,
      startChapterTimer: mockStartChapterTimer,
    }),
  },
}));

jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  const chapter = { index: 0, title: 'Stave One' };
  const usePlayer = create(() => ({
    nowPlaying: {
      connectionId: 'c1',
      title: 'A Christmas Carol',
      queue: { chapters: [{ index: 0, title: 'Stave One' }] },
    },
    snapshot: { state: 'paused' },
    toggle: jest.fn(),
  }));
  return {
    usePlayer,
    selectIsPlaying: (s: { snapshot: { state: string } }) => s.snapshot.state === 'playing',
    selectCurrentChapter: () => chapter,
  };
});

/* eslint-disable import/first */
import { useRecentSearches } from '@/stores/search';
import { useSession } from '@/stores/session';

import { CommandPalette } from './command-palette';
import { usePalette } from './palette-store';
/* eslint-enable import/first */

const keyPress = (key: string) =>
  fireEvent(screen.getByTestId('palette-input'), 'keyPress', {
    nativeEvent: { key },
    preventDefault: jest.fn(),
  });

async function openWith(query = '') {
  await mountWithPortal(<CommandPalette />);
  await act(async () => usePalette.getState().openPalette());
  if (query) {
    await fireEvent.changeText(screen.getByTestId('palette-input'), query);
    // The search waits for the typing to settle.
    await act(async () => {
      jest.advanceTimersByTime(250);
    });
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  usePalette.setState({ open: false, query: '' });
  useRecentSearches.setState({ recent: [] });
  useSession.setState({
    connections: [{ id: 'c1', name: 'Hearthside', serverUrl: 'u', token: 't', user: {} as never }],
    defaultConnectionId: 'c1',
  });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('CommandPalette', () => {
  it('opens on actions, Continue listening and Go to, as a combobox over a listbox', async () => {
    await openWith();
    // (React Native's host input keeps role/aria-expanded; aria-activedescendant and
    // aria-controls reach the DOM on web only, so the option ids are checked instead.)
    const input = screen.getByTestId('palette-input');
    expect(input).toHaveProp('role', 'combobox');
    expect(input).toHaveProp('aria-expanded', true);
    expect(screen.getAllByRole('option')[0]).toHaveProp('nativeID', 'palette-option-0');
    expect(screen.getAllByRole('option')[0]).toBeSelected();
    expect(screen.getByText('Resume Stave One')).toBeTruthy();
    expect(screen.getByText('Sleep in 30 minutes')).toBeTruthy();
    expect(screen.getByText('Sleep at end of chapter')).toBeTruthy();
    expect(screen.getByLabelText('Continue listening')).toHaveProp('role', 'group');
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('25% listened')).toBeTruthy();
    expect(screen.getByLabelText('Go to')).toBeTruthy();
    // Six actions, one book in progress, three destinations.
    expect(screen.getByText('10 results · Hearthside')).toBeTruthy();
  });

  it('searches books, moves with the arrows and opens the active one with Enter', async () => {
    await openWith('holmes');
    expect(screen.getByLabelText('Books')).toHaveProp('role', 'group');
    expect(
      screen.getByLabelText('The Adventures of Sherlock Holmes, Arthur Conan Doyle'),
    ).toBeTruthy();
    const options = screen.getAllByRole('option');
    // Two books, then one author.
    expect(options).toHaveLength(3);
    expect(options[0]).toBeSelected();
    expect(screen.getByLabelText('Authors')).toHaveProp('role', 'group');

    await keyPress('ArrowDown');
    expect(screen.getAllByRole('option')[1]).toBeSelected();
    await keyPress('ArrowDown');
    await keyPress('ArrowDown'); // clamped at the end
    expect(screen.getAllByRole('option')[2]).toBeSelected();
    await keyPress('ArrowUp');
    await keyPress('ArrowUp');
    await keyPress('ArrowDown');

    await keyPress('Enter');
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/book/[libraryId]',
      params: { libraryId: '1', connection: 'c1', path: 'Doyle/The Hound' },
    });
    expect(usePalette.getState().open).toBe(false);
    expect(useRecentSearches.getState().recent).toEqual(['holmes']);
  });

  it("bolds the match at the line's own label size", async () => {
    await openWith('holmes');
    // Two books carry "Holmes"; both highlights are label-sized (a bare nested <Text>
    // fell back to the larger `body` size).
    const [match] = screen.getAllByText('Holmes');
    const classes = String(match.props.className);
    expect(classes).toContain('font-sans-bold');
    expect(classes).toContain('text-brand-ink');
    expect(classes).toContain('text-sm');
    expect(classes).not.toContain('text-base');
  });

  it('reads Continue listening from the cache, and not at all while a query is typed', async () => {
    await openWith();
    expect(mockProgressOptions).toHaveBeenLastCalledWith({
      enabled: true,
      refetchOnMount: false,
    });
    await fireEvent.changeText(screen.getByTestId('palette-input'), 'holmes');
    await act(async () => jest.runOnlyPendingTimers());
    expect(mockProgressOptions).toHaveBeenLastCalledWith({
      enabled: false,
      refetchOnMount: false,
    });
  });

  it('runs the sleep action and confirms it with a toast', async () => {
    await openWith('30 min');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await keyPress('Enter');
    expect(mockStartDuration).toHaveBeenCalledWith(30);
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Sleep in 30 minutes',
      description: 'Fades out over the last 30 seconds',
    });
  });

  it('goes to a tab with JUMP_TO and switches the appearance', async () => {
    await openWith('library');
    await keyPress('Enter');
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'JUMP_TO',
      payload: { name: '(library)' },
    });

    await act(async () => usePalette.getState().openPalette());
    await fireEvent.changeText(screen.getByTestId('palette-input'), 'dark');
    await fireEvent.press(screen.getByText('Switch to dark appearance'));
    expect(mockSetPref).toHaveBeenCalledWith('dark');
  });

  it('says so when nothing matches, and offers recent searches on an empty query', async () => {
    useRecentSearches.setState({ recent: ['holmes'] });
    await openWith('zebra');
    expect(screen.getByText('Nothing called "zebra"')).toBeTruthy();
    expect(screen.getByText('0 results · Hearthside')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('palette-input'), '');
    await fireEvent.press(screen.getByText('holmes'));
    expect(usePalette.getState().query).toBe('holmes');
  });

  it('searches with the shared model, three of each named group, from the cached progress', async () => {
    await openWith('holmes');
    expect(mockSearch).toHaveBeenLastCalledWith('holmes', { limit: 3, refetchProgress: false });
  });

  it('lists series and met characters, and only counts the others (not an option)', async () => {
    await openWith('dres');
    expect(screen.getByLabelText('Series')).toHaveProp('role', 'group');
    expect(screen.getByLabelText('The Dresden Files, 4 books · Jim Butcher')).toBeTruthy();
    expect(screen.getByLabelText('Harry Dresden, Protagonist · Storm Front')).toBeTruthy();
    expect(screen.getByText('2 more match after your place in the book')).toBeTruthy();
    expect(screen.getByText('Hidden to avoid spoilers')).toBeTruthy();
    // The series and the character are the options; the count is not one.
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('2 results · Hearthside')).toBeTruthy();

    await keyPress('ArrowDown');
    await keyPress('Enter');
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/book/[libraryId]',
      params: { libraryId: '1', connection: 'c1', path: 'Butcher/Storm Front' },
    });
  });
});
