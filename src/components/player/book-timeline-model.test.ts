import { chapterIndexAt, runState } from '@/components/home/now-card-model';

import { heardIn, maxSegmentsFor, runBox, timelineRuns } from './book-timeline-model';

/** The runs as the timeline draws them with the listener at `at`: where each sits (percent
 * of the track), its state and how much of it is heard. */
function drawn(starts: number[], total: number, at: number, width = 0) {
  const current = chapterIndexAt(starts, at);
  return timelineRuns(starts, total, width).map((r) => ({
    ...runBox(r, total),
    state: runState(r, current),
    played: runState(r, current) === 'current' ? heardIn(r, at) : 0,
    first: r.first,
    last: r.last,
  }));
}

describe('timelineRuns', () => {
  const starts = [0, 100, 300, 600];

  it('places each chapter by its time and marks where the listener is', () => {
    expect(drawn(starts, 1000, 400)).toEqual([
      { left: 0, width: 10, state: 'past', played: 0, first: 0, last: 0 },
      { left: 10, width: 20, state: 'past', played: 0, first: 1, last: 1 },
      { left: 30, width: 30, state: 'current', played: 1 / 3, first: 2, last: 2 },
      { left: 60, width: 40, state: 'ahead', played: 0, first: 3, last: 3 },
    ]);
  });

  it('is one segment for a book without chapters', () => {
    expect(drawn([], 1000, 250)).toEqual([
      { left: 0, width: 100, state: 'current', played: 0.25, first: 0, last: 0 },
    ]);
  });

  it('is nothing without a known length (a per-file book)', () => {
    expect(timelineRuns(starts, 0, 400)).toEqual([]);
    expect(timelineRuns(starts, -5, 400)).toEqual([]);
  });

  it('counts an intro before the first chapter as part of it', () => {
    const [first] = drawn([30, 100], 200, 10);
    expect(first).toMatchObject({ left: 0, width: 50, state: 'current', played: 0.1 });
  });

  it('merges neighbours when there are more chapters than fit the width', () => {
    const many = Array.from({ length: 10 }, (_, i) => i * 100);
    // 5 segments fit 23 points (3-point segments, 2-point gaps).
    const segments = drawn(many, 1000, 450, 23);
    expect(segments).toHaveLength(5);
    expect(segments.map((s) => s.state)).toEqual(['past', 'past', 'current', 'ahead', 'ahead']);
    // Chapters 4 and 5 (400..600), the listener at 450.
    expect(segments[2]).toMatchObject({ first: 4, last: 5, left: 40, width: 20, played: 0.25 });
  });

  it('draws a zero-length chapter as nothing, without moving its neighbours', () => {
    const [, empty, next] = timelineRuns([0, 100, 100], 1000, 0);
    // The run keeps the Now card's sliver weight (shared `scaleRuns`), but the timeline
    // places by time.
    expect(empty.weight).toBe(1);
    expect(runBox(empty, 1000)).toEqual({ left: 10, width: 0 });
    expect(runBox(next, 1000)).toEqual({ left: 10, width: 90 });
  });

  it('clamps the place to the run', () => {
    const [only] = timelineRuns([0], 100, 0);
    expect(heardIn(only, 500)).toBe(1);
    expect(heardIn(only, -5)).toBe(0);
  });
});

describe('runBox', () => {
  it('maps every run where its time maps, however uneven the chapters', () => {
    // A 9.5 h book opening with five 30 s tracks, then long chapters: by flex weight
    // (with fixed gaps) every later segment drifted off the time it stands for.
    const total = 34_200;
    const starts = [0, 30, 60, 90, 120, 150, 3600, 9000, 20_000, 30_000];
    const runs = timelineRuns(starts, total, 335);
    const boxes = runs.map((r) => runBox(r, total));
    runs.forEach((r, i) => {
      // The box is exactly the run's span on the track's time scale (x = t / total)...
      expect(boxes[i].left).toBeCloseTo((r.from / total) * 100, 9);
      expect(boxes[i].width).toBeCloseTo(((r.to - r.from) / total) * 100, 9);
      // ...so its middle seeks into the chapter it draws.
      const middle = ((boxes[i].left + boxes[i].width / 2) / 100) * total;
      expect(chapterIndexAt(starts, middle)).toBe(r.first);
    });
    // Edge to edge: no run pushes the next one along, and the last ends at the track's end.
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].left).toBeCloseTo(boxes[i - 1].left + boxes[i - 1].width, 9);
    }
    expect(boxes.at(-1)!.left + boxes.at(-1)!.width).toBeCloseTo(100, 9);
  });

  it('is empty without a known length', () => {
    expect(runBox({ first: 0, last: 0, from: 0, to: 10, weight: 10 }, 0)).toEqual({
      left: 0,
      width: 0,
    });
  });
});

describe('maxSegmentsFor', () => {
  it('fits 3-point segments with their gaps, unlimited before layout', () => {
    expect(maxSegmentsFor(0)).toBe(Infinity);
    expect(maxSegmentsFor(98)).toBe(20);
    expect(maxSegmentsFor(1)).toBe(1);
  });
});
