import { act, fireEvent, renderHook, screen } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';

import type { Book, Progress } from '@/api/types';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

let mockCaps: Record<string, boolean | undefined> = {};
const mockEdit = jest.fn();
const mockMarkFinished = jest.fn();
// The full item a list-shape book is looked up as (`useBook`; an empty path = not asked).
let mockFull: Book | undefined;
let mockPodcastLibrary = false;
const mockUseBook = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    useBook: (_lib: number, path: string) => {
      mockUseBook(path);
      return { data: path ? mockFull : undefined };
    },
    useCapability: (flag: string) => mockCaps[flag],
    useIsPodcastLibrary: () => mockPodcastLibrary,
    useEditProgress: () => ({ mutateAsync: mockEdit }),
    useMarkFinished: () => ({ mutate: mockMarkFinished }),
  };
});
let mockQueueSupported = true;
const mockQueue = jest.fn();
jest.mock('../use-queue-actions', () => ({
  useQueueActions: () => ({
    supported: mockQueueSupported,
    isQueued: () => false,
    queue: mockQueue,
    unqueue: jest.fn(),
  }),
}));
let mockDownloadsSupported = true;
const mockDownload = jest.fn();
const mockRemove = jest.fn();
let mockEntry: { status: string } | undefined;
jest.mock('@/downloads/store', () => ({
  useDownloadEntry: () => mockEntry,
  useDownloadState: () => ({ status: mockEntry?.status, failure: undefined }),
  useDownloads: Object.assign(
    (select: (s: { supported: boolean }) => unknown) =>
      select({ supported: mockDownloadsSupported }),
    { getState: () => ({ download: mockDownload, remove: mockRemove, cancel: jest.fn() }) },
  ),
}));
const mockOpenSeries = jest.fn();
jest.mock('@/lib/open', () => ({ useOpen: () => ({ openSeries: mockOpenSeries }) }));
const mockPlay = jest.fn();
jest.mock('@/components/player/use-play-book', () => ({ usePlayBook: () => mockPlay }));
let mockTakesEvent = false;
// The Undo goes through `undoFinish` (the waiting finish taken back first, fe#208).
const mockUndoRefs: unknown[] = [];
jest.mock('@/playback/finish-route', () => ({
  finishTakesEvent: () => mockTakesEvent,
  undoFinish: (ref: unknown, edit: () => Promise<boolean>) => {
    mockUndoRefs.push(ref);
    return edit();
  },
}));
// The player's fetch of an episode (`useEpisodeFetch`'s `pending`), which the menu reads.
let mockPending: object | null = null;
jest.mock('@/playback/episode-fetch', () => ({
  useEpisodeFetch: (select: (s: { pending: object | null }) => unknown) =>
    select({ pending: mockPending }),
}));
let mockSendToWatch: jest.Mock | null = null;
jest.mock('@/watch/use-watch', () => ({ useSendToWatch: () => mockSendToWatch }));

/* eslint-disable import/first */
import { CapabilityError } from '@/api/hooks';
import { fetchStatus } from '@/testing/podcast-fixtures';

import { mountWithPortal } from '@/testing/render-overlay';

import { BookActionsButton, BookActionsMenu, useBookActions } from './book-actions';
/* eslint-enable import/first */

const H = 3600;
const book = (over: Partial<Book> = {}): Book => ({
  id: 1,
  library_id: 1,
  rel_path: 'Author/Series/01 - Book',
  is_folder: true,
  title: 'Book',
  author: 'Author',
  series: 'Series',
  series_index: 1,
  narrator: '',
  duration: 3 * H,
  format: 'm4b',
  size: 0,
  ...over,
});
const progress = (over: Partial<Progress> = {}): Progress => ({
  library_id: 1,
  path: 'Author/Series/01 - Book',
  position: 600,
  duration: 3 * H,
  finished: false,
  playback_speed: 1,
  version: 1,
  device_id: 'd',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

const ALL = { collections: true, progress_edit: true };

async function actions(b: Book, p?: Progress, opened?: boolean) {
  const openCollect = jest.fn();
  const confirmRemove = jest.fn();
  const { result } = await renderHook(() =>
    useBookActions(
      { connectionId: 'c', libraryId: 1, book: b, progress: p },
      { openCollect, confirmRemove },
      opened,
    ),
  );
  return {
    list: result.current,
    openCollect,
    confirmRemove,
    find: (key: string) => result.current.find((a) => a.key === key),
  };
}

describe('useBookActions', () => {
  beforeEach(() => {
    mockCaps = { ...ALL };
    mockQueueSupported = true;
    mockDownloadsSupported = true;
    [
      mockToast,
      mockEdit,
      mockMarkFinished,
      mockQueue,
      mockDownload,
      mockOpenSeries,
      mockPlay,
    ].forEach((m) => m.mockReset());
  });

  it('offers everything a server with every capability allows, in order', async () => {
    const { list } = await actions(book(), progress());
    expect(list.map((a) => [a.key, a.label])).toEqual([
      ['play', 'Resume'],
      ['queue', 'Add to Up next'],
      ['collect', 'Add to collection...'],
      ['download', 'Download for offline'],
      ['finish', 'Mark as finished'],
      ['series', 'More in this series'],
    ]);
  });

  it('hides what the server lacks or has not confirmed yet', async () => {
    mockCaps = { collections: undefined, progress_edit: undefined };
    mockQueueSupported = false;
    mockDownloadsSupported = false;
    const { list } = await actions(book({ series: '' }));
    expect(list.map((a) => [a.key, a.label])).toEqual([['play', 'Play']]);
  });

  it('marks finished through a progress edit with an Undo that restores the place', async () => {
    mockEdit.mockResolvedValue(progress({ finished: true }));
    const { find } = await actions(book(), progress({ position: 900 }));
    await act(async () => find('finish')!.onPress());
    expect(mockEdit).toHaveBeenCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: true, position: undefined },
    });
    const t = mockToast.mock.calls.at(-1)![0];
    expect(t.title).toBe('Marked as finished');
    await act(async () => t.action.onPress());
    expect(mockEdit).toHaveBeenLastCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: false, position: 900 },
    });
  });

  it('marks finished on an older server through the save at the end, without an Undo', async () => {
    mockCaps = { collections: true, progress_edit: false };
    const { find } = await actions(book(), progress());
    await act(async () => find('finish')!.onPress());
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockMarkFinished.mock.calls[0][0]).toEqual({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      position: 3 * H,
      duration: 3 * H,
    });
  });

  // fe#208: a server that takes listening events gets a `finish` event, offline too.
  describe('on a server that takes listening events', () => {
    beforeEach(() => {
      mockTakesEvent = true;
    });
    afterEach(() => {
      mockTakesEvent = false;
    });

    it('marks finished as the event, with an Undo through a progress edit', async () => {
      mockMarkFinished.mockImplementation((_p: unknown, o: { onSuccess: () => void }) =>
        o.onSuccess(),
      );
      const { find } = await actions(book(), progress({ position: 900 }));
      await act(async () => find('finish')!.onPress());
      expect(mockEdit).not.toHaveBeenCalled();
      expect(mockMarkFinished.mock.calls[0][0]).toEqual({
        libraryId: 1,
        path: 'Author/Series/01 - Book',
        position: 3 * H,
        duration: 3 * H,
      });
      const t = mockToast.mock.calls.at(-1)![0];
      expect(t.title).toBe('Marked as finished');
      mockUndoRefs.length = 0;
      await act(async () => t.action.onPress());
      expect(mockUndoRefs).toEqual([
        { connectionId: 'c', libraryId: 1, path: 'Author/Series/01 - Book', position: 900 },
      ]);
      expect(mockEdit).toHaveBeenLastCalledWith({
        libraryId: 1,
        path: 'Author/Series/01 - Book',
        edit: { finished: false, position: 900 },
      });
    });

    it('without progress edits: the event, and no Undo', async () => {
      mockCaps = { collections: true, progress_edit: false };
      mockMarkFinished.mockImplementation((_p: unknown, o: { onSuccess: () => void }) =>
        o.onSuccess(),
      );
      const { find } = await actions(book(), progress());
      await act(async () => find('finish')!.onPress());
      expect(mockMarkFinished).toHaveBeenCalled();
      expect(mockToast.mock.calls.at(-1)![0].action).toBeUndefined();
    });
  });

  it('marks a book finished at its end not finished from the start', async () => {
    mockEdit.mockResolvedValue(progress());
    const { find } = await actions(book(), progress({ finished: true, position: 3 * H }));
    expect(find('finish')!.label).toBe('Mark as not finished');
    await act(async () => find('finish')!.onPress());
    expect(mockEdit).toHaveBeenCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: false, position: 0 },
    });
  });

  it('offers no way back on a server that cannot edit progress', async () => {
    mockCaps = { collections: true, progress_edit: false };
    const { find } = await actions(book(), progress({ finished: true }));
    expect(find('finish')).toBeUndefined();
  });

  it('says nothing when the edit was never sent', async () => {
    mockEdit.mockRejectedValue(new CapabilityError('progress_edit', true));
    const { find } = await actions(book(), progress());
    await act(async () => find('finish')!.onPress());
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('plays, queues, collects, downloads and opens the series on this connection', async () => {
    mockPlay.mockResolvedValue(undefined);
    const b = book();
    const { find, openCollect } = await actions(b);
    find('play')!.onPress();
    expect(mockPlay).toHaveBeenCalledWith(
      { connectionId: 'c', libraryId: 1, path: b.rel_path },
      { viaBookPage: true },
    );
    find('queue')!.onPress();
    expect(mockQueue).toHaveBeenCalledWith(1, b.rel_path);
    find('collect')!.onPress();
    expect(openCollect).toHaveBeenCalled();
    find('download')!.onPress();
    expect(mockDownload).toHaveBeenCalledWith('c', 1, b, undefined);
    find('series')!.onPress();
    expect(mockOpenSeries).toHaveBeenCalledWith('c', 1, { name: 'Series' });
  });
});

// Track W3b: who may send is `useSendToWatch`'s (watch-model.test.ts); it is here when offered.
describe('useBookActions, Send to watch', () => {
  beforeEach(() => {
    mockCaps = ALL;
    mockQueueSupported = true;
    mockDownloadsSupported = true;
    mockSendToWatch = jest.fn();
  });
  afterEach(() => {
    mockSendToWatch = null;
    mockPodcastLibrary = false;
  });

  it('sits after the download and sends this book', async () => {
    const b = book();
    const { list, find } = await actions(b);
    const keys = list.map((a) => a.key);
    expect(keys.indexOf('watch')).toBe(keys.indexOf('download') + 1);
    expect(find('watch')!.label).toBe('Send to watch');
    find('watch')!.onPress();
    expect(mockSendToWatch).toHaveBeenCalledWith(b);
  });

  it('is not there where it is not offered', async () => {
    mockSendToWatch = null;
    const { find } = await actions(book());
    expect(find('watch')).toBeUndefined();
  });

  it('is not offered for a podcast episode', async () => {
    mockPodcastLibrary = true;
    const { find } = await actions(book());
    expect(find('watch')).toBeUndefined();
  });
});

// fe#166 (D1): an episode downloads like a book, once it is known to be one; never one its
// server can't fetch, and never to a watch.
describe('useBookActions, a podcast episode', () => {
  const info = (downloaded: boolean): Book['episode'] => ({
    show_path: 'Show',
    published: null,
    season: null,
    episode: null,
    episode_type: 'full',
    explicit: false,
    downloaded,
    duration_source: 'file',
    removed: false,
  });
  beforeEach(() => {
    mockDownload.mockReset();
    mockUseBook.mockReset();
    mockFull = undefined;
  });
  afterEach(() => {
    mockPodcastLibrary = false;
    mockSendToWatch = null;
  });

  it('offers Download for an item that is an episode, and downloads it', async () => {
    mockPodcastLibrary = true;
    const b = book({ episode: info(true) });
    const { find } = await actions(b);
    expect(find('download')!.label).toBe('Download for offline');
    find('download')!.onPress();
    expect(mockDownload).toHaveBeenCalledWith('c', 1, b, undefined);
    expect(find('play')).toBeDefined();
  });

  it("offers Download for one not on its server while the server fetches, not when it can't", async () => {
    const b = book({ episode: info(false) });
    mockCaps = { ...ALL, podcast_fetch: true };
    expect((await actions(b)).find('download')).toBeDefined();
    mockCaps = { ...ALL, podcast_fetch: false };
    expect((await actions(b)).find('download')).toBeUndefined();
  });

  it('offers no Download for one its server says is not available, as the episode page (fe#166)', async () => {
    mockCaps = { ...ALL, podcast_fetch: true };
    const refused = book({
      episode: {
        ...info(false)!,
        fetch: fetchStatus({
          state: 'unavailable',
          error: { code: 'library_not_writable', message: 'read-only' },
        }),
      },
    });
    expect((await actions(refused)).find('download')).toBeUndefined();
    const b = book({ episode: info(false) });
    // The player's fetch of this one stopped as not available (another's never counts).
    mockPending = { key: 'c:1:Author/Series/01 - Book', phase: 'unavailable', code: 'module_off' };
    expect((await actions(b)).find('download')).toBeUndefined();
    mockPending = { key: 'c:1:Other', phase: 'unavailable', code: 'module_off' };
    expect((await actions(b)).find('download')).toBeDefined();
    mockPending = null;
    expect((await actions(b)).find('download')).toBeDefined();
  });

  it('looks a list-shape item of a podcast library up once opened, then offers Download', async () => {
    mockPodcastLibrary = true;
    const shown = await actions(book());
    expect(mockUseBook).toHaveBeenCalledWith('');
    expect(shown.find('download')).toBeUndefined();
    expect(shown.find('queue')).toBeDefined();
    mockFull = book({ episode: info(true) });
    const opened = await actions(book(), undefined, true);
    expect(mockUseBook).toHaveBeenCalledWith('Author/Series/01 - Book');
    expect(opened.find('download')).toBeDefined();
  });

  it("offers no Download for a podcast library's item that is not an episode (a show's folder)", async () => {
    mockPodcastLibrary = true;
    mockFull = book();
    const { find } = await actions(book(), undefined, true);
    expect(find('download')).toBeUndefined();
  });

  it('never offers Send to watch for an episode', async () => {
    mockSendToWatch = jest.fn();
    const { find } = await actions(book({ episode: info(true) }));
    expect(find('watch')).toBeUndefined();
    expect(find('download')).toBeDefined();
  });
});

describe('useBookActions, a downloaded book', () => {
  it('asks before removing the download (the confirm does the removing)', async () => {
    mockEntry = { status: 'downloaded' };
    const { find, confirmRemove } = await actions(book());
    expect(find('download')!.label).toBe('Remove download');
    find('download')!.onPress();
    expect(confirmRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove).not.toHaveBeenCalled();
    mockEntry = undefined;
  });
});

// On web, list responses carry no `direct_playable`: the menu used to download a book this
// browser only plays transcoded (the store would read it as playable), and it then stopped
// playing here. The full item decides, looked up once the menu is shown.
describe('useBookActions on web, a list-shape book', () => {
  const prevOS = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'web';
    mockCaps = { ...ALL, transcode: true };
    mockDownloadsSupported = true;
    mockEntry = undefined;
    mockFull = undefined;
    mockDownload.mockReset();
    mockUseBook.mockReset();
  });
  afterEach(() => {
    Platform.OS = prevOS;
  });

  it('looks nothing up for a menu not shown, and offers no Download until it knows', async () => {
    const { find } = await actions(book());
    expect(mockUseBook).toHaveBeenCalledWith('');
    expect(find('download')).toBeUndefined();
  });

  it('offers no Download for an AC-3 book the browser plays transcoded', async () => {
    mockFull = book({ direct_playable: false, codec: 'ac3' });
    const { find } = await actions(book(), undefined, true);
    expect(mockUseBook).toHaveBeenCalledWith('Author/Series/01 - Book');
    expect(find('download')).toBeUndefined();
  });

  it('downloads the full item of a book the browser plays directly', async () => {
    const full = book({ direct_playable: true, codec: 'mp3' });
    mockFull = full;
    const { find } = await actions(book(), undefined, true);
    expect(find('download')!.label).toBe('Download for offline');
    find('download')!.onPress();
    expect(mockDownload).toHaveBeenCalledWith('c', 1, full, undefined);
  });

  it('the menu looks the book up once it is opened, then offers its Download', async () => {
    mockFull = book({ direct_playable: true, codec: 'mp3' });
    await mountWithPortal(<BookActionsButton connectionId="c" libraryId={1} book={book()} />);
    expect(mockUseBook).not.toHaveBeenCalledWith('Author/Series/01 - Book');
    await fireEvent.press(screen.getByLabelText('More for Book'));
    expect(mockUseBook).toHaveBeenCalledWith('Author/Series/01 - Book');
    expect(screen.getByText('Download for offline')).toBeTruthy();
  });

  it('keeps a download already there manageable before it knows', async () => {
    mockEntry = { status: 'downloaded' };
    const { find } = await actions(book());
    expect(find('download')!.label).toBe('Remove download');
    mockEntry = undefined;
  });
});

// The book page's menu leaves out what its own buttons do: with nothing else to offer it
// draws no "..." at all (no empty menu).
describe('BookActionsMenu', () => {
  const OMIT = ['play', 'queue', 'collect', 'download'] as const;
  const mount = (b: Book) =>
    mountWithPortal(
      <BookActionsMenu
        connectionId="c"
        libraryId={1}
        book={b}
        omit={OMIT}
        sheetOpen={false}
        onSheetOpenChange={jest.fn()}
        trigger={<Text>more</Text>}
      />,
    );

  it('renders nothing, trigger included, when every item is left out', async () => {
    mockCaps = { progress_edit: undefined };
    await mount(book({ series: '' }));
    expect(screen.queryByText('more')).toBeNull();
  });

  it('draws its trigger while something is left to offer', async () => {
    mockCaps = { progress_edit: undefined };
    await mount(book());
    expect(screen.getByText('more')).toBeTruthy();
  });
});
