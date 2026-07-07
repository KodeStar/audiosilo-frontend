import { endCreditsDecision, GRACE_SECONDS, type EndCreditsInput } from './end-credits-logic';

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
