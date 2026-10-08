import { act, renderHook } from '@testing-library/react-native';

jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePlayer: create(() => ({ key: null as string | null, position: 0 })),
    selectBookKey: (s: { key: string | null }) => s.key,
    selectBookPosition: (s: { position: number }) => s.position,
  };
});

/* eslint-disable import/first */
import { contentKey } from '@/lib/content-key';
import { usePlayer } from '@/playback/store';

import {
  useListeningChapter,
  useListeningPosition,
  useLivePosition,
  useResumePosition,
} from './use-listening-position';
/* eslint-enable import/first */

const target = { connectionId: 'c', libraryId: 1, path: 'Book' };
const setPlayer = (s: { key: string | null; position: number; loadingBook?: string | null }) =>
  act(() => (usePlayer as unknown as { setState: (p: object) => void }).setState(s));

describe('useListeningPosition', () => {
  it('is the saved place, or the live one (rounded down, never below the saved) while loaded', async () => {
    await setPlayer({ key: null, position: 0 });
    const { result } = await renderHook(() => useListeningPosition(target, 100, 15));
    expect(result.current).toBe(100);

    await setPlayer({ key: contentKey('c', 1, 'Book'), position: 250 });
    expect(result.current).toBe(240);

    await setPlayer({ key: contentKey('c', 1, 'Book'), position: 20 });
    expect(result.current).toBe(100);

    await setPlayer({ key: contentKey('c', 1, 'Other'), position: 999 });
    expect(result.current).toBe(100);
  });
});

describe('useResumePosition', () => {
  it("is the loaded book's live place, also below the saved one; the saved one otherwise", async () => {
    await setPlayer({ key: null, position: 0 });
    const { result } = await renderHook(() => useResumePosition(target, 1000, 15));
    expect(result.current).toBe(1000);

    // Loaded and paused behind a place another device saved: a press plays from here.
    await setPlayer({ key: contentKey('c', 1, 'Book'), position: 250 });
    expect(result.current).toBe(240);

    // Not ticked yet (the load reads 0): the saved place until the player has moved.
    await setPlayer({ key: contentKey('c', 1, 'Book'), position: 0 });
    expect(result.current).toBe(1000);
    // Moved, but under one bucket: still the player's place, not the saved one.
    await setPlayer({ key: contentKey('c', 1, 'Book'), position: 5 });
    expect(result.current).toBe(0);

    await setPlayer({ key: contentKey('c', 1, 'Other'), position: 999 });
    expect(result.current).toBe(1000);
  });

  it("waits out a new book's load", async () => {
    const key = contentKey('c', 1, 'Book');
    await setPlayer({ key, position: 1300, loadingBook: key });
    const { result } = await renderHook(() => useResumePosition(target, 100, 15));
    expect(result.current).toBe(100);
    await setPlayer({ key, position: 650, loadingBook: null });
    expect(result.current).toBe(645);
  });
});

describe('useListeningChapter', () => {
  const starts = [0, 600, 1200];

  it('places the listener by chapter, re-rendering only when the chapter changes', async () => {
    await setPlayer({ key: null, position: 0 });
    let renders = 0;
    const { result } = await renderHook(() => {
      renders++;
      return useListeningChapter(target, undefined, starts);
    });
    expect(result.current).toBe(0);

    await setPlayer({ key: contentKey('c', 1, 'Book'), position: 700 });
    expect(result.current).toBe(2);
    const before = renders;
    await setPlayer({ key: contentKey('c', 1, 'Book'), position: 760 });
    await setPlayer({ key: contentKey('c', 1, 'Book'), position: 1190 });
    expect(renders).toBe(before);
    // Rounded down to the gate's bucket: 1210 reads as 1200, the third chapter.
    await setPlayer({ key: contentKey('c', 1, 'Book'), position: 1210 });
    expect(result.current).toBe(3);
  });

  it("waits out a new book's load: the snapshot still holds the previous book's place", async () => {
    const key = contentKey('c', 1, 'Book');
    // 1300 s was the OLD book's place; in this book it would be chapter 3.
    await setPlayer({ key, position: 1300, loadingBook: key });
    const { result } = await renderHook(() => useListeningChapter(target, 100, starts));
    expect(result.current).toBe(1);
    const live = await renderHook(() => useLivePosition(15));
    expect(live.result.current).toBeNull();
    await setPlayer({ key, position: 650, loadingBook: null });
    expect(result.current).toBe(2);
  });

  it('never goes below the saved place', async () => {
    await setPlayer({ key: contentKey('c', 1, 'Book'), position: 5 });
    const { result } = await renderHook(() => useListeningChapter(target, 650, starts));
    expect(result.current).toBe(2);
  });
});

describe('useLivePosition', () => {
  it('names the loaded book and its bucketed place, nothing while disabled', async () => {
    await setPlayer({ key: 'k', position: 31 });
    const on = await renderHook(() => useLivePosition(15));
    expect(on.result.current).toEqual({ key: 'k', position: 30 });
    const off = await renderHook(() => useLivePosition(15, false));
    expect(off.result.current).toBeNull();
  });
});
