import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { ApiError, TimeoutError, type ApiClient } from '@/api/client';
import type {
  ListeningEvent,
  ListeningSyncRequest,
  ListeningSyncResponse,
  ListeningSyncResult,
  Progress,
} from '@/api/types';

jest.mock('@/api/reachability', () => ({
  isReachable: jest.fn(() => true),
  noteFailure: jest.fn(),
  noteSuccess: jest.fn(),
}));
jest.mock('@/api/connection-clients', () => ({
  resolveClient: jest.fn(() => null),
  sessionReady: jest.fn(() => true),
}));
jest.mock('@/stores/session', () => ({ onConnectionRemoved: jest.fn(() => () => {}) }));
let mockCaps: Record<string, unknown> | undefined;
jest.mock('@/api/hooks', () => ({
  cachedCapability: (_cid: string, flag: string) => (mockCaps ? !!mockCaps[flag] : undefined),
  qk: {
    progress: (cid: string, lib: number, path: string) => ['progress', cid, lib, path],
    historyAll: (cid: string) => ['history', cid],
    server: (cid: string) => ['server', cid],
  },
}));
type CacheEvent = {
  type: string;
  query: { queryKey: readonly unknown[]; state: { data?: unknown } };
  action: { type: string; manual?: boolean };
};
const mockCacheListeners: ((e: CacheEvent) => void)[] = [];
jest.mock('@/api/provider', () => ({
  queryClient: {
    setQueryData: jest.fn(),
    invalidateQueries: jest.fn(async () => {}),
    getQueryCache: () => ({
      subscribe: (cb: (e: CacheEvent) => void) => {
        mockCacheListeners.push(cb);
        return () => {};
      },
    }),
  },
}));

/* eslint-disable import/first */
import { resolveClient } from '@/api/connection-clients';
import { queryClient } from '@/api/provider';
import * as reachability from '@/api/reachability';
import { onConnectionRemoved } from '@/stores/session';

import {
  appendEvents,
  clockSkewOf,
  closeSpan,
  eventIsFinite,
  COULD_NOT_SYNC_KEEP_MS,
  discardFailed,
  MAX_COULD_NOT_SYNC,
  fitKeepalive,
  flushOutbox,
  GIVE_UP_AGE_MS,
  LIVE_SPAN_MS,
  MAX_EVENT_SPAN_MS,
  keptMine,
  legacySavesOf,
  type OpenSpan,
  outboxEvents,
  recoverOpenSpan,
  refreshOutboxFrom,
  resetOutboxForTests,
  spanSaysSomething,
  spanToEvent,
  storedOpenSpan,
  storeOpenSpan,
  noteListeningSyncFlag,
  onOutboxChange,
  sendOnPageHide,
  syncStateOf,
  unsentListens,
  usesListeningSync,
  watchListeningFlags,
  withdrawFinish,
} from './listening-outbox';
import {
  ackVersion,
  getDeviceId,
  pendingSaves,
  readLocalPlaces,
  readMirror,
  writeMirror,
} from './progress-sync';
/* eslint-enable import/first */

const OUTBOX = 'audiosilo.listeningOutbox';
const OPEN_SPAN = 'audiosilo.listeningOpenSpan';
const SYNC = 'audiosilo.listeningSync';

// Both modules register a purge at import; the outbox's names its own keys.
const purges = (onConnectionRemoved as jest.Mock).mock.calls.map(
  (c) => c[0] as (id: string) => Promise<void>,
);

const span = (over: Partial<OpenSpan> = {}): OpenSpan => ({
  connectionId: 'c1',
  libraryId: 3,
  path: 'Author/Book',
  from: { pos: 14400, file: 'Author/Book/04.mp3', filePos: 812.4 },
  to: { pos: 16800, file: 'Author/Book/05.mp3', filePos: 1203.9 },
  duration: 61200,
  speed: 1.2,
  startedAt: '2026-10-25T07:00:12.000Z',
  endedAt: '2026-10-25T07:33:30.000Z',
  start: 'resume',
  baseVersion: 41,
  ...over,
});

const listen = (id: string, over: Partial<ListeningEvent> = {}): ListeningEvent =>
  ({ ...spanToEvent(span(), id), ...over }) as ListeningEvent;

/** A sync answer giving each sent event the status `status(event)`. */
function answer(
  body: ListeningSyncRequest,
  status: (e: ListeningEvent) => Partial<ListeningSyncResult> = () => ({ status: 'applied' }),
  progress: Progress[] = [],
): ListeningSyncResponse {
  return {
    server_time: '2026-10-25T07:41:03.480Z',
    results: body.events.map((e) => ({ id: e.id, status: 'applied', ...status(e) })),
    progress,
  };
}

type SyncFn = (body: ListeningSyncRequest, opts?: { keepalive?: boolean }) => Promise<unknown>;
function client(
  sync: SyncFn,
  serverInfo: () => Promise<unknown> = async () => ({ capabilities: {} }),
) {
  const c = {
    syncListening: jest.fn(sync),
    saveProgress: jest.fn(async () => ({})),
    getProgress: jest.fn(async (): Promise<unknown> => null),
    serverInfo: jest.fn(serverInfo),
  };
  (resolveClient as jest.Mock).mockImplementation((cid: string) =>
    cid === 'c1' ? (c as unknown as ApiClient) : null,
  );
  return c;
}

const sent = (c: { syncListening: jest.Mock }) =>
  c.syncListening.mock.calls.map((call) => call[0] as ListeningSyncRequest);

beforeEach(async () => {
  await AsyncStorage.clear();
  resetOutboxForTests();
  mockCaps = { listening_sync: true };
  (reachability.isReachable as jest.Mock).mockReturnValue(true);
  jest.clearAllMocks();
});

describe('spanToEvent', () => {
  it('sends both ends with their files, the fingerprint, the speed and the base', () => {
    expect(spanToEvent(span(), 'e1')).toEqual({
      id: 'e1',
      kind: 'listen',
      library_id: 3,
      path: 'Author/Book',
      from_pos: 14400,
      to_pos: 16800,
      from_file: 'Author/Book/04.mp3',
      from_file_pos: 812.4,
      to_file: 'Author/Book/05.mp3',
      to_file_pos: 1203.9,
      duration: 61200,
      playback_speed: 1.2,
      started_at: '2026-10-25T07:00:12.000Z',
      ended_at: '2026-10-25T07:33:30.000Z',
      start: 'resume',
      base_version: 41,
    });
  });

  it('leaves out a half file pair, speed 1, an unknown length and an unknown base', () => {
    const e = spanToEvent(
      span({
        from: { pos: 10 },
        to: { pos: 20, file: 'x.mp3' },
        speed: 1,
        duration: 0,
        baseVersion: undefined,
      }),
      'e2',
    );
    expect(e).not.toHaveProperty('from_file');
    expect(e).not.toHaveProperty('to_file');
    expect(e).not.toHaveProperty('playback_speed');
    expect(e).not.toHaveProperty('duration');
    expect(e).not.toHaveProperty('base_version');
  });

  it('ids are UUIDs (the server takes [A-Za-z0-9_-]{1,64})', () => {
    expect(spanToEvent(span()).id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('a span that moved nowhere says nothing unless it is a deliberate move', () => {
    const still = { endedAt: span().startedAt, to: span().from };
    expect(spanSaysSomething(span(still))).toBe(false);
    expect(spanSaysSomething(span({ ...still, start: 'continue' }))).toBe(false);
    expect(spanSaysSomething(span({ ...still, start: 'jump' }))).toBe(true);
    expect(spanSaysSomething(span({ ...still, start: 'restart' }))).toBe(true);
    expect(spanSaysSomething(span())).toBe(true);
  });
});

describe('the outbox', () => {
  it('appends closed spans in order and clears the stored open span', async () => {
    await storeOpenSpan(span());
    expect(await storedOpenSpan()).toEqual(span());
    await closeSpan(span(), listen('a') as never);
    await closeSpan(span({ start: 'continue' }));
    const events = await outboxEvents('c1');
    expect(events.map((e) => e.event.id)[0]).toBe('a');
    expect(events).toHaveLength(2);
    expect(events[1].event).toMatchObject({ start: 'continue' });
    expect(await storedOpenSpan()).toBeNull();
    // Durable: in storage, not only in memory.
    expect(JSON.parse((await AsyncStorage.getItem(OUTBOX))!)).toHaveLength(2);
  });

  it('a span a kill left open is closed at its last stored values on the next launch', async () => {
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify(span()));
    resetOutboxForTests();
    await recoverOpenSpan();
    const [entry] = await outboxEvents('c1');
    expect(entry.event).toMatchObject({ kind: 'listen', from_pos: 14400, to_pos: 16800 });
    expect(JSON.parse((await AsyncStorage.getItem(OPEN_SPAN))!)).toBeNull();
    // Once per launch: this launch's own span is never "recovered".
    await storeOpenSpan(span({ start: 'continue' }));
    await recoverOpenSpan();
    expect(await outboxEvents('c1')).toHaveLength(1);
  });

  it('a span goes on the base acknowledged when it closes, never below the one it opened on', async () => {
    const row = {
      library_id: 3,
      path: 'Author/Book',
      position: 0,
      duration: 61200,
      finished: false,
      playback_speed: 1,
      version: 42,
      device_id: 'other',
      updated_at: '2026-10-25T07:00:00.000Z',
    };
    // Closed before its open's read came back (0), then acknowledged meanwhile (42).
    await ackVersion('c1', 3, 'Author/Book', 42, row);
    await closeSpan(span({ baseVersion: 0 }));
    await closeSpan(span({ baseVersion: 50 }));
    const events = (await outboxEvents('c1')).map((e) => e.event);
    expect(events.map((e) => (e.kind === 'listen' ? e.base_version : null))).toEqual([42, 50]);
  });

  it('a stored outbox that could not be read is never written over', async () => {
    await AsyncStorage.setItem(
      OUTBOX,
      JSON.stringify([{ connectionId: 'c1', event: listen('old') }]),
    );
    resetOutboxForTests();
    const getItem = AsyncStorage.getItem as jest.Mock;
    const original = getItem.getMockImplementation()!;
    const storedIds = async () =>
      (JSON.parse((await original(OUTBOX)) as string) as { event: { id: string } }[]).map(
        (e) => e.event.id,
      );
    getItem.mockImplementation(async (key: string) => {
      if (key === OUTBOX) throw new Error('storage unavailable');
      return original(key);
    });
    try {
      await appendEvents('c1', [listen('new')]);
      // Kept in memory meanwhile; the stored one is as it was.
      expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['new']);
      expect(await storedIds()).toEqual(['old']);
    } finally {
      getItem.mockImplementation(original);
    }
    // Read once it can be: the stored events first, then this launch's, written together.
    await appendEvents('c1', [listen('newer')]);
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['old', 'new', 'newer']);
    expect(await storedIds()).toEqual(['old', 'new', 'newer']);
  });

  it('an event is immutable once a send was tried: a later span is a new event', async () => {
    await appendEvents('c1', [listen('a')]);
    client(async () => {
      throw new TypeError('Network request failed');
    });
    await flushOutbox('c1');
    await appendEvents('c1', [listen('b', { to_pos: 17000 } as Partial<ListeningEvent>)]);
    const events = (await outboxEvents('c1')).map((e) => e.event);
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(events[0]).toEqual(listen('a'));
    // A repeated id is not appended twice.
    await appendEvents('c1', [listen('a')]);
    expect(await outboxEvents('c1')).toHaveLength(2);
  });

  it('counts its listens and an open span offline as pending (the pill)', async () => {
    await appendEvents('c1', [listen('a'), listen('b')]);
    await appendEvents('c2', [listen('c')]);
    await storeOpenSpan(span());
    expect(await pendingSaves('c1')).toEqual({ saves: 0, listens: 2, events: 2 });
    (reachability.isReachable as jest.Mock).mockReturnValue(false);
    expect(await pendingSaves('c1')).toEqual({ saves: 0, listens: 3, events: 3 });
    expect(await pendingSaves()).toEqual({ saves: 0, listens: 4, events: 4 });
  });

  it('removing a connection purges its events, open span and sync state', async () => {
    await appendEvents('c1', [listen('a')]);
    await appendEvents('c2', [listen('b')]);
    await storeOpenSpan(span());
    await AsyncStorage.setItem(SYNC, JSON.stringify({ c1: { lastSyncAt: 'x' }, c2: {} }));
    for (const purge of purges) await purge('c1');
    expect((await outboxEvents()).map((e) => e.event.id)).toEqual(['b']);
    expect(await storedOpenSpan()).toBeNull();
    expect(Object.keys(JSON.parse((await AsyncStorage.getItem(SYNC))!))).toEqual(['c2']);
  });
});

describe('flushOutbox', () => {
  it('sends a fresh sent_at per attempt and the device id', async () => {
    await appendEvents('c1', [listen('a')]);
    let fail = true;
    const c = client(async (body) => {
      if (fail) throw new TypeError('Network request failed');
      return answer(body);
    });
    jest.useFakeTimers({ now: new Date('2026-10-25T08:00:00.000Z') });
    try {
      await flushOutbox('c1');
      jest.setSystemTime(new Date('2026-10-25T09:30:00.000Z'));
      fail = false;
      await flushOutbox('c1');
    } finally {
      jest.useRealTimers();
    }
    const [first, second] = sent(c);
    expect(first.sent_at).toBe('2026-10-25T08:00:00.000Z');
    expect(second.sent_at).toBe('2026-10-25T09:30:00.000Z');
    expect(second.device_id).toBe(await getDeviceId());
    expect(second).not.toHaveProperty('clock_offset');
    expect(await outboxEvents('c1')).toEqual([]);
  });

  it('keeps everything on a network error (a check, not a down mark) and on a 5xx', async () => {
    await appendEvents('c1', [listen('a')]);
    client(async () => {
      throw new TypeError('Network request failed');
    });
    await flushOutbox('c1');
    expect(reachability.noteFailure).toHaveBeenCalledWith('c1', expect.any(TypeError));
    client(async () => {
      throw new ApiError(503, 'unavailable');
    });
    await flushOutbox('c1');
    expect(await outboxEvents('c1')).toHaveLength(1);
  });

  it('sends in chunks of 200, round after round', async () => {
    await appendEvents(
      'c1',
      Array.from({ length: 450 }, (_, i) => listen(`e${i}`)),
    );
    const c = client(async (body) => answer(body));
    await flushOutbox('c1');
    expect(sent(c).map((b) => b.events.length)).toEqual([200, 200, 50]);
    expect(sent(c)[1].events[0].id).toBe('e200');
    expect(await outboxEvents('c1')).toEqual([]);
  });

  it('halves the chunk on a 413 or too_many_events', async () => {
    await appendEvents(
      'c1',
      Array.from({ length: 300 }, (_, i) => listen(`e${i}`)),
    );
    let calls = 0;
    const c = client(async (body) => {
      calls++;
      if (calls === 1) throw new ApiError(413, 'too large');
      if (calls === 2) throw new ApiError(400, 'too many events', 'too_many_events');
      return answer(body);
    });
    await flushOutbox('c1');
    expect(sent(c).map((b) => b.events.length)).toEqual([200, 100, 50, 50, 50, 50, 50, 50]);
    expect(await outboxEvents('c1')).toEqual([]);
  });

  it('a 400 on a batch resends one by one once; one still refused alone moves to the list', async () => {
    await appendEvents('c1', [listen('good'), listen('bad'), listen('also-good')]);
    const c = client(async (body) => {
      if (body.events.length > 1 || body.events[0].id === 'bad') {
        throw new ApiError(400, 'invalid request');
      }
      return answer(body);
    });
    await flushOutbox('c1');
    expect(sent(c).map((b) => b.events.map((e) => e.id))).toEqual([
      ['good', 'bad', 'also-good'],
      ['good'],
      ['bad'],
      ['also-good'],
    ]);
    expect(await outboxEvents('c1')).toEqual([]);
    const state = await syncStateOf('c1');
    expect(state.failed?.map((f) => [f.event.id, f.reason])).toEqual([['bad', 'invalid']]);
  });

  it("every status but rejected removes the event; rejected moves to the couldn't-sync list", async () => {
    const statuses: Record<string, Partial<ListeningSyncResult>> = {
      a: { status: 'applied' },
      b: { status: 'duplicate' },
      c: { status: 'diverged', kept: 'stored' },
      d: { status: 'not_applied', reason: 'resume_behind' },
      e: { status: 'rejected', reason: 'duration_mismatch' },
    };
    await appendEvents(
      'c1',
      Object.keys(statuses).map((id) => listen(id)),
    );
    client(async (body) => answer(body, (e) => statuses[e.id]));
    await flushOutbox('c1');
    expect(await outboxEvents('c1')).toEqual([]);
    const state = await syncStateOf('c1');
    expect(state.failed?.map((f) => [f.event.id, f.reason])).toEqual([['e', 'duration_mismatch']]);
    expect(state.lastSyncAt).toEqual(expect.any(String));
    // Discard takes it off the list.
    await discardFailed('c1', 'e');
    expect((await syncStateOf('c1')).failed).toEqual([]);
  });

  it("keeps the newest MAX_COULD_NOT_SYNC on the couldn't-sync list", async () => {
    const count = MAX_COULD_NOT_SYNC + 50;
    await appendEvents(
      'c1',
      Array.from({ length: count }, (_, i) => listen(`r${i}`)),
    );
    client(async (body) => answer(body, () => ({ status: 'rejected', reason: 'not_found' })));
    await flushOutbox('c1');
    const failed = (await syncStateOf('c1')).failed ?? [];
    expect(failed).toHaveLength(MAX_COULD_NOT_SYNC);
    expect(failed[failed.length - 1].event.id).toBe(`r${count - 1}`);
    expect(await outboxEvents('c1')).toEqual([]);
  });

  it("keeps a couldn't-sync entry 30 days", async () => {
    const at = '2026-10-01T00:00:00.000Z';
    await AsyncStorage.setItem(
      SYNC,
      JSON.stringify({ c1: { failed: [{ event: listen('old'), reason: 'too_old', at }] } }),
    );
    expect((await syncStateOf('c1', Date.parse(at) + 1000)).failed).toHaveLength(1);
    expect(await syncStateOf('c1', Date.parse(at) + COULD_NOT_SYNC_KEEP_MS)).toEqual({
      failed: [],
    });
  });

  it("puts the answer's rows in the cache and acknowledges a row that kept this device's event", async () => {
    const deviceId = await getDeviceId();
    await appendEvents('c1', [listen('a')]);
    const row: Progress = {
      library_id: 3,
      path: 'Author/Book',
      position: 16800,
      duration: 61200,
      finished: false,
      playback_speed: 1.2,
      version: 42,
      device_id: deviceId,
      updated_at: '2026-10-25T07:33:30.000Z',
    };
    client(async (body) => answer(body, () => ({ status: 'applied' }), [row]));
    await flushOutbox('c1');
    expect(queryClient.setQueryData).toHaveBeenCalledWith(
      ['progress', 'c1', 3, 'Author/Book'],
      row,
    );
    expect((await readMirror('c1', 3, 'Author/Book'))?.ack_version).toBe(42);
  });

  it('acknowledges the row an unfinish of a book another device finished hands this device', async () => {
    // The server's unfinish of a finished row takes it for this device (server 0b7ce0f).
    const deviceId = await getDeviceId();
    const unfinish = {
      id: 'u',
      kind: 'unfinish',
      library_id: 3,
      path: 'Author/Book',
      at: '2026-10-25T08:00:00.000Z',
      base_version: 9,
    } as ListeningEvent;
    await appendEvents('c1', [unfinish]);
    const row: Progress = {
      library_id: 3,
      path: 'Author/Book',
      position: 61200,
      duration: 61200,
      finished: false,
      playback_speed: 1,
      version: 10,
      device_id: deviceId,
      updated_at: '2026-10-25T08:00:00.000Z',
    };
    client(async (body) => answer(body, () => ({ status: 'applied' }), [row]));
    await flushOutbox('c1');
    expect((await readMirror('c1', 3, 'Author/Book'))?.ack_version).toBe(10);
  });

  it('one flush in flight per connection; a call meanwhile makes it go round again', async () => {
    await appendEvents('c1', [listen('a')]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const c = client(async (body) => {
      await gate;
      return answer(body);
    });
    const first = flushOutbox('c1');
    while (c.syncListening.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 0));
    await appendEvents('c1', [listen('b')]);
    const second = flushOutbox('c1');
    await new Promise((r) => setTimeout(r, 0));
    expect(c.syncListening).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(sent(c).map((b) => b.events.map((e) => e.id))).toEqual([['a'], ['b']]);
  });

  // fe#208: an Undo's progress edit must not be followed by the finish it undoes.
  describe("withdrawFinish (before an Undo's edit)", () => {
    const finish = (id: string, path = 'Author/Book') =>
      ({
        id,
        kind: 'finish',
        library_id: 3,
        path,
        at: '2026-10-25T08:00:00.000Z',
      }) as ListeningEvent;
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it("takes the book's waiting finish back (only it); the restore sends it after all", async () => {
      await appendEvents('c1', [listen('a'), finish('f'), finish('g', 'Other/Book')]);
      const { unsent, restore } = await withdrawFinish('c1', 3, 'Author/Book');
      expect(unsent).toBe(true);
      expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['a', 'g']);
      const c = client(async (body) => answer(body));
      await flushOutbox('c1');
      expect(sent(c).flatMap((b) => b.events.map((e) => e.id))).toEqual(['a', 'g']);
      await restore();
      await flushOutbox('c1');
      expect(
        sent(c)
          .at(-1)
          ?.events.map((e) => e.id),
      ).toEqual(['f']);
    });

    it('a finish being sent is waited for: the withdrawal ends after its answer', async () => {
      await appendEvents('c1', [finish('f')]);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const c = client(async (body) => {
        await gate;
        return answer(body);
      });
      const flushing = flushOutbox('c1');
      while (c.syncListening.mock.calls.length === 0) await tick();
      let done = false;
      const withdrawing = withdrawFinish('c1', 3, 'Author/Book').then((w) => {
        done = true;
        return w;
      });
      await tick();
      expect(done).toBe(false);
      release();
      const [, taken] = await Promise.all([flushing, withdrawing]);
      expect(await outboxEvents('c1')).toEqual([]);
      // The server has it: the Undo needs its edit.
      expect(taken.unsent).toBe(false);
    });

    it('one finish answered while another waited: the Undo still needs its edit', async () => {
      await appendEvents('c1', [finish('f')]);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const c = client(async (body) => {
        await gate;
        return answer(body);
      });
      const flushing = flushOutbox('c1');
      while (c.syncListening.mock.calls.length === 0) await tick();
      await appendEvents('c1', [finish('g')]);
      const withdrawing = withdrawFinish('c1', 3, 'Author/Book');
      await tick();
      release();
      const [, taken] = await Promise.all([flushing, withdrawing]);
      expect(await outboxEvents('c1')).toEqual([]);
      expect(taken.unsent).toBe(false);
    });

    it("a rollback's PUT of the finish is waited for too", async () => {
      await appendEvents('c1', [finish('f')]);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const c = client(async () => {
        throw new ApiError(404, 'not found');
      });
      c.saveProgress.mockImplementation(async () => {
        await gate;
        return {};
      });
      const flushing = flushOutbox('c1');
      while (c.saveProgress.mock.calls.length === 0) await tick();
      let done = false;
      const withdrawing = withdrawFinish('c1', 3, 'Author/Book').then(() => (done = true));
      await tick();
      expect(done).toBe(false);
      release();
      await Promise.all([flushing, withdrawing]);
      expect(await outboxEvents('c1')).toEqual([]);
    });

    // The lost answer: the request arrived, the server finished the book, and the answer
    // never came back. Counted as unsent, the Undo was done on this device alone and the
    // book stayed finished on the server.
    it('a finish whose send got no answer may be on the server: the Undo needs its edit', async () => {
      await appendEvents('c1', [finish('f')]);
      let fail: (e: Error) => void = () => {};
      const c = client(() => new Promise((_r, reject) => (fail = reject)));
      const flushing = flushOutbox('c1');
      while (c.syncListening.mock.calls.length === 0) await tick();
      const withdrawing = withdrawFinish('c1', 3, 'Author/Book');
      fail(new TypeError('Failed to fetch'));
      const [, taken] = await Promise.all([flushing, withdrawing]);
      expect(taken.unsent).toBe(false);
      // Taken back all the same: sent while the edit is out, it could land after it.
      expect(await outboxEvents('c1')).toEqual([]);
      await flushOutbox('c1');
      expect(c.syncListening).toHaveBeenCalledTimes(1);
    });

    it('an edit that failed puts that finish back: sent again, the book finished on both sides', async () => {
      await appendEvents('c1', [finish('f')]);
      let lost = true;
      const c = client(async (body) => {
        if (lost) throw new TimeoutError(15000);
        return answer(body);
      });
      await flushOutbox('c1');
      const taken = await withdrawFinish('c1', 3, 'Author/Book');
      expect(taken.unsent).toBe(false);
      lost = false;
      await taken.restore();
      await flushOutbox('c1');
      expect(sent(c).map((b) => b.events.map((e) => e.id))).toEqual([['f'], ['f']]);
      expect(await outboxEvents('c1')).toEqual([]);
    });

    it('a gateway that gave up waiting (504) is no answer from the server either', async () => {
      await appendEvents('c1', [finish('f')]);
      client(async () => {
        throw new ApiError(504, 'gateway timeout');
      });
      await flushOutbox('c1');
      expect((await withdrawFinish('c1', 3, 'Author/Book')).unsent).toBe(false);
    });

    // A proxy whose server broke off after storing the batch (502, Cloudflare's 520), a
    // Cloudflare timeout (524), and a 2xx whose body could not be read (an `ApiError` with
    // its status).
    it.each([502, 520, 524, 200])(
      'a %i is no answer from the server either: it may hold the finish',
      async (status) => {
        await appendEvents('c1', [finish('f')]);
        client(async () => {
          throw new ApiError(status, 'no answer');
        });
        await flushOutbox('c1');
        expect((await withdrawFinish('c1', 3, 'Author/Book')).unsent).toBe(false);
      },
    );

    it('the server down by the Undo: no edit can be made, so it is undone here', async () => {
      await appendEvents('c1', [finish('f')]);
      client(async () => {
        throw new TypeError('Failed to fetch');
      });
      await flushOutbox('c1');
      // The check that follows a request with no answer marked the server down.
      (reachability.isReachable as jest.Mock).mockReturnValue(false);
      try {
        const taken = await withdrawFinish('c1', 3, 'Author/Book');
        expect(taken.unsent).toBe(true);
        expect(await outboxEvents('c1')).toEqual([]);
      } finally {
        (reachability.isReachable as jest.Mock).mockReturnValue(true);
      }
    });

    it('a finish whose send could not leave (its server marked down) is unsent', async () => {
      await appendEvents('c1', [finish('f')]);
      const c = client(async () => {
        throw new TypeError('Failed to fetch');
      });
      (reachability.isReachable as jest.Mock).mockReturnValue(false);
      try {
        await flushOutbox('c1');
      } finally {
        (reachability.isReachable as jest.Mock).mockReturnValue(true);
      }
      // Back since: the finish still never left this device.
      const taken = await withdrawFinish('c1', 3, 'Author/Book');
      expect(taken.unsent).toBe(true);
      expect(await outboxEvents('c1')).toEqual([]);
      await flushOutbox('c1');
      expect(c.syncListening).toHaveBeenCalledTimes(1);
    });

    it('a finish the server refused (an HTTP error is its answer) is unsent', async () => {
      await appendEvents('c1', [finish('f')]);
      client(async () => {
        throw new ApiError(503, 'unavailable');
      });
      await flushOutbox('c1');
      const taken = await withdrawFinish('c1', 3, 'Author/Book');
      expect(taken.unsent).toBe(true);
      expect(await outboxEvents('c1')).toEqual([]);
    });

    it('a finish the page sent as it went may be on the server (its answer may never be seen)', async () => {
      await appendEvents('c1', [finish('f')]);
      client(() => new Promise(() => {}));
      sendOnPageHide([], 'dev');
      expect((await withdrawFinish('c1', 3, 'Author/Book')).unsent).toBe(false);
    });
  });

  it('a 404/405 from anything but the rolled-back server keeps the outbox', async () => {
    await appendEvents('c1', [listen('a')]);
    // Another host at the address (its `/server` is no AudioSilo answer), or the server
    // itself still saying it takes listening events.
    for (const serverInfo of [
      async () => {
        throw new ApiError(404, 'not found');
      },
      async () => ({ capabilities: { listening_sync: true } }),
    ]) {
      const c = client(async () => {
        throw new ApiError(404, 'not found');
      }, serverInfo);
      await flushOutbox('c1');
      expect(c.serverInfo).toHaveBeenCalled();
      expect(c.saveProgress).not.toHaveBeenCalled();
      expect(await outboxEvents('c1')).toHaveLength(1);
      expect(usesListeningSync('c1')).toBe(true);
    }
  });

  it('a 404/405 (server rolled back) turns the outbox into one legacy save per book', async () => {
    const finish = {
      id: 'f',
      kind: 'finish',
      library_id: 3,
      path: 'Author/Book',
      at: '2026-10-25T08:00:00.000Z',
    } as ListeningEvent;
    await appendEvents('c1', [listen('a'), finish]);
    const c = client(async () => {
      throw new ApiError(404, 'not found');
    });
    expect(usesListeningSync('c1')).toBe(true);
    await flushOutbox('c1');
    expect(await outboxEvents('c1')).toEqual([]);
    expect(c.saveProgress).toHaveBeenCalledTimes(1);
    expect(c.saveProgress).toHaveBeenCalledWith(
      3,
      'Author/Book',
      expect.objectContaining({
        position: 61200,
        finished: true,
        updated_at: '2026-10-25T08:00:00.000Z',
      }),
    );
    // From now on this connection saves by PUT, and its capability is read again.
    expect(usesListeningSync('c1')).toBe(false);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['server', 'c1'] });
  });

  it("a rolled-back Mark as finished (no listen) is PUT at the book's end with its length", async () => {
    // The finish wrote this device's mirror (finishedSave) as it was queued.
    await writeMirror({
      connectionId: 'c1',
      libraryId: 3,
      path: 'Author/Book',
      position: 61200,
      duration: 61200,
      finished: true,
      playback_speed: 1.5,
      device_id: 'dev-1',
      updated_at: '2026-10-25T08:00:00.000Z',
    });
    await appendEvents('c1', [
      {
        id: 'f',
        kind: 'finish',
        library_id: 3,
        path: 'Author/Book',
        at: '2026-10-25T08:00:00.000Z',
      } as ListeningEvent,
    ]);
    const c = client(async () => {
      throw new ApiError(404, 'not found');
    });
    await flushOutbox('c1');
    expect(c.saveProgress).toHaveBeenCalledTimes(1);
    expect(c.saveProgress).toHaveBeenCalledWith(
      3,
      'Author/Book',
      expect.objectContaining({
        position: 61200,
        duration: 61200,
        finished: true,
        playback_speed: 1.5,
        updated_at: '2026-10-25T08:00:00.000Z',
      }),
    );
    expect(await outboxEvents('c1')).toEqual([]);
  });

  it("a rolled-back listen is held by another device's further place (the replay guard)", async () => {
    await appendEvents('c1', [listen('a')]);
    const c = client(async () => {
      throw new ApiError(404, 'not found');
    });
    c.getProgress.mockResolvedValue({
      library_id: 3,
      path: 'Author/Book',
      position: 20000,
      duration: 61200,
      finished: false,
      version: 7,
      device_id: 'other-device',
      updated_at: '2026-10-25T09:00:00.000Z',
    });
    await flushOutbox('c1');
    expect(c.getProgress).toHaveBeenCalledWith(3, 'Author/Book');
    expect(c.saveProgress).not.toHaveBeenCalled();
    expect(await outboxEvents('c1')).toEqual([]);
  });

  it('unsentListens sends once more while reachable, else only counts', async () => {
    await appendEvents('c1', [listen('a')]);
    (reachability.isReachable as jest.Mock).mockReturnValue(false);
    const c = client(async (body) => answer(body));
    expect(await unsentListens('c1')).toBe(1);
    expect(c.syncListening).not.toHaveBeenCalled();
    (reachability.isReachable as jest.Mock).mockReturnValue(true);
    expect(await unsentListens('c1')).toBe(0);
  });
});

describe('usesListeningSync', () => {
  it('follows the cached /server; unknown records events (the outbox), W2 F3', () => {
    mockCaps = { listening_sync: true };
    expect(usesListeningSync('c1')).toBe(true);
    mockCaps = { listening_sync: false };
    expect(usesListeningSync('c1')).toBe(false);
    mockCaps = {};
    expect(usesListeningSync('c1')).toBe(false);
    mockCaps = undefined; // unknown: events wait in the outbox (a 404 turns them into PUTs)
    expect(usesListeningSync('c1')).toBe(true);
  });
});

// W2 F3: after an offline cold launch the query cache is empty, and the PUT path took over.
describe("a connection's listening_sync across launches", () => {
  const storedFlag = async (cid: string) =>
    (
      JSON.parse((await AsyncStorage.getItem(SYNC)) ?? '{}') as Record<
        string,
        { listeningSync?: boolean }
      >
    )[cid]?.listeningSync;
  const serverAnswer = (cid: string, listening_sync: boolean, manual = false) => {
    for (const cb of mockCacheListeners) {
      cb({
        type: 'updated',
        query: { queryKey: ['server', cid], state: { data: { capabilities: { listening_sync } } } },
        action: { type: 'success', manual },
      });
    }
  };

  it("keeps the flag its server answered, and a cold launch reads it before the server's answer", async () => {
    watchListeningFlags();
    serverAnswer('c1', true);
    await settleState();
    expect(await storedFlag('c1')).toBe(true);
    // A cold launch: nothing cached, and the kept flag wins over a seeded copy saying no.
    resetOutboxForTests();
    mockCaps = { listening_sync: false };
    watchListeningFlags();
    await settleState();
    expect(usesListeningSync('c1')).toBe(true);
  });

  it('a server that says no now is the PUT path, kept too', async () => {
    noteListeningSyncFlag('c1', true);
    watchListeningFlags();
    serverAnswer('c1', false);
    await settleState();
    expect(usesListeningSync('c1')).toBe(false);
    expect(await storedFlag('c1')).toBe(false);
    resetOutboxForTests();
    mockCaps = undefined;
    watchListeningFlags();
    await settleState();
    expect(usesListeningSync('c1')).toBe(false);
  });

  it('a copy seeded into the cache (setQueryData) says nothing', async () => {
    watchListeningFlags();
    serverAnswer('c1', false, true);
    await settleState();
    expect(await storedFlag('c1')).toBeUndefined();
  });

  it('a sync answer keeps yes; a confirmed rollback keeps no', async () => {
    await appendEvents('c1', [listen('a')]);
    client(async (body) => answer(body));
    await flushOutbox('c1');
    expect(await storedFlag('c1')).toBe(true);
    await appendEvents('c1', [listen('b')]);
    client(
      async () => {
        throw new ApiError(404, 'not found');
      },
      async () => ({ capabilities: {} }),
    );
    await flushOutbox('c1');
    await settleState();
    expect(await storedFlag('c1')).toBe(false);
  });

  it('events recorded while the flag is unknown wait in the outbox and go by sync', async () => {
    mockCaps = undefined;
    expect(usesListeningSync('c1')).toBe(true);
    await appendEvents('c1', [listen('offline')]);
    const c = client(async (body) => answer(body));
    await flushOutbox('c1');
    expect(sent(c).flatMap((b) => b.events.map((e) => e.id))).toEqual(['offline']);
  });
});

/** Let the sync state's queued writes land. */
async function settleState() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe('legacySavesOf', () => {
  it('the newest listen end per book; finished only by a finish not older than it', () => {
    const later = listen('b', {
      to_pos: 20000,
      ended_at: '2026-10-25T09:00:00.000Z',
    } as Partial<ListeningEvent>);
    const unfinish = {
      id: 'u',
      kind: 'unfinish',
      library_id: 3,
      path: 'Author/Book',
      at: '2026-10-25T08:30:00.000Z',
    } as ListeningEvent;
    const other = listen('c', { path: 'Other/Book', to_pos: 50 } as Partial<ListeningEvent>);
    const saves = legacySavesOf(
      'c1',
      [listen('a'), unfinish, later, other].map((event) => ({ connectionId: 'c1', event })),
      'dev',
    );
    expect(saves).toEqual([
      {
        connectionId: 'c1',
        libraryId: 3,
        path: 'Author/Book',
        position: 20000,
        duration: 61200,
        finished: false,
        playback_speed: 1.2,
        device_id: 'dev',
        updated_at: '2026-10-25T09:00:00.000Z',
      },
      expect.objectContaining({ path: 'Other/Book', position: 50, finished: false }),
    ]);
  });
});

describe('keptMine (the ack rule)', () => {
  const row = { library_id: 3, path: 'Author/Book', device_id: 'me' };
  const events = [listen('a')];
  const results = (r: Partial<ListeningSyncResult>) =>
    new Map([['a', { id: 'a', status: 'applied', ...r } as ListeningSyncResult]]);

  it("acknowledges the row only when it is this device's and kept this device's event", () => {
    expect(keptMine(row, 'me', events, results({ status: 'applied' }))).toBe(true);
    expect(keptMine(row, 'me', events, results({ status: 'diverged', kept: 'event' }))).toBe(true);
    expect(keptMine(row, 'me', events, results({ status: 'diverged', kept: 'stored' }))).toBe(
      false,
    );
    expect(keptMine(row, 'me', events, results({ status: 'not_applied' }))).toBe(false);
    expect(keptMine({ ...row, device_id: 'other' }, 'me', events, results({}))).toBe(false);
    expect(keptMine({ ...row, path: 'Else' }, 'me', events, results({}))).toBe(false);
  });
});

describe('fitKeepalive', () => {
  it('takes the oldest events that fit in the keepalive limit', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      connectionId: 'c1',
      event: listen(`e${i}`),
    }));
    const one = JSON.stringify(entries[0].event).length + 1;
    expect(fitKeepalive(entries, 200 + one * 3)).toHaveLength(3);
    expect(fitKeepalive(entries)).toHaveLength(10);
  });
});

describe('a place that is not a number', () => {
  it('is never enqueued', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(eventIsFinite(listen('a'))).toBe(true);
    expect(eventIsFinite(listen('b', { to_pos: Number.NaN } as Partial<ListeningEvent>))).toBe(
      false,
    );
    expect(eventIsFinite(listen('c', { from_file_pos: Infinity } as Partial<ListeningEvent>))).toBe(
      false,
    );
    await appendEvents('c1', [
      listen('a'),
      listen('b', { to_pos: Number.NaN } as Partial<ListeningEvent>),
    ]);
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['a']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a stored open span without a place is not recovered', async () => {
    // JSON keeps NaN as null.
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify(span({ to: { pos: Number.NaN } })));
    resetOutboxForTests();
    await recoverOpenSpan();
    expect(await outboxEvents('c1')).toEqual([]);
  });
});

describe('several web tabs share the outbox', () => {
  // Node has Web Locks of its own (a getter on the prototype): shadow it to see the lock taken.
  const nav = globalThis.navigator as { locks?: unknown };
  let held: string[] = [];
  beforeEach(() => {
    held = [];
    Object.defineProperty(nav, 'locks', {
      configurable: true,
      value: {
        request: async (name: string, job: () => Promise<unknown>) => {
          held.push(name);
          return job();
        },
      },
    });
  });
  afterEach(() => {
    delete nav.locks;
  });

  it("re-reads the stored outbox under the shared lock, so another tab's events stay", async () => {
    await appendEvents('c1', [listen('mine')]);
    // Another tab adds an event to storage after this tab read it.
    const stored = JSON.parse((await AsyncStorage.getItem(OUTBOX))!) as unknown[];
    await AsyncStorage.setItem(
      OUTBOX,
      JSON.stringify([...stored, { connectionId: 'c1', event: listen('theirs') }]),
    );
    await appendEvents('c1', [listen('mine-2')]);
    const ids = (
      JSON.parse((await AsyncStorage.getItem(OUTBOX))!) as { event: { id: string } }[]
    ).map((e) => e.event.id);
    expect(ids).toEqual(['mine', 'theirs', 'mine-2']);
    expect(held.every((n) => n === OUTBOX)).toBe(true);
    expect(held.length).toBeGreaterThan(0);
  });

  it("another tab's send (removal) is not written back", async () => {
    await appendEvents('c1', [listen('a'), listen('b')]);
    // Another tab sent 'a' and wrote the outbox without it.
    await AsyncStorage.setItem(
      OUTBOX,
      JSON.stringify([{ connectionId: 'c1', event: listen('b') }]),
    );
    await appendEvents('c1', [listen('c')]);
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['b', 'c']);
  });

  it('keeps an event storage could not take, though the next read is from storage', async () => {
    await appendEvents('c1', [listen('a')]);
    // One write fails (a full storage); `Once` puts the mock back as it was.
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('quota'));
    await appendEvents('c1', [listen('b')]);
    await appendEvents('c1', [listen('c')]);
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['a', 'b', 'c']);
    const ids = (
      JSON.parse((await AsyncStorage.getItem(OUTBOX))!) as { event: { id: string } }[]
    ).map((e) => e.event.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it("follows another tab's change through the storage event", async () => {
    await appendEvents('c1', [listen('a')]);
    refreshOutboxFrom(JSON.stringify([]));
    expect(await outboxEvents('c1')).toEqual([]);
    refreshOutboxFrom(JSON.stringify([{ connectionId: 'c1', event: listen('x') }]));
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['x']);
    // Garbage leaves the copy as it was.
    refreshOutboxFrom('{not json');
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['x']);
  });
});

// fe#208 and W2 F1.
describe('a span is one event, however often it is closed', () => {
  it('takes the id it was given when it opened', () => {
    expect(spanToEvent(span({ id: 'span-1' })).id).toBe('span-1');
  });

  it('a span recovered after its close was written goes once (a kill before the clear)', async () => {
    const s = span({ id: 'span-2' });
    await closeSpan(s);
    // The stored copy was not cleared (a kill between the outbox write and the clear).
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify(s));
    resetOutboxForTests();
    await recoverOpenSpan();
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['span-2']);
  });
});

describe('a span whose timers stood still', () => {
  it('never claims more than MAX_EVENT_SPAN_MS of wall clock (the server refuses 24 h)', () => {
    const long = span({
      startedAt: '2026-10-20T07:00:00.000Z',
      endedAt: '2026-10-22T07:00:00.000Z',
      from: { pos: 100 },
      to: { pos: 1300 },
      speed: 1.5,
    });
    const event = spanToEvent(long);
    expect(event.ended_at).toBe('2026-10-22T07:00:00.000Z');
    // 1200 s of audio at 1.5x took 800 s to play.
    expect(Date.parse(event.ended_at) - Date.parse(event.started_at)).toBe(800_000);
    // One that covered more than the bound keeps the bound.
    const most = spanToEvent({ ...long, to: { pos: 400_000 }, speed: 1 });
    expect(Date.parse(most.ended_at) - Date.parse(most.started_at)).toBe(MAX_EVENT_SPAN_MS);
    // An ordinary span is untouched.
    expect(spanToEvent(span()).started_at).toBe(span().startedAt);
  });
});

describe('giving up', () => {
  it(`moves an event older than ${GIVE_UP_AGE_MS / 86_400_000} days to the list unsent (too_old)`, async () => {
    const old = new Date(Date.now() - GIVE_UP_AGE_MS - 60_000).toISOString();
    await appendEvents('c1', [
      listen('old', { started_at: old, ended_at: old } as Partial<ListeningEvent>),
      { id: 'old-finish', kind: 'finish', library_id: 3, path: 'Author/Book', at: old },
      listen('new'),
    ]);
    const c = client(async (body) => answer(body));
    await flushOutbox('c1');
    expect(sent(c).flatMap((b) => b.events.map((e) => e.id))).toEqual(['new']);
    expect((await syncStateOf('c1')).failed?.map((f) => [f.event.id, f.reason])).toEqual([
      ['old', 'too_old'],
      ['old-finish', 'too_old'],
    ]);
    expect(await outboxEvents('c1')).toEqual([]);
  });

  it('a single event the server still finds too big goes to the list as too_large', async () => {
    await appendEvents('c1', [listen('big')]);
    client(async () => {
      throw new ApiError(413, 'request body too large');
    });
    await flushOutbox('c1');
    expect((await syncStateOf('c1')).failed?.map((f) => [f.event.id, f.reason])).toEqual([
      ['big', 'too_large'],
    ]);
  });
});

describe('the server clock', () => {
  it('clockSkewOf measures from the middle of the request', () => {
    const sentAt = Date.parse('2026-10-25T07:41:00.000Z');
    expect(clockSkewOf('2026-10-25T07:41:21.000Z', sentAt, sentAt + 2_000)).toBe(20_000);
    expect(clockSkewOf('not a time', sentAt, sentAt)).toBeUndefined();
    expect(clockSkewOf(undefined, sentAt, sentAt)).toBeUndefined();
  });

  it("keeps each sync answer's measurement in the sync state", async () => {
    await appendEvents('c1', [listen('a')]);
    client(async (body) => ({
      ...answer(body),
      server_time: new Date(Date.now() + 30_000).toISOString(),
    }));
    await flushOutbox('c1');
    const stored = JSON.parse((await AsyncStorage.getItem(SYNC))!) as {
      c1: { clockSkewMs: number };
    };
    expect(stored.c1.clockSkewMs).toBeGreaterThan(29_000);
    expect(stored.c1.clockSkewMs).toBeLessThan(31_000);
  });
});

describe('the stored clock skew has one reader (fe#211)', () => {
  it("is the outbox's: progress-sync's merges read the sync state through it", async () => {
    await AsyncStorage.setItem(SYNC, JSON.stringify({ c9: { clockSkewMs: 12_345 }, c8: {} }));
    const { skews } = await readLocalPlaces();
    expect(skews?.c9).toBe(12_345);
    expect(skews).not.toHaveProperty('c8');
  });
});

describe('the waiting count', () => {
  it('counts listens, not finish or unfinish', async () => {
    await appendEvents('c1', [
      listen('a'),
      { id: 'f', kind: 'finish', library_id: 3, path: 'Author/Book', at: span().endedAt },
      { id: 'u', kind: 'unfinish', library_id: 3, path: 'Author/Book', at: span().endedAt },
    ]);
    expect(await pendingSaves('c1')).toEqual({ saves: 0, listens: 1, events: 3 });
  });

  it('the removal warnings count a finish waiting alone: removal would drop it', async () => {
    (reachability.isReachable as jest.Mock).mockReturnValue(false);
    await appendEvents('c1', [
      { id: 'f', kind: 'finish', library_id: 3, path: 'Author/Book', at: span().endedAt },
    ]);
    expect(await unsentListens('c1')).toBe(1);
  });
});

describe('open spans of several web tabs', () => {
  const os = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = os;
  });

  const stored = async () => JSON.parse((await AsyncStorage.getItem(OPEN_SPAN))!) as OpenSpan[];

  it("leaves another tab's live span alone at launch, and closes one left behind", async () => {
    const live = { ...span({ id: 'live' }), owner: 'tab-a', keptAt: Date.now() };
    const left = { ...span({ id: 'left' }), owner: 'tab-b', keptAt: Date.now() - LIVE_SPAN_MS - 1 };
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify([live, left]));
    await recoverOpenSpan();
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['left']);
    expect((await stored()).map((s) => s.id)).toEqual(['live']);
  });

  it("stores and clears this tab's span beside another tab's", async () => {
    const theirs = { ...span({ id: 'theirs' }), owner: 'tab-a', keptAt: Date.now() };
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify([theirs]));
    await storeOpenSpan(span({ id: 'mine' }));
    expect((await stored()).map((s) => s.id)).toEqual(['theirs', 'mine']);
    await closeSpan(span({ id: 'mine' }));
    expect((await stored()).map((s) => s.id)).toEqual(['theirs']);
    // Its listen counts as waiting only offline, the other tab's too.
    (reachability.isReachable as jest.Mock).mockReturnValue(false);
    expect((await pendingSaves('c1')).listens).toBe(2);
  });

  it('closes a span kept further ahead than a live one (the clock set back since)', async () => {
    // Well past the limit: real timers run on, so exactly LIVE_SPAN_MS is live after 1 ms.
    const keptAt = Date.now() + LIVE_SPAN_MS + 60_000;
    const ahead = { ...span({ id: 'ahead' }), owner: 'tab-a', keptAt };
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify([ahead]));
    const changed = jest.fn();
    const off = onOutboxChange(changed);
    await recoverOpenSpan();
    off();
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['ahead']);
    expect(await storedOpenSpan()).toBeNull();
    expect(changed).toHaveBeenCalled();
  });

  it('leaves the span of a tab on an older build alone while it keeps it (every 15 s)', async () => {
    const old = span({ endedAt: new Date(Date.now() - 20_000).toISOString() });
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify(old));
    await recoverOpenSpan();
    expect(await outboxEvents('c1')).toEqual([]);
    expect(await storedOpenSpan()).toEqual(old);
  });

  it('a span left by another tab is sent before a removal warning counts: removal drops it', async () => {
    await recoverOpenSpan();
    // That tab closed after this one's recovery, before its own close landed.
    const left = { ...span({ id: 'left' }), owner: 'tab-b', keptAt: Date.now() - LIVE_SPAN_MS };
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify([left]));
    const c = client(async (body) => answer(body));
    expect(await unsentListens('c1')).toBe(0);
    expect(sent(c).flatMap((b) => b.events.map((e) => e.id))).toEqual(['left']);
  });

  it('a span whose last copy another tab took plays on under a new id from that copy', async () => {
    await recoverOpenSpan();
    const playing = span({ id: 'mine' });
    expect(await storeOpenSpan(playing)).toBeNull();
    // This tab's keeps stood still (the computer slept): another tab sent its copy.
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify([]));
    const later = { ...playing, to: { pos: 17000 }, endedAt: '2026-10-25T07:40:00.000Z' };
    const kept = await storeOpenSpan(later);
    expect(kept).toMatchObject({
      from: playing.to,
      to: later.to,
      startedAt: playing.endedAt,
      start: 'continue',
    });
    expect(kept?.id).not.toBe('mine');
    expect(await storedOpenSpan()).toEqual(kept);
    // A close still under the old id (queued before the keep) goes as the new span.
    await closeSpan({ ...later, endedAt: '2026-10-25T07:41:00.000Z' });
    expect((await outboxEvents('c1')).map((e) => e.event)).toEqual([
      expect.objectContaining({
        id: kept?.id,
        from_pos: 16800,
        to_pos: 17000,
        started_at: playing.endedAt,
        start: 'continue',
      }),
    ]);
  });

  it('a close finds its last copy taken: what played since goes as its own event', async () => {
    await recoverOpenSpan();
    const playing = span({ id: 'mine' });
    await storeOpenSpan(playing);
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify([]));
    await closeSpan({ ...playing, to: { pos: 17000 }, endedAt: '2026-10-25T07:40:00.000Z' });
    const [event] = (await outboxEvents('c1')).map((e) => e.event);
    expect(event).toMatchObject({ from_pos: 16800, to_pos: 17000, start: 'continue' });
    expect(event.id).not.toBe('mine');
  });

  it('the page going sends the closes still queued behind the lock too', async () => {
    await recoverOpenSpan();
    const c = client(async (body) => answer(body));
    const closing = closeSpan(span({ id: 'queued' }));
    sendOnPageHide([], 'dev');
    expect(sent(c).map((b) => b.events.map((e) => e.id))).toEqual([['queued']]);
    expect(c.syncListening.mock.calls[0][1]).toEqual({ keepalive: true });
    await closing;
  });

  it('a span stored before W2 (one bare span, no owner) is recovered', async () => {
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify(span({ id: 'legacy' })));
    await recoverOpenSpan();
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['legacy']);
  });

  it("the app recovers every span it finds: they are a previous launch's", async () => {
    Platform.OS = os;
    const fresh = { ...span({ id: 'previous' }), owner: 'launch-1', keptAt: Date.now() };
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify([fresh]));
    await recoverOpenSpan();
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['previous']);
  });
});

describe('a plain-http web player (no Web Locks)', () => {
  const nav = globalThis.navigator as { locks?: unknown };
  const os = Platform.OS;
  const g = globalThis as { localStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
  let leases: Map<string, string>;
  beforeEach(() => {
    Platform.OS = 'web';
    Object.defineProperty(nav, 'locks', { configurable: true, value: undefined });
    leases = new Map();
    const setItem = jest.fn((k: string, v: string) => void leases.set(k, v));
    Object.defineProperty(g, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => leases.get(k) ?? null,
        setItem,
        removeItem: (k: string) => void leases.delete(k),
      },
    });
  });
  afterEach(() => {
    Platform.OS = os;
    delete nav.locks;
    if (had) Object.defineProperty(g, 'localStorage', had);
    else delete g.localStorage;
  });

  it("takes a lease and re-reads the stored outbox, so another tab's event stays", async () => {
    await appendEvents('c1', [listen('mine')]);
    const before = JSON.parse((await AsyncStorage.getItem(OUTBOX))!) as unknown[];
    await AsyncStorage.setItem(
      OUTBOX,
      JSON.stringify([...before, { connectionId: 'c1', event: listen('theirs') }]),
    );
    await appendEvents('c1', [listen('mine-2')]);
    const ids = (
      JSON.parse((await AsyncStorage.getItem(OUTBOX))!) as { event: { id: string } }[]
    ).map((e) => e.event.id);
    expect(ids).toEqual(['mine', 'theirs', 'mine-2']);
    const storage = g.localStorage as { setItem: jest.Mock };
    expect(storage.setItem).toHaveBeenCalledWith(
      `audiosilo-lock:${OUTBOX}`,
      expect.stringContaining('token'),
    );
    // Released when done.
    expect(leases.has(`audiosilo-lock:${OUTBOX}`)).toBe(false);
  });

  it('the sync state takes its lease too', async () => {
    await discardFailed('c1', 'x');
    const storage = g.localStorage as { setItem: jest.Mock };
    expect(storage.setItem).toHaveBeenCalledWith(`audiosilo-lock:${SYNC}`, expect.any(String));
  });
});
