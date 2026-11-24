jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { chapterRowHeight, inlineRows } from './chapters-panel';
/* eslint-enable import/first */

describe('chapterRowHeight', () => {
  it('is 52 at the default text size and grows with the scale, to a cap', () => {
    expect(chapterRowHeight(1)).toBe(52);
    expect(chapterRowHeight(0.85)).toBe(52);
    expect(chapterRowHeight(2)).toBe(104);
    expect(chapterRowHeight(10)).toBe(chapterRowHeight(3.2));
  });
});

describe('inlineRows', () => {
  // A thousand rows of 50 in a page 800 high.
  it('draws the rows from the top before the list is measured', () => {
    expect(inlineRows(1000, 50, null, 0, 800)).toEqual([0, 40]);
  });

  it('draws the rows a page height either side of the visible part, in steps of 20', () => {
    // The list starts 1000 into the page, scrolled 26000: row 500 is at the top.
    expect(inlineRows(1000, 50, 1000, 26_000, 800)).toEqual([480, 540]);
    // A little further on stays in the same step, so the list is not redrawn.
    expect(inlineRows(1000, 50, 1000, 26_200, 800)).toEqual([480, 540]);
  });

  it('draws no rows while the list is far below or above the visible part', () => {
    expect(inlineRows(1000, 50, 5000, 0, 800)).toEqual([0, 0]);
    expect(inlineRows(1000, 50, 0, 60_000, 800)).toEqual([1000, 1000]);
  });

  it('keeps to the list at its ends', () => {
    expect(inlineRows(1000, 50, 1000, 0, 800)).toEqual([0, 20]);
    expect(inlineRows(30, 50, 0, 0, 800)).toEqual([0, 30]);
    expect(inlineRows(1000, 50, 0, 49_200, 800)).toEqual([960, 1000]);
  });
});
