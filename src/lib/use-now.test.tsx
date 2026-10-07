import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { useNow } from './use-now';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('useNow', () => {
  let onChange: (state: string) => void = () => {};
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      l: (s: string) => void,
    ) => {
      onChange = l;
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('moves on every period', async () => {
    const { result } = await renderHook(() => useNow(HOUR));
    const start = result.current;
    await act(async () => {
      jest.advanceTimersByTime(HOUR);
    });
    expect(result.current).toBe(start + HOUR);
  });

  it('reads the clock again when the app comes back after a suspension', async () => {
    const { result } = await renderHook(() => useNow(HOUR));
    const start = result.current;
    // Suspended for three days: no timer ran, the clock moved on.
    jest.setSystemTime(start + 3 * DAY);
    await act(async () => onChange('active'));
    expect(result.current).toBe(start + 3 * DAY);
  });
});
