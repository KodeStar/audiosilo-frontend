import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Bookmark, HistoryEntry, MyBookmark, MyNote } from '@/api/types';
import { contentKey } from '@/lib/content-key';
import { formatWallClock } from '@/lib/format';
import { setItem } from '@/lib/storage';
import { DRIFT_STORAGE_KEY } from '@/playback/drift';
import { useSession } from '@/stores/session';
import { mountWithPortal } from '@/testing/render-overlay';

import type { Source } from './use-journal-sources';

let mockParams: { tab?: string } = {};
const mockSetParams = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  router: { setParams: (p: unknown) => mockSetParams(p), push: jest.fn() },
}));
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    selectBookKey: () => null,
    selectIsTransportLive: () => false,
    usePlayer: create(() => ({ nowPlaying: null })),
  };
});
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/api/hooks', () => ({ useBook: () => ({ data: undefined }) }));
const mockPress = jest.fn();
jest.mock('@/components/shell/destinations', () => ({
  useTabPress: () => ({ press: (n: string) => mockPress(n) }),
}));
const mockOpenBook = jest.fn();
jest.mock('@/lib/open', () => ({ useOpen: () => ({ openBook: mockOpenBook }) }));
const mockJump = jest.fn();
// The shared rows have their own tests: here they only show what they were handed.
jest.mock('@/components/annotations', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    ...jest.requireActual('@/components/annotations/drift-marker'),
    ...jest.requireActual('@/components/annotations/labels'),
    BookmarkRow: ({ bookmark, server }: { bookmark: Bookmark; server?: string }) => (
      <T>{`bookmark: ${bookmark.note}${server ? ` @ ${server}` : ''}`}</T>
    ),
    NoteRow: ({ note }: { note: { body: string } }) => <T>{`note: ${note.body}`}</T>,
    useChapterNamer: () => () => null,
    useJumpTo: () => mockJump,
  };
});

let mockSources: {
  history: Source<HistoryEntry>[];
  bookmarks: Source<MyBookmark>[];
  notes: Source<MyNote>[];
};
jest.mock('./use-journal-sources', () => ({
  useJournalSources: () => ({ ...mockSources, feeders: null }),
}));
const mockRun = jest.fn();
jest.mock('./use-journal-export', () => ({
  useJournalExport: () => ({ run: (...a: unknown[]) => mockRun(...a), preparing: null }),
}));

/* eslint-disable import/first */
import { JournalScreen } from './journal-screen';
/* eslint-enable import/first */

const iso = (ms: number) => new Date(ms).toISOString();
// A time today (local), whatever the clock says.
const today = (h: number, m: number) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
};
// The same time yesterday: a drift record must lie in the past to be kept.
const yesterday = (h: number, m: number) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, h, m).getTime();
};

function source<T>(connectionId: string, rows: T[], over: Partial<Source<T>> = {}): Source<T> {
  return {
    connectionId,
    connectionName: connectionId === 'c1' ? 'Hearthside' : "Maya's Shelf",
    status: 'ready',
    rows,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
    refetch: jest.fn(),
    ...over,
  };
}

const span = (id: number, start: number, end: number, to = 3600): HistoryEntry => ({
  id,
  library_id: 1,
  path: 'Sanderson/Kings',
  from_pos: 1000,
  to_pos: to,
  started_at: iso(start),
  ended_at: iso(end),
  book: { title: 'The Way of Kings', duration: 90000 } as HistoryEntry['book'],
});

const bookmark = (id: number, over: Partial<MyBookmark> = {}): MyBookmark => ({
  id,
  library_id: 1,
  path: 'Sanderson/Kings',
  position: 3600,
  note: `note ${id}`,
  label: '',
  created_at: iso(today(21, 0) + id * 1000),
  ...over,
});

const note = (id: number, body: string): MyNote => ({
  id,
  library_id: 1,
  path: 'Sanderson/Kings',
  position: 10,
  body,
  created_at: iso(today(20, 0) + id),
  updated_at: iso(today(20, 0) + id),
});

const empty = () => ({
  history: [source<HistoryEntry>('c1', [])],
  bookmarks: [source<MyBookmark>('c1', [])],
  notes: [source<MyNote>('c1', [])],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockSources = empty();
  useSession.setState({
    connections: [{ id: 'c1', name: 'Hearthside', serverUrl: 'u', token: 't', user: {} as never }],
    defaultConnectionId: 'c1',
  });
});

const mount = () => mountWithPortal(<JournalScreen />);

describe('JournalScreen: the Diary', () => {
  it('shows each day with its spans, and a drift-off strip that jumps back', async () => {
    const drift = bookmark(9, {
      label: 'fell_asleep',
      note: 'Fell asleep',
      created_at: iso(yesterday(21, 41) + 30_000),
    });
    mockSources.history = [source('c1', [span(1, yesterday(21, 12), yesterday(21, 41))])];
    mockSources.bookmarks = [source('c1', [drift])];
    // This device still remembers the night: the last touch at 21:37, four minutes back.
    await setItem(DRIFT_STORAGE_KEY, {
      [contentKey('c1', 1, 'Sanderson/Kings')]: {
        touchAt: yesterday(21, 37),
        touchPosition: 3360,
        stoppedAt: 3600,
        recordedAt: yesterday(21, 41) + 30_000,
      },
    });
    await mount();
    expect(screen.getByText("Everything you've marked")).toBeTruthy();
    expect(screen.getByText('Yesterday')).toBeTruthy();
    expect(
      screen.getByText(`· ${formatWallClock(new Date(yesterday(21, 12)))}, 29 min`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.getByText('16:40 to 1:00:00')).toBeTruthy();
    const strip = await screen.findByText(
      `You drifted off around ${formatWallClock(new Date(yesterday(21, 37)))}. Jump back 4 minutes?`,
    );
    expect(strip).toBeTruthy();
    await fireEvent.press(screen.getByText('Jump back'));
    await waitFor(() =>
      expect(mockJump).toHaveBeenCalledWith(
        { connectionId: 'c1', libraryId: 1, path: 'Sanderson/Kings' },
        3360,
      ),
    );
  });

  it('without the record, offers to play from the drift-off bookmark', async () => {
    mockSources.history = [source('c1', [span(1, today(21, 12), today(21, 41))])];
    mockSources.bookmarks = [
      source('c1', [bookmark(9, { label: 'fell_asleep', created_at: iso(today(21, 42)) })]),
    ];
    await setItem(DRIFT_STORAGE_KEY, {});
    await mount();
    await fireEvent.press(await screen.findByText('Play from where you drifted off'));
    expect(mockJump).toHaveBeenCalledWith(
      { connectionId: 'c1', libraryId: 1, path: 'Sanderson/Kings' },
      3600,
    );
  });

  it('marks a span that reached the end of its book', async () => {
    mockSources.history = [source('c1', [span(1, today(9, 0), today(9, 30), 89990)])];
    await mount();
    expect(screen.getByText('Finished the book')).toBeTruthy();
  });

  it('opens the book page on its History tab from the cover', async () => {
    mockSources.history = [source('c1', [span(1, today(9, 0), today(9, 30))])];
    await mount();
    await fireEvent.press(screen.getByLabelText('Open The Way of Kings'));
    expect(mockOpenBook).toHaveBeenCalledWith('c1', 1, 'Sanderson/Kings', 'history');
  });

  it('shows a skeleton while the listening loads', async () => {
    mockSources.history = [source('c1', [], { status: 'loading' })];
    await mount();
    expect(screen.getByTestId('diary-skeleton')).toBeTruthy();
  });

  it('says when nothing was listened to', async () => {
    await mount();
    expect(screen.getByText('Nothing listened yet')).toBeTruthy();
  });

  it('says when the listening failed, with a retry', async () => {
    const failed = source<HistoryEntry>('c1', [], { status: 'error' });
    mockSources.history = [failed];
    await mount();
    expect(screen.getByText("Couldn't load your listening")).toBeTruthy();
    await fireEvent.press(screen.getByText('Retry'));
    expect(failed.refetch).toHaveBeenCalled();
  });

  it("notes one server's failure quietly and keeps the other's days", async () => {
    const maya = source<HistoryEntry>('c2', [], { status: 'error' });
    mockSources.history = [source('c1', [span(1, today(9, 0), today(9, 30))]), maya];
    await mount();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(
      screen.getByText("Couldn't reach Maya's Shelf, so its listening isn't shown."),
    ).toBeTruthy();
    await fireEvent.press(screen.getByText('Retry'));
    expect(maya.refetch).toHaveBeenCalled();
  });

  it("asks the server on the boundary for its next page at the list's end", async () => {
    const a = source('c1', [span(1, today(9, 0), today(9, 30))], { hasNextPage: true });
    mockSources.history = [a];
    await mount();
    await act(async () => {
      screen.getByTestId('journal-list').props.onEndReached();
    });
    expect(a.fetchNextPage).toHaveBeenCalled();
  });
});

describe('JournalScreen: bookmarks and notes', () => {
  it("lists every server's bookmarks, filtered by label chip and search", async () => {
    mockParams = { tab: 'bookmarks' };
    mockSources.bookmarks = [
      source('c1', [
        bookmark(1, { label: 'quote', note: 'Life before death' }),
        bookmark(2, { note: 'Bridge Four crew' }),
      ]),
      source('c2', [bookmark(3, { label: 'fell_asleep', note: 'Fell asleep' })]),
    ];
    mockSources.notes = [source('c1', []), source('c2', [])];
    await mount();
    expect(screen.getByText('bookmark: Life before death')).toBeTruthy();
    expect(screen.getByText('bookmark: Bridge Four crew')).toBeTruthy();
    expect(screen.getByLabelText('Bookmarks, 3')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Quote'));
    expect(screen.queryByText('bookmark: Bridge Four crew')).toBeNull();
    expect(screen.getByText('bookmark: Life before death')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Fell asleep'));
    expect(screen.getByText('bookmark: Fell asleep')).toBeTruthy();
    expect(screen.queryByText('bookmark: Life before death')).toBeNull();

    await fireEvent.press(screen.getByLabelText('All labels'));
    await fireEvent.changeText(screen.getByLabelText('Search the journal'), 'bridge');
    expect(screen.getByText('bookmark: Bridge Four crew')).toBeTruthy();
    expect(screen.queryByText('bookmark: Life before death')).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('Search the journal'), 'nothing like it');
    expect(screen.getByText('No bookmarks match')).toBeTruthy();
  });

  it("names a friend's server on its rows when several servers are signed in", async () => {
    mockParams = { tab: 'bookmarks' };
    useSession.setState({
      connections: [
        { id: 'c1', name: 'Hearthside', serverUrl: 'u', token: 't', user: {} as never },
        { id: 'c2', name: "Maya's Shelf", serverUrl: 'v', token: 't', user: {} as never },
      ],
      defaultConnectionId: 'c1',
    });
    mockSources.bookmarks = [
      source('c1', [bookmark(1, { note: 'home' })]),
      source('c2', [bookmark(2, { note: 'away' })]),
    ];
    await mount();
    expect(screen.getByText('bookmark: home')).toBeTruthy();
    expect(screen.getByText("bookmark: away @ Maya's Shelf")).toBeTruthy();
  });

  it('searches notes by their body', async () => {
    mockParams = { tab: 'notes' };
    mockSources.notes = [source('c1', [note(1, 'Szeth in the palace'), note(2, 'Shallan')])];
    await mount();
    await fireEvent.changeText(screen.getByLabelText('Search the journal'), 'palace');
    expect(screen.getByText('note: Szeth in the palace')).toBeTruthy();
    expect(screen.queryByText('note: Shallan')).toBeNull();
  });

  it('says plainly when no server can list them, pointing to the books, with no export', async () => {
    mockParams = { tab: 'bookmarks' };
    mockSources.bookmarks = [source<MyBookmark>('c1', [], { status: 'unsupported' })];
    mockSources.notes = [source<MyNote>('c1', [], { status: 'unsupported' })];
    await mount();
    expect(screen.getByText("This server can't list all your bookmarks yet")).toBeTruthy();
    expect(screen.queryByLabelText('Export the journal')).toBeNull();
    await fireEvent.press(screen.getByText('Go to the Library'));
    expect(mockPress).toHaveBeenCalledWith('(library)');
  });

  it('names an older server beside one that can list', async () => {
    mockParams = { tab: 'notes' };
    mockSources.notes = [
      source('c1', [note(1, 'Kept')]),
      source<MyNote>('c2', [], { status: 'unsupported' }),
    ];
    await mount();
    expect(screen.getByText('note: Kept')).toBeTruthy();
    expect(
      screen.getByText(
        "Maya's Shelf can't list its notes here yet. Find them on each book's page.",
      ),
    ).toBeTruthy();
  });

  it('shows no count while more pages wait', async () => {
    mockSources.bookmarks = [source('c1', [bookmark(1)], { hasNextPage: true })];
    await mount();
    expect(screen.getByLabelText('Bookmarks')).toBeTruthy();
  });
});

describe('JournalScreen: header', () => {
  it('switches tabs through the route', async () => {
    await mount();
    await fireEvent.press(screen.getByLabelText('Notes, 0'));
    expect(mockSetParams).toHaveBeenCalledWith({ tab: 'notes' });
  });

  it('goes back to the Diary with the plain route', async () => {
    mockParams = { tab: 'notes' };
    await mount();
    await fireEvent.press(screen.getByLabelText('Diary'));
    expect(mockSetParams).toHaveBeenCalledWith({ tab: undefined });
  });

  it('exports from the menu', async () => {
    await mount();
    await fireEvent.press(screen.getByLabelText('Export the journal'));
    await fireEvent.press(await screen.findByText('Share as CSV'));
    expect(mockRun).toHaveBeenCalledWith('csv', 'save');
  });
});
