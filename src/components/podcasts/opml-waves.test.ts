import { ApiError } from '@/api/client';
import type { OpmlImportResult, OpmlImportRow, PodcastRequest } from '@/api/types';
import { golden2c3 } from '@/testing/podcast-fixtures-2c3';

import { mergeRows, OpmlWaves, type WaveState } from './opml-waves';

/** A row of the queue-cap golden's shape (`opml/queue-cap.opml`: seven new feeds, the
 * first an outline index 1). */
function row(i: number, status: string, over: Partial<OpmlImportRow> = {}): OpmlImportRow {
  return {
    outline_index: i,
    status,
    feed: 'https://feeds.example.org/...',
    private: false,
    path: null,
    request_id: status === 'queued' || status === 'already_queued' ? 100 + i : null,
    duplicate_of: null,
    error:
      status === 'limited'
        ? { code: 'too_many_requests', message: 'x' }
        : status === 'unavailable'
          ? { code: 'bridge_unavailable', message: 'x' }
          : null,
    ...over,
  };
}

const answer = (rows: OpmlImportRow[]): OpmlImportResult => ({ library_id: 7, rows });

function request(id: number, state: string): PodcastRequest {
  return {
    id,
    library_id: 7,
    state,
    feed: 'https://feeds.example.org/...',
    private: false,
    show_path: null,
    error: null,
    created_at: '2026-10-20T08:00:00Z',
    updated_at: '2026-10-20T08:00:00Z',
  };
}

/** The first wave of the queue-cap list: five queued, two limited. */
const WAVE_1 = [1, 2, 3, 4, 5]
  .map((i) => row(i, 'queued'))
  .concat([row(6, 'limited'), row(7, 'limited')]);
/** The second, once those ended: the five done ones followed, the last two queued. */
const WAVE_2 = [1, 2, 3, 4, 5]
  .map((i) => row(i, 'already_following', { path: `Show ${i}` }))
  .concat([row(6, 'queued'), row(7, 'queued')]);
/** The two merged: the five this import queued say followed, not "Already following"
 * (R-26: the second wave answers `already_following` for the shows the first one added). */
const MERGED = WAVE_2.map((r) =>
  r.status === 'already_following' ? { ...r, status: 'followed' } : r,
);

function setup(uploads: (OpmlImportResult | Error)[], requests: () => PodcastRequest[] = () => []) {
  const states: WaveState[] = [];
  const upload = jest.fn(async (_signal: AbortSignal): Promise<OpmlImportResult> => {
    const next = uploads.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  });
  const listRequests = jest.fn(async () => requests());
  const mayAct = jest.fn(() => true);
  const waves = new OpmlWaves({
    upload,
    listRequests,
    mayAct,
    onChange: (s) => states.push(s),
  });
  const last = () => states[states.length - 1];
  return { waves, upload, listRequests, mayAct, states, last };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-23T09:00:00Z'));
});
afterEach(() => jest.useRealTimers());

const flush = () => jest.advanceTimersByTimeAsync(0);

describe('mergeRows', () => {
  it('keeps every row by outline_index, the latest answer winning', () => {
    expect(mergeRows(WAVE_1, WAVE_2)).toEqual(MERGED);
    expect(mergeRows([row(3, 'limited')], [row(1, 'queued')]).map((r) => r.outline_index)).toEqual([
      1, 3,
    ]);
  });

  it('says followed for a show this import added, and already following only for one it did not (R-26)', () => {
    const first = [
      row(1, 'followed', { path: 'A' }),
      row(2, 'already_following'),
      row(3, 'limited'),
    ];
    const second = [
      row(1, 'already_following', { path: 'A' }),
      row(2, 'already_following'),
      row(3, 'already_following'),
    ];
    expect(mergeRows(first, second).map((r) => r.status)).toEqual([
      'followed',
      'already_following',
      'already_following',
    ]);
  });

  it('reads the import golden rows as they are', () => {
    expect(mergeRows([], golden2c3.importRows.rows)).toEqual(golden2c3.importRows.rows);
  });
});

describe('OpmlWaves', () => {
  it('runs the queue-cap list in two waves: after its requests end and 30 s', async () => {
    let open = true;
    const t = setup([answer(WAVE_1), answer(WAVE_2)], () =>
      [1, 2, 3, 4, 5].map((i) => request(100 + i, open ? 'running' : 'done')),
    );
    t.waves.start();
    await flush();
    expect(t.upload).toHaveBeenCalledTimes(1);
    expect(t.last().status).toEqual({ kind: 'waitingRequests' });
    expect(t.last().rows).toEqual(WAVE_1);

    // Polled every 5 s while its requests are open; nothing uploaded.
    await jest.advanceTimersByTimeAsync(40_000);
    expect(t.upload).toHaveBeenCalledTimes(1);
    expect(t.listRequests).toHaveBeenCalledTimes(9);

    open = false;
    await jest.advanceTimersByTimeAsync(5_000);
    expect(t.upload).toHaveBeenCalledTimes(2);
    expect(t.last()).toMatchObject({ status: { kind: 'done' }, rows: MERGED });

    // Done: nothing more is asked.
    const asked = t.listRequests.mock.calls.length;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(t.listRequests).toHaveBeenCalledTimes(asked);
    expect(t.upload).toHaveBeenCalledTimes(2);
  });

  it('waits out the 30 s spacing without polling once nothing is open', async () => {
    const t = setup([answer(WAVE_1), answer(WAVE_2)], () => []);
    t.waves.start();
    await flush();
    expect(t.listRequests).toHaveBeenCalledTimes(1);
    expect(t.last().status).toEqual({
      kind: 'waitingTime',
      at: Date.parse('2026-10-23T09:00:30Z'),
      why: 'spacing',
    });
    await jest.advanceTimersByTimeAsync(29_000);
    expect(t.upload).toHaveBeenCalledTimes(1);
    expect(t.listRequests).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.upload).toHaveBeenCalledTimes(2);
    expect(t.last().status.kind).toBe('done');
  });

  it('waits while five of the caller requests are open, from any import', async () => {
    let others = 5;
    const t = setup([answer(WAVE_1), answer(WAVE_2)], () =>
      Array.from({ length: others }, (_, i) => request(900 + i, 'queued')),
    );
    t.waves.start();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(t.upload).toHaveBeenCalledTimes(1);
    expect(t.last().status.kind).toBe('waitingRequests');
    others = 4;
    await jest.advanceTimersByTimeAsync(5_000);
    expect(t.upload).toHaveBeenCalledTimes(2);
  });

  it('is done after one wave when nothing is limited, also with unavailable rows', async () => {
    const t = setup([answer([row(1, 'queued'), row(2, 'unavailable'), row(3, 'invalid')])]);
    t.waves.start();
    await flush();
    expect(t.last().status.kind).toBe('done');
    await jest.advanceTimersByTimeAsync(120_000);
    expect(t.upload).toHaveBeenCalledTimes(1);
    expect(t.listRequests).not.toHaveBeenCalled();
  });

  it('stops when the limited rows turn unavailable (the Bridge went away): no loop', async () => {
    const t = setup([
      answer(WAVE_1),
      answer(
        [1, 2, 3, 4, 5]
          .map((i) => row(i, 'already_queued'))
          .concat([row(6, 'unavailable'), row(7, 'unavailable')]),
      ),
    ]);
    t.waves.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(t.upload).toHaveBeenCalledTimes(2);
    expect(t.last().status.kind).toBe('done');
    await jest.advanceTimersByTimeAsync(120_000);
    expect(t.upload).toHaveBeenCalledTimes(2);
  });

  it('lets Try again ask again for rows that could not be added, never a done one', async () => {
    const t = setup([
      answer([row(1, 'queued'), row(2, 'unavailable')]),
      answer([row(1, 'already_queued'), row(2, 'queued')]),
    ]);
    t.waves.start();
    await flush();
    expect(t.last().status.kind).toBe('done');
    t.waves.retry();
    await flush();
    expect(t.upload).toHaveBeenCalledTimes(2);
    expect(t.last().rows.map((r) => r.status)).toEqual(['already_queued', 'queued']);
    // Nothing is left that needs a person: Try again does nothing more.
    t.waves.retry();
    await flush();
    expect(t.upload).toHaveBeenCalledTimes(2);
  });

  it('stops as stalled when a wave moves no row out of limited, and Try again uploads', async () => {
    const t = setup([answer(WAVE_1), answer(WAVE_1), answer(WAVE_2)]);
    t.waves.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(t.upload).toHaveBeenCalledTimes(2);
    expect(t.last().status.kind).toBe('stalled');
    await jest.advanceTimersByTimeAsync(120_000);
    expect(t.upload).toHaveBeenCalledTimes(2);
    t.waves.retry();
    await flush();
    expect(t.upload).toHaveBeenCalledTimes(3);
    expect(t.last().status.kind).toBe('done');
  });

  it('honours Retry-After on 429 opml_rate_limited and 503 opml_busy', async () => {
    const t = setup([
      new ApiError(429, 'x', 'opml_rate_limited', 12),
      new ApiError(503, 'x', 'opml_busy', 1),
      answer([row(1, 'queued')]),
    ]);
    t.waves.start();
    await flush();
    // Its own limit (BRIDGE-08): an import can run about once every half minute.
    expect(t.last().status).toEqual({
      kind: 'waitingTime',
      at: Date.now() + 12_000,
      why: 'rateLimited',
    });
    await jest.advanceTimersByTimeAsync(11_999);
    expect(t.upload).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.upload).toHaveBeenCalledTimes(2);
    // The server's own load is busy, not the import's limit.
    expect(t.last().status).toMatchObject({ kind: 'waitingTime', why: 'busy' });
    await jest.advanceTimersByTimeAsync(999);
    expect(t.upload).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.upload).toHaveBeenCalledTimes(3);
    expect(t.last().status.kind).toBe('done');
  });

  it('falls back to 30 s and 2 s when Retry-After cannot be read', async () => {
    const t = setup([
      new ApiError(429, 'x', 'opml_rate_limited'),
      new ApiError(503, 'x', 'opml_busy'),
      answer([row(1, 'queued')]),
    ]);
    t.waves.start();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(t.upload).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.upload).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(t.upload).toHaveBeenCalledTimes(3);
  });

  it('stops after five busy answers in a row', async () => {
    const t = setup(Array.from({ length: 6 }, () => new ApiError(503, 'x', 'opml_busy', 1)));
    t.waves.start();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(t.upload).toHaveBeenCalledTimes(5);
    expect(t.last().status).toEqual({ kind: 'stopped', why: 'busy' });
  });

  it('fails on a refusal with its code, and on no answer with none', async () => {
    for (const [e, code] of [
      [new ApiError(400, 'x', 'invalid_opml'), 'invalid_opml'],
      [new ApiError(413, 'x', 'opml_limit'), 'opml_limit'],
      [new ApiError(415, 'x', 'unsupported_opml_type'), 'unsupported_opml_type'],
      [new ApiError(404, 'x', 'module_off'), 'module_off'],
      [new ApiError(403, 'x', 'no_library_access'), 'no_library_access'],
      [new ApiError(503, 'request timed out'), null],
      [new TypeError('Network request failed'), null],
    ] as const) {
      const t = setup([e]);
      t.waves.start();
      await flush();
      expect(t.last().status).toEqual({ kind: 'failed', code });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(t.upload).toHaveBeenCalledTimes(1);
    }
  });

  it('re-queues a failed private request with the next wave', async () => {
    const privateQueued = row(5, 'queued', { private: true, request_id: 81 });
    const t = setup(
      [
        answer([row(1, 'queued'), privateQueued, row(6, 'limited')]),
        answer([
          row(1, 'already_following'),
          row(5, 'queued', { private: true, request_id: 90 }),
          row(6, 'queued'),
        ]),
      ],
      () => [
        request(101, 'done'),
        { ...request(81, 'failed'), error: { code: 'request_expired', message: 'x' } },
      ],
    );
    t.waves.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(t.upload).toHaveBeenCalledTimes(2);
    expect(t.last().rows.find((r) => r.outline_index === 5)).toMatchObject({
      status: 'queued',
      request_id: 90,
    });
    expect(t.last().status.kind).toBe('done');
  });

  it('sends nothing more once stopped or disposed', async () => {
    const t = setup([answer(WAVE_1), answer(WAVE_2)]);
    t.waves.start();
    await flush();
    t.waves.stop();
    expect(t.last().status).toEqual({ kind: 'stopped', why: 'user' });
    await jest.advanceTimersByTimeAsync(120_000);
    expect(t.upload).toHaveBeenCalledTimes(1);

    const d = setup([answer(WAVE_1), answer(WAVE_2)]);
    d.waves.start();
    await flush();
    const told = d.states.length;
    d.waves.dispose();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(d.upload).toHaveBeenCalledTimes(1);
    expect(d.states).toHaveLength(told);
  });

  it('aborts an upload in flight when stopped, and ignores its answer', async () => {
    let signal: AbortSignal | undefined;
    let resolve: (r: OpmlImportResult) => void = () => {};
    const t = setup([]);
    t.upload.mockImplementationOnce(
      (s: AbortSignal): Promise<OpmlImportResult> =>
        new Promise((r) => {
          signal = s;
          resolve = r;
        }),
    );
    t.waves.start();
    await flush();
    t.waves.stop();
    expect(signal?.aborted).toBe(true);
    resolve(answer(WAVE_1));
    await flush();
    expect(t.last().status).toEqual({ kind: 'stopped', why: 'user' });
    expect(t.last().rows).toEqual([]);
  });

  it('pauses in the background and looks again at once on the way back', async () => {
    let open = true;
    const t = setup([answer(WAVE_1), answer(WAVE_2)], () =>
      open ? [request(101, 'running')] : [],
    );
    t.waves.start();
    await flush();
    const asked = t.listRequests.mock.calls.length;
    t.waves.pause();
    open = false;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(t.listRequests).toHaveBeenCalledTimes(asked);
    expect(t.upload).toHaveBeenCalledTimes(1);
    t.waves.resume();
    await flush();
    expect(t.listRequests).toHaveBeenCalledTimes(asked + 1);
    // Over 30 s since the last upload: the next wave goes at once.
    expect(t.upload).toHaveBeenCalledTimes(2);
    expect(t.last().status.kind).toBe('done');
  });

  it('asks whether it may still act before each upload', async () => {
    const t = setup([answer(WAVE_1), answer(WAVE_2)]);
    t.waves.start();
    await flush();
    t.mayAct.mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(t.upload).toHaveBeenCalledTimes(1);
    expect(t.last().status).toEqual({ kind: 'stopped', why: 'cantAct' });
  });
});
