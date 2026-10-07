import {
  HISTORY_LIMIT,
  endCreditsDecision,
  GRACE_SECONDS,
  listeningSummary,
  nextAvailability,
  spinesThatFit,
  upNextReason,
  yearShelf,
  type EndCreditsInput,
} from './end-credits-logic';

// A sensible base: auto-play on, a next book exists, book already over, nothing elapsed.
const base: EndCreditsInput = {
  autoPlayNext: true,
  hasNext: true,
  stillPlaying: false,
  remainingSeconds: 0,
  cancelled: false,
  elapsedGrace: 0,
};

describe('endCreditsDecision', () => {
  it('does nothing when auto-play is off', () => {
    expect(endCreditsDecision({ ...base, autoPlayNext: false })).toEqual({
      showCountdown: false,
      countdownSeconds: 0,
      fireNext: false,
    });
  });

  it('does nothing when there is no next book', () => {
    const d = endCreditsDecision({ ...base, hasNext: false });
    expect(d.showCountdown).toBe(false);
    expect(d.fireNext).toBe(false);
  });

  it('does nothing when cancelled (Play next stays, countdown hidden)', () => {
    const d = endCreditsDecision({ ...base, cancelled: true, elapsedGrace: GRACE_SECONDS });
    expect(d.showCountdown).toBe(false);
    expect(d.fireNext).toBe(false);
  });

  describe('still playing (early arrival)', () => {
    it('counts down the remaining audio time and never fires', () => {
      const d = endCreditsDecision({ ...base, stillPlaying: true, remainingSeconds: 135 });
      expect(d.showCountdown).toBe(true);
      expect(d.countdownSeconds).toBe(135);
      expect(d.fireNext).toBe(false);
    });

    it('clamps a negative remaining to zero but still does not fire', () => {
      const d = endCreditsDecision({ ...base, stillPlaying: true, remainingSeconds: -4 });
      expect(d.countdownSeconds).toBe(0);
      expect(d.fireNext).toBe(false);
    });
  });

  describe('book over (grace countdown)', () => {
    it('shows the full grace at the start', () => {
      const d = endCreditsDecision({ ...base, elapsedGrace: 0 });
      expect(d.showCountdown).toBe(true);
      expect(d.countdownSeconds).toBe(GRACE_SECONDS);
      expect(d.fireNext).toBe(false);
    });

    it('counts down as time elapses', () => {
      expect(endCreditsDecision({ ...base, elapsedGrace: 5 }).countdownSeconds).toBe(
        GRACE_SECONDS - 5,
      );
    });

    it('fires when the grace is exhausted', () => {
      const d = endCreditsDecision({ ...base, elapsedGrace: GRACE_SECONDS });
      expect(d.countdownSeconds).toBe(0);
      expect(d.fireNext).toBe(true);
    });

    it('fires (and clamps to zero) past the grace', () => {
      const d = endCreditsDecision({ ...base, elapsedGrace: GRACE_SECONDS + 3 });
      expect(d.countdownSeconds).toBe(0);
      expect(d.fireNext).toBe(true);
    });
  });
});

describe('endCreditsDecision with a queue head next', () => {
  // The countdown does not care why a book is next: a queued book counts down and fires
  // exactly like a series one.
  it('counts the grace down and fires for any next book', () => {
    expect(endCreditsDecision({ ...base, elapsedGrace: 14 })).toMatchObject({
      showCountdown: true,
      countdownSeconds: 1,
      fireNext: false,
    });
    expect(endCreditsDecision({ ...base, elapsedGrace: 15 }).fireNext).toBe(true);
  });
});

describe('listeningSummary', () => {
  // Local times, so the day count is the device's calendar.
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const span = (from: string, to: string) => ({ started_at: from, ended_at: to });

  it('adds the wall-clock time of every span and counts the days', () => {
    const s = listeningSummary([
      span(at(1, 20), at(1, 21)), // 1h
      span(at(1, 22), at(1, 22, 30)), // 30m, same day
      span(at(3, 8), at(3, 8, 15)), // 15m
    ]);
    expect(s).toEqual({ seconds: 6300, days: 2, partial: false });
  });

  it('counts both days of a span across midnight', () => {
    expect(listeningSummary([span(at(1, 23, 30), at(2, 0, 30))]).days).toBe(2);
  });

  it('ignores unparseable and backwards spans', () => {
    expect(listeningSummary([span('nope', at(1, 2)), span(at(1, 3), at(1, 2))])).toMatchObject({
      seconds: 0,
      days: 1,
    });
  });

  it('is partial when the server returned as many spans as asked', () => {
    const one = span(at(1, 1), at(1, 2));
    expect(listeningSummary(Array(HISTORY_LIMIT).fill(one)).partial).toBe(true);
    expect(listeningSummary(Array(HISTORY_LIMIT - 1).fill(one)).partial).toBe(false);
  });
});

describe('yearShelf', () => {
  const row = (path: string) => ({ library_id: 1, path });
  const book = { libraryId: 1, path: 'Now' };

  it('shows the other books oldest first and counts this one when the stats have it', () => {
    const stats = { totals: { finished: 3 }, finished_books: [row('Now'), row('B'), row('A')] };
    expect(yearShelf(stats, book, true, 10)).toEqual({
      others: [row('A'), row('B')],
      bookNumber: 3,
    });
  });

  it('adds this book to the count when its finish is not in the stats yet', () => {
    const stats = { totals: { finished: 2 }, finished_books: [row('B'), row('A')] };
    expect(yearShelf(stats, book, true, 10).bookNumber).toBe(3);
  });

  it('keeps only the newest `max` others', () => {
    const stats = { totals: { finished: 3 }, finished_books: [row('C'), row('B'), row('A')] };
    expect(yearShelf(stats, book, true, 2).others).toEqual([row('B'), row('C')]);
  });

  it('gives no number for a book still playing', () => {
    const stats = { totals: { finished: 2 }, finished_books: [row('A')] };
    expect(yearShelf(stats, book, false, 10)).toEqual({ others: [row('A')] });
  });
});

describe('nextAvailability', () => {
  it('says where the next book plays from', () => {
    expect(nextAvailability(undefined)).toEqual({ kind: 'stream' });
    expect(nextAvailability({ status: 'error', progress: 0.4 })).toEqual({ kind: 'stream' });
    expect(nextAvailability({ status: 'downloaded', progress: 1 })).toEqual({
      kind: 'downloaded',
    });
    expect(nextAvailability({ status: 'downloading', progress: 0.526 })).toEqual({
      kind: 'downloading',
      percent: 52,
    });
    expect(nextAvailability({ status: 'queued', progress: 0 })).toEqual({
      kind: 'downloading',
      percent: 0,
    });
  });
});

describe('upNextReason', () => {
  it('names the queue, the series and its place, or the folder', () => {
    expect(upNextReason({ source: 'queue', series: { name: 'S', position: '2' } })).toEqual({
      key: 'fromQueue',
    });
    expect(
      upNextReason({ source: 'series', series: { name: 'The Expanse', position: '3' } }),
    ).toEqual({
      key: 'fromSeriesBook',
      values: { series: 'The Expanse', position: '3' },
    });
    expect(upNextReason({ source: 'series', series: { name: 'The Expanse' } })).toEqual({
      key: 'fromSeries',
      values: { series: 'The Expanse' },
    });
    expect(upNextReason({ source: 'series' })).toEqual({ key: 'nextInSeries' });
    expect(upNextReason({ source: 'folder' })).toEqual({ key: 'fromFolder' });
  });
});

describe('spinesThatFit', () => {
  it('takes the newest spines that fit, gaps included', () => {
    // 23 + 33 + 43 = 99
    expect(spinesThatFit([20, 30, 40], 99, 3)).toBe(3);
    expect(spinesThatFit([20, 30, 40], 98, 3)).toBe(2);
    expect(spinesThatFit([20], 10, 3)).toBe(0);
    expect(spinesThatFit([], 500, 3)).toBe(0);
  });
});
