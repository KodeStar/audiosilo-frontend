import {
  chapterIndexAt,
  maxSegmentsFor,
  pinFractions,
  timelineSegments,
} from './book-timeline-model';

describe('timelineSegments', () => {
  const starts = [0, 100, 300, 600];

  it('sizes each chapter by its length and marks where the listener is', () => {
    expect(timelineSegments(starts, 1000, 400)).toEqual([
      { weight: 100, state: 'past', played: 0, first: 0, last: 0 },
      { weight: 200, state: 'past', played: 0, first: 1, last: 1 },
      { weight: 300, state: 'current', played: 1 / 3, first: 2, last: 2 },
      { weight: 400, state: 'ahead', played: 0, first: 3, last: 3 },
    ]);
  });

  it('is one segment for a book without chapters', () => {
    expect(timelineSegments([], 1000, 250)).toEqual([
      { weight: 1000, state: 'current', played: 0.25, first: 0, last: 0 },
    ]);
  });

  it('is nothing without a known length (a per-file book)', () => {
    expect(timelineSegments(starts, 0, 10)).toEqual([]);
    expect(timelineSegments(starts, -5, 10)).toEqual([]);
  });

  it('counts an intro before the first chapter as part of it', () => {
    const [first] = timelineSegments([30, 100], 200, 10);
    expect(first).toMatchObject({ weight: 100, state: 'current', played: 0.1 });
  });

  it('merges neighbours when there are more chapters than fit', () => {
    const many = Array.from({ length: 10 }, (_, i) => i * 100);
    const segments = timelineSegments(many, 1000, 450, 5);
    expect(segments).toHaveLength(5);
    expect(segments.map((s) => s.state)).toEqual(['past', 'past', 'current', 'ahead', 'ahead']);
    // Chapters 4 and 5 (400..600), the listener at 450.
    expect(segments[2]).toMatchObject({ first: 4, last: 5, weight: 200, played: 0.25 });
  });

  it('gives a zero-length chapter a sliver', () => {
    const [, empty] = timelineSegments([0, 100, 100], 1000, 0);
    expect(empty.weight).toBe(1);
  });

  it('clamps the place to the book', () => {
    expect(timelineSegments([0], 100, 500)[0].played).toBe(1);
    expect(timelineSegments([0], 100, -5)[0].played).toBe(0);
  });
});

describe('maxSegmentsFor', () => {
  it('fits 3-point segments with their gaps, unlimited before layout', () => {
    expect(maxSegmentsFor(0)).toBe(Infinity);
    expect(maxSegmentsFor(98)).toBe(20);
    expect(maxSegmentsFor(1)).toBe(1);
  });
});

describe('chapterIndexAt', () => {
  it('finds the chapter holding a position', () => {
    expect(chapterIndexAt([0, 100, 300], 0)).toBe(0);
    expect(chapterIndexAt([0, 100, 300], 299)).toBe(1);
    expect(chapterIndexAt([0, 100, 300], 5000)).toBe(2);
    expect(chapterIndexAt([50, 100], 10)).toBe(0);
    expect(chapterIndexAt([], 10)).toBe(0);
  });
});

describe('pinFractions', () => {
  it('places pins along the book, dropping any outside it', () => {
    expect(pinFractions([0, 250, 1000, 1200, -1], 1000)).toEqual([0, 0.25, 1]);
    expect(pinFractions([10], 0)).toEqual([]);
  });
});
