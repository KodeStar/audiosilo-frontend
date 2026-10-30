import { bridgeJob } from '@/testing/bridge-fixtures';

import {
  BRIDGE_IDLE_POLL_MS,
  BRIDGE_POLL_MS,
  bridgePollInterval,
  CHAPTERS_DETECT,
  estimatePollInterval,
  isOpenJob,
  latestDone,
  latestJob,
  midRunCheckpoint,
  READALONG_ALIGN,
  SIDECARS_CONTRIBUTE,
  SIDECARS_DESCRIBE,
  SIDECARS_GENERATE,
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

  // Bridge Phase 1d: the console's chapter detection, so the page sees it end.
  it('polls for an open chapters.detect job too', () => {
    expect(bridgePollInterval([job({ kind: CHAPTERS_DETECT, state: 'running' })], true)).toBe(
      BRIDGE_POLL_MS,
    );
    expect(bridgePollInterval([job({ kind: CHAPTERS_DETECT, state: 'queued' })], true)).toBe(
      BRIDGE_IDLE_POLL_MS,
    );
    expect(bridgePollInterval([job({ kind: CHAPTERS_DETECT, state: 'done' })], true)).toBe(false);
  });

  // Bridge Phase 3c: a page that offers Make read-along sees its job end.
  it('polls for an open readalong.align job too', () => {
    expect(READALONG_ALIGN).toBe('readalong.align');
    expect(bridgePollInterval([job({ kind: READALONG_ALIGN, state: 'claimed' })], true)).toBe(
      BRIDGE_POLL_MS,
    );
    expect(
      bridgePollInterval([job({ kind: READALONG_ALIGN, state: 'needs_attention' })], true),
    ).toBe(BRIDGE_IDLE_POLL_MS);
    expect(bridgePollInterval([job({ kind: READALONG_ALIGN, state: 'failed' })], true)).toBe(false);
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

// Bridge Phase 2b: a share holding Generate back ends in seconds, so the confirmation's
// estimate is read again until it has.
describe('estimatePollInterval', () => {
  const share = (state: string) => job({ kind: SIDECARS_CONTRIBUTE, state });

  it('polls while a share holds Generate back: every 10 s while it works, a minute while it waits', () => {
    for (const state of ['claimed', 'running'])
      expect(estimatePollInterval(share(state), true)).toBe(BRIDGE_POLL_MS);
    expect(estimatePollInterval(share('queued'), true)).toBe(BRIDGE_IDLE_POLL_MS);
  });

  it("never for a detection, the book's own generate job, an ended share, none, or off screen", () => {
    expect(estimatePollInterval(job({ kind: CHAPTERS_DETECT, state: 'running' }), true)).toBe(
      false,
    );
    expect(estimatePollInterval(job({ state: 'running' }), true)).toBe(false);
    expect(estimatePollInterval(share('done'), true)).toBe(false);
    expect(estimatePollInterval(undefined, true)).toBe(false);
    expect(estimatePollInterval(share('running'), false)).toBe(false);
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

  // Bridge 1c: a description the console queued also rewrote the book's files.
  it('counts a done describe job too, the newest of the two kinds', () => {
    const jobs = [
      job({ id: 3, state: 'done' }),
      job({ id: 6, kind: SIDECARS_DESCRIBE, state: 'done' }),
      job({ id: 8, kind: SIDECARS_DESCRIBE, state: 'running' }),
    ];
    expect(latestDone(jobs)?.id).toBe(6);
    expect(latestDone([job({ id: 7, state: 'done' }), ...jobs])?.id).toBe(7);
  });

  // Bridge 1d: the console's chapter detection wrote the book's chapters.json.
  it('counts a done chapters.detect job too', () => {
    const jobs = [
      job({ id: 3, state: 'done' }),
      job({ id: 5, kind: CHAPTERS_DETECT, state: 'done' }),
      job({ id: 9, kind: CHAPTERS_DETECT, state: 'running' }),
    ];
    expect(latestDone(jobs)?.id).toBe(5);
  });

  it('counts a done readalong.align job too (it wrote readalong.json)', () => {
    const jobs = [
      job({ id: 3, state: 'done' }),
      job({ id: 7, kind: READALONG_ALIGN, state: 'done' }),
      job({ id: 8, kind: READALONG_ALIGN, state: 'failed' }),
    ];
    expect(latestDone(jobs)?.id).toBe(7);
  });
});

describe('midRunCheckpoint', () => {
  it('marks a running generate job past chapter detection by its step, else its stage', () => {
    const at = (progress: { step?: string; stage?: string }, over = {}) =>
      midRunCheckpoint([job({ id: 4, state: 'running', progress, ...over })])?.mark;
    expect(at({ step: 'sanitizing', stage: 'sanitizing' })).toBe('4:sanitizing');
    expect(at({ step: 'writing', stage: 'sanitizing' })).toBe('4:writing');
    expect(at({ stage: 'qa_sweep' })).toBe('4:qa_sweep');
    // Not past detection yet, not running, no stage, or another kind: none.
    for (const stage of ['inspecting', 'splitting', 'asr', 'chapter_detecting'])
      expect(at({ step: stage, stage })).toBeUndefined();
    expect(at({ stage: 'sanitizing' }, { state: 'needs_attention' })).toBeUndefined();
    expect(at({ step: 'writing' })).toBeUndefined();
    expect(at({ stage: 'sanitizing' }, { kind: CHAPTERS_DETECT })).toBeUndefined();
    expect(midRunCheckpoint(undefined)).toBeUndefined();
  });
});
