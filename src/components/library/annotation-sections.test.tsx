import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { Bookmark, Note } from '@/api/types';
import type { QueuedBookmark } from '@/playback/annotation-outbox';

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useSegments: () => [] }));
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
type Query<T> = {
  data?: T;
  isPending: boolean;
  isPaused: boolean;
  isError: boolean;
  error: unknown;
  isSuccess: boolean;
  refetch: jest.Mock;
};
const query = <T,>(data?: T, state: 'ok' | 'pending' | 'held' | 'error' = 'ok'): Query<T> => ({
  data,
  // Held for the network (the device is offline): still pending, and paused.
  isPending: state === 'pending' || state === 'held',
  isPaused: state === 'held',
  isError: state === 'error',
  error: state === 'error' ? new TypeError('Network request failed') : null,
  isSuccess: state === 'ok',
  refetch: jest.fn(),
});
let mockBookmarks: Query<Bookmark[]> = query([]);
let mockNotes: Query<Note[]> = query([]);
let mockAnnotations: boolean | undefined = true;
let mockSaved: number | undefined;
jest.mock('@/api/hooks', () => ({
  useBookmarks: () => mockBookmarks,
  useNotes: () => mockNotes,
  useCapability: () => mockAnnotations,
  useChapters: () => ({ data: undefined }),
  useBookProgress: () => ({ data: mockSaved === undefined ? undefined : { position: mockSaved } }),
  useDeleteBookmark: () => ({ mutate: jest.fn() }),
  useDeleteNote: () => ({ mutate: jest.fn() }),
}));
jest.mock('@/api/provider', () => ({
  useCid: (id?: string) => id ?? 'c',
  useOptionalApi: () => ({}),
}));
const mockAddHere = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('@/components/player/player-shortcuts', () => ({
  addBookmarkHere: (...a: unknown[]) => mockAddHere(...a),
}));
// The bookmark outbox (fe#356): what waits on the device for this book's server.
let mockWaiting: QueuedBookmark[] = [];
jest.mock('@/playback/use-queued-bookmarks', () => ({
  useQueuedBookmarks: (cid: string | undefined) => (cid ? mockWaiting : []),
}));
// The entry as stored when it was taken out (a replay may have changed it since it was listed).
const mockDiscard = jest.fn(async (_id: string): Promise<QueuedBookmark | undefined> => undefined);
const mockRequeue = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock('@/playback/annotation-outbox', () => ({
  discardQueuedBookmark: (id: string) => mockDiscard(id),
  requeueBookmark: (...a: unknown[]) => mockRequeue(...a),
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
const mockOpenJournal = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openBook: jest.fn() }),
  openJournal: (...a: unknown[]) => mockOpenJournal(...a),
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('react-native-marked', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { useMarkdown: (body: string) => [<T key="md">{body}</T>] };
});

/* eslint-disable import/first */
import { usePlayerSheets } from '@/components/player/player-sheets';
import { playerStoreMock } from '@/testing/player-store-mock';

import { BookmarksSection } from './bookmarks-section';
import { NotesSection } from './notes-section';
/* eslint-enable import/first */

const bookmark = (id: number, position: number): Bookmark => ({
  id,
  library_id: 1,
  path: 'a/book',
  position,
  note: `note ${id}`,
  label: '',
  created_at: '2026-10-01T10:00:00Z',
});
const note = (id: number, position: number): Note => ({
  id,
  library_id: 1,
  path: 'a/book',
  position,
  body: `body ${id}`,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
});

const OS = Platform.OS;
const player = playerStoreMock();
const target = { connectionId: 'c', libraryId: 1, path: 'a/book' };

beforeEach(() => {
  jest.clearAllMocks();
  mockBookmarks = query([]);
  mockNotes = query([]);
  mockAnnotations = true;
  mockSaved = undefined;
  mockWaiting = [];
  player.reset();
  usePlayerSheets.setState({ open: null, editor: null });
  Platform.OS = OS;
});
afterAll(() => {
  Platform.OS = OS;
});

describe('BookmarksSection', () => {
  it('lists the bookmarks in book order', async () => {
    mockBookmarks = query([bookmark(1, 900), bookmark(2, 30), bookmark(3, 400)]);
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    const notes = screen.getAllByText(/^note \d$/).map((n) => n.props.children);
    expect(notes).toEqual(['note 2', 'note 3', 'note 1']);
  });

  it('teaches the way in when empty: B on the web, the player’s button on a phone', async () => {
    Platform.OS = 'web';
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    expect(screen.getByText('No bookmarks yet.')).toBeTruthy();
    expect(
      screen.getByText('Press B while listening, or tap the bookmark in the player.'),
    ).toBeTruthy();
  });

  it('has no B key on native', async () => {
    Platform.OS = 'ios';
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    expect(screen.getByText('Tap the bookmark in the player while listening.')).toBeTruthy();
  });

  it('shows a loading shape, then a failure with Retry', async () => {
    mockBookmarks = query<Bookmark[]>(undefined, 'pending');
    const view = await render(<BookmarksSection libraryId={1} path="a/book" />);
    expect(screen.queryByText('No bookmarks yet.')).toBeNull();
    mockBookmarks = query<Bookmark[]>(undefined, 'error');
    await view.rerender(<BookmarksSection libraryId={1} path="a/book" />);
    expect(screen.getByText("Couldn't load your bookmarks")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockBookmarks.refetch).toHaveBeenCalled();
  });

  // The list is held for the network (it stays pending): the loading shape never ended,
  // on the page of a downloaded book too.
  it('says offline, with no Retry, while the list waits for the network', async () => {
    mockBookmarks = query<Bookmark[]>(undefined, 'held');
    mockNotes = query<Note[]>(undefined, 'held');
    for (const section of [
      <BookmarksSection key="b" libraryId={1} path="a/book" />,
      <NotesSection key="n" libraryId={1} path="a/book" />,
    ]) {
      const view = await render(section);
      expect(screen.getByText("You're offline")).toBeTruthy();
      // The book is on screen: nothing sends the listener to Downloads.
      expect(screen.queryByText(/Downloads/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      await view.unmount();
    }
  });

  it('keeps showing the bookmarks it holds while it is offline', async () => {
    mockBookmarks = { ...query([bookmark(1, 900)]), isPaused: true };
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    expect(screen.getByText('note 1')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  // fe#356: a bookmark made while the server couldn't take it is listed, marked waiting.
  const waiting = (id: string, position: number, note = ''): QueuedBookmark => ({
    id,
    connectionId: 'c',
    libraryId: 1,
    path: 'a/book',
    position,
    note,
    updated_at: '2026-11-19T10:00:00.000Z',
  });

  it('lists the bookmarks waiting to sync among the others, in book order, with no Edit', async () => {
    mockBookmarks = query([bookmark(1, 900), bookmark(2, 30)]);
    mockWaiting = [waiting('w1', 400, 'kept here')];
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    const notes = screen.getAllByText(/^(note \d|kept here)$/).map((n) => n.props.children);
    expect(notes).toEqual(['note 2', 'kept here', 'note 1']);
    expect(screen.getByTestId('bookmark-queued-w1')).toHaveTextContent(/Waiting to sync/);
    expect(screen.getAllByRole('button', { name: /^Edit bookmark/ })).toHaveLength(2);
    expect(screen.queryByText('No bookmarks yet.')).toBeNull();
  });

  it('shows a bookmark waiting to sync while the list itself waits for the network', async () => {
    mockBookmarks = query<Bookmark[]>(undefined, 'held');
    mockWaiting = [waiting('w1', 400, 'kept here')];
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getByText('kept here')).toBeTruthy();
  });

  it('takes a waiting bookmark out unsent, with an Undo that keeps it again', async () => {
    mockWaiting = [waiting('w1', 400, 'kept here')];
    const stored = { ...waiting('w1', 400, 'kept here'), client_id: 'k1', othersHeld: [3] };
    mockDiscard.mockResolvedValueOnce(stored);
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Delete bookmark at 6:40' }));
    expect(mockDiscard).toHaveBeenCalledWith('w1');
    await Promise.resolve();
    const shown = mockToast.mock.calls[0][0];
    expect(shown).toMatchObject({ title: 'Bookmark deleted', description: '6:40' });
    shown.action.onPress();
    // Put back as it was stored: its client_id and what a send of it did go with it.
    expect(mockRequeue).toHaveBeenCalledWith(stored);
  });

  it('lists no waiting bookmark among the notes', async () => {
    mockWaiting = [waiting('w1', 400, 'kept here')];
    await render(<NotesSection libraryId={1} path="a/book" />);
    expect(screen.queryByText('kept here')).toBeNull();
  });

  it('links to the journal where the server lists bookmarks across books', async () => {
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    await fireEvent.press(screen.getByRole('button', { name: 'See all in your journal' }));
    expect(mockOpenJournal).toHaveBeenCalledWith('bookmarks');
  });

  it('has no journal link on a server without annotations', async () => {
    mockAnnotations = false;
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    expect(screen.queryByRole('button', { name: 'See all in your journal' })).toBeNull();
  });

  it('bookmarks the playing book in one tap, at the live place', async () => {
    player.usePlayer.setState({
      nowPlaying: { ...target, queue: { chapters: [], total: 1 } },
      bookPosition: 62_810.6,
    });
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmark 17:26:50' }));
    expect(mockAddHere).toHaveBeenCalledTimes(1);
    expect(usePlayerSheets.getState().open).toBeNull();
  });

  it('opens the editor at the shown place while the loaded book is still being placed', async () => {
    mockSaved = 37_200.4;
    player.usePlayer.setState({
      nowPlaying: { ...target, queue: { chapters: [], total: 1 } },
      bookPosition: 0,
      loadingBook: 'c:1:a/book',
    });
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    // The label shows the saved place; the press must not bookmark the unplaced 0:00.
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmark 10:20:00' }));
    expect(mockAddHere).not.toHaveBeenCalled();
    expect(usePlayerSheets.getState()).toMatchObject({
      open: 'editor',
      editor: { kind: 'bookmark', target, position: 37_200 },
    });
  });

  it("opens the editor for a book that isn't playing, at the listener's place in it", async () => {
    mockSaved = 37_200.4;
    await render(<BookmarksSection libraryId={1} path="a/book" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmark 10:20:00' }));
    expect(mockAddHere).not.toHaveBeenCalled();
    expect(usePlayerSheets.getState()).toMatchObject({
      open: 'editor',
      editor: { kind: 'bookmark', target, position: 37_200 },
    });
  });
});

describe('NotesSection', () => {
  it('lists the notes in book order, a legacy note at 0:00 first', async () => {
    mockNotes = query([note(1, 500), note(2, 0)]);
    await render(<NotesSection libraryId={1} path="a/book" />);
    expect(screen.getAllByText(/^body \d$/).map((n) => n.props.children)).toEqual([
      'body 2',
      'body 1',
    ]);
    expect(screen.getByRole('button', { name: 'Jump to 0:00' })).toBeTruthy();
  });

  it('pins a new note at the live place while the book plays', async () => {
    player.usePlayer.setState({
      nowPlaying: { ...target, queue: { chapters: [], total: 1 } },
      bookPosition: 62_810,
    });
    await render(<NotesSection libraryId={1} path="a/book" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Note at 17:26:50' }));
    expect(usePlayerSheets.getState()).toMatchObject({
      open: 'editor',
      editor: { kind: 'note', target, position: 62_810 },
    });
  });

  it('pins it at the saved place, else at the start, for a book not playing', async () => {
    await render(<NotesSection libraryId={1} path="a/book" />);
    expect(screen.getByText('No notes yet.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Note at 0:00' }));
    expect(usePlayerSheets.getState().editor).toMatchObject({ kind: 'note', position: 0 });
  });

  it('takes the companion’s jump', async () => {
    mockNotes = query([note(1, 500)]);
    const onJump = jest.fn();
    await render(<NotesSection libraryId={1} path="a/book" connectionId="c" onJump={onJump} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Jump to 8:20' }));
    expect(onJump).toHaveBeenCalledWith(500);
  });
});
