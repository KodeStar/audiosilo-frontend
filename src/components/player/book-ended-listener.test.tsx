import { act, render, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';

import type { QueueEntry } from '@/api/types';
import type { UpNextAnswer } from '@/playback/up-next-resolver';

const mockRemove = jest.fn();
const mockQueueRead = jest.fn();
jest.mock('@/api/hooks', () => ({
  ...jest.requireActual('@/api/hooks'),
  removeFromQueue: (_cid: string, _client: unknown, v: unknown) => mockRemove(v),
}));
jest.mock('@/api/provider', () =>
  // `require` (not an import) because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({}),
);
const mockClient = { queue: () => mockQueueRead() };
jest.mock('@/api/connection-clients', () => ({ resolveClient: () => mockClient }));
const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockPathname = '/library';
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h), replace: (h: unknown) => mockReplace(h) },
  usePathname: () => mockPathname,
}));
const mockResolve = jest.fn();
jest.mock('@/playback/up-next-resolver', () => ({
  ...jest.requireActual('@/playback/up-next-resolver'),
  resolveUpNext: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock('@/playback/up-next-sources', () => ({ upNextSources: () => ({}) }));
const mockStart = jest.fn();
jest.mock('./start-book', () => ({ startBookInPlace: (t: unknown) => mockStart(t) }));
const mockFinishBook = jest.fn();
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    selectIsEnded: (s: { snapshot: { state: string } }) => s.snapshot.state === 'ended',
    usePlayer: create(() => ({
      nowPlaying: null,
      snapshot: { state: 'playing' },
      finishBook: () => mockFinishBook(),
    })),
  };
});

/* eslint-disable import/first */
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { finishedHref } from '@/lib/paths';
import { usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';

import { BookEndedListener } from './book-ended-listener';
/* eslint-enable import/first */

/** The mocked store holds only what the listener reads. */
const setPlayer = (state: object) =>
  (usePlayer as unknown as { setState: (s: object) => void }).setState(state);

const FINISHED = {
  connectionId: 'c1',
  libraryId: 1,
  path: 'Series/Book 1',
  title: 'Book 1',
  author: 'A',
  cover: '',
};
const entry = (path: string): QueueEntry => ({ library_id: 1, path, added_at: '' });

const headAnswer: UpNextAnswer = {
  next: {
    connectionId: 'c1',
    libraryId: 1,
    path: 'Other/Queued',
    title: 'Queued',
    author: '',
    duration: 0,
    source: 'queue',
    queueEntry: { library_id: 1, path: 'Other/Queued' },
  },
};

async function playThenEnd() {
  await render(<BookEndedListener />);
  await act(async () => {
    setPlayer({
      nowPlaying: { connectionId: 'c1', libraryId: 1, path: FINISHED.path },
      snapshot: { state: 'playing' },
    });
  });
  await act(async () => {
    setPlayer({ snapshot: { state: 'ended' } });
  });
  // finishBook clears nowPlaying, as the real store does.
  await act(async () => {
    setPlayer({ nowPlaying: null, snapshot: { state: 'idle' } });
  });
}

let appState: string;
let appStateListeners: ((s: string) => void)[] = [];
/** The app comes back to the foreground. */
async function becomeActive() {
  appState = 'active';
  await act(async () => {
    for (const l of [...appStateListeners]) l('active');
  });
}
beforeEach(() => {
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _: string,
    l: (s: string) => void,
  ) => {
    appStateListeners.push(l);
    return {
      remove: () => {
        appStateListeners = appStateListeners.filter((x) => x !== l);
      },
    };
  }) as unknown as typeof AppState.addEventListener);
  mockStart.mockReset().mockResolvedValue(true);
  queryClient.clear();
  // The test client collects unobserved entries at once; this one stands in for the
  // queue the Up next badge keeps cached.
  queryClient.setQueryDefaults(qk.queue('c1'), { gcTime: Infinity });
  queryClient.setQueryDefaults(qk.server('c1'), { gcTime: Infinity });
  queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued'), entry(FINISHED.path)]);
  queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
  mockRemove.mockReset().mockResolvedValue(undefined);
  mockQueueRead.mockReset().mockResolvedValue([entry(FINISHED.path)]);
  mockPush.mockReset();
  mockReplace.mockReset();
  mockResolve.mockReset().mockResolvedValue(headAnswer);
  mockFinishBook.mockReset().mockReturnValue(FINISHED);
  mockPathname = '/library';
  appState = 'active';
  Object.defineProperty(AppState, 'currentState', { get: () => appState, configurable: true });
  useSettings.setState({ autoPlayNext: true });
  setPlayer({ nowPlaying: null, snapshot: { state: 'idle' } });
});

describe('BookEndedListener', () => {
  it('finishes the book and opens the end credits, which take it off Up next', async () => {
    await playThenEnd();
    expect(mockFinishBook).toHaveBeenCalledTimes(1);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(finishedHref('c1', 1, FINISHED.path, true));
    // In the foreground the credits screen decides what plays.
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('reads the queue when it is not cached, on a server known to have one', async () => {
    mockPathname = '/finished';
    queryClient.clear();
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
    await playThenEnd();
    expect(mockQueueRead).toHaveBeenCalled();
    await waitFor(() =>
      expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: FINISHED.path }),
    );
  });

  it('sends nothing on a server without a queue', async () => {
    mockPathname = '/finished';
    queryClient.clear();
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: false } });
    await playThenEnd();
    expect(mockQueueRead).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('does not navigate again when the credits are already showing, and drops the book', async () => {
    mockPathname = '/finished';
    await playThenEnd();
    expect(mockFinishBook).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    // Credits opened early do not drop it themselves (they were not opened by the end).
    expect(mockRemove.mock.calls).toEqual([[{ libraryId: 1, path: FINISHED.path }]]);
  });

  it('in the background starts the queue head in place, never navigating', async () => {
    appState = 'background';
    mockPathname = '/player';
    await playThenEnd();
    expect(mockResolve).toHaveBeenCalledWith({}, FINISHED);
    await waitFor(() => expect(mockStart).toHaveBeenCalledWith(headAnswer.next));
    // Presenting the player modal from the background left iOS on a black screen.
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    // Both leave the queue (in queue order): the one now playing and the finished one.
    await waitFor(() =>
      expect(mockRemove.mock.calls).toEqual([
        [{ libraryId: 1, path: 'Other/Queued' }],
        [{ libraryId: 1, path: FINISHED.path }],
      ]),
    );
    // Back in the foreground the mini player shows the new book: nothing opens.
    await act(async () => {
      setPlayer({ nowPlaying: { connectionId: 'c1', libraryId: 1, path: 'Other/Queued' } });
    });
    await becomeActive();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('in the background with nothing next opens the end credits only once back', async () => {
    appState = 'background';
    mockResolve.mockResolvedValue({ next: null });
    await playThenEnd();
    await waitFor(() => expect(appStateListeners).toHaveLength(1));
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    await becomeActive();
    expect(mockPush).toHaveBeenCalledWith(finishedHref('c1', 1, FINISHED.path, true));
    expect(mockPush).toHaveBeenCalledTimes(1);
    // The credits it opens drop the finished book.
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('in the background with auto-play off opens the end credits once back, without resolving', async () => {
    appState = 'background';
    useSettings.setState({ autoPlayNext: false });
    await playThenEnd();
    await waitFor(() => expect(appStateListeners).toHaveLength(1));
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    await becomeActive();
    expect(mockPush).toHaveBeenCalledWith(finishedHref('c1', 1, FINISHED.path, true));
  });

  it('in the background a next book that fails to start falls back to the credits on return', async () => {
    appState = 'background';
    mockStart.mockRejectedValue(new Error('offline'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await playThenEnd();
    await waitFor(() => expect(appStateListeners).toHaveLength(1));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    await becomeActive();
    expect(mockPush).toHaveBeenCalledWith(finishedHref('c1', 1, FINISHED.path, true));
    warn.mockRestore();
  });

  it('does not open the deferred credits over a book started meanwhile', async () => {
    appState = 'background';
    mockResolve.mockResolvedValue({ next: null });
    await playThenEnd();
    await waitFor(() => expect(appStateListeners).toHaveLength(1));
    await act(async () => {
      setPlayer({ nowPlaying: { connectionId: 'c1', libraryId: 1, path: 'Other/Book' } });
    });
    await becomeActive();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('a series next that was not queued leaves the queue alone', async () => {
    appState = 'background';
    mockResolve.mockResolvedValue({
      next: { ...headAnswer.next, path: 'Series/Book 2', source: 'series', queueEntry: undefined },
    });
    await playThenEnd();
    await waitFor(() =>
      expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ path: 'Series/Book 2' })),
    );
    expect(mockPush).not.toHaveBeenCalled();
    // Only the finished book left the queue.
    await waitFor(() =>
      expect(mockRemove.mock.calls).toEqual([[{ libraryId: 1, path: FINISHED.path }]]),
    );
  });
});
