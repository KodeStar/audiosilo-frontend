import { engineTick, engineTicker } from './engine-ticks';

/** `seconds` of engine events, one a second, with no JS timer firing (Android with the
 * screen off). */
function eventsOnly(seconds: number) {
  for (let i = 0; i < seconds; i++) {
    jest.setSystemTime(Date.now() + 1_000);
    engineTick();
  }
}

describe('engineTicker', () => {
  const stops: (() => void)[] = [];
  /** A started ticker whose runs are counted; stopped after each test. */
  function counted(ms: number) {
    const fn = jest.fn();
    const t = engineTicker(fn, ms);
    stops.push(() => t.stop());
    return { fn, t };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
    jest.useRealTimers();
  });

  it('runs from engine events alone, once per interval', () => {
    const { fn, t } = counted(5_000);
    t.start();
    eventsOnly(4);
    expect(fn).not.toHaveBeenCalled();
    eventsOnly(16);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('never runs twice in one interval when the interval and the events both fire', () => {
    const { fn, t } = counted(1_000);
    t.start();
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(500);
      engineTick();
      jest.advanceTimersByTime(500); // the interval's turn
    }
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it('runs on every event of a jittery cadence of about the interval', () => {
    const { fn, t } = counted(1_000);
    t.start();
    // Events about a second apart, some a little short of it (bridge latency varies).
    for (const gap of [1_000, 990, 1_010, 980, 1_000, 995]) {
      jest.setSystemTime(Date.now() + gap);
      engineTick();
    }
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('keeps the others running when one throws', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const first = counted(1_000);
    const second = counted(1_000);
    first.fn.mockImplementation(() => {
      throw new Error('boom');
    });
    first.t.start();
    second.t.start();
    expect(() => eventsOnly(1)).not.toThrow();
    expect(second.fn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('runs nothing before a start or after a stop, and a second start does not re-base', () => {
    const { fn, t } = counted(1_000);
    eventsOnly(3);
    expect(fn).not.toHaveBeenCalled();
    t.start();
    jest.setSystemTime(Date.now() + 600);
    t.start(); // already running: the next run is still 1 s after the first start
    jest.setSystemTime(Date.now() + 400);
    engineTick();
    expect(fn).toHaveBeenCalledTimes(1);
    t.stop();
    eventsOnly(3);
    jest.advanceTimersByTime(3_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('skips one that an earlier one stopped in the same pass', () => {
    const second = counted(1_000);
    const first = counted(1_000);
    first.fn.mockImplementation(() => second.t.stop());
    first.t.start();
    second.t.start();
    eventsOnly(1);
    expect(first.fn).toHaveBeenCalledTimes(1);
    expect(second.fn).not.toHaveBeenCalled();
  });
});
