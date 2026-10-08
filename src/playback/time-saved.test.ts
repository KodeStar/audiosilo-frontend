import type AsyncStorageType from '@react-native-async-storage/async-storage';

import {
  addSaved,
  mergeSaved,
  parseTimeSaved,
  savedForDisplay,
  silenceDelta,
  withoutConnection,
} from './time-saved';
import { formatDuration } from '@/lib/format';

const KEY = 'audiosilo.timeSaved';

// The removal registry, captured so a test can remove a connection.
let mockRemoved: ((id: string) => Promise<void> | void) | null = null;
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: (fn: (id: string) => Promise<void> | void) => {
    mockRemoved = fn;
    return () => {};
  },
}));

describe('silenceDelta', () => {
  it('takes the first total as the base: an engine can hold savings already counted', () => {
    expect(silenceDelta(null, 40)).toEqual({ delta: 0, base: 40 });
  });
  it('adds growth', () => {
    expect(silenceDelta(40, 42.5)).toEqual({ delta: 2.5, base: 42.5 });
    expect(silenceDelta(42.5, 42.5)).toEqual({ delta: 0, base: 42.5 });
  });
  it('re-bases on a lower total (a new engine starts again at 0), adding nothing', () => {
    expect(silenceDelta(42.5, 1)).toEqual({ delta: 0, base: 1 });
  });
  it('ignores a total that is not a count', () => {
    expect(silenceDelta(10, Number.NaN)).toEqual({ delta: 0, base: 10 });
    expect(silenceDelta(10, -1)).toEqual({ delta: 0, base: 10 });
  });
});

describe('the counts document', () => {
  it('adds to the book and the lifetime total', () => {
    const doc = addSaved(addSaved({ lifetime: 0, books: {} }, 'c1:2:a', 3), 'c1:2:b', 2);
    expect(addSaved(doc, 'c1:2:a', 1)).toEqual({
      lifetime: 6,
      books: { 'c1:2:a': 4, 'c1:2:b': 2 },
    });
    expect(addSaved(doc, 'c1:2:a', 0)).toBe(doc);
  });
  it('merges two documents by summing', () => {
    expect(
      mergeSaved({ lifetime: 5, books: { a: 5 } }, { lifetime: 2, books: { a: 1, b: 1 } }),
    ).toEqual({ lifetime: 7, books: { a: 6, b: 1 } });
  });
  it("drops a removed connection's books and keeps the lifetime total", () => {
    expect(withoutConnection({ lifetime: 9, books: { 'c1:2:a': 4, 'c10:2:a': 5 } }, 'c1')).toEqual({
      lifetime: 9,
      books: { 'c10:2:a': 5 },
    });
  });
  it('reads only counts back', () => {
    expect(parseTimeSaved(null)).toEqual({});
    expect(parseTimeSaved({ lifetime: 'x', books: { a: 3, b: -1, c: 'y' } })).toEqual({
      lifetime: 0,
      books: { a: 3 },
    });
  });
});

describe('savedForDisplay', () => {
  it('keeps whole seconds under a minute, then whole minutes', () => {
    expect(savedForDisplay(0.4)).toBe(0);
    expect(savedForDisplay(41.6)).toBe(42);
    expect(savedForDisplay(59.4)).toBe(59);
    expect(savedForDisplay(59.6)).toBe(60);
    expect(savedForDisplay(7899)).toBe(7860);
  });
  it('never changes the words the figure is shown in', () => {
    for (const s of [0.6, 12.4, 59.5, 60, 61, 119.6, 3599.5, 3600, 7899, 90061.2]) {
      expect(formatDuration(savedForDisplay(s))).toBe(formatDuration(s));
    }
  });
});

describe('counting and saving', () => {
  // The module keeps its hydration and engine base as module state: a fresh registry each.
  let AsyncStorage: typeof AsyncStorageType;
  let ts: typeof import('./time-saved');
  beforeEach(() => {
    jest.resetModules();
    /* eslint-disable @typescript-eslint/no-require-imports */
    AsyncStorage = require('@react-native-async-storage/async-storage').default;
    ts = require('./time-saved');
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const stored = async () => JSON.parse((await AsyncStorage.getItem(KEY)) ?? 'null');

  it('counts growth on the playing book, and adds to what was stored, never over it', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ lifetime: 100, books: { 'c1:2:a': 50 } }));
    ts.noteSilenceSaved(10, 'c1:2:a'); // the base
    ts.noteSilenceSaved(14, 'c1:2:a');
    ts.noteSilenceSaved(15, 'c1:2:b');
    await ts.flushTimeSaved();
    expect(await stored()).toEqual({ lifetime: 105, books: { 'c1:2:a': 54, 'c1:2:b': 1 } });
    expect(ts.useTimeSavedStore.getState().lifetime).toBe(105);
  });

  it('counts nothing for a new engine, then its growth', async () => {
    ts.noteSilenceSaved(30, 'k');
    ts.noteSilenceSaved(32, 'k'); // +2
    ts.noteSilenceSaved(0.5, 'k'); // a new engine: base only
    ts.noteSilenceSaved(1.5, 'k'); // +1
    expect(ts.useTimeSavedStore.getState().books.k).toBe(3);
  });

  it('writes nothing per tick: only a flush writes, and only when something was added', async () => {
    jest.spyOn(AsyncStorage, 'setItem');
    ts.noteSilenceSaved(0, 'k');
    ts.noteSilenceSaved(1, 'k');
    ts.noteSilenceSaved(2, 'k');
    await Promise.resolve();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    await ts.flushTimeSaved();
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    await ts.flushTimeSaved();
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  });

  it('flushes by itself 30 s after the counts grow', async () => {
    jest.useFakeTimers();
    ts.noteSilenceSaved(0, 'k');
    ts.noteSilenceSaved(4, 'k');
    await ts.hydrateTimeSaved();
    expect(await stored()).toBeNull();
    jest.advanceTimersByTime(30_000);
    jest.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    expect(await stored()).toEqual({ lifetime: 4, books: { k: 4 } });
  });

  it('flushes when the app leaves the foreground', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppState } = require('react-native') as typeof import('react-native');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const listeners: ((s: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      l: (s: string) => void,
    ) => {
      listeners.push(l);
      return { remove: () => {} };
    }) as unknown as typeof AppState.addEventListener);
    ts.noteSilenceSaved(0, 'k');
    ts.noteSilenceSaved(4, 'k');
    ts.noteSilenceSaved(5, 'k');
    expect(listeners).toHaveLength(1); // one listener for the run, not one per count
    await ts.hydrateTimeSaved();
    expect(await stored()).toBeNull();
    listeners.forEach((l) => l('background'));
    await new Promise((r) => setTimeout(r, 0));
    expect(await stored()).toEqual({ lifetime: 5, books: { k: 5 } });
  });

  it("forgets a removed connection's books", async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ lifetime: 9, books: { 'c1:2:a': 4, 'c2:2:a': 5 } }),
    );
    await mockRemoved!('c1');
    expect(await stored()).toEqual({ lifetime: 9, books: { 'c2:2:a': 5 } });
    expect(ts.useTimeSavedStore.getState().books).toEqual({ 'c2:2:a': 5 });
  });
});
