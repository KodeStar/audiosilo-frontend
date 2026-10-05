import { act, renderHook } from '@testing-library/react-native';

import { useDebouncedValue } from './use-debounced-value';

describe('useDebouncedValue', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts with the value, then follows it only after a quiet period', async () => {
    const { result, rerender } = await renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 300),
      { initialProps: { value: 'a' } },
    );
    expect(result.current).toBe('a');

    await rerender({ value: 'ab' });
    await act(async () => jest.advanceTimersByTime(200));
    await rerender({ value: 'abc' });
    await act(async () => jest.advanceTimersByTime(200));
    // Each change restarts the wait: 'ab' never lands.
    expect(result.current).toBe('a');

    await act(async () => jest.advanceTimersByTime(100));
    expect(result.current).toBe('abc');
  });
});
