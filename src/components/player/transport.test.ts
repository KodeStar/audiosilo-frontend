import { currentSegment, nextSegmentStart, previousSegmentStart, segmentStarts } from './transport';

describe('currentSegment', () => {
  const chapter = { book_offset: 100, start: 0, end: 50 };

  it('is the current chapter, clamped', () => {
    expect(
      currentSegment({
        total: 1000,
        bookPosition: 120,
        chapter,
        trackPosition: 0,
        trackDuration: 0,
      }),
    ).toEqual({ perTrack: false, start: 100, length: 50, elapsed: 20 });
    expect(
      currentSegment({
        total: 1000,
        bookPosition: 999,
        chapter,
        trackPosition: 0,
        trackDuration: 0,
      }).elapsed,
    ).toBe(50);
  });

  it('is the whole book without a chapter', () => {
    expect(
      currentSegment({
        total: 600,
        bookPosition: 30,
        chapter: null,
        trackPosition: 0,
        trackDuration: 0,
      }),
    ).toEqual({ perTrack: false, start: 0, length: 600, elapsed: 30 });
  });

  it('is the current file when the timeline is unknown', () => {
    expect(
      currentSegment({ total: 0, bookPosition: 0, chapter, trackPosition: 12, trackDuration: 0 }),
    ).toEqual({ perTrack: true, start: 0, length: 1, elapsed: 12 });
  });
});

describe('segmentStarts', () => {
  it('prefers chapters, else file offsets', () => {
    expect(
      segmentStarts({ chapters: [{ book_offset: 0 }, { book_offset: 60 }], offsets: [0, 9] }),
    ).toEqual([0, 60]);
    expect(segmentStarts({ chapters: [], offsets: [0, 9] })).toEqual([0, 9]);
  });
});

describe('previous / next chapter', () => {
  const starts = [0, 60, 120];

  it('next skips to the following boundary, with slack after a jump', () => {
    expect(nextSegmentStart(starts, 10)).toBe(60);
    expect(nextSegmentStart(starts, 59)).toBe(120);
    expect(nextSegmentStart(starts, 125)).toBeUndefined();
  });

  it('previous restarts the chapter, or goes back one within its first 3 s', () => {
    expect(previousSegmentStart(starts, 90)).toBe(60);
    expect(previousSegmentStart(starts, 61)).toBe(0);
    expect(previousSegmentStart(starts, 1)).toBe(0);
  });
});
