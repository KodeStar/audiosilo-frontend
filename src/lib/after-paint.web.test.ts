import { afterPaint, AFTER_PAINT_MAX_MS } from './after-paint.web';

describe('afterPaint (web)', () => {
  const frames: FrameRequestCallback[] = [];
  const idles: (() => void)[] = [];
  beforeEach(() => {
    jest.useFakeTimers();
    frames.length = 0;
    idles.length = 0;
    globalThis.requestAnimationFrame = (fn) => frames.push(fn);
    globalThis.cancelAnimationFrame = (id?: number | null) => {
      if (id) frames[id - 1] = () => {};
    };
    globalThis.requestIdleCallback = (fn) => idles.push(() => fn({} as IdleDeadline));
    globalThis.cancelIdleCallback = (id) => {
      idles[id - 1] = () => {};
    };
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs after the next frame, once the page is idle', () => {
    const fn = jest.fn();
    afterPaint(fn);
    expect(idles).toHaveLength(0);
    frames[0](0);
    expect(fn).not.toHaveBeenCalled();
    idles[0]();
    expect(fn).toHaveBeenCalledTimes(1);
    // The cap does not run it a second time.
    jest.advanceTimersByTime(AFTER_PAINT_MAX_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs at most AFTER_PAINT_MAX_MS after the call when no frame comes (a hidden tab)', () => {
    const fn = jest.fn();
    afterPaint(fn);
    jest.advanceTimersByTime(AFTER_PAINT_MAX_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    // A frame arriving later (the tab shown) does not run it again.
    frames[0](0);
    expect(idles).toHaveLength(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs at the cap when the frame came but the page never went idle', () => {
    const fn = jest.fn();
    afterPaint(fn);
    frames[0](0);
    jest.advanceTimersByTime(AFTER_PAINT_MAX_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    idles[0]();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never runs once cancelled, before or after the frame', () => {
    const before = jest.fn();
    afterPaint(before)();
    frames[0](0);
    idles[0]?.();
    jest.advanceTimersByTime(AFTER_PAINT_MAX_MS);
    expect(before).not.toHaveBeenCalled();

    const after = jest.fn();
    const cancel = afterPaint(after);
    frames[1](0);
    cancel();
    idles[idles.length - 1]();
    jest.advanceTimersByTime(AFTER_PAINT_MAX_MS);
    expect(after).not.toHaveBeenCalled();
  });
});
