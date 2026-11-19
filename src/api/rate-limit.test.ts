import { ApiError } from './client';
import {
  forgetRateLimit,
  noteRateLimit,
  onRateLimitOver,
  RATE_LIMIT_HOLD_S,
  RATE_LIMIT_MAX_HOLD_S,
  rateLimited,
  stopsReplay,
} from './rate-limit';

describe('rate-limit', () => {
  afterEach(() => {
    for (const id of ['c1', 'c2']) forgetRateLimit(id);
  });

  it('holds a connection for the 429’s Retry-After, then lets it go', () => {
    expect(noteRateLimit('c1', new ApiError(429, 'slow down', undefined, 90), 1_000)).toBe(true);
    expect(rateLimited('c1', 1_000 + 89_999)).toBe(true);
    expect(rateLimited('c1', 1_000 + 90_000)).toBe(false);
    // Let go: a later check does not hold it again.
    expect(rateLimited('c1', 1_000)).toBe(false);
  });

  it('holds for the default wait with no Retry-After, never past the cap, nor under a second', () => {
    noteRateLimit('c1', new ApiError(429, 'slow down'), 0);
    expect(rateLimited('c1', RATE_LIMIT_HOLD_S * 1000 - 1)).toBe(true);
    expect(rateLimited('c1', RATE_LIMIT_HOLD_S * 1000)).toBe(false);
    noteRateLimit('c1', new ApiError(429, 'slow down', undefined, 86_400), 0);
    expect(rateLimited('c1', RATE_LIMIT_MAX_HOLD_S * 1000)).toBe(false);
    // A `Retry-After: 0` (a proxy's) would replay straight back into the limit.
    noteRateLimit('c1', new ApiError(429, 'slow down', undefined, 0), 0);
    expect(rateLimited('c1', 999)).toBe(true);
    expect(rateLimited('c1', 1_000)).toBe(false);
  });

  it('notes nothing but a 429, and holds only the connection it answered', () => {
    for (const e of [
      new ApiError(408, 'timeout'),
      new ApiError(503, 'busy'),
      new TypeError('offline'),
    ]) {
      expect(noteRateLimit('c1', e, 0)).toBe(false);
    }
    expect(rateLimited('c1', 0)).toBe(false);
    noteRateLimit('c1', new ApiError(429, 'slow down'), 0);
    expect(rateLimited('c1', 0)).toBe(true);
    expect(rateLimited('c2', 0)).toBe(false);
  });

  it('stops a replay at no answer or a 429 (noted), never at a save’s own failure', () => {
    expect(stopsReplay('c1', new ApiError(500, 'oops'))).toBe(false);
    expect(rateLimited('c1')).toBe(false);
    expect(stopsReplay('c1', new TypeError('offline'))).toBe(true);
    expect(rateLimited('c1')).toBe(false);
    expect(stopsReplay('c1', new ApiError(429, 'slow down'))).toBe(true);
    expect(rateLimited('c1')).toBe(true);
  });

  it('tells its listeners once the wait is over, and never once the connection is gone', () => {
    jest.useFakeTimers();
    const over = jest.fn();
    const stop = onRateLimitOver(over);
    try {
      noteRateLimit('c1', new ApiError(429, 'slow down', undefined, 5));
      jest.advanceTimersByTime(4_999);
      expect(over).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(over).toHaveBeenCalledWith('c1');
      expect(rateLimited('c1')).toBe(false);

      over.mockClear();
      noteRateLimit('c2', new ApiError(429, 'slow down'));
      forgetRateLimit('c2');
      expect(rateLimited('c2')).toBe(false);
      jest.advanceTimersByTime(RATE_LIMIT_HOLD_S * 1000);
      expect(over).not.toHaveBeenCalled();
    } finally {
      stop();
      jest.useRealTimers();
    }
  });
});
