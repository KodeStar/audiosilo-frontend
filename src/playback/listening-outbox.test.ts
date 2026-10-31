import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError, type ApiClient } from '@/api/client';
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
jest.mock('@/api/provider', () => ({
  queryClient: { setQueryData: jest.fn(), invalidateQueries: jest.fn(async () => {}) },
}));

/* eslint-disable import/first */
import { resolveClient } from '@/api/connection-clients';
import { queryClient } from '@/api/provider';
import * as reachability from '@/api/reachability';
import { onConnectionRemoved } from '@/stores/session';

import {
  appendEvents,
  closeSpan,
  COULD_NOT_SYNC_KEEP_MS,
  discardFailed,
  MAX_COULD_NOT_SYNC,
  fitKeepalive,
  flushOutbox,
  keptMine,
  legacySavesOf,
  type OpenSpan,
  outboxEvents,
  recoverOpenSpan,
  resetOutboxForTests,
  spanSaysSomething,
  spanToEvent,
  storedOpenSpan,
  storeOpenSpan,
  syncStateOf,
  unsentListens,
  usesListeningSync,
} from './listening-outbox';
import { ackVersion, getDeviceId, pendingSaves, readMirror } from './progress-sync';
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
    expect(await pendingSaves('c1')).toEqual({ saves: 0, listens: 2 });
    (reachability.isReachable as jest.Mock).mockReturnValue(false);
    expect(await pendingSaves('c1')).toEqual({ saves: 0, listens: 3 });
    expect(await pendingSaves()).toEqual({ saves: 0, listens: 4 });
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
  it('only when the cached /server says listening_sync: true', () => {
    mockCaps = { listening_sync: true };
    expect(usesListeningSync('c1')).toBe(true);
    mockCaps = { listening_sync: false };
    expect(usesListeningSync('c1')).toBe(false);
    mockCaps = {};
    expect(usesListeningSync('c1')).toBe(false);
    mockCaps = undefined; // unknown: the PUT path
    expect(usesListeningSync('c1')).toBe(false);
  });
});

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
