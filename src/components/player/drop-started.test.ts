const mockDrop = jest.fn();
jest.mock('./queue-drop', () => ({ dropFromQueue: (...a: unknown[]) => mockDrop(...a) }));
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  const { contentKey } = jest.requireActual('@/lib/content-key');
  return {
    usePlayer: create(() => ({ nowPlaying: null, snapshot: { state: 'paused' } })),
    selectBookKey: (s: {
      nowPlaying: { connectionId: string; libraryId: number; path: string };
    }) =>
      s.nowPlaying
        ? contentKey(s.nowPlaying.connectionId, s.nowPlaying.libraryId, s.nowPlaying.path)
        : null,
  };
});

/* eslint-disable import/first */
import { usePlayer } from '@/playback/store';

import { dropStartedBook } from './drop-started';
/* eslint-enable import/first */

const loaded = { connectionId: 'c1', libraryId: 1, path: 'Other/Queued' };

beforeEach(() => {
  mockDrop.mockReset();
  usePlayer.setState({ nowPlaying: null, snapshot: { state: 'paused' } } as never);
});

it('takes a started book off Up next once it is the book loaded', () => {
  usePlayer.setState({ nowPlaying: loaded } as never);
  dropStartedBook('c1', 1, 'Other/Queued');
  expect(mockDrop).toHaveBeenCalledWith('c1', [{ library_id: 1, path: 'Other/Queued' }]);
});

it('keeps it queued when the start failed or another book took over', () => {
  dropStartedBook('c1', 1, 'Other/Queued');
  usePlayer.setState({ nowPlaying: { ...loaded, path: 'Else/Book' } } as never);
  dropStartedBook('c1', 1, 'Other/Queued');
  usePlayer.setState({ nowPlaying: loaded, snapshot: { state: 'error' } } as never);
  dropStartedBook('c1', 1, 'Other/Queued');
  expect(mockDrop).not.toHaveBeenCalled();
});
