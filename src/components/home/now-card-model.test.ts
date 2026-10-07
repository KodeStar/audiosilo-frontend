import {
  bookmarkPins,
  bookScale,
  chapterIndexAt,
  chapterPlace,
  nowCardCompact,
  scaleRuns,
} from './now-card-model';

describe('bookScale', () => {
  const starts = [0, 100, 300, 600];
  it('weighs each chapter by its length and marks where the listener is', () => {
    expect(bookScale(starts, 1000, 350)).toEqual([
      { weight: 100, state: 'past' },
      { weight: 200, state: 'past' },
      { weight: 300, state: 'current' },
      { weight: 400, state: 'ahead' },
    ]);
  });
  it('starts on the first chapter before anything is heard', () => {
    expect(bookScale(starts, 1000, 0).map((s) => s.state)).toEqual([
      'current',
      'ahead',
      'ahead',
      'ahead',
    ]);
  });
  it('merges neighbours past the tick limit, keeping the current one', () => {
    const many = Array.from({ length: 10 }, (_, i) => i * 10);
    const merged = bookScale(many, 100, 55, 4);
    expect(merged).toHaveLength(4); // runs of three
    expect(merged.map((s) => s.state)).toEqual(['past', 'current', 'ahead', 'ahead']);
    expect(merged.map((s) => s.weight)).toEqual([30, 30, 30, 10]);
  });
  it('is a plain progress bar without chapters', () => {
    expect(bookScale([], 1000, 250)).toEqual([
      { weight: 250, state: 'past' },
      { weight: 750, state: 'ahead' },
    ]);
    expect(bookScale([], 0, 0)).toEqual([]);
  });
});

describe('scaleRuns', () => {
  it('is the chapters, or runs of them past the limit, whatever the place', () => {
    expect(scaleRuns([0, 100, 300], 600, 10)).toEqual([
      { first: 0, last: 0, from: 0, to: 100, weight: 100 },
      { first: 1, last: 1, from: 100, to: 300, weight: 200 },
      { first: 2, last: 2, from: 300, to: 600, weight: 300 },
    ]);
    expect(scaleRuns([0, 100, 300], 600, 2)).toEqual([
      { first: 0, last: 1, from: 0, to: 300, weight: 300 },
      { first: 2, last: 2, from: 300, to: 600, weight: 300 },
    ]);
    expect(scaleRuns([0, 100], 600, Infinity)).toHaveLength(2);
    expect(scaleRuns([], 600, 10)).toEqual([]);
    expect(scaleRuns([0], 0, 10)).toEqual([]);
  });
});

describe('chapterIndexAt', () => {
  it('is the 0-based chapter holding the place, 0 before the first start', () => {
    expect(chapterIndexAt([0, 100, 300], 0)).toBe(0);
    expect(chapterIndexAt([0, 100, 300], 299)).toBe(1);
    expect(chapterIndexAt([0, 100, 300], 5000)).toBe(2);
    expect(chapterIndexAt([50, 100], 10)).toBe(0);
    expect(chapterIndexAt([], 10)).toBe(0);
  });
});

describe('bookmarkPins', () => {
  it('places bookmarks along the book and drops strays', () => {
    expect(bookmarkPins([0, 250, 1000, 1200, -5], 1000)).toEqual([0, 0.25, 1]);
    expect(bookmarkPins([10], 0)).toEqual([]);
  });
});

describe('chapterPlace', () => {
  const titles = ['Prologue', 'One', 'Two'];
  it('names the chapter the listener is in', () => {
    expect(chapterPlace(titles, [0, 100, 200], 150)).toEqual({
      number: 2,
      count: 3,
      title: 'One',
    });
  });
  it('is chapter 1 before the first start, and nothing without chapters', () => {
    expect(chapterPlace(titles, [0, 100, 200], 0)?.number).toBe(1);
    expect(chapterPlace([], [], 50)).toBeNull();
  });
});

describe('nowCardCompact', () => {
  it('stacks on a phone, and on a card too narrow for the cover beside the text', () => {
    expect(nowCardCompact(true, 0)).toBe(true);
    expect(nowCardCompact(false, 0)).toBe(false);
    expect(nowCardCompact(false, 420)).toBe(true);
    expect(nowCardCompact(false, 600)).toBe(true);
    expect(nowCardCompact(false, 620)).toBe(false);
  });
});
