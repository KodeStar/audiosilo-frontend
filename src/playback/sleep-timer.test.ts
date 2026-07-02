// Mock the player store the sleep timer depends on: it reads usePlayer.getState()
// (for nowPlaying + pause) and selectBookPosition(player). We control both so the
// firing logic can be tested without the real playback engine.
// Names must be `mock`-prefixed to be referenced inside the jest.mock factory.
const mockPause = jest.fn(() => Promise.resolve());
const mockPlayerState: {
  nowPlaying: { id: string } | null;
  pause: typeof mockPause;
  rate: number;
} = {
  nowPlaying: { id: 'book-1' },
  pause: mockPause,
  rate: 1,
};
const mockBook = { position: 0 };

jest.mock('@/playback/store', () => ({
  usePlayer: { getState: () => mockPlayerState },
  selectBookPosition: () => mockBook.position,
}));

// Imported after the mock setup (the factory closes over the mock-prefixed vars).
// eslint-disable-next-line import/first
import { useSleepTimer } from '@/playback/sleep-timer';

const NOW = 1_700_000_000_000; // fixed epoch ms

describe('sleep timer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockPause.mockClear();
    mockBook.position = 0;
    mockPlayerState.nowPlaying = { id: 'book-1' };
    mockPlayerState.rate = 1;
    useSleepTimer.getState().cancel();
  });

  afterEach(() => {
    useSleepTimer.getState().cancel();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('fires a duration timer after the configured minutes elapse', () => {
    useSleepTimer.getState().startDuration(1); // 1 minute
    expect(useSleepTimer.getState().active).toBe(true);
    expect(useSleepTimer.getState().endsAt).toBe(NOW + 60_000);

    // Advance 59s: the 1s tick updates remaining but hasn't fired yet.
    jest.advanceTimersByTime(59_000);
    expect(mockPause).not.toHaveBeenCalled();
    expect(useSleepTimer.getState().active).toBe(true);

    // Cross the full minute: pause is called and the timer deactivates.
    jest.advanceTimersByTime(1_000);
    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(useSleepTimer.getState().active).toBe(false);
    expect(useSleepTimer.getState().endsAt).toBeNull();
  });

  it('fires an until-position timer when the book position crosses the target', () => {
    mockBook.position = 100;
    useSleepTimer.getState().startUntilPosition(160, 'End of Chapter 12');
    expect(useSleepTimer.getState().active).toBe(true);
    expect(useSleepTimer.getState().pauseAtPosition).toBe(160);
    expect(useSleepTimer.getState().label).toBe('End of Chapter 12');

    // Position still short of the target: a tick updates remaining, no pause.
    mockBook.position = 150;
    jest.advanceTimersByTime(1_000);
    expect(mockPause).not.toHaveBeenCalled();
    expect(useSleepTimer.getState().active).toBe(true);

    // Position reaches/passes the target: pause and deactivate.
    mockBook.position = 160;
    jest.advanceTimersByTime(1_000);
    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(useSleepTimer.getState().active).toBe(false);
    expect(useSleepTimer.getState().pauseAtPosition).toBeNull();
  });

  it('scales the until-position countdown by the playback rate (wall-clock time)', () => {
    mockBook.position = 100;
    mockPlayerState.rate = 2; // 60s of remaining audio = 30s of real time at 2x
    useSleepTimer.getState().startUntilPosition(160, 'End of Chapter 12');
    // (160 - 100) / 2 = 30, not 60.
    expect(useSleepTimer.getState().remaining).toBe(30);

    // A tick keeps it in wall-clock terms too.
    mockBook.position = 120;
    jest.advanceTimersByTime(1_000);
    expect(useSleepTimer.getState().remaining).toBe(20); // (160 - 120) / 2

    // The pause still fires strictly by position, regardless of rate.
    mockBook.position = 160;
    jest.advanceTimersByTime(1_000);
    expect(mockPause).toHaveBeenCalledTimes(1);
  });

  it('does not start an until-position timer when nothing is playing', () => {
    mockPlayerState.nowPlaying = null;
    useSleepTimer.getState().startUntilPosition(100, 'x');
    expect(useSleepTimer.getState().active).toBe(false);
  });

  it('extend() from a live timer adds to the remaining endsAt', () => {
    useSleepTimer.getState().startDuration(1); // endsAt = NOW + 60_000
    // 30s in, still live.
    jest.advanceTimersByTime(30_000);
    useSleepTimer.getState().extend(1); // re-base off the not-yet-expired endsAt
    // base was NOW + 60_000, + 60_000 = NOW + 120_000.
    expect(useSleepTimer.getState().endsAt).toBe(NOW + 120_000);
  });

  it('extend() from an expired timer bases off now', () => {
    useSleepTimer.getState().startDuration(1); // endsAt = NOW + 60_000
    // Let it fire (which cancels), so endsAt is back to null / in the past.
    jest.advanceTimersByTime(60_000);
    expect(useSleepTimer.getState().active).toBe(false);

    // Move the clock forward, then extend: base must be the current now, not stale.
    jest.setSystemTime(NOW + 200_000);
    useSleepTimer.getState().extend(1);
    expect(useSleepTimer.getState().endsAt).toBe(NOW + 200_000 + 60_000);
  });
});
