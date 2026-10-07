import { act, renderHook } from '@testing-library/react-native';

jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return { usePlayer: create(() => ({ nowPlaying: null, position: 0 })) };
});

/* eslint-disable import/first */
import { usePlayer } from '@/playback/store';

import { selectIsLoaded, usePlayingTarget } from './playing-target';
/* eslint-enable import/first */

const setPlayer = (s: object) =>
  act(() => (usePlayer as unknown as { setState: (p: object) => void }).setState(s));
const BOOK = { connectionId: 'c', libraryId: 1, path: 'A/Book' };

describe('selectIsLoaded', () => {
  it('matches the loaded book by connection, library and path', () => {
    const np = { ...BOOK, title: 'T' };
    expect(selectIsLoaded(BOOK)({ nowPlaying: np })).toBe(true);
    expect(selectIsLoaded({ ...BOOK, connectionId: 'd' })({ nowPlaying: np })).toBe(false);
    expect(selectIsLoaded({ ...BOOK, libraryId: 2 })({ nowPlaying: np })).toBe(false);
    expect(selectIsLoaded({ ...BOOK, path: 'A/Other' })({ nowPlaying: np })).toBe(false);
    expect(selectIsLoaded(null)({ nowPlaying: np })).toBe(false);
    expect(selectIsLoaded(BOOK)({ nowPlaying: null })).toBe(false);
  });
});

describe('usePlayingTarget', () => {
  it('is the same object until another book loads', async () => {
    await setPlayer({ nowPlaying: null });
    const { result } = await renderHook(() => usePlayingTarget());
    expect(result.current).toBeNull();
    await setPlayer({ nowPlaying: { ...BOOK, title: 'T' } });
    const first = result.current;
    expect(first).toEqual(BOOK);
    await setPlayer({ nowPlaying: { ...BOOK, title: 'T' }, position: 10 });
    expect(result.current).toBe(first);
    await setPlayer({ nowPlaying: { ...BOOK, path: 'A/Next' } });
    expect(result.current).toEqual({ ...BOOK, path: 'A/Next' });
  });
});
