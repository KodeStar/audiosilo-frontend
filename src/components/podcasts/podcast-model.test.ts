import { fetchStatus, wire2b } from '@/testing/podcast-fixtures';

import { fetchProgress, fetchReasonKey } from './podcast-model';

describe('fetchReasonKey', () => {
  it("names a listener's sentence for each known code, else the generic one", () => {
    for (const code of [
      'module_off',
      'bridge_unavailable',
      'library_not_writable',
      'fetch_limit',
      'demo_account',
      'too_large',
      'identity_changed',
    ]) {
      expect(fetchReasonKey(code)).toBe(`podcasts.fetch.reason.${code}`);
    }
    expect(fetchReasonKey('http_404')).toBe('podcasts.fetch.reason.other');
    expect(fetchReasonKey(null)).toBe('podcasts.fetch.reason.other');
    expect(fetchReasonKey(undefined)).toBe('podcasts.fetch.reason.other');
  });
});

describe('fetchProgress', () => {
  it('is the bytes so far and the share done, when the size is known', () => {
    expect(fetchProgress(wire2b.status_response.fetch)).toEqual({
      received: 100,
      total: 1000,
      percent: 10,
    });
    expect(fetchProgress(fetchStatus({ bytes_received: 2000 }))).toMatchObject({ percent: 100 });
  });

  it('has no share without a size, or without a status', () => {
    expect(fetchProgress(fetchStatus({ bytes_total: null }))).toEqual({
      received: 100,
      total: null,
      percent: null,
    });
    expect(fetchProgress(fetchStatus({ bytes_total: 0 }))).toMatchObject({ percent: null });
    expect(fetchProgress(null)).toEqual({ received: 0, total: null, percent: null });
  });
});
