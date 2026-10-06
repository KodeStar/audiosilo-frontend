import { fireEvent, render, screen } from '@testing-library/react-native';

import type { Book, PeopleList } from '@/api/types';

const mockPush = jest.fn();
const mockSetParams = jest.fn();
// A tile's actions menu (book actions, the player) has its own tests.
jest.mock('@/components/library/tile-actions', () => ({ TileActions: () => null }));
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h), setParams: (p: unknown) => mockSetParams(p) },
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'desktop',
}));
jest.mock('@/api/provider', () => ({
  useCid: () => 'home',
  useOptionalApi: () => ({ coverUrl: () => 'https://s/c', authHeaders: () => ({}) }),
}));
jest.mock('@/stores/session', () => ({
  useSession: (sel: (s: unknown) => unknown) =>
    sel({ connections: [{ id: 'home', name: 'Home Library' }] }),
}));
let mockCaps: Record<string, boolean | undefined> = {};
let mockSeries: { isPending: boolean; data?: unknown; refetch: jest.Mock };
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({ data: { capabilities: {} } }),
  useCapability: (flag: string) => mockCaps[flag],
  useLibraryBooks: () => ({ data: undefined }),
  useSeriesList: () => mockSeries,
}));
let mockBooks: {
  books: Book[];
  isLoading: boolean;
  isIdle: boolean;
  error: unknown;
  refetch: jest.Mock;
};
jest.mock('./use-series-data', () => ({
  useAllLibraryBooks: () => mockBooks,
  useProgressLookup: () => ({ progressOf: () => undefined, isLoading: false }),
}));

/* eslint-disable import/first */
import { GhostCover } from '@/components/library/ghost-cover';
import { SeriesMode } from '@/components/library/modes/series-mode';

import { cardGridMetrics, cardRows } from './card-grid';
import { PeopleMode } from './people-mode';
import { PersonPage } from './person-page';
import { Spine } from './spine';
/* eslint-enable import/first */

const layoutEvent = { nativeEvent: { layout: { width: 1200, height: 800 } } };

beforeEach(() => {
  mockPush.mockClear();
  mockSetParams.mockClear();
  mockCaps = { browse_people: true };
});

describe('Spine', () => {
  it('is a button named by its full title, which picks it', async () => {
    const onPress = jest.fn();
    const title = 'The Remarkably Long and Occasionally Tedious Account of a Lighthouse Keeper';
    await render(
      <Spine
        title={title}
        position="1"
        width={26}
        height={180}
        scale={1}
        variant="book"
        onPress={onPress}
        accessibilityLabel={`Book 1, ${title}`}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: `Book 1, ${title}` }));
    expect(onPress).toHaveBeenCalled();
  });

  it('is decoration without a press (the mini shelves)', async () => {
    await render(<Spine title="Dune" width={30} height={180} scale={1} variant="ghost" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('GhostCover as a thumbnail', () => {
  it('drops the note below 100 wide but keeps it in the name', async () => {
    await render(<GhostCover title="Cibola Burn" position="4" width={72} />);
    expect(
      screen.getByRole('image', { name: 'Book 4, Cibola Burn, Not in your library' }),
    ).toBeTruthy();
    expect(screen.queryByText('Not in your library')).toBeNull();
  });
});

describe('cardRows / cardGridMetrics', () => {
  it('fits as many cards as the width allows, one or two on a phone', () => {
    expect(cardGridMetrics(1200, 'desktop', 300, 1).columns).toBe(3);
    expect(cardGridMetrics(370, 'phone', 300, 1).columns).toBe(1);
    expect(cardGridMetrics(370, 'phone', 176, 2).columns).toBe(2);
  });

  it('chunks rows, with A-Z heads only for a long list', () => {
    const names = ['Ann', 'Bob', 'Cy'];
    expect(
      cardRows(
        names,
        2,
        (n) => n,
        (n) => n,
      ).map((r) => r.kind),
    ).toEqual(['row', 'row']);
    const many = Array.from({ length: 70 }, (_, i) => (i < 35 ? `A${i}` : `B${i}`));
    const rows = cardRows(
      many,
      10,
      (n) => n,
      (n) => n,
    );
    expect(rows[0]).toEqual({ kind: 'head', letter: 'A' });
    expect(rows.filter((r) => r.kind === 'head')).toHaveLength(2);
  });
});

describe('PeopleMode', () => {
  const list = (data?: PeopleList, isPending = false) => ({
    data,
    isPending,
    refetch: jest.fn(),
  });

  it('shows placeholders while the list loads', async () => {
    await render(
      <PeopleMode kind="author" connectionId="home" libraryId={1} list={list(undefined, true)} />,
    );
    expect(screen.getByTestId('people-mode-loading')).toBeTruthy();
  });

  it('lists people, opens one, and counts the unnamed books', async () => {
    await render(
      <PeopleMode
        kind="narrator"
        connectionId="home"
        libraryId={1}
        list={list({ people: [{ name: 'Kate Reading', books: 2, duration: 7200 }], unknown: 3 })}
      />,
    );
    await fireEvent(screen.getByTestId('card-grid'), 'layout', layoutEvent);
    await fireEvent.press(screen.getByRole('button', { name: 'Kate Reading, 2 books · 2h' }));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/narrator',
      params: { connection: 'home', library: '1', name: 'Kate Reading' },
    });
    expect(screen.getByText('3 books have no narrator listed.')).toBeTruthy();
  });

  it('says when there is nobody, and goes back to the books', async () => {
    await render(
      <PeopleMode
        kind="author"
        connectionId="home"
        libraryId={1}
        list={list({ people: [], unknown: 0 })}
      />,
    );
    expect(screen.getByText('No authors here yet')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Browse books' }));
    expect(mockSetParams).toHaveBeenCalledWith({ mode: undefined });
  });

  it('offers Retry when the list fails', async () => {
    const failed = list(undefined, false);
    await render(<PeopleMode kind="author" connectionId="home" libraryId={1} list={failed} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(failed.refetch).toHaveBeenCalled();
  });
});

describe('SeriesMode', () => {
  it('lists the series, opening one', async () => {
    mockBooks = { books: [], isLoading: true, isIdle: false, error: null, refetch: jest.fn() };
    mockSeries = {
      isPending: false,
      data: [
        {
          name: 'Codex Alera',
          author: 'Jim Butcher',
          books: 3,
          duration: 15_300,
          positions: [1, 2, 4],
        },
      ],
      refetch: jest.fn(),
    };
    await render(<SeriesMode connectionId="home" libraryId={1} />);
    await fireEvent(screen.getByTestId('card-grid'), 'layout', layoutEvent);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Codex Alera, Jim Butcher · 4h 15m, 3 of 4' }),
    );
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/series',
      params: { connection: 'home', library: '1', name: 'Codex Alera' },
    });
  });

  it('has an empty state', async () => {
    mockSeries = { isPending: false, data: [], refetch: jest.fn() };
    await render(<SeriesMode connectionId="home" libraryId={1} />);
    expect(screen.getByText('No series here yet')).toBeTruthy();
  });
});

describe('PersonPage', () => {
  it("says a server without the narrator filter can't list a narrator's books", async () => {
    mockCaps = { browse_people: false };
    mockBooks = { books: [], isLoading: false, isIdle: true, error: null, refetch: jest.fn() };
    await render(<PersonPage kind="narrator" libraryId={1} name="Kate Reading" />);
    expect(screen.getByText("This server can't list books by narrator yet")).toBeTruthy();
  });

  it('groups the books by series, opening the series page', async () => {
    const book = (title: string, series = '', index = 0): Book => ({
      id: 1,
      library_id: 1,
      rel_path: `JB/${title}`,
      is_folder: true,
      title,
      author: 'Jim Butcher',
      series,
      series_index: index,
      narrator: 'James Marsters',
      duration: 3600,
      format: 'm4b',
      size: 1,
    });
    mockBooks = {
      books: [book('Storm Front', 'The Dresden Files', 1), book('Standalone')],
      isLoading: false,
      isIdle: false,
      error: null,
      refetch: jest.fn(),
    };
    await render(<PersonPage kind="author" libraryId={1} name="Jim Butcher" />);
    await fireEvent(screen.getByTestId('cover-grid'), 'layout', layoutEvent);
    expect(screen.getByRole('header', { name: 'Jim Butcher' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('link', { name: 'Open the series The Dresden Files' }));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/series',
      params: { connection: 'home', library: '1', name: 'The Dresden Files' },
    });
    expect(screen.getByText('Other books')).toBeTruthy();
    // Read by: narrator chips need browse_people (true here).
    expect(screen.getByRole('link', { name: 'James Marsters' })).toBeTruthy();
  });
});
