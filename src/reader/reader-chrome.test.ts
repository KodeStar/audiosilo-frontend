import { act, renderHook } from '@testing-library/react-native';

import {
  CHROME_HIDE_MS,
  CHROME_START,
  type ChromeHold,
  chromeTimerRuns,
  mayHide,
  nextChrome,
  settleChrome,
  useReaderChrome,
} from './reader-chrome';

const READING: ChromeHold = { autoHide: true, screenReader: false, reading: true, menuOpen: false };
const hidden = { hidden: true, epoch: 0 };

describe('mayHide', () => {
  it('hides only with auto-hide on, no screen reader, the book showing and no menu open', () => {
    expect(mayHide(READING)).toBe(true);
    expect(mayHide({ ...READING, autoHide: false })).toBe(false);
    expect(mayHide({ ...READING, screenReader: true })).toBe(false);
    expect(mayHide({ ...READING, reading: false })).toBe(false);
    expect(mayHide({ ...READING, menuOpen: true })).toBe(false);
  });
});

describe('nextChrome', () => {
  it('hides when the wait runs out, or at a page turn, whichever comes first', () => {
    expect(nextChrome(CHROME_START, 'timeout', true)).toEqual(hidden);
    expect(nextChrome(CHROME_START, 'pageTurn', true)).toEqual(hidden);
    // Hidden already: nothing changes (no new state to render).
    expect(nextChrome(hidden, 'pageTurn', true)).toBe(hidden);
  });

  it('never hides while something holds the bar', () => {
    expect(nextChrome(CHROME_START, 'timeout', false)).toBe(CHROME_START);
    expect(nextChrome(CHROME_START, 'pageTurn', false)).toBe(CHROME_START);
    expect(nextChrome(CHROME_START, 'centreTap', false)).toBe(CHROME_START);
  });

  it('shows on a centre tap with a fresh wait, and hides on the next', () => {
    const shown = nextChrome(hidden, 'centreTap', true);
    expect(shown).toEqual({ hidden: false, epoch: 1 });
    expect(nextChrome(shown, 'centreTap', true)).toEqual({ hidden: true, epoch: 1 });
  });

  it('starts the wait again at a touch on the bar', () => {
    expect(nextChrome(CHROME_START, 'touch', true)).toEqual({ hidden: false, epoch: 1 });
  });
});

describe('settleChrome', () => {
  it('shows a hidden bar once something holds it (a screen reader, the setting off, a menu)', () => {
    expect(settleChrome(hidden, false)).toEqual({ hidden: false, epoch: 1 });
    expect(settleChrome(hidden, true)).toBe(hidden);
    expect(settleChrome(CHROME_START, false)).toBe(CHROME_START);
  });
});

describe('chromeTimerRuns', () => {
  it('runs while the bar shows and may hide', () => {
    expect(chromeTimerRuns(CHROME_START, true)).toBe(true);
    expect(chromeTimerRuns(CHROME_START, false)).toBe(false);
    expect(chromeTimerRuns(hidden, true)).toBe(false);
  });
});

describe('useReaderChrome', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const mount = (hold: ChromeHold) =>
    renderHook((props: ChromeHold) => useReaderChrome(props), { initialProps: hold });

  it('hides after the wait, shows on a centre tap, and hides again after the wait', async () => {
    const { result } = await mount(READING);
    expect(result.current.shown).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(CHROME_HIDE_MS - 1);
    });
    expect(result.current.shown).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.shown).toBe(false);
    await act(async () => result.current.centreTapped());
    expect(result.current.shown).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(CHROME_HIDE_MS);
    });
    expect(result.current.shown).toBe(false);
  });

  it('hides at the first page turn, before the wait runs out', async () => {
    const { result } = await mount(READING);
    await act(async () => result.current.pageTurned());
    expect(result.current.shown).toBe(false);
  });

  it('starts the wait again at a touch on the bar', async () => {
    const { result } = await mount(READING);
    await act(async () => {
      jest.advanceTimersByTime(CHROME_HIDE_MS - 100);
    });
    await act(async () => result.current.touched());
    await act(async () => {
      jest.advanceTimersByTime(CHROME_HIDE_MS - 100);
    });
    expect(result.current.shown).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current.shown).toBe(false);
  });

  it('waits while a menu is open, and starts the wait afresh once it closes', async () => {
    const { result, rerender } = await mount({ ...READING, menuOpen: true });
    await act(async () => {
      jest.advanceTimersByTime(CHROME_HIDE_MS * 3);
    });
    await act(async () => result.current.pageTurned());
    expect(result.current.shown).toBe(true);
    await rerender(READING);
    await act(async () => {
      jest.advanceTimersByTime(CHROME_HIDE_MS - 1);
    });
    expect(result.current.shown).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.shown).toBe(false);
  });

  it('shows a hidden bar once a screen reader is turned on, and never hides it then', async () => {
    const { result, rerender } = await mount(READING);
    await act(async () => result.current.pageTurned());
    expect(result.current.shown).toBe(false);
    await rerender({ ...READING, screenReader: true });
    expect(result.current.shown).toBe(true);
    await act(async () => result.current.pageTurned());
    await act(async () => {
      jest.advanceTimersByTime(CHROME_HIDE_MS * 2);
    });
    expect(result.current.shown).toBe(true);
    // Turned off again: the wait starts from then, the bar not hidden at once.
    await rerender(READING);
    expect(result.current.shown).toBe(true);
  });

  it('never hides with auto-hide off, nor while no book shows', async () => {
    for (const hold of [
      { ...READING, autoHide: false },
      { ...READING, reading: false },
    ]) {
      const { result, unmount } = await mount(hold);
      await act(async () => result.current.pageTurned());
      await act(async () => result.current.centreTapped());
      await act(async () => {
        jest.advanceTimersByTime(CHROME_HIDE_MS * 2);
      });
      expect(result.current.shown).toBe(true);
      await unmount();
    }
  });
});
