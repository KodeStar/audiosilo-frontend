import { ApiError } from '@/api/client';
import { READALONG_ALIGN } from '@/lib/bridge-jobs';
import { bridgeJob } from '@/testing/bridge-fixtures';

import {
  readalongBlockKey,
  readalongOffer,
  readalongRefusalKey,
  readalongStatusJob,
} from './readalong-model';

const job = (over: Parameters<typeof bridgeJob>[0]) =>
  bridgeJob({ kind: READALONG_ALIGN, ...over });

describe('readalongStatusJob', () => {
  it("shows the newest read-along job while open or once failed, never another kind's", () => {
    expect(readalongStatusJob([job({ id: 2, state: 'queued' })])?.id).toBe(2);
    expect(readalongStatusJob([job({ id: 3, state: 'failed' })])?.id).toBe(3);
    expect(readalongStatusJob([job({ state: 'done' })])).toBeUndefined();
    expect(readalongStatusJob([job({ state: 'cancelled' })])).toBeUndefined();
    expect(readalongStatusJob([bridgeJob({ state: 'running' })])).toBeUndefined();
  });
});

describe('readalongOffer', () => {
  const base = { allowed: true, hasEbook: true, jobsKnown: true, showsJob: false };
  it('offers it once the jobs are known, with no status showing, for a book with an ebook', () => {
    expect(readalongOffer(base)).toBe(true);
    expect(readalongOffer({ ...base, allowed: false })).toBe(false);
    expect(readalongOffer({ ...base, hasEbook: false })).toBe(false);
    expect(readalongOffer({ ...base, jobsKnown: false })).toBe(false);
    expect(readalongOffer({ ...base, showsJob: true })).toBe(false);
  });
});

describe('readalongBlockKey', () => {
  const e = { ebook: { path: 'a.epub', size: 1 }, writable: true };
  it('holds nothing back for a writable book with an ebook and no open job', () => {
    expect(readalongBlockKey(e)).toBeNull();
    // A finished job of its own holds nothing back.
    expect(readalongBlockKey({ ...e, open_job: job({ state: 'done' }) })).toBeNull();
  });
  it('holds back on its own open read-along job too', () => {
    expect(readalongBlockKey({ ...e, open_job: job({ state: 'running' }) })).toBe(
      'bridge.readalong.readalongOpen',
    );
    expect(readalongBlockKey({ ...e, ebook: null })).toBe('bridge.readalong.noEbook');
  });
});

describe('readalongRefusalKey', () => {
  it("words the server's refusals, else the fallback", () => {
    expect(readalongRefusalKey(new ApiError(409, 'x', 'generate_open'), 'f')).toBe(
      'bridge.readalong.generateOpen',
    );
    expect(readalongRefusalKey(new ApiError(409, 'x', 'kind_unavailable'), 'f')).toBe(
      'bridge.generate.unavailable',
    );
    expect(readalongRefusalKey(new Error('x'), 'f')).toBe('f');
  });
});
