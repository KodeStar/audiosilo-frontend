import { chapterIndexAt, runState } from '@/components/home/now-card-model';

import { heardIn, maxSegmentsFor, timelineRuns } from './book-timeline-model';

/** The runs as the timeline draws them with the listener at `at`. */
function drawn(starts: number[], total: number, at: number, width = 0) {
  const current = chapterIndexAt(starts, at);
  return timelineRuns(starts, total, width).map((r) => ({
    weight: r.weight,
    state: runState(r, current),
    played: runState(r, current) === 'current' ? heardIn(r, at) : 0,
    first: r.first,
    last: r.last,
  }));
}

describe('timelineRuns', () => {
  const starts = [0, 100, 300, 600];

  it('sizes each chapter by its length and marks where the listener is', () => {
    expect(drawn(starts, 1000, 400)).toEqual([
      { weight: 100, state: 'past', played: 0, first: 0, last: 0 },
      { weight: 200, state: 'past', played: 0, first: 1, last: 1 },
      { weight: 300, state: 'current', played: 1 / 3, first: 2, last: 2 },
      { weight: 400, state: 'ahead', played: 0, first: 3, last: 3 },
    ]);
  });

  it('is one segment for a book without chapters', () => {
    expect(drawn([], 1000, 250)).toEqual([
      { weight: 1000, state: 'current', played: 0.25, first: 0, last: 0 },
    ]);
  });

  it('is nothing without a known length (a per-file book)', () => {
    expect(timelineRuns(starts, 0, 400)).toEqual([]);
    expect(timelineRuns(starts, -5, 400)).toEqual([]);
  });

  it('counts an intro before the first chapter as part of it', () => {
    const [first] = drawn([30, 100], 200, 10);
    expect(first).toMatchObject({ weight: 100, state: 'current', played: 0.1 });
  });

  it('merges neighbours when there are more chapters than fit the width', () => {
    const many = Array.from({ length: 10 }, (_, i) => i * 100);
    // 5 segments fit 23 points (3-point segments, 2-point gaps).
    const segments = drawn(many, 1000, 450, 23);
    expect(segments).toHaveLength(5);
    expect(segments.map((s) => s.state)).toEqual(['past', 'past', 'current', 'ahead', 'ahead']);
    // Chapters 4 and 5 (400..600), the listener at 450.
    expect(segments[2]).toMatchObject({ first: 4, last: 5, weight: 200, played: 0.25 });
  });

  it('gives a zero-length chapter a sliver', () => {
    const [, empty] = timelineRuns([0, 100, 100], 1000, 0);
    expect(empty.weight).toBe(1);
  });

  it('clamps the place to the run', () => {
    const [only] = timelineRuns([0], 100, 0);
    expect(heardIn(only, 500)).toBe(1);
    expect(heardIn(only, -5)).toBe(0);
  });
});

describe('maxSegmentsFor', () => {
  it('fits 3-point segments with their gaps, unlimited before layout', () => {
    expect(maxSegmentsFor(0)).toBe(Infinity);
    expect(maxSegmentsFor(98)).toBe(20);
    expect(maxSegmentsFor(1)).toBe(1);
  });
});
