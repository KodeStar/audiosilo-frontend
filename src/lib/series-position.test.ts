import {
  bookSeriesNumber,
  bookSeriesSpan,
  parseSeriesPosition,
  placedPositionLabel,
  railPositionLabel,
  seriesNumber,
  seriesPositionValue,
  seriesSpan,
  spanCovers,
  spanEnd,
} from './series-position';

describe('parseSeriesPosition', () => {
  it('reads a single position', () => {
    expect(parseSeriesPosition('3')).toEqual({ start: 3 });
    expect(parseSeriesPosition('2.5')).toEqual({ start: 2.5 });
    expect(parseSeriesPosition(' 7 ')).toEqual({ start: 7 });
  });

  it('reads a range, with or without spaces, hyphen or en dash', () => {
    expect(parseSeriesPosition('1-3')).toEqual({ start: 1, end: 3 });
    expect(parseSeriesPosition('1 - 3')).toEqual({ start: 1, end: 3 });
    expect(parseSeriesPosition('1–3')).toEqual({ start: 1, end: 3 });
    expect(parseSeriesPosition('1-3.5')).toEqual({ start: 1, end: 3.5 });
  });

  it('keeps only the start of a range that does not run forward', () => {
    expect(parseSeriesPosition('3-1')).toEqual({ start: 3 });
    expect(parseSeriesPosition('2-2')).toEqual({ start: 2 });
  });

  it('reads a range only where the server takes one (above 0, at most 100 places on)', () => {
    expect(parseSeriesPosition('0-3')).toEqual({ start: 0 });
    expect(parseSeriesPosition('1-101')).toEqual({ start: 1, end: 101 });
    expect(parseSeriesPosition('1-102')).toEqual({ start: 1 });
    expect(parseSeriesPosition('99999-100001')).toEqual({ start: 99999 });
  });

  it('reads the leading number of anything else, as positions always have', () => {
    expect(parseSeriesPosition('1, 2')).toEqual({ start: 1 });
    expect(parseSeriesPosition('4a')).toEqual({ start: 4 });
  });

  it('is undefined for no number', () => {
    expect(parseSeriesPosition('')).toBeUndefined();
    expect(parseSeriesPosition('novella')).toBeUndefined();
    expect(parseSeriesPosition(undefined)).toBeUndefined();
  });

  it('sorts a range by its start', () => {
    expect(seriesPositionValue('1-3')).toBe(1);
    expect(seriesPositionValue('2.5')).toBe(2.5);
    expect(seriesPositionValue('x')).toBeUndefined();
  });
});

describe('spans', () => {
  it('end at their end, else their start', () => {
    expect(spanEnd({ start: 1, end: 3 })).toBe(3);
    expect(spanEnd({ start: 4 })).toBe(4);
  });

  it('cover every slot from start to end, inclusive', () => {
    const omnibus = seriesSpan(1, 3);
    expect([0, 1, 2, 3, 4].map((n) => spanCovers(omnibus, n))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(spanCovers(seriesSpan(2), 2)).toBe(true);
    expect(spanCovers(seriesSpan(2), 3)).toBe(false);
  });

  it('drop an end that is not past the start', () => {
    expect(seriesSpan(3, 3)).toEqual({ start: 3 });
    expect(seriesSpan(3, 1)).toEqual({ start: 3 });
    expect(seriesSpan(3)).toEqual({ start: 3 });
  });
});

describe('seriesNumber', () => {
  it('shows a single position or a range', () => {
    expect(seriesNumber(3)).toBe('3');
    expect(seriesNumber(2.5)).toBe('2.5');
    expect(seriesNumber(1, 3)).toBe('1-3');
    expect(seriesNumber(3, 3)).toBe('3');
  });

  it('is empty without a position', () => {
    expect(seriesNumber(0)).toBe('');
    expect(seriesNumber(0, 3)).toBe('');
    expect(seriesNumber(undefined)).toBe('');
  });

  it('reads a book', () => {
    expect(bookSeriesNumber({ series_index: 1, series_index_end: 3 })).toBe('1-3');
    // An older server sends no end.
    expect(bookSeriesNumber({ series_index: 4 })).toBe('4');
    expect(bookSeriesNumber({})).toBe('');
    expect(bookSeriesSpan({ series_index: 1, series_index_end: 3 })).toEqual({ start: 1, end: 3 });
    expect(bookSeriesSpan({ series_index: 0 })).toEqual({ start: 0 });
  });
});

describe('railPositionLabel', () => {
  it('writes a range one way and leaves anything else as the rail wrote it', () => {
    expect(railPositionLabel('1 - 3')).toBe('1-3');
    expect(railPositionLabel('1–3')).toBe('1-3');
    expect(railPositionLabel('2.5')).toBe('2.5');
    expect(railPositionLabel(' 4 ')).toBe('4');
    expect(railPositionLabel('novella')).toBe('novella');
    expect(railPositionLabel(undefined)).toBe('');
    // No range the server takes: as written, never blanked.
    expect(railPositionLabel('0-3')).toBe('0-3');
  });
});

describe('placedPositionLabel', () => {
  it('shows an omnibus placed at the entry it starts at by its range', () => {
    expect(placedPositionLabel('1', { series_index: 1, series_index_end: 3 })).toBe('1-3');
  });

  it("else the rail's label", () => {
    expect(placedPositionLabel('1 - 3', { series_index: 1, series_index_end: 3 })).toBe('1-3');
    expect(placedPositionLabel('2', { series_index: 1, series_index_end: 3 })).toBe('2');
    expect(placedPositionLabel('1', { series_index: 1 })).toBe('1');
    expect(placedPositionLabel('novella', { series_index: 1, series_index_end: 3 })).toBe(
      'novella',
    );
    expect(placedPositionLabel('4', undefined)).toBe('4');
  });
});
