import { openingIndex, openingOffset } from './list-opening';

describe('openingIndex', () => {
  it('opens at the row only when the rows from it on fill the window', () => {
    // 10 rows of 50 below row 190 fill a 500-high window; 9 rows do not.
    expect(openingIndex(190, 200, 50, 500)).toBe(190);
    expect(openingIndex(191, 200, 50, 500)).toBeUndefined();
    // Four files, on Part 4 (two above it is Part 2): the list can't scroll there, so it
    // opens at its top and Part 1 is drawn (it stayed blank on Android).
    expect(openingIndex(1, 4, 52, 800)).toBeUndefined();
    expect(openingIndex(50, 100, 52, 800)).toBe(50);
    expect(openingIndex(90, 100, 52, 800)).toBeUndefined();
  });

  it('needs no opening index at the top', () => {
    expect(openingIndex(0, 200, 50, 500)).toBeUndefined();
  });
});

describe('openingOffset', () => {
  it('scrolls to the row when the list goes that far', () => {
    expect(openingOffset(10, 100, 50, 500)).toBe(500);
  });

  it('stops at the end of the list, its bottom padding included', () => {
    // 100 rows of 50 in a 500-high list scroll 4500 at most; 12 of padding adds to that.
    expect(openingOffset(95, 100, 50, 500)).toBe(4500);
    expect(openingOffset(95, 100, 50, 500, 12)).toBe(4512);
  });

  it('never scrolls a list shorter than its window', () => {
    expect(openingOffset(3, 4, 52, 800)).toBe(0);
  });
});
