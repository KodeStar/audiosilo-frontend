import { ticker } from '@/lib/ticker';

describe('ticker', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('runs on its period until stopped, leaving nothing behind', () => {
    const fn = jest.fn();
    const t = ticker(fn, 1000);
    t.start();
    jest.advanceTimersByTime(3_000);
    expect(fn).toHaveBeenCalledTimes(3);

    t.stop();
    jest.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
    // Stopping twice is as harmless as stopping once (every teardown path calls it).
    t.stop();
  });

  it('does not push the next run out when started again PART WAY through the period', () => {
    // The property auto sleep's 60s poll depends on: it is re-started from several edges
    // (a play edge, a timer ending, the setting going on) at arbitrary points in the
    // period, and a re-base would defer the next check every time one of them fired.
    //
    // The partial advance is the whole test. Restarting exactly ON a tick - which is what
    // a callback that calls `start()` does - re-bases to the same instant the running
    // interval was already going to fire at, so it cannot tell the two semantics apart.
    const fn = jest.fn();
    const t = ticker(fn, 1_000);
    t.start();
    jest.advanceTimersByTime(600);
    expect(fn).not.toHaveBeenCalled();

    t.start(); // a second edge asks for it, 600ms in
    jest.advanceTimersByTime(400); // reaches the ORIGINAL deadline
    expect(fn).toHaveBeenCalledTimes(1);

    // ...and it stays on the original cadence rather than the restart's.
    jest.advanceTimersByTime(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
    t.stop();
  });

  it('survives a callback that starts it again, without stalling the cadence', () => {
    // `syncFade` reconciles rather than transitions: it calls `start()` unconditionally
    // from inside the fade ticker's own callback. That must not skip or double a tick.
    const fn = jest.fn(() => t.start());
    const t = ticker(fn, 250);
    t.start();
    jest.advanceTimersByTime(1_000);
    expect(fn).toHaveBeenCalledTimes(4);
    t.stop();
    expect(jest.getTimerCount()).toBe(0);
  });
});
