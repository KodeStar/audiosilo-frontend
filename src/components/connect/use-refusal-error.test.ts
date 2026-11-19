import { act, renderHook } from '@testing-library/react-native';

import { useRefusalError } from './use-refusal-error';

describe('useRefusalError', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const waitOver = (ms: number) => ({ at: Date.now() + ms, text: 'You can try again now.' });

  it('swaps the words once their wait is over, not before', async () => {
    const { result } = await renderHook(() => useRefusalError());
    await act(async () => result.current[1]('Try again in 30 seconds.', waitOver(30_000)));
    await act(async () => jest.advanceTimersByTime(29_999));
    expect(result.current[0]).toBe('Try again in 30 seconds.');
    await act(async () => jest.advanceTimersByTime(1));
    expect(result.current[0]).toBe('You can try again now.');
  });

  it("keeps a wait past a timer's limit, never swapping it at once", async () => {
    const { result } = await renderHook(() => useRefusalError());
    await act(async () => result.current[1]('Try again in 50000 minutes.', waitOver(3e9)));
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(result.current[0]).toBe('Try again in 50000 minutes.');
  });

  it('never lands an earlier wait on new words, or on none', async () => {
    const { result } = await renderHook(() => useRefusalError());
    await act(async () => result.current[1]('Try again in 30 seconds.', waitOver(30_000)));
    await act(async () => result.current[1]('Wrong name or password.'));
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(result.current[0]).toBe('Wrong name or password.');

    await act(async () => result.current[1]('Try again in 30 seconds.', waitOver(30_000)));
    await act(async () => result.current[1](null));
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(result.current[0]).toBeNull();
  });
});
