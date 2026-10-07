import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';

import type { QueueEntry, UserStats } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';
import type { UpNextAnswer } from '@/playback/up-next-resolver';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    replace: (h: unknown) => mockReplace(h),
    back: jest.fn(),
    canGoBack: () => true,
    push: jest.fn(),
  },
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
let mockEntry: { status: string; progress: number } | undefined;
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => mockEntry }));
let mockLayout: 'phone' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/stores/session', () => ({
  ...jest.requireActual('@/stores/session'),
  useConnectionName: () => 'Hearthside',
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('@/lib/support', () => ({ openExternalUrl: jest.fn() }));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));

const mockStart = jest.fn();
let mockAppState = 'active';
jest.mock('./start-book', () => ({ startBookInPlace: (t: unknown) => mockStart(t) }));
const mockFinishBook = jest.fn();
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    selectBookPosition: (s: { position: number }) => s.position,
    usePlayer: create(() => ({
      nowPlaying: null,
      snapshot: { state: 'idle' },
      rate: 1,
      position: 0,
      finishBook: () => mockFinishBook(),
    })),
  };
});

const mockHistory = jest.fn();
jest.mock('@/api/provider', () => {
  const { QueryClient: QC } = jest.requireActual('@tanstack/react-query');
  return {
    queryClient: new QC({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }),
    useOptionalApi: () => ({
      history: (...a: unknown[]) => mockHistory(...a),
      coverUrl: () => 'https://s/cover',
      authHeaders: () => ({}),
    }),
    useCid: (id?: string) => id || 'c1',
    ConnectionScope: ({ children }: { children: unknown }) => children,
  };
});

let mockCaps: Record<string, boolean | undefined> = {};
let mockEnded = true;
let mockSavedFinished = false;
let mockSavedSpeed = 1.25;
let mockStats: UserStats | undefined;
let mockRating: { rating: number; note: string } | null = null;
const mockSetRating = jest.fn();
const mockRemove = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError, cachedCapability, historyQuery, qk, queueQuery } =
    jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    cachedCapability,
    historyQuery,
    qk,
    queueQuery,
    useCapability: (flag: string) => mockCaps[flag],
    useBook: () => ({
      data: {
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
        narrator: 'Michael Kramer',
        series: 'The Stormlight Archive',
        series_index: 1,
        duration: 36_000,
        asin: 'B003ZWFO7E',
        published: '2010',
      },
    }),
    useBookMeta: () => ({ data: undefined }),
    useBookProgress: () => ({
      data: { playback_speed: mockSavedSpeed, finished: mockSavedFinished },
    }),
    useMyStats: () => ({ data: mockStats, isLoading: false }),
    useAllProgressAll: () => ({ progress: [] }),
    useRating: () => ({ data: mockRating }),
    useSetRating: () => ({ mutateAsync: mockSetRating, isPending: false }),
    removeFromQueue: (_cid: string, _client: unknown, v: unknown) => mockRemove(v),
  };
});

jest.mock('@/api/connection-clients', () => ({ resolveClient: () => ({}) }));

const mockResolve = jest.fn();
jest.mock('@/playback/up-next-resolver', () => ({
  ...jest.requireActual('@/playback/up-next-resolver'),
  resolveUpNext: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock('@/playback/up-next-sources', () => ({ upNextSources: () => ({}) }));

/* eslint-disable import/first */
import { queryClient } from '@/api/provider';
import { contentKey } from '@/lib/content-key';
import { playerHref } from '@/lib/paths';
import { usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';

import { EndCredits } from './end-credits';
import { useAutoPlayHold } from './end-of-book';
/* eslint-enable import/first */

const PATH = 'Sanderson/The Way of Kings';
const setPlayer = (s: object) =>
  (usePlayer as unknown as { setState: (s: object) => void }).setState(s);

const queueHead: UpNextAnswer = {
  next: {
    connectionId: 'c1',
    libraryId: 1,
    path: 'Weir/Project Hail Mary',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    duration: 58_000,
    source: 'queue',
    queueEntry: { library_id: 1, path: 'Weir/Project Hail Mary' },
  },
};
const seriesNext: UpNextAnswer = {
  next: {
    connectionId: 'c1',
    libraryId: 1,
    path: 'Sanderson/Words of Radiance',
    title: 'Words of Radiance',
    author: 'Brandon Sanderson',
    duration: 173_700,
    source: 'series',
    series: { name: 'The Stormlight Archive', position: '2' },
  },
};

function stats(finished: { path: string; title: string }[], total: number): UserStats {
  return {
    range: '2026',
    from: '',
    to: '',
    timezone: 'UTC',
    utc_offset: 0,
    totals: { listened: 0, sessions: 0, books: 0, finished: total },
    previous: { listened: 0, sessions: 0, books: 0, finished: 0 },
    estimated: 0,
    days: [],
    hour_weekday: [],
    top_books: [],
    top_authors: [],
    top_narrators: [],
    top_series: [],
    finished_books: finished.map((b) => ({
      library_id: 1,
      path: b.path,
      title: b.title,
      author: 'A',
      finished_at: '',
    })),
    playback: [],
    clients: [],
  };
}

async function mount() {
  const view = await mountWithPortal(
    <QueryClientProvider client={queryClient as QueryClient}>
      <EndCredits connectionId="c1" libraryId={1} path={PATH} ended={mockEnded} />
    </QueryClientProvider>,
  );
  // Let the next book and the history settle.
  await act(async () => {});
  return view;
}

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryData(['queue', 'c1'], [
    { library_id: 1, path: 'Weir/Project Hail Mary', added_at: '' },
  ] satisfies QueueEntry[]);
  queryClient.setQueryData(['server', 'c1'], { capabilities: { queue: true } });
  mockCaps = { queue: true, next_book: true, ratings: true, user_stats: true };
  mockStats = undefined;
  mockEnded = true;
  mockSavedFinished = false;
  mockSavedSpeed = 1.25;
  mockRating = null;
  mockEntry = undefined;
  mockLayout = 'desktop';
  mockReplace.mockReset();
  mockToast.mockReset();
  mockFinishBook.mockReset();
  mockStart.mockReset().mockResolvedValue(true);
  mockAppState = 'active';
  Object.defineProperty(AppState, 'currentState', { get: () => mockAppState, configurable: true });
  mockRemove.mockReset().mockResolvedValue(undefined);
  mockSetRating.mockReset().mockResolvedValue({});
  mockResolve.mockReset().mockResolvedValue(queueHead);
  mockHistory.mockReset().mockResolvedValue([
    { started_at: '2026-10-01T20:00:00Z', ended_at: '2026-10-01T21:30:00Z' },
    { started_at: '2026-10-04T20:00:00Z', ended_at: '2026-10-04T21:00:00Z' },
  ]);
  useSettings.setState({ autoPlayNext: false, defaultRate: 1 });
  setPlayer({ nowPlaying: null, snapshot: { state: 'idle' }, rate: 1, position: 0 });
  useAutoPlayHold.setState({ key: null });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('EndCredits', () => {
  it('shows the finished book, its listening and the queue head as up next', async () => {
    await mount();
    expect(screen.getByText('End of book')).toBeTruthy();
    expect(screen.getByText('The Way of Kings')).toBeTruthy();
    expect(screen.getByText('Brandon Sanderson · read by Michael Kramer')).toBeTruthy();
    expect(screen.getByText('2h 30m')).toBeTruthy();
    expect(screen.getByText('2 days')).toBeTruthy();
    expect(screen.getByText('1.25×')).toBeTruthy();
    expect(screen.getByText('Up next · from your queue')).toBeTruthy();
    expect(screen.getByText('Project Hail Mary')).toBeTruthy();
    expect(screen.getByText('16h 6m · Streams from Hearthside')).toBeTruthy();
    expect(mockHistory).toHaveBeenCalledWith(1, PATH, 500);
  });

  it("says the speed the book plays at: its saved one, else the listener's default", async () => {
    mockSavedSpeed = 0;
    useSettings.setState({ defaultRate: 1.1 });
    await mount();
    expect(screen.getByText('1.1×')).toBeTruthy();
  });

  it('Play now plays the queue head and takes it off Up next', async () => {
    await mount();
    await fireEvent.press(screen.getByLabelText('Play Project Hail Mary now'));
    // Started here, in place: the player route only shows it.
    expect(mockStart).toHaveBeenCalledWith(queueHead.next);
    expect(mockReplace).toHaveBeenCalledWith(playerHref('c1', 1, 'Weir/Project Hail Mary'));
    expect(mockFinishBook).not.toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: 'Weir/Project Hail Mary' });
  });

  it('a start that fails says so, stops the countdown and leaves Play now to try again', async () => {
    jest.useFakeTimers();
    useSettings.setState({ autoPlayNext: true });
    mockStart.mockRejectedValueOnce(new Error('offline'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();
    await act(async () => {
      jest.advanceTimersByTime(15_500);
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith({
      title: "Couldn't start Project Hail Mary. Try again.",
    });
    expect(mockReplace).not.toHaveBeenCalled();
    // Nothing left the queue for a book that never started.
    expect(mockRemove).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Starts in/)).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText('Play now'));
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(mockReplace).toHaveBeenCalledWith(playerHref('c1', 1, 'Weir/Project Hail Mary'));
    warn.mockRestore();
  });

  it('closed while the next book starts, it plays on without the player taking over', async () => {
    let started: (ok: boolean) => void = () => {};
    mockStart.mockReturnValueOnce(new Promise<boolean>((r) => (started = r)));
    const view = await mount();
    await fireEvent.press(screen.getByLabelText('Play Project Hail Mary now'));
    await view.unmount();
    await act(async () => started(true));
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: 'Weir/Project Hail Mary' });
  });

  it('counts down 15 seconds, then plays the queue head', async () => {
    jest.useFakeTimers();
    useSettings.setState({ autoPlayNext: true });
    await mount();
    expect(screen.getByLabelText('Starts in 15 seconds')).toBeTruthy();
    expect(screen.getByText('Not now')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(14_000);
    });
    expect(mockReplace).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(mockReplace).toHaveBeenCalledWith(playerHref('c1', 1, 'Weir/Project Hail Mary'));
    expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: 'Weir/Project Hail Mary' });
  });

  it('a countdown that runs out in the background starts the book in place, then shows the player on return', async () => {
    jest.useFakeTimers();
    useSettings.setState({ autoPlayNext: true });
    mockAppState = 'background';
    let onChange: ((s: string) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      l: (s: string) => void,
    ) => {
      onChange = l;
      return { remove: () => (onChange = undefined) };
    }) as unknown as typeof AppState.addEventListener);
    await mount();
    await act(async () => {
      jest.advanceTimersByTime(15_500);
    });
    expect(mockStart).toHaveBeenCalledWith(queueHead.next);
    // No modal from the background (iOS came back to a black screen).
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: 'Weir/Project Hail Mary' });
    mockAppState = 'active';
    await act(async () => onChange?.('active'));
    expect(mockReplace).toHaveBeenCalledWith(playerHref('c1', 1, 'Weir/Project Hail Mary'));
  });

  it('counts only the time it saw: woken hours later, the countdown goes on from where it stopped', async () => {
    jest.useFakeTimers();
    useSettings.setState({ autoPlayNext: true });
    await mount();
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(screen.getByLabelText('Starts in 10 seconds')).toBeTruthy();
    // The phone locks with the credits up: the app is suspended, and no tick runs for an
    // hour. The first tick after waking must not read that hour as countdown.
    jest.setSystemTime(Date.now() + 3_600_000);
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(mockStart).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Starts in 10 seconds')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(9_000);
    });
    expect(mockStart).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(mockStart).toHaveBeenCalledWith(queueHead.next);
  });

  it('holds the countdown for a book that ended under the sleep timer, keeping Play now', async () => {
    jest.useFakeTimers();
    useSettings.setState({ autoPlayNext: true });
    useAutoPlayHold.setState({ key: contentKey('c1', 1, PATH) });
    await mount();
    expect(screen.queryByLabelText(/Starts in/)).toBeNull();
    expect(screen.queryByText('Not now')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });
    expect(mockStart).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Play now'));
    expect(mockStart).toHaveBeenCalledWith(queueHead.next);
  });

  it('opened before the end, starts nothing when the book ends under the sleep timer', async () => {
    jest.useFakeTimers();
    useSettings.setState({ autoPlayNext: true });
    mockEnded = false;
    setPlayer({
      nowPlaying: { connectionId: 'c1', libraryId: 1, path: PATH, queue: { total: 1000 } },
      snapshot: { state: 'playing' },
      position: 990,
    });
    await mount();
    expect(screen.getByText('Starting in 10s')).toBeTruthy();
    // The end, as BookEndedListener handles it: the hold for this book, then finishBook.
    await act(async () => {
      useAutoPlayHold.setState({ key: contentKey('c1', 1, PATH) });
      setPlayer({ nowPlaying: null, snapshot: { state: 'idle' } });
    });
    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });
    expect(mockStart).not.toHaveBeenCalled();
    expect(screen.getByText('Play now')).toBeTruthy();
  });

  it('Not now stops the countdown and keeps Play now', async () => {
    jest.useFakeTimers();
    useSettings.setState({ autoPlayNext: true });
    await mount();
    await fireEvent.press(screen.getByText('Not now'));
    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Starts in 15 seconds')).toBeNull();
    expect(screen.getByText('Play now')).toBeTruthy();
  });

  it('a book still playing counts its remaining audio and finishes it on Play now', async () => {
    useSettings.setState({ autoPlayNext: true });
    setPlayer({
      nowPlaying: { connectionId: 'c1', libraryId: 1, path: PATH, queue: { total: 1000 } },
      snapshot: { state: 'playing' },
      rate: 1.5,
      position: 865,
    });
    await mount();
    expect(screen.getByText('Starting in 2m 15s')).toBeTruthy();
    // No ring: nothing starts before the book ends.
    expect(screen.queryByLabelText(/Starts in/)).toBeNull();
    expect(screen.getByText('1.5×')).toBeTruthy();
    await fireEvent.press(screen.getByText('Play now'));
    expect(mockFinishBook).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith(playerHref('c1', 1, 'Weir/Project Hail Mary'));
  });

  it('takes the book off Up next when opened by its end', async () => {
    queryClient.setQueryData(['queue', 'c1'], [
      { library_id: 1, path: 'Weir/Project Hail Mary', added_at: '' },
      { library_id: 1, path: PATH, added_at: '' },
    ] satisfies QueueEntry[]);
    await mount();
    expect(mockRemove.mock.calls).toEqual([[{ libraryId: 1, path: PATH }]]);
  });

  it('leaves the queue alone when opened for a book that has not ended', async () => {
    mockEnded = false;
    queryClient.setQueryData(['queue', 'c1'], [
      { library_id: 1, path: PATH, added_at: '' },
    ] satisfies QueueEntry[]);
    await mount();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('names the series place of a series next and where it plays from', async () => {
    mockResolve.mockResolvedValue(seriesNext);
    mockEntry = { status: 'downloading', progress: 0.52 };
    await mount();
    expect(screen.getByText('Up next · The Stormlight Archive, book 2')).toBeTruthy();
    expect(screen.getByText('48h 15m · Downloading, 52%')).toBeTruthy();
    await fireEvent.press(screen.getByText('Play now'));
    // Not from the queue: nothing to take off it.
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('shows a community next book that is not on this server as a ghost, never played', async () => {
    mockResolve.mockResolvedValue({
      next: null,
      unplaced: { title: 'Words of Radiance', position: '2', webUrl: 'https://meta/w2' },
    });
    useSettings.setState({ autoPlayNext: true });
    await mount();
    expect(screen.getByText('The next book is not on this server')).toBeTruthy();
    expect(
      screen.getByText(
        'Next in the series: book 2, Words of Radiance, which is not on this server.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Play now')).toBeNull();
  });

  it('says the series has ended when nothing follows', async () => {
    mockResolve.mockResolvedValue({ next: null });
    await mount();
    expect(screen.getByText('End of the series')).toBeTruthy();
    expect(
      screen.getByText("That's every book in The Stormlight Archive on this server so far."),
    ).toBeTruthy();
  });

  it('rates the book with a toast, keeping the saved note', async () => {
    mockRating = { rating: 2, note: 'Slow start' };
    await mount();
    const group = screen.getByLabelText('Your rating');
    expect(group).toBeTruthy();
    expect(screen.getByLabelText('2 stars')).toBeChecked();
    expect(screen.getByLabelText('4 stars')).not.toBeChecked();
    await fireEvent.press(screen.getByLabelText('4 stars'));
    expect(mockSetRating).toHaveBeenCalledWith({
      libraryId: 1,
      path: PATH,
      rating: 4,
      note: 'Slow start',
    });
    await act(async () => {});
    expect(mockToast).toHaveBeenCalledWith({ title: 'Rating saved' });
    expect(screen.getByLabelText('4 stars')).toBeChecked();
  });

  it('hides the rating without the ratings capability', async () => {
    mockCaps = { ...mockCaps, ratings: false };
    await mount();
    expect(screen.queryByText('How was it?')).toBeNull();
    expect(screen.queryByLabelText('Your rating')).toBeNull();
  });

  it('puts the book on the year shelf with its number when the stats have the year', async () => {
    mockStats = stats(
      [
        { path: 'B/Two', title: 'Two' },
        { path: 'A/One', title: 'One' },
      ],
      2,
    );
    await mount();
    expect(screen.getByText('Book 3 this year · you finished')).toBeTruthy();
    expect(screen.getByLabelText('3 books finished this year')).toBeTruthy();
  });

  it('numbers only a finished book: reopened later, the saved progress decides', async () => {
    mockStats = stats([{ path: 'A/One', title: 'One' }], 1);
    mockEnded = false;
    await mount();
    expect(screen.queryByText(/this year · you finished/)).toBeNull();
  });

  it('numbers a book reopened later whose saved progress is finished', async () => {
    mockStats = stats(
      [
        { path: PATH, title: 'The Way of Kings' },
        { path: 'A/One', title: 'One' },
      ],
      2,
    );
    mockEnded = false;
    mockSavedFinished = true;
    await mount();
    expect(screen.getByText('Book 2 this year · you finished')).toBeTruthy();
  });

  it('shows no year number without the stats capability', async () => {
    mockCaps = { ...mockCaps, user_stats: false };
    await mount();
    expect(screen.queryByText(/this year · you finished/)).toBeNull();
  });

  it('opens the credits with the path on the server', async () => {
    await mount();
    await fireEvent.press(screen.getByText('Credits'));
    expect(screen.getByText('Written by')).toBeTruthy();
    expect(screen.getByText('Read by')).toBeTruthy();
    expect(screen.getByText('Released')).toBeTruthy();
    expect(screen.getByText('2010')).toBeTruthy();
    expect(screen.getByText(PATH)).toBeTruthy();
  });
});
