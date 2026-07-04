import { ApiError, TimeoutError } from '@/api/client';
import {
  anyOffline,
  isReachable,
  noteError,
  noteSuccess,
  onReconnect,
  useReachability,
} from '@/api/reachability';

// Exercises the per-connection reachability state machine. `setOnline` is driven through
// the public `noteError` (-> offline) / `noteSuccess` (-> online) per connection id.
// Fake timers keep the offline probe's setInterval from leaking between tests.
describe('per-connection reachability state machine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useReachability.setState({ online: {} });
  });

  afterEach(() => {
    // Clear any state so the probe interval (started when a connection went offline)
    // stops, then drop timers.
    useReachability.setState({ online: {} });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('treats an unknown connection as reachable (optimistic default)', () => {
    expect(isReachable('c1')).toBe(true);
  });

  it('stays online for an ApiError (the server answered)', () => {
    noteError('c1', new ApiError(503, 'unavailable'));
    expect(isReachable('c1')).toBe(true);
  });

  it('is a no-op for an AbortError (deliberate cancellation)', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    noteError('c1', abort);
    expect(isReachable('c1')).toBe(true);
  });

  it('flips a connection offline for a TimeoutError', () => {
    noteError('c1', new TimeoutError(5000));
    expect(isReachable('c1')).toBe(false);
  });

  it('flips a connection offline for a generic connection error', () => {
    noteError('c1', new Error('Network request failed'));
    expect(isReachable('c1')).toBe(false);
  });

  it('marks only the failing connection offline, not its siblings', () => {
    noteError('c1', new Error('down'));
    expect(isReachable('c1')).toBe(false);
    expect(isReachable('c2')).toBe(true); // unaffected
  });

  it('anyOffline reflects whether any connection is down', () => {
    expect(anyOffline(useReachability.getState().online)).toBe(false);
    noteError('c1', new Error('down'));
    expect(anyOffline(useReachability.getState().online)).toBe(true);
    noteSuccess('c1');
    expect(anyOffline(useReachability.getState().online)).toBe(false);
  });

  it('fires onReconnect with the recovered connection id, exactly once per edge', () => {
    const handler = jest.fn();
    const unsubscribe = onReconnect(handler);

    noteError('c1', new Error('down')); // online -> offline
    expect(isReachable('c1')).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    noteSuccess('c1'); // offline -> online edge
    expect(isReachable('c1')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('c1');

    // A redundant online->online call must not re-fire the handler.
    noteSuccess('c1');
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('reconnect edges are independent per connection', () => {
    const handler = jest.fn();
    const unsubscribe = onReconnect(handler);

    noteError('c1', new Error('down'));
    noteError('c2', new Error('down'));
    noteSuccess('c2'); // only c2 recovers
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('c2');
    expect(isReachable('c1')).toBe(false);

    unsubscribe();
  });
});
