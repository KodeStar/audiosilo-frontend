import { act, renderHook } from '@testing-library/react-native';

import { playerStoreMock } from '@/testing/player-store-mock';

import type { ReaderHostHandle } from './reader-host-types';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { NARRATION_JUMP_S, narrationMoved, type NarrationSample, useNarration } from './narration';
/* eslint-enable import/first */

const player = playerStoreMock();
const BOOK = { connectionId: 'c1', libraryId: 1, path: 'A/Book' };
const nowPlaying = (path = BOOK.path) => ({
  connectionId: 'c1',
  libraryId: 1,
  path,
  queue: { chapters: [], total: 1000 },
});

const sample = (t: number | null, at: number, playing = true, rate = 1): NarrationSample => ({
  position: t === null ? null : { t, rate, playing },
  at,
});

describe('narrationMoved', () => {
  it('passes over the narration playing on by itself', () => {
    expect(narrationMoved(sample(10, 0), sample(11, 1000))).toBe(false);
    // At 2x a second plays two.
    expect(narrationMoved(sample(10, 0, true, 2), sample(12, 1000, true, 2))).toBe(false);
    expect(narrationMoved(sample(10, 0, false), sample(10, 1000, false))).toBe(false);
  });

  it('hears a seek, a play, a pause and a speed change', () => {
    expect(narrationMoved(sample(10, 0), sample(10 + NARRATION_JUMP_S + 2, 1000))).toBe(true);
    expect(narrationMoved(sample(10, 0), sample(5, 1000))).toBe(true);
    expect(narrationMoved(sample(10, 0, false), sample(10, 1000, true))).toBe(true);
    expect(narrationMoved(sample(10, 0, true), sample(11, 1000, false))).toBe(true);
    expect(narrationMoved(sample(10, 0, true, 1), sample(11, 1000, true, 1.5))).toBe(true);
  });

  it('hears the book becoming, or stopping being, the one placed', () => {
    expect(narrationMoved(sample(null, 0), sample(10, 1000))).toBe(true);
    expect(narrationMoved(sample(10, 0), sample(null, 1000))).toBe(true);
    expect(narrationMoved(sample(null, 0), sample(null, 1000))).toBe(false);
  });
});

describe('useNarration', () => {
  const handle: ReaderHostHandle = {
    goto: jest.fn(),
    next: jest.fn(),
    prev: jest.fn(),
    follow: jest.fn(),
    syncPosition: jest.fn(),
  };
  const host = { current: handle };

  beforeEach(() => {
    jest.clearAllMocks();
    player.reset();
    player.clearSpies();
  });

  it('reads the narration of the book while it is the one placed, else none', async () => {
    const { result } = await renderHook(() => useNarration(BOOK, host));
    expect(result.current.narrating).toBe(false);
    expect(result.current.readalongPosition()).toBeNull();
    await act(async () => {
      player.usePlayer.setState({
        nowPlaying: nowPlaying(),
        bookPosition: 42,
        rate: 1.25,
        snapshot: { state: 'playing', trackIndex: 0, position: 42, duration: 99, rate: 1.25 },
      });
    });
    expect(result.current.narrating).toBe(true);
    expect(result.current.readalongPosition()).toEqual({ t: 42, rate: 1.25, playing: true });
    // A book just started whose load has not landed is not placed yet.
    await act(async () => {
      player.usePlayer.setState({ loadingBook: 'c1:1:A/Book' });
    });
    expect(result.current.readalongPosition()).toBeNull();
  });

  it('tells the host at once of a play, a pause and a seek, not of a tick', async () => {
    player.patch({ nowPlaying: nowPlaying(), bookPosition: 10 });
    await renderHook(() => useNarration(BOOK, host));
    await act(async () => player.setPlayState('playing'));
    expect(handle.syncPosition).toHaveBeenCalledTimes(1);
    await act(async () => {
      player.usePlayer.setState({ bookPosition: 10.25 });
    });
    expect(handle.syncPosition).toHaveBeenCalledTimes(1);
    await act(async () => {
      player.usePlayer.setState({ bookPosition: 300 });
    });
    expect(handle.syncPosition).toHaveBeenCalledTimes(2);
    await act(async () => player.setPlayState('paused'));
    expect(handle.syncPosition).toHaveBeenCalledTimes(3);
  });

  it('plays a tapped sentence through the whole-book seek, then sends the place', async () => {
    player.patch({ nowPlaying: nowPlaying(), bookPosition: 10 });
    const { result } = await renderHook(() => useNarration(BOOK, host));
    await act(async () => result.current.onSeek(123.4));
    expect(player.spies.seekBook).toHaveBeenCalledWith(123.4);
    expect(handle.syncPosition).toHaveBeenCalled();
  });

  it('plays nothing for a tap in a book the player does not hold', async () => {
    player.patch({ nowPlaying: nowPlaying('B/Other'), bookPosition: 10 });
    const { result } = await renderHook(() => useNarration(BOOK, host));
    await act(async () => result.current.onSeek(5));
    expect(player.spies.seekBook).not.toHaveBeenCalled();
  });
});
