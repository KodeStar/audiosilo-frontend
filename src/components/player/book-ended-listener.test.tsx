import { act, render, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';

import type { QueueEntry } from '@/api/types';
import type { UpNextAnswer } from '@/playback/up-next-resolver';

const mockRemove = jest.fn();
const mockQueueRead = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError, qk, queueQuery } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    qk,
    queueQuery,
    useRemoveFromQueue: () => ({ mutateAsync: mockRemove }),
  };
});
jest.mock('@/api/provider', () =>
  // `require` (not an import) because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({ c1: { queue: () => mockQueueRead() } }),
);
const mockClient = {};
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
import { finishedHref, playerHref } from '@/lib/paths';
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
beforeEach(() => {
  queryClient.clear();
  // The test client collects unobserved entries at once; this one stands in for the
  // queue the Up next badge keeps cached.
  queryClient.setQueryDefaults(qk.queue('c1'), { gcTime: Infinity });
  queryClient.setQueryDefaults(qk.server('c1'), { gcTime: Infinity });
  queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued'), entry(FINISHED.path)]);
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
  it('finishes the book, takes it off Up next and opens the end credits', async () => {
    await playThenEnd();
    expect(mockFinishBook).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: FINISHED.path });
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(finishedHref('c1', 1, FINISHED.path, true));
    // In the foreground the credits screen decides what plays.
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('reads the queue when it is not cached, on a server known to have one', async () => {
    queryClient.clear();
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
    await playThenEnd();
    expect(mockQueueRead).toHaveBeenCalled();
    await waitFor(() =>
      expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: FINISHED.path }),
    );
  });

  it('sends nothing on a server without a queue', async () => {
    queryClient.clear();
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: false } });
    await playThenEnd();
    expect(mockQueueRead).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(finishedHref('c1', 1, FINISHED.path, true));
  });

  it('does not navigate again when the credits are already showing', async () => {
    mockPathname = '/finished';
    await playThenEnd();
    expect(mockFinishBook).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('in the background plays the queue head and takes it off Up next', async () => {
    appState = 'background';
    mockPathname = '/player';
    await playThenEnd();
    expect(mockResolve).toHaveBeenCalledWith({}, FINISHED);
    expect(mockReplace).toHaveBeenCalledWith(playerHref('c1', 1, 'Other/Queued'));
    expect(mockRemove.mock.calls).toEqual([
      [{ libraryId: 1, path: FINISHED.path }],
      [{ libraryId: 1, path: 'Other/Queued' }],
    ]);
  });

  it('in the background with nothing next opens the end credits', async () => {
    appState = 'background';
    mockResolve.mockResolvedValue({ next: null });
    await playThenEnd();
    expect(mockPush).toHaveBeenCalledWith(finishedHref('c1', 1, FINISHED.path, true));
  });

  it('in the background with auto-play off opens the end credits without resolving', async () => {
    appState = 'background';
    useSettings.setState({ autoPlayNext: false });
    await playThenEnd();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(finishedHref('c1', 1, FINISHED.path, true));
  });

  it('a series next that was not queued leaves the queue alone', async () => {
    appState = 'background';
    mockResolve.mockResolvedValue({
      next: { ...headAnswer.next, path: 'Series/Book 2', source: 'series', queueEntry: undefined },
    });
    await playThenEnd();
    expect(mockPush).toHaveBeenCalledWith(playerHref('c1', 1, 'Series/Book 2'));
    // Only the finished book left the queue.
    expect(mockRemove.mock.calls).toEqual([[{ libraryId: 1, path: FINISHED.path }]]);
  });
});
