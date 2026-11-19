import { ApiError, type ApiClient } from './client';
import { noteRateLimit, RATE_LIMIT_HOLD_S, RATE_LIMIT_MAX_HOLD_S, rateLimited } from './rate-limit';

const client = () => ({}) as ApiClient;

describe('rate-limit', () => {
  it('holds a client for the 429’s Retry-After, then lets it go', () => {
    const api = client();
    expect(noteRateLimit(api, new ApiError(429, 'slow down', undefined, 90), 1_000)).toBe(true);
    expect(rateLimited(api, 1_000 + 89_999)).toBe(true);
    expect(rateLimited(api, 1_000 + 90_000)).toBe(false);
    // Let go: a later check does not hold it again.
    expect(rateLimited(api, 1_000)).toBe(false);
  });

  it('holds for the default wait with no Retry-After, and never past the cap', () => {
    const plain = client();
    noteRateLimit(plain, new ApiError(429, 'slow down'), 0);
    expect(rateLimited(plain, RATE_LIMIT_HOLD_S * 1000 - 1)).toBe(true);
    expect(rateLimited(plain, RATE_LIMIT_HOLD_S * 1000)).toBe(false);
    const far = client();
    noteRateLimit(far, new ApiError(429, 'slow down', undefined, 86_400), 0);
    expect(rateLimited(far, RATE_LIMIT_MAX_HOLD_S * 1000)).toBe(false);
  });

  it('notes nothing but a 429, and holds only the client it answered', () => {
    const api = client();
    for (const e of [
      new ApiError(408, 'timeout'),
      new ApiError(503, 'busy'),
      new TypeError('offline'),
    ]) {
      expect(noteRateLimit(api, e, 0)).toBe(false);
    }
    expect(rateLimited(api, 0)).toBe(false);
    noteRateLimit(api, new ApiError(429, 'slow down'), 0);
    expect(rateLimited(client(), 0)).toBe(false);
  });
});
