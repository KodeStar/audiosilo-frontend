import {
  SHELF_GAP,
  SHELF_MAX_COLUMNS,
  SHELF_MIN_WIDTH,
  shelfColumns,
  shelfRows,
} from './smart-shelves-model';

describe('shelfColumns', () => {
  it('takes two on a phone at any width, measured or not', () => {
    for (const w of [0, 280, 358, 600, 2000]) expect(shelfColumns('phone', w)).toBe(2);
  });

  it('falls back to the form factor before the row is measured', () => {
    for (const w of [0, -10, Number.NaN]) {
      expect(shelfColumns('tablet', w)).toBe(2);
      expect(shelfColumns('desktop', w)).toBe(SHELF_MAX_COLUMNS);
    }
  });

  it('fits as many cards as stay at least the minimum width, two to four', () => {
    const fits = (n: number) => n * SHELF_MIN_WIDTH + (n - 1) * SHELF_GAP;
    expect(shelfColumns('tablet', fits(3) - 1)).toBe(2);
    expect(shelfColumns('tablet', fits(3))).toBe(3);
    expect(shelfColumns('desktop', fits(4) - 1)).toBe(3);
    expect(shelfColumns('desktop', fits(4))).toBe(4);
    // Never more than four, never fewer than two.
    expect(shelfColumns('desktop', 1416)).toBe(4);
    expect(shelfColumns('tablet', 100)).toBe(2);
    // The real pages: a 640 tablet (608 wide), a 1024 desktop (960 wide).
    expect(shelfColumns('tablet', 608)).toBe(3);
    expect(shelfColumns('desktop', 960)).toBe(4);
  });

  it('keeps every card at or above the minimum width it chose for', () => {
    for (let w = 400; w <= 1600; w += 7) {
      const cols = shelfColumns('desktop', w);
      if (cols > 2)
        expect((w - SHELF_GAP * (cols - 1)) / cols).toBeGreaterThanOrEqual(SHELF_MIN_WIDTH);
    }
  });
});

describe('shelfRows', () => {
  const sizes = (n: number, cols: number) =>
    shelfRows(
      Array.from({ length: n }, (_, i) => i),
      cols,
    ).map((r) => r.length);

  it('puts two on a row on a phone, the last odd card on its own', () => {
    expect(sizes(1, 2)).toEqual([1]);
    expect(sizes(2, 2)).toEqual([2]);
    expect(sizes(3, 2)).toEqual([2, 1]);
    expect(sizes(4, 2)).toEqual([2, 2]);
  });

  it('fills one row when four fit', () => {
    expect(sizes(2, 4)).toEqual([2]);
    expect(sizes(3, 4)).toEqual([3]);
    expect(sizes(4, 4)).toEqual([4]);
  });

  it('balances rows rather than leaving one card alone', () => {
    expect(sizes(4, 3)).toEqual([2, 2]);
    expect(sizes(5, 4)).toEqual([3, 2]);
    expect(sizes(3, 3)).toEqual([3]);
    // Rows differ by at most one, the fuller first, whatever the count.
    expect(sizes(10, 4)).toEqual([4, 3, 3]);
    expect(sizes(13, 4)).toEqual([4, 3, 3, 3]);
  });

  it('never loops on a column count below one', () => {
    expect(sizes(3, 0)).toEqual([1, 1, 1]);
    expect(sizes(3, Number.NaN)).toEqual([1, 1, 1]);
  });

  it('keeps the order and handles no shelves', () => {
    expect(shelfRows(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
    expect(shelfRows([], 4)).toEqual([]);
  });
});
