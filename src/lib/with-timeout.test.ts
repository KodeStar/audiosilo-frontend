import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves with the promise when it settles first, and clears its timer', async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, 'slow')).resolves.toBe(7);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('passes on the promise rejecting first', async () => {
    await expect(withTimeout(Promise.reject(new Error('no')), 1_000, 'slow')).rejects.toThrow('no');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects with the message once the time runs out first', async () => {
    const late = withTimeout(new Promise<number>(() => {}), 1_000, 'slow');
    jest.advanceTimersByTime(1_000);
    await expect(late).rejects.toThrow('slow');
  });
});
