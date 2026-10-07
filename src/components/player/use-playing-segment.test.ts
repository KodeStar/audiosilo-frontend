import { act, renderHook } from '@testing-library/react-native';
import type { StoreApi, UseBoundStore } from 'zustand';

type Chapter = { index: number; title: string; start: number; end: number; book_offset: number };
type MockPlayer = {
  nowPlaying: { queue: { total: number } } | null;
  bookPosition: number;
  chapter: Chapter | null;
  snapshot: { trackIndex: number; position: number; duration: number };
  seekBook: jest.Mock;
  seekInTrack: jest.Mock;
};
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePlayer: create(() => ({})),
    selectBookPosition: (s: MockPlayer) => s.bookPosition,
    selectCurrentChapter: (s: MockPlayer) => s.chapter,
  };
});

/* eslint-disable import/first */
import { usePlayer } from '@/playback/store';

import { selectPlayingSegment, usePlayingSegment } from './use-playing-segment';
/* eslint-enable import/first */

const player = usePlayer as unknown as UseBoundStore<StoreApi<MockPlayer>>;
const CHAPTER: Chapter = { index: 3, title: 'Three', start: 0, end: 600, book_offset: 600 };

beforeEach(() => {
  player.setState({
    nowPlaying: { queue: { total: 3600 } },
    bookPosition: 900.6,
    chapter: CHAPTER,
    snapshot: { trackIndex: 0, position: 900.6, duration: 3600 },
    seekBook: jest.fn(),
    seekInTrack: jest.fn(),
  });
});

describe('selectPlayingSegment', () => {
  it('is the chapter with the live place, or nothing with no book', () => {
    expect(selectPlayingSegment(player.getState() as never)).toEqual({
      perTrack: false,
      start: 600,
      length: 600,
      elapsed: expect.closeTo(300.6),
    });
    expect(selectPlayingSegment({ ...player.getState(), nowPlaying: null } as never)).toBeNull();
  });
});

describe('usePlayingSegment', () => {
  it("keeps only the chapter's bookmarks, as seconds into it, and seeks in the book", async () => {
    const { result } = await renderHook(() => usePlayingSegment([50, 650, 900, 1200]));
    expect(result.current.segment).toMatchObject({ perTrack: false, start: 600, length: 600 });
    expect(result.current.elapsed).toBeCloseTo(300.6);
    expect(result.current.bookmarks).toEqual([50, 300]);
    result.current.onSeek(120);
    expect(player.getState().seekBook).toHaveBeenCalledWith(720);
  });

  it('moves in whole seconds for a clock, and keeps its shape while the chapter plays', async () => {
    const { result } = await renderHook(() => usePlayingSegment(undefined, { wholeSeconds: true }));
    const shape = result.current.segment;
    expect(result.current.elapsed).toBe(300);
    await act(async () => player.setState({ bookPosition: 901.2 }));
    expect(result.current.elapsed).toBe(301);
    expect(result.current.segment).toBe(shape);
  });

  it('is the file, seeking in it, without a whole-book timeline', async () => {
    player.setState({
      nowPlaying: { queue: { total: 0 } },
      chapter: null,
      snapshot: { trackIndex: 2, position: 30, duration: 600 },
    });
    const { result } = await renderHook(() => usePlayingSegment([10]));
    expect(result.current.segment).toMatchObject({ perTrack: true, length: 600 });
    expect(result.current.bookmarks).toEqual([]);
    result.current.onSeek(45);
    expect(player.getState().seekInTrack).toHaveBeenCalledWith(45);
  });
});
