import { bridgeJob } from '@/testing/bridge-fixtures';

import {
  BRIDGE_IDLE_POLL_MS,
  BRIDGE_POLL_MS,
  bridgePollInterval,
  isOpenJob,
  latestDone,
  latestJob,
  SIDECARS_GENERATE,
  staleAfterFinish,
  turnedDone,
} from './bridge-jobs';

const job = bridgeJob;

describe('isOpenJob', () => {
  it('reads queued, claimed, running and parked as open, the rest as ended', () => {
    for (const state of ['queued', 'claimed', 'running', 'needs_attention'])
      expect(isOpenJob({ state })).toBe(true);
    for (const state of ['done', 'failed', 'cancelled', 'something_new'])
      expect(isOpenJob({ state })).toBe(false);
  });
});

describe('latestJob', () => {
  it('picks the highest id of the kind, whatever the order', () => {
    const jobs = [job({ id: 3 }), job({ id: 9, kind: 'bridge.verify' }), job({ id: 5 })];
    expect(latestJob(jobs, SIDECARS_GENERATE)?.id).toBe(5);
    expect(latestJob(jobs, 'bridge.verify')?.id).toBe(9);
    expect(latestJob(undefined, SIDECARS_GENERATE)).toBeUndefined();
  });
});

describe('bridgePollInterval', () => {
  it('polls every 10 s while a generate job of the book is claimed or running', () => {
    expect(BRIDGE_POLL_MS).toBe(10_000);
    for (const state of ['claimed', 'running'])
      expect(bridgePollInterval([job({ state })], true)).toBe(BRIDGE_POLL_MS);
  });

  it('polls every minute while it only waits, queued or parked', () => {
    expect(BRIDGE_IDLE_POLL_MS).toBe(60_000);
    for (const state of ['queued', 'needs_attention'])
      expect(bridgePollInterval([job({ state })], true)).toBe(BRIDGE_IDLE_POLL_MS);
    // A running job anywhere in the list wins.
    expect(
      bridgePollInterval([job({ id: 2, state: 'queued' }), job({ id: 1, state: 'running' })], true),
    ).toBe(BRIDGE_POLL_MS);
  });

  it('stops once the job ended, off screen, for another kind and with nothing known', () => {
    for (const state of ['done', 'failed', 'cancelled'])
      expect(bridgePollInterval([job({ state })], true)).toBe(false);
    expect(bridgePollInterval([job()], false)).toBe(false);
    expect(bridgePollInterval([job({ kind: 'bridge.verify' })], true)).toBe(false);
    expect(bridgePollInterval(undefined, true)).toBe(false);
    expect(bridgePollInterval([], true)).toBe(false);
  });
});

describe('latestDone', () => {
  it('picks the newest done generate job, ignoring open, failed and other kinds', () => {
    const jobs = [
      job({ id: 2, state: 'done' }),
      job({ id: 5, state: 'running' }),
      job({ id: 4, state: 'failed' }),
      job({ id: 3, state: 'done' }),
      job({ id: 9, kind: 'bridge.verify', state: 'done' }),
    ];
    expect(latestDone(jobs)?.id).toBe(3);
    expect(latestDone([job()])).toBeUndefined();
    expect(latestDone(undefined)).toBeUndefined();
  });
});

describe('staleAfterFinish', () => {
  const done = job({ state: 'done', finished_at: '2026-10-15T10:05:00Z' });
  const before = Date.parse('2026-10-15T10:00:00Z');
  const after = Date.parse('2026-10-15T11:00:00Z');

  it('says an answer fetched before the job finished is stale', () => {
    expect(staleAfterFinish(done, [before], false)).toBe(true);
    expect(staleAfterFinish(done, [after, before], false)).toBe(true);
  });

  it('keeps answers fetched after the finish, and ignores ones never fetched', () => {
    expect(staleAfterFinish(done, [after], false)).toBe(false);
    expect(staleAfterFinish(done, [0], false)).toBe(false);
    expect(staleAfterFinish(done, [], false)).toBe(false);
  });

  it('trusts a job seen turning done over the clocks', () => {
    expect(staleAfterFinish(done, [after], true)).toBe(true);
  });

  it('falls back to updated_at without a finish time', () => {
    const updated = job({ state: 'done', updated_at: '2026-10-15T10:30:00Z' });
    expect(staleAfterFinish(updated, [before], false)).toBe(true);
  });
});

describe('turnedDone', () => {
  it('sees a generate job go from open to done between two answers', () => {
    expect(turnedDone([job({ state: 'running' })], [job({ state: 'done' })])).toBe(true);
  });

  it('is false for a job already done, a new done job, a failure and no earlier answer', () => {
    expect(turnedDone([job({ state: 'done' })], [job({ state: 'done' })])).toBe(false);
    expect(turnedDone([], [job({ state: 'done' })])).toBe(false);
    expect(turnedDone([job({ state: 'running' })], [job({ state: 'failed' })])).toBe(false);
    expect(turnedDone(undefined, [job({ state: 'done' })])).toBe(false);
  });
});
