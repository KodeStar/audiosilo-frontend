import { afterPaint, AFTER_PAINT_MAX_MS } from './after-paint.web';

describe('afterPaint (web)', () => {
  const frames: FrameRequestCallback[] = [];
  const idles: { fn: () => void; timeout?: number }[] = [];
  beforeEach(() => {
    frames.length = 0;
    idles.length = 0;
    globalThis.requestAnimationFrame = (fn) => frames.push(fn);
    globalThis.cancelAnimationFrame = (id?: number | null) => {
      if (id) frames[id - 1] = () => {};
    };
    globalThis.requestIdleCallback = (fn, opts) =>
      idles.push({ fn: () => fn({} as IdleDeadline), timeout: opts?.timeout });
    globalThis.cancelIdleCallback = (id) => {
      idles[id - 1] = { fn: () => {} };
    };
  });

  it('runs after the next frame, once the page is idle (at most AFTER_PAINT_MAX_MS on)', () => {
    const fn = jest.fn();
    afterPaint(fn);
    expect(idles).toHaveLength(0);
    frames[0](0);
    expect(fn).not.toHaveBeenCalled();
    expect(idles[0].timeout).toBe(AFTER_PAINT_MAX_MS);
    idles[0].fn();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never runs once cancelled, before or after the frame', () => {
    const before = jest.fn();
    afterPaint(before)();
    frames[0](0);
    idles[0]?.fn();
    expect(before).not.toHaveBeenCalled();

    const after = jest.fn();
    const cancel = afterPaint(after);
    frames[1](0);
    cancel();
    idles[idles.length - 1].fn();
    expect(after).not.toHaveBeenCalled();
  });
});
