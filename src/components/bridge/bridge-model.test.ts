import { ApiError } from '@/api/client';
import en from '@/i18n/locales/en.json';
import { ADMIN, bridgeEstimate, bridgeJob, bridgeServer } from '@/testing/bridge-fixtures';

import {
  blockedReason,
  bridgeRefusalKey,
  generateOffer,
  hasCharactersOrRecaps,
  jobStatusView,
  mayGenerate,
  parkEndsByItself,
  parkReason,
  queueInOrder,
  queueOrder,
  runEstimate,
  stageOf,
  statusJob,
} from './bridge-model';

describe('mayGenerate (who sees the action)', () => {
  it('lets an admin generate where the Bridge offers sidecars and metadata is on', () => {
    expect(mayGenerate(ADMIN, bridgeServer())).toBe(true);
  });

  it('never shows it to a non-admin, a household member, a kid or a demo account', () => {
    const server = bridgeServer();
    expect(mayGenerate({ ...ADMIN, role: 'user' }, server)).toBe(false);
    // Members can't be admins today; the gate holds even if one ever were.
    expect(mayGenerate({ ...ADMIN, managed_by: { id: 2, username: 'owner' } }, server)).toBe(false);
    expect(mayGenerate({ ...ADMIN, member_kind: 'kid' }, server)).toBe(false);
    expect(mayGenerate({ ...ADMIN, member_kind: 'grownup' }, server)).toBe(false);
    expect(mayGenerate({ ...ADMIN, is_demo: true }, server)).toBe(false);
    // An ordinary account's null household fields don't count as a member.
    expect(mayGenerate({ ...ADMIN, managed_by: null, member_kind: null }, server)).toBe(true);
  });

  it('needs the bridge flag, the sidecars feature and metadata', () => {
    const caps = bridgeServer().capabilities;
    expect(mayGenerate(ADMIN, bridgeServer({ capabilities: { ...caps, bridge: false } }))).toBe(
      false,
    );
    expect(mayGenerate(ADMIN, bridgeServer({ capabilities: { ...caps, metadata: false } }))).toBe(
      false,
    );
    expect(
      mayGenerate(ADMIN, bridgeServer({ bridge: { version: '0.1.0', features: ['verify'] } })),
    ).toBe(false);
  });

  it('shows nothing for an older server without the flag, or while nothing is known', () => {
    const old = bridgeServer({
      capabilities: {
        admin_ui: true,
        web_player: true,
        transcode: false,
        upload: false,
        websocket: false,
        metadata: true,
      },
      bridge: undefined,
    });
    expect(mayGenerate(ADMIN, old)).toBe(false);
    expect(mayGenerate(ADMIN, undefined)).toBe(false);
    expect(mayGenerate(undefined, bridgeServer())).toBe(false);
    expect(mayGenerate(null, null)).toBe(false);
  });
});

describe('stage labels', () => {
  const STAGES = [
    'inspecting',
    'splitting',
    'asr',
    'chapter_detecting',
    'sanitizing',
    'qa_sweep',
    'qa_adjudicating',
    'retranscribing',
    'markers_normalizing',
    'spelling_research',
    'correcting',
    'fact_pass',
    'synthesizing',
    'auditing',
    'fixing',
    'validating',
    'ready',
    'contributing',
    'extracting',
    'chapter_mapping',
    'waiting',
    'describing',
    'writing',
    'rescanning',
  ];

  it('names every engine stage and Bridge step, each with English words', () => {
    for (const s of STAGES) {
      expect(stageOf({ step: s })).toBe(s);
      expect((en.bridge.stage as Record<string, string>)[stageOf({ step: s })]).toBeTruthy();
    }
  });

  // Every run passes the engine's contributing stage, a local one (all the player asks
  // for) only saving its results: never worded as offering them to the community.
  it('words the contributing stage as saving, not as contributing', () => {
    expect(en.bridge.stage.contributing).not.toMatch(/AudioSilo Meta|contribut/i);
  });

  // Bridge Phase 1d: a generate run saves the chapters it found long before its end; that
  // save's steps come with an engine stage before ready and read as that stage.
  it('words a save mid-run by the engine stage, never as saving the results', () => {
    expect(stageOf({ step: 'writing', stage: 'chapter_detecting' })).toBe('chapter_detecting');
    expect(stageOf({ step: 'rescanning', stage: 'sanitizing' })).toBe('sanitizing');
    expect(stageOf({ step: 'writing', stage: 'validating' })).toBe('validating');
    // An unknown engine stage with the step still reads as the step.
    expect(stageOf({ step: 'writing', stage: 'teleporting' })).toBe('writing');
  });

  it('reads the step first, then the engine stage, and an unknown one as Working', () => {
    expect(stageOf({ step: 'describing', stage: 'validating' })).toBe('describing');
    expect(stageOf({ step: 'writing', stage: 'contributing' })).toBe('writing');
    expect(stageOf({ step: 'rescanning', stage: 'done' })).toBe('rescanning');
    expect(stageOf({ stage: 'auditing' })).toBe('auditing');
    expect(stageOf({ step: 'teleporting' })).toBe('working');
    expect(stageOf(null)).toBe('working');
    expect(en.bridge.stage.working).toBe('Working');
  });
});

describe('parkReason', () => {
  it('groups the park codes into reasons the player can say, and the rest as other', () => {
    expect(parkReason('agent_unavailable')).toBe('agent');
    expect(parkReason('asr_worker_waiting')).toBe('worker');
    expect(parkReason('budget_exceeded')).toBe('budget');
    expect(parkReason('agent_credential_refused')).toBe('agent');
    expect(parkReason('book_not_writable')).toBe('notWritable');
    // The Bridge's own park when the library stops being writable mid-job.
    expect(parkReason('library_not_writable')).toBe('notWritable');
    expect(parkReason('ebook_no_chapters')).toBe('chapters');
    expect(parkReason('chapters_not_detected')).toBe('chaptersNotDetected');
    expect(parkReason('qa_no_converge')).toBe('review');
    expect(parkReason('core_needed')).toBe('core');
    expect(parkReason('a_new_code')).toBe('other');
    expect(parkReason(undefined)).toBe('other');
    // A code that names an Object member is no reason either.
    expect(parkReason('constructor')).toBe('other');
    expect(parkReason('toString')).toBe('other');
  });

  // A book waiting for a worker goes on once one connects, with no time to name.
  it('says which parks end by themselves', () => {
    expect(parkEndsByItself('worker')).toBe(true);
    expect(parkEndsByItself('asr')).toBe(false);
    expect(parkEndsByItself('other')).toBe(false);
  });
});

describe('jobStatusView', () => {
  it('reads a running job: the stage, the counts and the time left', () => {
    const job = bridgeJob({
      progress: { step: 'asr', done: 12, total: 40, eta_seconds: 5400 },
    });
    expect(jobStatusView(job)).toEqual({
      phase: 'running',
      stage: 'asr',
      done: 12,
      total: 40,
      etaSeconds: 5400,
    });
  });

  it('drops counts that make no sense and an ETA that is not positive', () => {
    const job = bridgeJob({ progress: { step: 'asr', done: 50, total: 40, eta_seconds: 0 } });
    expect(jobStatusView(job)).toEqual({ phase: 'running', stage: 'asr' });
  });

  it('reads queued and claimed as waiting, and a cancel in flight as stopping', () => {
    expect(jobStatusView(bridgeJob({ state: 'queued' }))).toEqual({ phase: 'waiting' });
    expect(jobStatusView(bridgeJob({ state: 'claimed' }))).toEqual({ phase: 'waiting' });
    expect(jobStatusView(bridgeJob({ cancel_requested: true }))).toEqual({ phase: 'stopping' });
  });

  it('reads a park as its reason, with when it resumes by itself', () => {
    const job = bridgeJob({
      state: 'needs_attention',
      error: 'agent unavailable',
      progress: {
        step: 'synthesizing',
        park: { code: 'agent_rate_limited', retry_at: '2026-10-15T14:05:00Z' },
      },
    });
    expect(jobStatusView(job)).toEqual({
      phase: 'parked',
      reason: 'rateLimited',
      retryAt: new Date('2026-10-15T14:05:00Z'),
    });
    expect(
      jobStatusView(bridgeJob({ state: 'needs_attention', progress: { park: { code: 'x' } } })),
    ).toEqual({ phase: 'parked', reason: 'other', retryAt: undefined });
  });

  it('reads a failure as its error', () => {
    expect(jobStatusView(bridgeJob({ state: 'failed', error: ' disk full ' }))).toEqual({
      phase: 'failed',
      error: 'disk full',
    });
  });
});

describe('statusJob and generateOffer', () => {
  const open = bridgeJob({ id: 2, state: 'running' });

  it('shows the newest generate job while open or once failed, never a finished one', () => {
    expect(statusJob([open])).toBe(open);
    const failed = bridgeJob({ id: 3, state: 'failed' });
    expect(statusJob([open, failed])).toBe(failed);
    expect(statusJob([open, bridgeJob({ id: 4, state: 'done' })])).toBeUndefined();
    expect(statusJob([open, bridgeJob({ id: 4, state: 'cancelled' })])).toBeUndefined();
    expect(statusJob([bridgeJob({ kind: 'bridge.verify' })])).toBeUndefined();
  });

  const base = {
    allowed: true,
    metaKnown: true,
    jobsKnown: true,
    showsJob: false,
  };

  it('offers Generate for a book with no characters or recaps at all', () => {
    expect(generateOffer({ ...base, content: undefined })).toBe('generate');
    expect(generateOffer({ ...base, content: { characters: [], recaps: [] } })).toBe('generate');
  });

  it('offers nothing for community content, and Regenerate for generated content', () => {
    expect(generateOffer({ ...base, content: { characters: [{}] } })).toBeNull();
    expect(generateOffer({ ...base, content: { recaps: [{}] } })).toBeNull();
    expect(generateOffer({ ...base, content: { recaps: [{}], generated: { recaps: true } } })).toBe(
      'regenerate',
    );
  });

  it('offers nothing before the metadata and jobs are known, while a job shows, or when not allowed', () => {
    expect(generateOffer({ ...base, metaKnown: false, content: undefined })).toBeNull();
    expect(generateOffer({ ...base, jobsKnown: false, content: undefined })).toBeNull();
    expect(generateOffer({ ...base, showsJob: true, content: undefined })).toBeNull();
    expect(generateOffer({ ...base, allowed: false, content: undefined })).toBeNull();
  });

  it('counts characters or recaps, community or generated', () => {
    expect(hasCharactersOrRecaps({ characters: [{}] })).toBe(true);
    expect(hasCharactersOrRecaps({ recaps: [{}] })).toBe(true);
    expect(hasCharactersOrRecaps({})).toBe(false);
  });
});

describe('queueOrder and queueInOrder', () => {
  const current = { library_id: 1, path: 'Saga/Book 3' };
  const earlier = [
    {
      library_id: 1,
      path: 'Saga/Book 1',
      title: 'Book 1',
      series_index: '1',
      asr_hours: 1.5,
      agent_cost_usd: 10,
    },
    {
      library_id: 1,
      path: 'Saga/Book 2',
      title: 'Book 2',
      series_index: '2',
      asr_hours: 1.5,
      agent_cost_usd: 10,
    },
  ];

  it('queues the earlier books first, in reading order, then this one', () => {
    expect(queueOrder(current, earlier, true)).toEqual([
      { library_id: 1, path: 'Saga/Book 1' },
      { library_id: 1, path: 'Saga/Book 2' },
      current,
    ]);
  });

  it('queues only this one with the switch off, and never this one twice', () => {
    expect(queueOrder(current, earlier, false)).toEqual([current]);
    expect(queueOrder(current, [{ ...earlier[0], path: current.path }], true)).toEqual([current]);
  });

  it('queues one after another, each waiting for the one before', async () => {
    const calls: string[] = [];
    let inFlight = 0;
    const queue = jest.fn(async (b: { path: string }) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      calls.push(b.path);
      await Promise.resolve();
      inFlight -= 1;
      return bridgeJob({ path: b.path });
    });
    const out = await queueInOrder(queueOrder(current, earlier, true), queue);
    expect(calls).toEqual(['Saga/Book 1', 'Saga/Book 2', 'Saga/Book 3']);
    expect(out.queued.map((j) => j.path)).toEqual(calls);
    expect(out.error).toBeUndefined();
  });

  it('stops at the first refusal, keeping what was queued before it', async () => {
    const refusal = new Error('409');
    const queue = jest.fn(async (b: { path: string }) => {
      if (b.path === 'Saga/Book 2') throw refusal;
      return bridgeJob({ path: b.path });
    });
    const out = await queueInOrder(queueOrder(current, earlier, true), queue);
    expect(queue).toHaveBeenCalledTimes(2);
    expect(out.queued.map((j) => j.path)).toEqual(['Saga/Book 1']);
    expect(out.error).toBe(refusal);
  });
});

describe('bridgeRefusalKey and blockedReason', () => {
  const refusal = (code: string) => new ApiError(409, 'refused', code);

  it("names the Bridge's refusals in the app's words, else the fallback", () => {
    expect(bridgeRefusalKey(refusal('library_not_writable'), 'x.fallback')).toBe(
      'bridge.generate.notWritable',
    );
    expect(bridgeRefusalKey(refusal('kind_unavailable'), 'x.fallback')).toBe(
      'bridge.generate.unavailable',
    );
    expect(bridgeRefusalKey(refusal('detect_open'), 'x.fallback')).toBe(
      'bridge.generate.detectOpen',
    );
    expect(bridgeRefusalKey(new Error('offline'), 'x.fallback')).toBe('x.fallback');
  });

  // Bridge Phase 1d: while a chapters.detect job is queued or working the server refuses a
  // generate job (409 detect_open), and its estimate names that job as `open_job`.
  it("holds Generate back while the book's chapters are still being found", () => {
    const detect = bridgeJob({ kind: 'chapters.detect', state: 'running' });
    expect(
      blockedReason({ writable: true, agent_ready: true, figures: true, open_job: detect }),
    ).toBe('bridge.generate.detectOpen');
    // The book's own open generate job holds nothing back here (its status shows instead).
    expect(
      blockedReason({ writable: true, agent_ready: true, figures: true, open_job: bridgeJob() }),
    ).toBeNull();
    // A library it can't write is still the first reason.
    expect(
      blockedReason({ writable: false, agent_ready: true, figures: true, open_job: detect }),
    ).toBe('bridge.generate.notWritable');
  });

  it('holds Generate back for an unwritable library, then an agent known not ready', () => {
    expect(blockedReason({ writable: false, agent_ready: false, figures: true })).toBe(
      'bridge.generate.notWritable',
    );
    expect(blockedReason({ writable: true, agent_ready: false, figures: true })).toBe(
      'bridge.generate.agentNotReady',
    );
    expect(blockedReason({ writable: true, agent_ready: true, figures: true })).toBeNull();
  });

  // Without the Bridge's figures agent_ready is only a default: the server queues the job
  // anyway (it waits for the agent), so nothing is held back on a guess.
  it('holds nothing back on an agent readiness that is not known', () => {
    expect(blockedReason({ writable: true, agent_ready: false, figures: false })).toBeNull();
    expect(blockedReason({ writable: true, agent_ready: false })).toBeNull();
    expect(blockedReason({ writable: false, agent_ready: false })).toBe(
      'bridge.generate.notWritable',
    );
  });
});

describe('runEstimate (what the confirmation quotes)', () => {
  const earlier = [
    {
      library_id: 1,
      path: 'Saga/Book 1',
      title: 'Book 1',
      series_index: '1',
      asr_hours: 1.5,
      agent_cost_usd: 10,
    },
    {
      library_id: 1,
      path: 'Saga/Book 2',
      title: 'Book 2',
      series_index: '2',
      asr_hours: 1.25,
      agent_cost_usd: 8.5,
    },
  ];
  const estimate = bridgeEstimate({ path: 'Saga/Book 3', earlier });

  it('quotes every run the button queues: this book and the earlier ones', () => {
    expect(runEstimate(estimate, true)).toEqual({ books: 3, asrHours: 5.25, costUsd: 34.5 });
  });

  it('quotes this book alone with the switch off, and never counts it twice', () => {
    expect(runEstimate(estimate, false)).toEqual({ books: 1, asrHours: 2.5, costUsd: 16 });
    const self = { ...earlier[0], path: 'Saga/Book 3' };
    expect(runEstimate({ ...estimate, earlier: [self] }, true)).toEqual({
      books: 1,
      asrHours: 2.5,
      costUsd: 16,
    });
  });

  it('reads an audio book with no transcription figure as not known, never as none', () => {
    expect(runEstimate(bridgeEstimate({ asr_hours: 0 }), false).asrHours).toBeNull();
    expect(runEstimate(bridgeEstimate({ source: 'ebook', asr_hours: 0 }), false).asrHours).toBe(0);
    // An earlier book is read from its audio: one without a figure makes the whole unknown.
    const unknown = [{ ...earlier[0], asr_hours: 0 }];
    expect(runEstimate({ ...estimate, earlier: unknown }, true).asrHours).toBeNull();
  });

  it('has no cost estimate when any book has none', () => {
    expect(runEstimate(bridgeEstimate({ agent_cost_usd: null }), false).costUsd).toBeNull();
    const unknown = [{ ...earlier[0], agent_cost_usd: null }];
    expect(runEstimate({ ...estimate, earlier: unknown }, true).costUsd).toBeNull();
  });
});
