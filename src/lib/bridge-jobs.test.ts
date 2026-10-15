import { bridgeJob } from '@/testing/bridge-fixtures';

import {
  BRIDGE_POLL_MS,
  bridgePollInterval,
  finishedSince,
  isOpenJob,
  latestJob,
  SIDECARS_GENERATE,
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
  it('polls every 10 s while a generate job of the book is open and the surface is active', () => {
    expect(BRIDGE_POLL_MS).toBe(10_000);
    for (const state of ['queued', 'claimed', 'running', 'needs_attention'])
      expect(bridgePollInterval([job({ state })], true)).toBe(BRIDGE_POLL_MS);
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

describe('finishedSince', () => {
  const fetched = Date.parse('2026-10-15T10:00:00Z');

  it('says the metadata is stale when a generate job finished after it was fetched', () => {
    expect(
      finishedSince([job({ state: 'done', finished_at: '2026-10-15T10:05:00Z' })], fetched),
    ).toBe(true);
  });

  it('keeps metadata fetched after the finish, and ignores open, failed and other jobs', () => {
    expect(
      finishedSince([job({ state: 'done', finished_at: '2026-10-15T09:55:00Z' })], fetched),
    ).toBe(false);
    expect(finishedSince([job({ state: 'running' })], 0)).toBe(false);
    expect(finishedSince([job({ state: 'failed', finished_at: '2026-10-15T11:00:00Z' })], 0)).toBe(
      false,
    );
    expect(
      finishedSince(
        [job({ kind: 'bridge.verify', state: 'done', finished_at: '2026-10-15T11:00:00Z' })],
        0,
      ),
    ).toBe(false);
  });

  it('falls back to updated_at without a finish time', () => {
    expect(
      finishedSince([job({ state: 'done', updated_at: '2026-10-15T10:30:00Z' })], fetched),
    ).toBe(true);
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
