import {
  currentSegment,
  nextSegmentStart,
  trackLabel,
  previousSegmentStart,
  segmentStarts,
  stepSegment,
} from './transport';

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

describe('stepSegment', () => {
  const make = (
    queue: { total: number; chapters: { book_offset: number }[]; offsets: number[] } | null,
    trackIndex: number,
    position: number,
  ) => ({
    nowPlaying: queue ? { queue } : null,
    snapshot: { trackIndex, position },
    seekBook: jest.fn(),
    seekInTrack: jest.fn(),
    goToTrack: jest.fn(),
  });
  const chaptered = {
    total: 300,
    chapters: [{ book_offset: 0 }, { book_offset: 100 }, { book_offset: 200 }],
    offsets: [0, 150],
  };

  it('does nothing with no book loaded', () => {
    const s = make(null, 0, 0);
    stepSegment(s, 1);
    expect(s.seekBook).not.toHaveBeenCalled();
    expect(s.goToTrack).not.toHaveBeenCalled();
  });

  it('steps between chapters on the whole-book timeline (file offsets applied)', () => {
    // Track 1 at 10s = book 160, inside chapter 2 (100..200).
    const next = make(chaptered, 1, 10);
    stepSegment(next, 1);
    expect(next.seekBook).toHaveBeenCalledWith(200);
    const prev = make(chaptered, 1, 10);
    stepSegment(prev, -1);
    expect(prev.seekBook).toHaveBeenCalledWith(100);
  });

  it('does not seek past the last chapter', () => {
    const s = make(chaptered, 1, 100); // book 250
    stepSegment(s, 1);
    expect(s.seekBook).not.toHaveBeenCalled();
  });

  it('steps per file without a timeline; previous restarts the file after 3 s', () => {
    const perFile = { total: 0, chapters: [], offsets: [] };
    const next = make(perFile, 2, 1);
    stepSegment(next, 1);
    expect(next.goToTrack).toHaveBeenCalledWith(3);
    const restart = make(perFile, 2, 4);
    stepSegment(restart, -1);
    expect(restart.seekInTrack).toHaveBeenCalledWith(0);
    expect(restart.goToTrack).not.toHaveBeenCalled();
    const back = make(perFile, 2, 2);
    stepSegment(back, -1);
    expect(back.goToTrack).toHaveBeenCalledWith(1);
  });
});

describe('trackLabel', () => {
  it("is the leaf of the track's path, else the fallback", () => {
    expect(trackLabel({ id: '2:Author/Book/03 - Part.mp3' }, 'Book')).toBe('03 - Part.mp3');
    expect(trackLabel({ id: '2:Odd:Name/x.mp3' }, 'Book')).toBe('x.mp3');
    expect(trackLabel(undefined, 'Book')).toBe('Book');
    expect(trackLabel({ id: '2:' }, 'Book')).toBe('Book');
  });
});
