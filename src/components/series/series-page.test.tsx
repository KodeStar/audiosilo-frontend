import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { Book, BookMeta } from '@/api/types';
import { contentKey } from '@/lib/content-key';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'desktop',
}));
const mockOpenUrl = jest.fn();
jest.mock('@/lib/support', () => ({ openExternalUrl: (u: string) => mockOpenUrl(u) }));
jest.mock('@/api/provider', () => ({
  useCid: () => 'home',
  useOptionalApi: () => ({ coverUrl: () => 'https://s/c', authHeaders: () => ({}) }),
  useApis: () => [],
}));
jest.mock('@/stores/session', () => ({
  useSession: (sel: (s: unknown) => unknown) =>
    sel({ connections: [{ id: 'home', name: 'Home Library' }] }),
  useConnectionName: (id: string) => (id === 'home' ? 'Home Library' : ''),
}));

let mockCaps: Record<string, boolean | undefined> = {};
let mockMeta: BookMeta | undefined;
const mockMetaCalls: { path: string; enabled: boolean }[] = [];
jest.mock('@/api/hooks', () => ({
  useSavedProgress: () => undefined,
  useServerInfo: () => ({ data: { capabilities: {} } }),
  useCapability: (flag: string) => mockCaps[flag],
  useBookMeta: (_lib: number, path: string, enabled: boolean) => {
    mockMetaCalls.push({ path, enabled });
    return { data: enabled ? mockMeta : undefined };
  },
  useMetaWork: () => ({ isLoading: false, data: undefined }),
  useAllLibraryBooks: () => mockBooks,
  useProgressLookup: () => ({
    progressOf: (c: string, l: number, p: string) => mockProgress[`${c}:${l}:${p}`],
    isLoading: false,
  }),
}));

const mockQueue = jest.fn();
jest.mock('@/components/library/use-queue-actions', () => ({
  useQueueActions: () => ({
    supported: true,
    pending: false,
    isQueued: () => false,
    queue: (...a: unknown[]) => mockQueue(...a),
    unqueue: jest.fn(),
  }),
}));
const mockPlay = jest.fn(() => Promise.resolve());
jest.mock('@/components/player/use-play-book', () => ({ usePlayBook: () => mockPlay }));
jest.mock('./use-resume-chapter', () => ({ useResumeChapter: () => 7 }));
// The keep-ahead shortcut has its own tests (it reads the downloads and settings stores).
jest.mock('./keep-ahead-card', () => ({ KeepAheadCard: () => null }));

type BooksResult = {
  books: Book[];
  isLoading: boolean;
  isIdle: boolean;
  complete: boolean;
  error: unknown;
  retry: jest.Mock;
};
let mockBooks: BooksResult;
let mockElsewhere: unknown[] = [];
const mockProgress: Record<
  string,
  { position: number; duration: number; finished: boolean; updated_at: string }
> = {};
jest.mock('./use-series-data', () => ({
  useElsewhereBooks: () => mockElsewhere,
  usePlacedBooks: () => [],
}));

/* eslint-disable import/first */
import { useSeriesOrderings } from '@/stores/series-orderings';

import { SeriesPage } from './series-page';
/* eslint-enable import/first */

function book(title: string, index: number, extra: Partial<Book> = {}): Book {
  return {
    id: index,
    library_id: 1,
    rel_path: `Corey/${title}`,
    is_folder: true,
    title,
    author: 'James S. A. Corey',
    series: 'The Expanse',
    series_index: index,
    narrator: 'Jefferson Mays',
    duration: 36_000,
    format: 'm4b',
    size: 1,
    ...extra,
  };
}

const lw = book('Leviathan Wakes', 1, { asin: 'B1' });
const cw = book("Caliban's War", 2, { asin: 'B2' });
const ng = book('Nemesis Games', 5);

function loaded(books: Book[]): BooksResult {
  return {
    books,
    isLoading: false,
    isIdle: false,
    complete: true,
    error: null,
    retry: jest.fn(),
  };
}

beforeEach(() => {
  mockCaps = { metadata: false };
  mockMeta = undefined;
  mockMetaCalls.length = 0;
  mockElsewhere = [];
  for (const k of Object.keys(mockProgress)) delete mockProgress[k];
  mockPush.mockClear();
  mockQueue.mockClear();
  mockPlay.mockClear();
  mockOpenUrl.mockClear();
});

describe('SeriesPage, local series', () => {
  it('shows the owned books with "Book N" ghosts for the gaps, and never asks for metadata the server lacks', async () => {
    mockBooks = loaded([ng, lw, cw]);
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    expect(screen.getByRole('header', { name: 'The Expanse' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Book 3, Not in your library' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Book 4, Not in your library' })).toBeTruthy();
    expect(mockMetaCalls.every((c) => !c.enabled)).toBe(true);
    // Nothing started: the first unfinished owned book is face-out, with "Queue it".
    expect(screen.getByRole('header', { name: 'Leviathan Wakes' })).toBeTruthy();
    await fireEvent.press(screen.getAllByRole('button', { name: /^Queue it/ })[0]);
    expect(mockQueue).toHaveBeenCalledWith(1, lw.rel_path);
  });

  // HORIZONTAL_SCROLLER: on native a growing row would swallow the column under it.
  it('keeps the bookcase to its own height (no native flex-grow)', async () => {
    mockBooks = loaded([lw, cw, ng]);
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    const shelf = screen.getByTestId('bookcase-scroller');
    expect(StyleSheet.flatten(shelf.props.style)?.flexGrow).toBe(0);
  });

  it('turns a chosen spine face-out', async () => {
    mockBooks = loaded([lw, cw, ng]);
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Book 5, Nemesis Games' }));
    expect(screen.getByRole('header', { name: 'Nemesis Games' })).toBeTruthy();
  });

  it('says what went wrong, with Retry, when nothing loaded', async () => {
    mockBooks = { ...loaded([]), error: new Error('down') };
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    expect(screen.getByText("Couldn't load this series")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockBooks.retry).toHaveBeenCalled();
  });

  it('keeps the books it has when a later page fails', async () => {
    mockBooks = { ...loaded([lw]), error: new Error('down') };
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    expect(screen.queryByText("Couldn't load this series")).toBeNull();
    expect(screen.getByRole('header', { name: 'Leviathan Wakes' })).toBeTruthy();
  });

  it('shows skeletons while loading and an empty state for an unknown series', async () => {
    mockBooks = { ...loaded([]), isLoading: true, complete: false };
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    expect(screen.getByTestId('series-skeleton', { includeHiddenElements: true })).toBeTruthy();
    mockBooks = loaded([]);
    await render(<SeriesPage libraryId={1} name="Nope" />);
    expect(screen.getByText('Nothing in this series here')).toBeTruthy();
  });
});

describe('SeriesPage, community rail', () => {
  const work = (id: string, title: string, position: string, local?: Book) => ({
    id,
    title,
    position,
    authors: [{ id: 'c', name: 'James S. A. Corey' }],
    web_url: `https://meta/${id}`,
    ...(local ? { local: { library_id: 1, path: local.rel_path } } : {}),
  });

  beforeEach(() => {
    mockCaps = { metadata: true };
    mockBooks = loaded([lw, cw]);
    mockProgress[contentKey('home', 1, cw.rel_path)] = {
      position: 14_400,
      duration: 36_000,
      finished: false,
      updated_at: '2026-10-05T00:00:00Z',
    };
    mockMeta = {
      matched: true,
      web_url: 'https://meta/cw',
      work: { id: 'cw', title: "Caliban's War", authors: [], language: 'en' },
      series: [
        {
          id: 'the-expanse',
          name: 'The Expanse',
          position: '2',
          works: [
            work('lw', 'Leviathan Wakes', '1', lw),
            work('cw', "Caliban's War", '2', cw),
            work('ag', "Abaddon's Gate", '3'),
            work('cb', 'Cibola Burn', '4'),
          ],
        },
      ],
    };
    mockElsewhere = [
      {
        ...book("Abaddon's Gate", 3, { rel_path: 'Corey/AG' }),
        connectionId: 'maya',
        connectionName: "Maya's Shelf",
      },
    ];
  });

  it('asks about the book you are on and shows the whole series', async () => {
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    expect(mockMetaCalls.some((c) => c.enabled && c.path === cw.rel_path)).toBe(true);
    // The book you're on is face-out, resuming at its chapter.
    expect(screen.getByRole('header', { name: "Caliban's War" })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: "Resume chapter 7, Caliban's War" }));
    expect(mockPlay).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'home', libraryId: 1, path: cw.rel_path }),
    );
    expect(screen.getByText('40% into book 2 · 26h of listening ahead')).toBeTruthy();
  });

  it('links a book on no server out to AudioSilo Meta', async () => {
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Book 4, Cibola Burn, Not in your library' }),
    );
    await fireEvent.press(
      screen.getAllByRole('link', { name: 'View on AudioSilo Meta, Cibola Burn' })[0],
    );
    expect(mockOpenUrl).toHaveBeenCalledWith('https://meta/cb');
  });

  it('opens a copy on another server there', async () => {
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    await fireEvent.press(
      screen.getByRole('button', { name: "Book 3, Abaddon's Gate, On Maya's Shelf" }),
    );
    await fireEvent.press(screen.getByRole('button', { name: "Listen on Maya's Shelf" }));
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ connection: 'maya' }) }),
    );
  });

  it('falls back to the local series when the metadata does not match', async () => {
    mockMeta = { matched: false };
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    expect(screen.queryByText(/Cibola Burn/)).toBeNull();
    expect(screen.getByRole('header', { name: "Caliban's War" })).toBeTruthy();
  });

  it('switches the reading order, remembered for the family', async () => {
    const series = (mockMeta as { series: { works: unknown[] }[] }).series[0];
    Object.assign(series, {
      ordering: 'publication',
      orderings: [
        {
          id: 'expanse-chrono',
          name: 'The Expanse (chronological)',
          ordering: 'chronological',
          ordering_of: 'the-expanse',
          position: '2',
          works: [...series.works].reverse(),
        },
      ],
    });
    await render(<SeriesPage libraryId={1} name="The Expanse" />);
    expect(screen.getByText('The order the books came out.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'Chronological' }));
    expect(useSeriesOrderings.getState().picks['the-expanse']).toBe('expanse-chrono');
    expect(screen.getByText('The order the story happens in.')).toBeTruthy();
    expect(screen.getByText('In story order')).toBeTruthy();
  });
});
