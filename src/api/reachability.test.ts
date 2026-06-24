import { ApiError, TimeoutError } from '@/api/client';
import { noteError, noteSuccess, onReconnect, useReachability } from '@/api/reachability';

// Exercises the pure reachability state machine. `setOnline` is module-private, so we
// drive transitions through the public `noteError` (-> offline) / `noteSuccess`
// (-> online) and read the store via getState(). Fake timers keep the offline probe's
// setInterval from leaking between tests.
describe('reachability state machine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Reset to the optimistic default. Going offline starts a probe interval;
    // returning to online (which we do here) stops it via stopProbe.
    useReachability.setState({ online: true });
  });

  afterEach(() => {
    // Ensure any probe interval started during a test is cleared, then drop timers.
    useReachability.setState({ online: true });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('stays online for an ApiError (the server answered)', () => {
    noteError(new ApiError(503, 'unavailable'));
    expect(useReachability.getState().online).toBe(true);
  });

  it('is a no-op for an AbortError (deliberate cancellation)', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    noteError(abort);
    expect(useReachability.getState().online).toBe(true);
  });

  it('flips offline for a TimeoutError', () => {
    noteError(new TimeoutError(5000));
    expect(useReachability.getState().online).toBe(false);
  });

  it('flips offline for a generic connection error', () => {
    noteError(new Error('Network request failed'));
    expect(useReachability.getState().online).toBe(false);
  });

  it('fires registered onReconnect handlers exactly once on the offline->online edge', () => {
    const handler = jest.fn();
    const unsubscribe = onReconnect(handler);

    noteError(new Error('down')); // online -> offline
    expect(useReachability.getState().online).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    noteSuccess(); // offline -> online edge
    expect(useReachability.getState().online).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    // A redundant online->online call must not re-fire the handler.
    noteSuccess();
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
