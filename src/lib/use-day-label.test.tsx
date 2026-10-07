import { act, renderHook } from '@testing-library/react-native';

import { formatDayDate, formatShortDay, formatWeekday } from '@/lib/format';
import { localDayStart } from '@/lib/listening-sessions';

import { useDayLabel, useToday } from './use-day-label';

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

describe('useToday', () => {
  beforeEach(() => jest.useFakeTimers({ now: at(5, 23, 58) }));
  afterEach(() => jest.useRealTimers());

  it('is local midnight, and moves on just after the next one, once a day', async () => {
    let renders = 0;
    const { result } = await renderHook(() => {
      renders++;
      return useToday();
    });
    expect(result.current).toBe(localDayStart(at(5, 12)));
    const before = renders;
    // A minute in: the same day, so nothing re-renders.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(renders).toBe(before);
    await act(async () => {
      jest.advanceTimersByTime(2 * 60_000);
    });
    expect(result.current).toBe(localDayStart(at(6, 12)));
    // And again the night after.
    await act(async () => {
      jest.advanceTimersByTime(24 * 60 * 60_000);
    });
    expect(result.current).toBe(localDayStart(at(7, 12)));
  });
});

describe('useDayLabel', () => {
  const today = localDayStart(at(7, 15));

  it('names today, yesterday, this week by weekday, then by date', async () => {
    const { result } = await renderHook(() => useDayLabel());
    const label = result.current;
    expect(label(localDayStart(at(7, 1)), today)).toBe('Today');
    expect(label(localDayStart(at(6, 23)), today)).toBe('Yesterday');
    expect(label(localDayStart(at(2, 12)), today)).toBe(formatWeekday(new Date(at(2, 0))));
    expect(label(localDayStart(at(0, 12)), today)).toBe(formatDayDate(new Date(at(0, 0))));
  });

  it('names every day before yesterday with the fallback it is given', async () => {
    const { result } = await renderHook(() => useDayLabel(formatShortDay));
    expect(result.current(localDayStart(at(6, 1)), today)).toBe('Yesterday');
    expect(result.current(localDayStart(at(2, 1)), today)).toBe(formatShortDay(new Date(at(2, 0))));
  });
});
