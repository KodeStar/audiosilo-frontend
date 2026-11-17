jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { chapterRowHeight, openingIndex } from './chapters-panel';
/* eslint-enable import/first */

describe('chapterRowHeight', () => {
  it('is 52 at the default text size and grows with the scale, to a cap', () => {
    expect(chapterRowHeight(1)).toBe(52);
    expect(chapterRowHeight(0.85)).toBe(52);
    expect(chapterRowHeight(2)).toBe(104);
    expect(chapterRowHeight(10)).toBe(chapterRowHeight(3.2));
  });
});

describe('openingIndex', () => {
  it('opens at the row only when the rows from it on fill the window', () => {
    // Four files, on Part 4 (two above it is Part 2): the list can't scroll there, so it
    // opens at its top and Part 1 is drawn (it stayed blank on Android).
    expect(openingIndex(1, 4, 52, 800)).toBeUndefined();
    expect(openingIndex(50, 100, 52, 800)).toBe(50);
    expect(openingIndex(90, 100, 52, 800)).toBeUndefined();
    expect(openingIndex(0, 100, 52, 800)).toBeUndefined();
  });
});
