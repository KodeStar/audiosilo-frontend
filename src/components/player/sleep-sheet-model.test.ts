import type { Chapter } from '@/api/types';

// The model reads the sleep timer's types and label helper, which pull in the player
// store: the shared double keeps the engine out.
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import {
  isDurationTimer,
  sleepNotice,
  stopAfterLabel,
  stopAfterRows,
  stopsAt,
} from './sleep-sheet-model';
/* eslint-enable import/first */

function chapter(
  index: number,
  offset: number,
  length: number,
  title = `Ch ${index + 1}`,
): Chapter {
  return {
    index,
    title,
    file_index: 0,
    file_path: 'b.m4b',
    start: 0,
    end: length,
    book_offset: offset,
  };
}

/** Six 10-minute chapters. */
const SIX = Array.from({ length: 6 }, (_, i) => chapter(i, i * 600, 600));
const queue = (chapters = SIX, extra: { syntheticChapters?: boolean } = {}) => ({
  chapters,
  total: chapters.length * 600,
  ...extra,
});

describe('stopAfterRows', () => {
  it('lists this chapter and the next three, with wall-clock time at the speed', () => {
    const rows = stopAfterRows(queue(), 900, 2); // halfway through chapter 2, at 2x
    expect(rows.map((r) => [r.count, r.chapter.index, r.endPosition])).toEqual([
      [1, 1, 1200],
      [2, 2, 1800],
      [3, 3, 2400],
      [4, 4, 3000],
    ]);
    expect(rows[0].untilEnd).toBe(150); // 300 content seconds at 2x
  });

  it('stops at the end of the book', () => {
    const rows = stopAfterRows(queue(), 3000 + 60, 1); // in the last chapter
    expect(rows.map((r) => r.chapter.index)).toEqual([5]);
  });

  it('offers nothing for synthetic or missing chapters', () => {
    expect(stopAfterRows(queue(SIX, { syntheticChapters: true }), 0, 1)).toEqual([]);
    expect(stopAfterRows(queue([]), 0, 1)).toEqual([]);
  });

  it('leaves out a chapter ending past the book (bad metadata)', () => {
    const q = { chapters: [chapter(0, 0, 600), chapter(1, 600, 9000)], total: 1200 };
    expect(stopAfterRows(q, 0, 1).map((r) => r.chapter.index)).toEqual([0]);
  });
});

describe('stopAfterLabel', () => {
  it('names one chapter, and counts more', () => {
    const [one, two] = stopAfterRows(queue(), 0, 1);
    expect(stopAfterLabel(one)).toEqual({
      key: 'player.sleepTimer.endOf',
      params: { chapter: 'Ch 1' },
    });
    expect(stopAfterLabel(two)).toEqual({
      key: 'player.sleepTimer.afterChapters',
      params: { count: 2 },
    });
  });
});

describe('sleepNotice', () => {
  it('reads a duration timer as on', () => {
    expect(sleepNotice({ kind: 'duration', minutes: 30 }, null, null, SIX, 0)).toEqual({
      kind: 'duration',
    });
  });

  it('counts the chapters left before a chapter timer stops, live', () => {
    const origin = { kind: 'chapter' } as const;
    expect(sleepNotice(origin, null, 1800, SIX, 100)).toEqual({ kind: 'chapters', count: 3 });
    // A chapter later, the same timer has two to go.
    expect(sleepNotice(origin, null, 1800, SIX, 700)).toEqual({ kind: 'chapters', count: 2 });
    expect(sleepNotice(origin, null, 1800, SIX, 1700)).toEqual({ kind: 'chapters', count: 1 });
  });

  it('says the end of the book for that target', () => {
    expect(
      sleepNotice({ kind: 'chapter' }, { key: 'player.sleepTimer.endOfBook' }, 3600, SIX, 0),
    ).toEqual({ kind: 'book' });
  });
});

describe('selection', () => {
  it('selects the preset of a running duration timer only', () => {
    expect(isDurationTimer('running', { kind: 'duration', minutes: 30 }, 30)).toBe(true);
    expect(isDurationTimer('running', { kind: 'duration', minutes: 30 }, 15)).toBe(false);
    expect(isDurationTimer('idle', null, 30)).toBe(false);
    expect(isDurationTimer('running', { kind: 'chapter' }, 30)).toBe(false);
  });

  it('selects the row a chapter timer stops at', () => {
    expect(stopsAt('running', 1800, 1800.2)).toBe(true);
    expect(stopsAt('running', 1800, 2400)).toBe(false);
    expect(stopsAt('idle', null, 1800)).toBe(false);
  });
});
