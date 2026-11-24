import { ApiError } from '@/api/client';

import { ARTWORK_RETRY_DELAYS_MS, artworkRetryDelay, probeArtwork } from './artwork-retry';

const refused = (status: number, retryAfter?: number) => () =>
  Promise.reject(new ApiError(status, 'no', undefined, retryAfter));

describe('probeArtwork', () => {
  it('reads what asking the artwork again answered', async () => {
    expect(await probeArtwork(() => Promise.resolve())).toEqual({ kind: 'ready' });
    expect(await probeArtwork(refused(429, 4))).toEqual({ kind: 'wait', seconds: 4 });
    expect(await probeArtwork(refused(503, 1))).toEqual({ kind: 'wait', seconds: 1 });
    // A Retry-After the browser can't read (cross-origin, a date) says nothing.
    expect(await probeArtwork(refused(429))).toEqual({ kind: 'unknown' });
    for (const status of [401, 403, 404]) {
      expect(await probeArtwork(refused(status))).toEqual({ kind: 'gone' });
    }
    for (const status of [408, 500, 502]) {
      expect(await probeArtwork(refused(status))).toEqual({ kind: 'unknown' });
    }
    expect(await probeArtwork(() => Promise.reject(new TypeError('offline')))).toEqual({
      kind: 'unknown',
    });
  });
});

describe('artworkRetryDelay', () => {
  it('waits by the probe, within the four tries', () => {
    expect(artworkRetryDelay(1)).toBe(ARTWORK_RETRY_DELAYS_MS[0]);
    expect(artworkRetryDelay(1, { kind: 'unknown' })).toBe(ARTWORK_RETRY_DELAYS_MS[0]);
    expect(artworkRetryDelay(2, { kind: 'ready' })).toBe(0);
    expect(artworkRetryDelay(1, { kind: 'gone' })).toBeNull();
    expect(artworkRetryDelay(1, { kind: 'wait', seconds: 7 })).toBe(7_000);
    // Never under a second, never past a minute.
    expect(artworkRetryDelay(1, { kind: 'wait', seconds: 0 })).toBe(1_000);
    expect(artworkRetryDelay(1, { kind: 'wait', seconds: 600 })).toBe(60_000);
    // Past the last try nothing asks again, whatever the probe said.
    expect(artworkRetryDelay(ARTWORK_RETRY_DELAYS_MS.length + 1, { kind: 'ready' })).toBeNull();
    expect(artworkRetryDelay(0)).toBeNull();
  });
});
