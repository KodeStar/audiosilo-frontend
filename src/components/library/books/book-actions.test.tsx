import { act, fireEvent, renderHook, screen } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';

import type { Book, Progress } from '@/api/types';
import type { PlacedProgress } from '@/playback/progress-sync';

const mockToast = jest.fn();
const mockDismissToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({
  toast: (o: unknown) => mockToast(o),
  dismissToast: (id: number) => mockDismissToast(id),
}));

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
    qk: jest.requireActual('@/api/hooks').qk,
    useBook: (_lib: number, path: string) => {
      mockUseBook(path);
      return { data: path ? mockFull : undefined };
    },
    useCapability: (flag: string) => mockCaps[flag],
    useIsPodcastLibrary: () => mockPodcastLibrary,
    useEditProgress: () => ({ mutateAsync: mockEdit }),
    useMarkFinished: () => ({ mutateAsync: mockMarkFinished }),
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
  useDownloadBytes: () => 0,
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
// The loaded book stops before the finish is recorded (fe#258); `steps` gives the order.
const mockSteps: string[] = [];
// The place the loaded book's leave saved (undefined: not the loaded book).
let mockLeftAt: number | undefined;
// The floor each leave was given (`held`: the place the server held before the finish).
const mockHeld: (number | undefined)[] = [];
// How the Undo ends when its finish may be on a server that looks down (fe#258).
let mockUnreachable = false;
jest.mock('@/playback/finish-route', () => ({
  finishTakesEvent: () => mockTakesEvent,
  leaveFinishedBook: async (ref: { path: string; held?: number }) => {
    mockSteps.push(`leave ${ref.path}`);
    mockHeld.push(ref.held);
    return mockLeftAt;
  },
  reloadLeftBook: async (ref: { path: string }) => {
    mockSteps.push(`reload ${ref.path}`);
  },
  undoFinish: async (ref: unknown, edit: () => Promise<unknown>) => {
    mockUndoRefs.push(ref);
    if (mockUnreachable) return 'unreachable';
    await edit();
    return 'undone';
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
import { ApiError } from '@/api/client';
import { CapabilityError, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { fetchStatus } from '@/testing/podcast-fixtures';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

import { mountWithPortal } from '@/testing/render-overlay';
import { builtByCompiler } from '@/testing/react-compiler';

import { BookActionsButton, BookActionsMenu, useBookActions } from './book-actions';
/* eslint-enable import/first */

// The live fetch status reaches a row through the cache's batched notifications.
notifyQueriesSynchronously();

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

async function actions(b: Book, p?: PlacedProgress, opened?: boolean, open?: boolean) {
  const openCollect = jest.fn();
  const confirmRemove = jest.fn();
  const { result } = await renderHook(() =>
    useBookActions(
      { connectionId: 'c', libraryId: 1, book: b, progress: p },
      { openCollect, confirmRemove },
      opened,
      open,
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
    mockTakesEvent = false;
    mockLeftAt = undefined;
    mockUnreachable = false;
    mockSteps.length = 0;
    mockHeld.length = 0;
    mockQueueSupported = true;
    mockDownloadsSupported = true;
    [
      mockToast,
      mockDismissToast,
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

  // The page's progress was read before the loaded book played on; unloaded, no later save
  // of the player moves the place on after the Undo.
  it("the loaded book's Undo goes back to the place its leave saved", async () => {
    mockLeftAt = 1234;
    mockEdit.mockResolvedValue(progress({ finished: true }));
    const { find } = await actions(book(), progress({ position: 900 }));
    await act(async () => find('finish')!.onPress());
    const t = mockToast.mock.calls.at(-1)![0];
    await act(async () => t.action.onPress());
    expect(mockEdit).toHaveBeenLastCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: false, position: 1234 },
    });
  });

  // The page shows this device's newer record (3001) with the server's own row beside it at
  // another device's further place (3300, stamped earlier). The Undo moved the server back
  // to this device's place: the server's row is the floor, for the store's unsaved leave
  // (`held`) and for a book that was not loaded.
  it("an Undo never goes behind the server's own row under this device's newer place", async () => {
    mockEdit.mockResolvedValue(progress({ finished: true }));
    const page: PlacedProgress = {
      ...progress({ position: 3001, version: 0, updated_at: '2026-10-02T00:00:00Z' }),
      server: progress({ position: 3300, device_id: 'other', version: 4 }),
    };
    const { find } = await actions(book(), page);
    await act(async () => find('finish')!.onPress());
    expect(mockHeld).toEqual([3300]);
    await act(async () => mockToast.mock.calls.at(-1)![0].action.onPress());
    expect(mockEdit).toHaveBeenLastCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: false, position: 3300 },
    });
  });

  it.each([
    [false, 'edit'],
    [true, 'mark'],
  ])(
    'stops the loaded book before the finish is recorded (finish event: %s) (fe#258)',
    async (takesEvent, route) => {
      mockSteps.length = 0;
      mockTakesEvent = takesEvent;
      mockEdit.mockImplementation(async () => mockSteps.push('edit'));
      mockMarkFinished.mockImplementation(async () => mockSteps.push('mark'));
      const { find } = await actions(book(), progress());
      await act(async () => find('finish')!.onPress());
      expect(mockSteps).toEqual(['leave Author/Series/01 - Book', route]);
    },
  );

  it('marks finished on an older server through the save at the end, without an Undo', async () => {
    mockCaps = { collections: true, progress_edit: false };
    mockMarkFinished.mockResolvedValue(undefined);
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
      const before = { position: 900, file: 'Book/02.mp3', file_pos: 17 };
      mockMarkFinished.mockResolvedValue({ before });
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
        { connectionId: 'c', libraryId: 1, path: 'Author/Series/01 - Book', position: 900, before },
      ]);
      expect(mockEdit).toHaveBeenLastCalledWith({
        libraryId: 1,
        path: 'Author/Series/01 - Book',
        edit: { finished: false, position: 900 },
      });
    });

    it('without progress edits: the event, and no Undo', async () => {
      mockCaps = { collections: true, progress_edit: false };
      mockMarkFinished.mockResolvedValue(undefined);
      const { find } = await actions(book(), progress());
      await act(async () => find('finish')!.onPress());
      expect(mockMarkFinished).toHaveBeenCalled();
      expect(mockToast.mock.calls.at(-1)![0].action).toBeUndefined();
    });

    // fe#258 (4a): the finish may be on a server that can't be asked now; the Undo says so
    // rather than undoing it on this device alone.
    it('an Undo the server could not take says so; the book stays finished', async () => {
      mockMarkFinished.mockResolvedValue(undefined);
      const { find } = await actions(book(), progress({ position: 900 }));
      await act(async () => find('finish')!.onPress());
      mockUnreachable = true;
      await act(async () => mockToast.mock.calls.at(-1)![0].action.onPress());
      expect(mockEdit).not.toHaveBeenCalled();
      const said = mockToast.mock.calls.at(-1)![0];
      expect(said).toMatchObject({
        title: "Can't undo while the server can't be reached. Try again once it's back.",
        description: 'Book',
        action: { label: 'Retry' },
      });
      // Retry runs the Undo again: with the server back it goes through.
      mockUnreachable = false;
      mockUndoRefs.length = 0;
      await act(async () => said.action.onPress());
      expect(mockUndoRefs).toEqual([
        { connectionId: 'c', libraryId: 1, path: 'Author/Series/01 - Book', position: 900 },
      ]);
      expect(mockEdit).toHaveBeenLastCalledWith({
        libraryId: 1,
        path: 'Author/Series/01 - Book',
        edit: { finished: false, position: 900 },
      });
    });

    // FE-1: the book it unloaded stayed unloaded after a finish that failed.
    it('a finish event that failed loads the book it left again', async () => {
      mockMarkFinished.mockRejectedValue(new Error('storage'));
      const { find } = await actions(book(), progress());
      await act(async () => find('finish')!.onPress());
      expect(mockSteps).toEqual([
        'leave Author/Series/01 - Book',
        'reload Author/Series/01 - Book',
      ]);
      expect(mockToast.mock.calls.at(-1)![0].title).toBe("Couldn't update this book. Try again.");
    });
  });

  it('an edit marking finished that failed loads the book it left again (FE-1)', async () => {
    mockEdit.mockRejectedValue(new Error('offline'));
    const { find } = await actions(book(), progress());
    await act(async () => find('finish')!.onPress());
    expect(mockSteps).toEqual(['leave Author/Series/01 - Book', 'reload Author/Series/01 - Book']);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0][0].title).toBe("Couldn't update this book. Try again.");
  });

  // A busy server's own 503 was reached: it says busy, to try again in a moment, never
  // "can't be reached" (a gateway's 502 / 504) nor the edit's own failure.
  it("a busy server's 503 on the Mark and on its Undo says the server is busy", async () => {
    const BUSY = 'The server is busy. Try again in a moment.';
    mockEdit.mockRejectedValueOnce(new ApiError(503, 'busy'));
    const { find } = await actions(book(), progress());
    await act(async () => find('finish')!.onPress());
    expect(mockToast.mock.calls.at(-1)![0].title).toBe(BUSY);
    mockEdit.mockResolvedValueOnce(progress({ finished: true }));
    await act(async () => find('finish')!.onPress());
    expect(mockToast.mock.calls.at(-1)![0].title).toBe('Marked as finished');
    mockEdit.mockRejectedValueOnce(new ApiError(503, 'busy'));
    await act(async () => mockToast.mock.calls.at(-1)![0].action.onPress());
    expect(mockToast.mock.calls.at(-1)![0].title).toBe(BUSY);
    // Another failure is still the edit's own.
    mockEdit.mockRejectedValueOnce(new ApiError(500, 'oops'));
    await act(async () => find('finish')!.onPress());
    expect(mockToast.mock.calls.at(-1)![0].title).toBe("Couldn't update this book. Try again.");
  });

  // FE-1: the Mark waited on its request with nothing shown (the menu had closed).
  it('a slow Mark as finished says it is on its way, and the toast goes once it is done', async () => {
    jest.useFakeTimers();
    try {
      let done = () => {};
      mockEdit.mockImplementation(() => new Promise<void>((resolve) => (done = resolve)));
      mockToast.mockReturnValue(7);
      const { find } = await actions(book(), progress());
      let pressed: Promise<void> = Promise.resolve();
      await act(async () => {
        pressed = Promise.resolve(find('finish')!.onPress());
      });
      expect(mockToast).not.toHaveBeenCalled();
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(mockToast.mock.calls[0][0].title).toBe('Marking as finished...');
      await act(async () => {
        done();
        await pressed;
      });
      expect(mockDismissToast).toHaveBeenCalledWith(7);
      expect(mockToast.mock.calls.at(-1)![0].title).toBe('Marked as finished');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a quick Mark as finished shows only its result', async () => {
    jest.useFakeTimers();
    try {
      mockEdit.mockResolvedValue(progress({ finished: true }));
      const { find } = await actions(book(), progress());
      await act(async () => find('finish')!.onPress());
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      expect(mockToast.mock.calls.map((c) => c[0].title)).toEqual(['Marked as finished']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows which book a slow Undo is waiting for and clears the notice on failure', async () => {
    jest.useFakeTimers();
    try {
      mockEdit.mockResolvedValueOnce(progress({ finished: true }));
      const { find } = await actions(book(), progress());
      await act(async () => find('finish')!.onPress());
      const undo = mockToast.mock.calls.at(-1)![0].action;
      mockToast.mockClear().mockReturnValue(17);
      let refuse!: (error: Error) => void;
      mockEdit.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)));
      await act(async () => undo.onPress());
      expect(mockToast).not.toHaveBeenCalled();
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Marking as not finished...',
        description: 'Book',
        duration: null,
      });
      await act(async () => refuse(new ApiError(503, 'busy')));
      expect(mockDismissToast).toHaveBeenCalledWith(17);
      expect(mockToast.mock.calls.at(-1)![0].title).toBe(
        'The server is busy. Try again in a moment.',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  // FE-1: finished again by the Undo, a book started since played on past its finish.
  it("Mark as not finished's Undo stops a book started since before it finishes it again", async () => {
    mockEdit.mockImplementation(async (v: { edit: { finished: boolean } }) => {
      if (v.edit.finished) mockSteps.push('finish');
    });
    const { find } = await actions(book(), progress({ finished: true, position: 3 * H }));
    await act(async () => find('finish')!.onPress());
    await act(async () => mockToast.mock.calls.at(-1)![0].action.onPress());
    expect(mockSteps).toEqual(['leave Author/Series/01 - Book', 'finish']);
  });

  // On a server that takes listening events the finish goes as an event, behind the close of
  // the span the book was left with: a progress edit, sent beside the outbox, reached the
  // server before that span did.
  it("Mark as not finished's Undo is a finish event where the server takes one", async () => {
    mockTakesEvent = true;
    mockEdit.mockImplementation(async (v: { edit: { finished: boolean } }) => {
      mockSteps.push(v.edit.finished ? 'edit finished' : 'edit unfinished');
    });
    mockMarkFinished.mockImplementation(async () => mockSteps.push('mark'));
    const { find } = await actions(book(), progress({ finished: true, position: 3 * H }));
    await act(async () => find('finish')!.onPress());
    await act(async () => mockToast.mock.calls.at(-1)![0].action.onPress());
    expect(mockSteps).toEqual(['edit unfinished', 'leave Author/Series/01 - Book', 'mark']);
    expect(mockMarkFinished).toHaveBeenCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      position: 3 * H,
      duration: 3 * H,
    });
  });

  it("a finish event that failed on Mark as not finished's Undo loads the book again", async () => {
    mockTakesEvent = true;
    mockEdit.mockResolvedValue(progress());
    mockMarkFinished.mockRejectedValue(new Error('storage'));
    const { find } = await actions(book(), progress({ finished: true, position: 3 * H }));
    await act(async () => find('finish')!.onPress());
    await act(async () => mockToast.mock.calls.at(-1)![0].action.onPress());
    expect(mockSteps).toEqual(['leave Author/Series/01 - Book', 'reload Author/Series/01 - Book']);
    expect(mockToast.mock.calls.at(-1)![0].title).toBe("Couldn't update this book. Try again.");
  });

  it('marks a book finished at its end not finished from the start', async () => {
    mockEdit.mockResolvedValue(progress());
    const { find } = await actions(book(), progress({ finished: true, position: 3 * H }));
    expect(find('finish')!.label).toBe('Mark as not finished');
    mockUndoRefs.length = 0;
    await act(async () => find('finish')!.onPress());
    // Through `undoFinish`: a finish still waiting in the outbox is taken back before the
    // edit, else sent after it, it finished the book again.
    expect(mockUndoRefs).toEqual([
      {
        connectionId: 'c',
        libraryId: 1,
        path: 'Author/Series/01 - Book',
        position: 0,
        atPosition: true,
      },
    ]);
    expect(mockEdit).toHaveBeenCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: false, position: 0 },
    });
    expect(mockToast.mock.calls.at(-1)![0].title).toBe('Marked as not finished');
  });

  // fe#258: the finish may be on a server that can't be asked now, as for an Undo.
  it('a Mark as not finished the server could not take says so, with a Retry', async () => {
    mockUnreachable = true;
    const { find } = await actions(book(), progress({ finished: true, position: 3 * H }));
    await act(async () => find('finish')!.onPress());
    expect(mockEdit).not.toHaveBeenCalled();
    const said = mockToast.mock.calls.at(-1)![0];
    expect(said).toMatchObject({
      title:
        "Can't mark as not finished while the server can't be reached. Try again once it's back.",
      description: 'Book',
      action: { label: 'Retry' },
    });
    mockUnreachable = false;
    mockEdit.mockResolvedValue(progress());
    await act(async () => said.action.onPress());
    expect(mockEdit).toHaveBeenCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: false, position: 0 },
    });
    expect(mockToast.mock.calls.at(-1)![0].title).toBe('Marked as not finished');
  });

  // The Retry is pressed later: the place it unfinishes at is the progress read since, not
  // the one the failed tap saw.
  it('a Mark as not finished Retry takes the progress of the latest render', async () => {
    mockUnreachable = true;
    const target = (p: Progress) => ({
      connectionId: 'c',
      libraryId: 1,
      book: book(),
      progress: p,
    });
    const dialogs = { openCollect: jest.fn(), confirmRemove: jest.fn() };
    const { result, rerender } = await renderHook(
      (p: Progress) => useBookActions(target(p), dialogs),
      { initialProps: progress({ finished: true, position: 3 * H }) },
    );
    await act(async () => result.current.find((a) => a.key === 'finish')!.onPress());
    const said = mockToast.mock.calls.at(-1)![0];
    await rerender(progress({ finished: true, position: H }));
    mockUnreachable = false;
    mockEdit.mockResolvedValue(progress());
    await act(async () => said.action.onPress());
    expect(mockEdit).toHaveBeenCalledWith({
      libraryId: 1,
      path: 'Author/Series/01 - Book',
      edit: { finished: false, position: H },
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
    mockPending = null;
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
    // One on its server needs no fetch: a stopped fetch of it from before never hides it.
    mockPending = { key: 'c:1:Author/Series/01 - Book', phase: 'unavailable', code: 'module_off' };
    expect((await actions(book({ episode: info(true) }))).find('download')).toBeDefined();
  });

  const notAvailable = () =>
    fetchStatus({
      state: 'unavailable',
      error: { code: 'library_not_writable', message: 'read-only' },
    });

  it('reads the live fetch status once opened, as the episode page does (fe#280)', async () => {
    mockCaps = { ...ALL, podcast_fetch: true };
    const b = book({ episode: info(false) });
    const key = qk.podcastFetch('c', 1, b.rel_path);
    queryClient.setQueryData(key, notAvailable());
    try {
      // Closed, the row's own (older) status; open, the live one.
      expect((await actions(b)).find('download')).toBeDefined();
      expect((await actions(b, undefined, true)).find('download')).toBeUndefined();
    } finally {
      queryClient.removeQueries({ queryKey: key });
    }
  });

  it('follows the live fetch status only while the menu is open, not once it closed (fe#280)', async () => {
    mockCaps = { ...ALL, podcast_fetch: true };
    const b = book({ episode: info(false) });
    const key = qk.podcastFetch('c', 1, b.rel_path);
    queryClient.setQueryData(key, notAvailable());
    try {
      // Opened once, closed now: no listener on the live status, the row's own is read.
      expect((await actions(b, undefined, true, false)).find('download')).toBeDefined();
      expect((await actions(b, undefined, true, true)).find('download')).toBeUndefined();
    } finally {
      queryClient.removeQueries({ queryKey: key });
    }
  });

  it('follows the live fetch status while the menu is open (fe#280)', async () => {
    mockCaps = { ...ALL, podcast_fetch: true };
    const b = book({ episode: info(false) });
    const key = qk.podcastFetch('c', 1, b.rel_path);
    try {
      await mountWithPortal(<BookActionsButton connectionId="c" libraryId={1} book={b} />);
      await fireEvent.press(screen.getByLabelText('More for Book'));
      expect(screen.getByText('Download for offline')).toBeTruthy();
      // The player's fetch, meanwhile, found it not available: nothing else renders the row.
      await act(async () => void queryClient.setQueryData(key, notAvailable()));
      expect(screen.getByText('Play')).toBeTruthy();
      expect(screen.queryByText('Download for offline')).toBeNull();
    } finally {
      queryClient.removeQueries({ queryKey: key });
    }
  });

  // The React Compiler memoised a read at render against the row's props, so a menu
  // opened again offered what it read the first time.
  it("reads the live fetch status again at each opening of a row's menu (fe#280)", async () => {
    // Only a hook the compiler builds can go stale this way.
    expect(builtByCompiler(useBookActions)).toBe(true);
    mockCaps = { ...ALL, podcast_fetch: true };
    const b = book({ episode: info(false) });
    const key = qk.podcastFetch('c', 1, b.rel_path);
    try {
      await mountWithPortal(<BookActionsButton connectionId="c" libraryId={1} book={b} />);
      const more = screen.getByLabelText('More for Book');
      await fireEvent.press(more);
      expect(screen.getByText('Download for offline')).toBeTruthy();
      await fireEvent.press(more);
      expect(screen.queryByText('Download for offline')).toBeNull();
      // The episode page, visited since, read it as not available.
      queryClient.setQueryData(key, notAvailable());
      await fireEvent.press(more);
      expect(screen.getByText('Play')).toBeTruthy();
      expect(screen.queryByText('Download for offline')).toBeNull();
    } finally {
      queryClient.removeQueries({ queryKey: key });
    }
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
