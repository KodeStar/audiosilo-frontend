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
jest.mock('@/api/provider', () => ({
  queryClient: {
    setQueryData: jest.fn(),
    invalidateQueries: jest.fn(async () => {}),
  },
}));
// Each connection's kept `/server` answer (its own tests: server-snapshots.test.ts): this
// server's answer is kept unless a test says it names another one.
jest.mock('@/api/server-snapshots', () => ({
  keepServerAnswer: jest.fn(() => true),
  keepServerFlag: jest.fn(),
}));

/* eslint-disable import/first */
import { resolveClient } from '@/api/connection-clients';
import { queryClient } from '@/api/provider';
import * as reachability from '@/api/reachability';
import { keepServerAnswer, keepServerFlag } from '@/api/server-snapshots';
import { setDownloadEndCheck, setDownloadLengthCheck } from '@/downloads/kept-offline';
import { onConnectionRemoved } from '@/stores/session';

import {
  appendEvents,
  appendInTurn,
  clockSkewOf,
  connectionGeneration,
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
  resendMismatched,
  resetOutboxForTests,
  movesNowhere,
  spanIsBareMove,
  spanSaysSomething,
  spanToEvent,
  staysHeld,
  storedOpenSpan,
  storeOpenSpan,
  onOutboxChange,
  onSyncAnswer,
  sendOnPageHide,
  syncStateOf,
  unsentListens,
  usesListeningStay,
  usesListeningSync,
  withdrawFinish,
} from './listening-outbox';
import {
  ackVersion,
  getDeviceId,
  noteClockSkew,
  pendingSaves,
  type ProgressSave,
  readLocalPlaces,
  readMirror,
  resumeLookupOf,
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

  // A span nothing was heard in: no time passed and the place stayed.
  const still = { endedAt: span().startedAt, to: span().from };

  it('a span that moved nowhere says nothing unless it is a deliberate move', () => {
    expect(spanSaysSomething(span(still))).toBe(false);
    expect(spanSaysSomething(span({ ...still, start: 'continue' }))).toBe(false);
    expect(spanSaysSomething(span({ ...still, start: 'jump' }))).toBe(true);
    expect(spanSaysSomething(span({ ...still, start: 'restart' }))).toBe(true);
    expect(spanSaysSomething(span({ ...still, start: 'stay' }))).toBe(true);
    expect(spanSaysSomething(span())).toBe(true);
  });

  it('a bare move is a deliberate move nothing was heard after', () => {
    expect(spanIsBareMove(span({ ...still, start: 'moved_back' }))).toBe(true);
    expect(spanIsBareMove(span({ ...still, start: 'jump' }))).toBe(true);
    expect(spanIsBareMove(span({ ...still, start: 'restart' }))).toBe(true);
    expect(spanIsBareMove(span({ ...still, start: 'stay' }))).toBe(true);
    expect(spanIsBareMove(span({ ...still, start: 'resume' }))).toBe(false);
    expect(spanIsBareMove(span({ ...still, start: 'continue' }))).toBe(false);
    // Heard: a second of playing, or a place moved one.
    expect(spanIsBareMove(span({ to: span().from, start: 'jump' }))).toBe(false);
    expect(
      spanIsBareMove(span({ endedAt: span().startedAt, to: { pos: span().from.pos + 1 } })),
    ).toBe(false);
  });

  it('a move moves nowhere only to where the place already is', () => {
    expect(movesNowhere({ pos: 0 }, { pos: 0 })).toBe(true);
    expect(movesNowhere({ pos: 180.004 }, { pos: 180 })).toBe(true); // a seek lands a hair off
    expect(movesNowhere({ pos: 0.5 }, { pos: 0 })).toBe(false);
    expect(movesNowhere(null, { pos: 0 })).toBe(false);
    expect(movesNowhere(undefined, { pos: 0 })).toBe(false);
    expect(movesNowhere({ pos: 0 }, null)).toBe(false);
    expect(movesNowhere({ pos: NaN }, { pos: 0 })).toBe(false);
    // Another file is another place (unknown file lengths start every file at 0).
    expect(movesNowhere({ pos: 0, file: 'a.mp3' }, { pos: 0, file: 'b.mp3' })).toBe(false);
    expect(movesNowhere({ pos: 0 }, { pos: 0, file: 'a.mp3' })).toBe(true);
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

  // fe#321: the store keeps a move's span as it opens, right behind the close before it.
  it("a move's span stored right behind the close before it is the one a kill leaves", async () => {
    await storeOpenSpan(span({ id: 'a' }));
    const at = { pos: 30000, file: 'Author/Book/09.mp3', filePos: 12 };
    const jump = span({
      id: 'b',
      from: at,
      to: at,
      start: 'jump',
      startedAt: '2026-10-25T07:33:30.000Z',
      endedAt: '2026-10-25T07:33:30.000Z',
    });
    // Neither awaited before the other starts, as the store calls them.
    await Promise.all([closeSpan(span({ id: 'a' })), storeOpenSpan(jump)]);
    resetOutboxForTests();
    await recoverOpenSpan();
    const events = (await outboxEvents('c1')).map((e) => e.event);
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(events[1]).toMatchObject({ start: 'jump', from_pos: 30000, to_pos: 30000 });
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

  // fe#258: a close or a finish on its way as the connection was removed was appended
  // after the purge, and sent once the same account signed in again.
  it('removing a connection: what was on its way for it is not appended after', async () => {
    await recoverOpenSpan();
    const before = connectionGeneration('c1');
    const closing = closeSpan(span({ id: 'late-close' }));
    const finishing = appendInTurn('c1', [
      { id: 'late-finish', kind: 'finish', library_id: 3, path: 'Author/Book', at: 'x' },
    ]);
    const removing = Promise.all(purges.map((purge) => purge('c1')));
    expect(connectionGeneration('c1')).toBe(before + 1);
    await Promise.all([closing, finishing, removing]);
    expect(await outboxEvents('c1')).toEqual([]);
    // Signed in again: its own events go in as ever.
    await closeSpan(span({ id: 'next' }));
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['next']);
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

// The open span is stored every 5 s while a book plays, the mirror every 15 s: after a
// kill the span's end is this device's later word on the place (`mirrorSpanEnd`).
describe("a recovered span brings this device's record of the place up to its end", () => {
  /** This device's last capture of the book before the kill: 15 s before the span's keep. */
  const capture = (over: Partial<ProgressSave> = {}): ProgressSave => ({
    connectionId: 'c1',
    libraryId: 3,
    path: 'Author/Book',
    position: 16782,
    duration: 61200,
    finished: false,
    playback_speed: 1.2,
    device_id: 'old-id',
    updated_at: '2026-10-25T07:33:15.000Z',
    file: 'Author/Book/05.mp3',
    file_pos: 1185.9,
    ack_version: 41,
    answered: ['other|2026-10-20T00:00:00.000Z'],
    ...over,
  });
  /** A kill left `left` stored; the next launch recovers it. */
  async function relaunch(left: OpenSpan = span()) {
    await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify(left));
    resetOutboxForTests();
    await recoverOpenSpan();
  }
  const record = () => readMirror('c1', 3, 'Author/Book');

  it('moves a record older than the span and behind it, keeping what the mirror keeps', async () => {
    await writeMirror(capture());
    await relaunch();
    expect(await record()).toEqual({
      ...capture(),
      position: 16800,
      file: 'Author/Book/05.mp3',
      file_pos: 1203.9,
      updated_at: '2026-10-25T07:33:30.000Z',
      device_id: await getDeviceId(),
    });
    // The span itself still goes to the server.
    expect(await outboxEvents('c1')).toHaveLength(1);
  });

  it('a start offline then resumes where the span ended, by its file', async () => {
    await writeMirror(capture());
    await relaunch();
    // The server is not reached (`undefined`): only this device's own records.
    const lookup = resumeLookupOf(undefined, await readLocalPlaces(), 'c1', 3, 'Author/Book');
    expect(lookup).toMatchObject({
      kind: 'progress',
      progress: { position: 16800 },
      file: { path: 'Author/Book/05.mp3', pos: 1203.9 },
    });
  });

  it('leaves a record newer than the span: a place chosen since stands', async () => {
    // The listener went back just before the kill: the move saved at once, and the span
    // of before it was still stored.
    const chosen = capture({ position: 300, updated_at: '2026-10-25T07:33:31.000Z' });
    await writeMirror(chosen);
    await relaunch();
    expect(await record()).toEqual(chosen);
  });

  // fe#259: a server's row read back is stamped by its clock, here 20 s ahead: by this
  // device's it is from before the span's end.
  it("moves a server row older than the span by this device's clock", async () => {
    noteClockSkew('c1', 20_000);
    try {
      await writeMirror({
        ...capture({ updated_at: '2026-10-25T07:33:45.000Z' }),
        server_clock: true,
      });
      await relaunch();
      const moved = await record();
      expect(moved).toMatchObject({ position: 16800, updated_at: '2026-10-25T07:33:30.000Z' });
      // Stamped by this device now: no longer the server's clock.
      expect(moved).not.toHaveProperty('server_clock');
    } finally {
      noteClockSkew('c1', 0);
    }
  });

  it('never moves a place back', async () => {
    const further = capture({ position: 20000 });
    await writeMirror(further);
    await relaunch();
    expect(await record()).toEqual(further);
  });

  it('leaves a finished book, and a book with no record', async () => {
    const done = capture({ position: 300, finished: true });
    await writeMirror(done);
    await relaunch();
    expect(await record()).toEqual(done);

    await AsyncStorage.clear();
    await relaunch();
    expect(await record()).toBeNull();
    expect(await outboxEvents('c1')).toHaveLength(1);
  });

  it('drops the file place of the older capture when the span has none', async () => {
    await writeMirror(capture());
    await relaunch(span({ to: { pos: 16800 } }));
    const moved = await record();
    expect(moved).toMatchObject({ position: 16800 });
    expect(moved).not.toHaveProperty('file');
    expect(moved).not.toHaveProperty('file_pos');
  });

  it('reads the end of the book as finished, as a capture there does', async () => {
    await writeMirror(capture({ duration: 16803 }));
    await relaunch();
    expect(await record()).toMatchObject({ position: 16800, finished: true });
  });

  it('never reads the end of a queue that ends before its book as finished (D3, fe#185)', async () => {
    // Captured playing a download that lacks the book's last file: its 16803 s are the
    // downloaded part's, and a kill in its last seconds leaves a span at that end.
    await writeMirror(capture({ duration: 16803, partial: true }));
    await relaunch();
    expect(await record()).toMatchObject({ position: 16800, finished: false, partial: true });
  });

  describe("a download that ends before its book, by the download's own fact (D3, fe#185)", () => {
    // This device's download of the book lacks its last file, 06.mp3 (`endsBefore`).
    beforeEach(() =>
      setDownloadEndCheck(async (_c, _l, path) =>
        path === 'Author/Book' ? 'Author/Book/06.mp3' : undefined,
      ),
    );
    afterEach(() => setDownloadEndCheck(async () => undefined));

    it('never reads its end as finished from a server row written into the mirror since the capture', async () => {
      // The server's row (this device's earlier save of the downloaded part's end, read back)
      // was written over the capture: it carries no `partial`.
      await writeMirror(capture({ duration: 16803, device_id: 'server-row' }));
      await relaunch();
      expect(await record()).toMatchObject({ position: 16800, finished: false });
    });

    it("reads the end of the book's last file as finished: that was streamed", async () => {
      await writeMirror(capture({ duration: 16803 }));
      await relaunch(span({ to: { pos: 16800, file: 'Author/Book/06.mp3', filePos: 1203.9 } }));
      expect(await record()).toMatchObject({ position: 16800, finished: true });
    });

    // fe#273: before the launch read the registry (or after a read that threw) the check
    // answered "no early end", as if the download held the book's end.
    it('never reads its end as finished while the downloads registry is not known', async () => {
      setDownloadEndCheck(async () => {
        throw new Error('the downloads registry is not read');
      });
      await writeMirror(capture({ duration: 16803 }));
      await relaunch();
      expect(await record()).toMatchObject({ position: 16800, finished: false });
    });
  });

  it("brings the shared record up to a closed tab's span, dated when that tab kept it", async () => {
    const os = Platform.OS;
    Platform.OS = 'web';
    try {
      await writeMirror(capture());
      const left = {
        ...span({ id: 'left' }),
        owner: 'tab-b',
        keptAt: Date.now() - LIVE_SPAN_MS - 1,
      };
      const live = {
        ...span({ id: 'live', path: 'Author/Other', to: { pos: 99999 } }),
        owner: 'tab-a',
        keptAt: Date.now(),
      };
      await writeMirror(capture({ path: 'Author/Other' }));
      await AsyncStorage.setItem(OPEN_SPAN, JSON.stringify([live, left]));
      resetOutboxForTests();
      await recoverOpenSpan();
      // Not dated now: a tab that has played on since has the newer record.
      expect(await record()).toMatchObject({
        position: 16800,
        updated_at: '2026-10-25T07:33:30.000Z',
      });
      // A span its tab is still playing is that tab's to save.
      expect(await readMirror('c1', 3, 'Author/Other')).toMatchObject({ position: 16782 });
    } finally {
      Platform.OS = os;
    }
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

  // Pixel 6a: listens over a download that ends before its book carried the downloaded
  // part's length, and the server refused them all; the list said so, the server had nothing.
  describe('a listen refused for its length over an early-ending download', () => {
    const at = new Date().toISOString();
    const refused = (
      id: string,
      reason = 'duration_mismatch',
      over: Partial<ListeningEvent> = {},
    ) => ({
      event: listen(id, { duration: 4501, ...over }),
      reason,
      at,
    });
    afterEach(() => setDownloadLengthCheck(async () => undefined));

    it("goes back to the outbox at the book's length, and off the list", async () => {
      setDownloadLengthCheck(async (_c, _l, path) => (path === 'Author/Book' ? 4561 : undefined));
      await AsyncStorage.setItem(
        SYNC,
        JSON.stringify({
          c1: {
            failed: [
              refused('a'),
              refused('other-book', 'duration_mismatch', { path: 'Other/Book' }),
              refused('gone', 'not_found'),
            ],
          },
        }),
      );
      await resendMismatched();
      const out = await outboxEvents('c1');
      expect(out.map((e) => [e.event.id, (e.event as { duration?: number }).duration])).toEqual([
        ['a', 4561],
      ]);
      expect((await syncStateOf('c1')).failed?.map((f) => f.event.id)).toEqual([
        'other-book',
        'gone',
      ]);
    });

    it('goes back with no length when the book length is not known, and never twice', async () => {
      setDownloadLengthCheck(async () => 0);
      await AsyncStorage.setItem(
        SYNC,
        JSON.stringify({
          c1: {
            failed: [refused('a'), refused('b', 'duration_mismatch', { duration: undefined })],
          },
        }),
      );
      await resendMismatched();
      const out = await outboxEvents('c1');
      expect(out.map((e) => e.event.id)).toEqual(['a']);
      expect(out[0].event).not.toHaveProperty('duration');
      // One refused again at the length it would be sent with stays on the list.
      expect((await syncStateOf('c1')).failed?.map((f) => f.event.id)).toEqual(['b']);
    });
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

  it("caches this device's newer place, with the row, when the server kept another device's (fe#211)", async () => {
    const deviceId = await getDeviceId();
    // This device resumed behind another device's further place, and played on since.
    await writeMirror({
      connectionId: 'c1',
      libraryId: 3,
      path: 'Author/Book',
      position: 7200,
      duration: 61200,
      finished: false,
      playback_speed: 1,
      device_id: deviceId,
      updated_at: '2026-10-25T08:00:00.000Z',
    });
    await appendEvents('c1', [listen('a')]);
    const row: Progress = {
      library_id: 3,
      path: 'Author/Book',
      position: 16800,
      duration: 61200,
      finished: false,
      playback_speed: 1.2,
      version: 42,
      device_id: 'tablet',
      updated_at: '2026-10-25T07:33:30.000Z',
    };
    client(async (body) =>
      answer(body, () => ({ status: 'not_applied', reason: 'resume_behind' }), [row]),
    );
    await flushOutbox('c1');
    // Where Resume plays, as the book's own read answers, never the row alone.
    expect(queryClient.setQueryData).toHaveBeenCalledWith(
      ['progress', 'c1', 3, 'Author/Book'],
      expect.objectContaining({ position: 7200, device_id: deviceId, version: 0, server: row }),
    );
    // Another device's row is not acknowledged by the answer.
    expect((await readMirror('c1', 3, 'Author/Book'))?.ack_version).toBeUndefined();
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

    // fe#258 (4a): undone here, a finish whose request did arrive stayed on the server,
    // which then won on reconnect. The Undo fails instead, the finish left as it was.
    it('the server down by the Undo: no edit can be made, so the Undo fails, nothing taken', async () => {
      await appendEvents('c1', [finish('f')]);
      client(async () => {
        throw new TypeError('Failed to fetch');
      });
      await flushOutbox('c1');
      // The check that follows a request with no answer marked the server down.
      (reachability.isReachable as jest.Mock).mockReturnValue(false);
      try {
        const taken = await withdrawFinish('c1', 3, 'Author/Book');
        expect(taken).toMatchObject({ unsent: false, unreachable: true });
        expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['f']);
      } finally {
        (reachability.isReachable as jest.Mock).mockReturnValue(true);
      }
      // Back: the Undo takes the finish and its edit.
      const taken = await withdrawFinish('c1', 3, 'Author/Book');
      expect(taken).toMatchObject({ unsent: false });
      expect(taken.unreachable).toBeUndefined();
      expect(await outboxEvents('c1')).toEqual([]);
    });

    // fe#258: counted as taken, the finish storage still held was sent after a restart, over
    // the Undo's edit.
    it('a withdrawal storage would not keep takes nothing and fails', async () => {
      await appendEvents('c1', [listen('a'), finish('f')]);
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('quota'));
      await expect(withdrawFinish('c1', 3, 'Author/Book')).rejects.toThrow();
      expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['a', 'f']);
      const stored = (
        JSON.parse((await AsyncStorage.getItem(OUTBOX))!) as { event: { id: string } }[]
      ).map((e) => e.event.id);
      expect(stored).toEqual(['a', 'f']);
      // Not withdrawn: a send leaves it in.
      const c = client(async (body) => answer(body));
      await flushOutbox('c1');
      expect(sent(c).flatMap((b) => b.events.map((e) => e.id))).toEqual(['a', 'f']);
    });

    // fe#258: put back at the end, the finish went after what was listened to since (an
    // unfinish and a restart included), and finished the book again over them.
    it('an edit that failed puts the finish back where it was, ahead of what came since', async () => {
      await appendEvents('c1', [listen('a'), finish('f'), listen('b')]);
      const taken = await withdrawFinish('c1', 3, 'Author/Book');
      await appendEvents('c1', [listen('c')]);
      await taken.restore();
      expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['a', 'f', 'b', 'c']);
    });

    it('put back with everything ahead of it sent: first', async () => {
      await appendEvents('c1', [listen('a'), finish('f')]);
      const taken = await withdrawFinish('c1', 3, 'Author/Book');
      client(async (body) => answer(body));
      await flushOutbox('c1');
      await appendEvents('c1', [listen('c')]);
      await taken.restore();
      expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['f', 'c']);
    });

    // fe#258: put back after a sign-out, the finish outlived the purge and was sent once
    // the same account signed in again.
    it('signed out before an edit failed: nothing is put back', async () => {
      await appendEvents('c1', [finish('f')]);
      const taken = await withdrawFinish('c1', 3, 'Author/Book');
      for (const purge of purges) await purge('c1');
      await taken.restore();
      expect(await outboxEvents('c1')).toEqual([]);
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

    // fe#258: a page only hidden comes back (the back-forward cache) with its keepalive
    // request still out; the Undo took the finish back from under it.
    it("an Undo waits for the page's keepalive send: answered, the server has it", async () => {
      await appendEvents('c1', [finish('f')]);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      client(async (body) => {
        await gate;
        return answer(body);
      });
      sendOnPageHide([], 'dev');
      let done = false;
      const withdrawing = withdrawFinish('c1', 3, 'Author/Book').then((w) => {
        done = true;
        return w;
      });
      await tick();
      expect(done).toBe(false);
      release();
      const taken = await withdrawing;
      expect(taken.unsent).toBe(false);
      expect(await outboxEvents('c1')).toEqual([]);
    });

    it('a finish the page sent as it went, with no answer, may be on the server', async () => {
      await appendEvents('c1', [finish('f')]);
      let fail: (e: Error) => void = () => {};
      client(() => new Promise((_r, reject) => (fail = reject)));
      sendOnPageHide([], 'dev');
      const withdrawing = withdrawFinish('c1', 3, 'Author/Book');
      fail(new TypeError('Failed to fetch'));
      const taken = await withdrawing;
      expect(taken.unsent).toBe(false);
      expect(await outboxEvents('c1')).toEqual([]);
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
    // From now on this connection saves by PUT, and the answer that said so is the
    // connection's `/server` (in the cache and kept for the next launch).
    expect(usesListeningSync('c1')).toBe(false);
    expect(keepServerAnswer).toHaveBeenCalledWith('c1', { capabilities: {} });
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

describe('usesListeningStay (row 9c-2)', () => {
  it('only a server that said listening_stay takes a stay; unknown is no', () => {
    mockCaps = { listening_sync: true, listening_stay: true };
    expect(usesListeningStay('c1')).toBe(true);
    mockCaps = { listening_sync: true };
    expect(usesListeningStay('c1')).toBe(false);
    mockCaps = undefined; // unknown: sync counts as on, a stay does not (it would be `invalid`)
    expect(usesListeningSync('c1')).toBe(true);
    expect(usesListeningStay('c1')).toBe(false);
  });
});

describe('a queued stay to a server without listening_stay (row 9c-2)', () => {
  const stay = (id = 's') => listen(id, { start: 'stay' } as Partial<ListeningEvent>);
  const starts = (body: ListeningSyncRequest) =>
    body.events.map((e) => (e.kind === 'listen' ? e.start : e.kind));

  it('goes as a jump once the flag is gone, and as a stay while it is there', async () => {
    await appendEvents('c1', [stay(), listen('a')]);
    let fail = true;
    const c = client(async (body) => {
      if (fail) throw new TypeError('Network request failed');
      return answer(body);
    });
    mockCaps = { listening_sync: true };
    await flushOutbox('c1');
    mockCaps = { listening_sync: true, listening_stay: true };
    fail = false;
    await flushOutbox('c1');
    expect(sent(c).map(starts)).toEqual([
      ['jump', 'resume'],
      ['stay', 'resume'],
    ]);
    // Same ids: the answer matched the stored events, which left the outbox.
    expect(sent(c)[0].events.map((e) => e.id)).toEqual(['s', 'a']);
    expect(await outboxEvents('c1')).toEqual([]);
  });

  it('the stored event keeps its stay; a batch sent one by one and the page going map it too', async () => {
    await appendEvents('c1', [stay(), listen('a')]);
    let calls = 0;
    const c = client(async (body) => {
      calls += 1;
      if (calls === 1) throw new ApiError(400, 'invalid request');
      return answer(body);
    });
    await flushOutbox('c1');
    expect(sent(c).map(starts)).toEqual([['jump', 'resume'], ['jump'], ['resume']]);

    await appendEvents('c1', [stay('s2')]);
    const waiting = await outboxEvents('c1');
    expect(waiting.map((e) => e.event.kind === 'listen' && e.event.start)).toEqual(['stay']);
    const h = client(() => new Promise(() => {}));
    sendOnPageHide([], 'dev');
    expect(sent(h).map(starts)).toEqual([['jump']]);
  });

  // fe#321: the cached flag was stale (the server rolled back to a build without it), so the
  // stay went as a stay and the old decoder refused it.
  it('a stay refused alone under a stale flag goes once more as a jump', async () => {
    mockCaps = { listening_sync: true, listening_stay: true };
    await appendEvents('c1', [listen('a'), stay()]);
    const c = client(async (body) => {
      if (body.events.some((e) => e.kind === 'listen' && e.start === 'stay')) {
        throw new ApiError(400, 'invalid request');
      }
      return answer(body);
    });
    await flushOutbox('c1');
    expect(sent(c).map(starts)).toEqual([['resume', 'stay'], ['resume'], ['stay'], ['jump']]);
    expect(sent(c)[3].events[0].id).toBe('s');
    expect(await outboxEvents('c1')).toEqual([]);
    expect((await syncStateOf('c1')).failed ?? []).toEqual([]);
    // The flag is asked again, so the next Stay goes as a jump from the start.
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['server', 'c1'] });
  });

  it('a stay alone refused as a jump too goes to the list as invalid', async () => {
    mockCaps = { listening_sync: true, listening_stay: true };
    await appendEvents('c1', [stay()]);
    const c = client(async () => {
      throw new ApiError(400, 'invalid request');
    });
    await flushOutbox('c1');
    expect(sent(c).map(starts)).toEqual([['stay'], ['jump']]);
    const state = await syncStateOf('c1');
    expect(state.failed?.map((f) => [f.event.id, f.reason])).toEqual([['s', 'invalid']]);
    // The list keeps the event as it was stored.
    expect(state.failed?.[0].event).toMatchObject({ start: 'stay' });
  });

  it('held as the jump it went as, it is no held Stay (the usual 10 minutes apply)', async () => {
    const told: string[][] = [];
    const stop = onSyncAnswer((_cid, _rows, held) => told.push([...held]));
    try {
      await appendEvents('c1', [stay()]);
      client(async (body) => answer(body, () => ({ status: 'diverged', kept: 'stored' })));
      mockCaps = { listening_sync: true };
      await flushOutbox('c1');
      await appendEvents('c1', [stay('s2')]);
      mockCaps = { listening_sync: true, listening_stay: true };
      await flushOutbox('c1');
      expect(told.map((keys) => keys.length)).toEqual([0, 1]);
    } finally {
      stop();
    }
  });
});

// W2 F3: after an offline cold launch the query cache was empty, and the PUT path took over.
// The flag now comes from the connection's kept `/server` answer, seeded into the cache at
// launch (server-snapshots.test.ts: "the launch"); the outbox keeps no copy of its own.
describe("a connection's listening_sync across launches", () => {
  it('reads the cached /server alone: a seeded "no" is the PUT path, a seeded "yes" is events', () => {
    mockCaps = { listening_sync: false };
    expect(usesListeningSync('c1')).toBe(false);
    mockCaps = { listening_sync: true };
    expect(usesListeningSync('c1')).toBe(true);
  });

  it('keeps no flag of its own in the sync state', async () => {
    await appendEvents('c1', [listen('a')]);
    client(async (body) => answer(body));
    await flushOutbox('c1');
    await settleState();
    const state = JSON.parse((await AsyncStorage.getItem(SYNC)) ?? '{}') as Record<string, object>;
    expect(state.c1).not.toHaveProperty('listeningSync');
  });

  it('a sync answer from a server whose kept /server says no sets the flag', async () => {
    // An answer from before the server was updated: it took the events, so it has the
    // route, and the next listening goes by sync without waiting on a /server read (fe#270).
    mockCaps = { listening_sync: false };
    await appendEvents('c1', [listen('a')]);
    client(async (body) => answer(body));
    await flushOutbox('c1');
    expect(keepServerFlag).toHaveBeenCalledWith('c1', 'listening_sync');
  });

  it('a sync answer after a rollback this launch takes the sync route again', async () => {
    // Rolled back (the server had no route then), and a later send (another tab's events,
    // the server since updated) is taken: the next listening goes by sync.
    await appendEvents('c1', [listen('old')]);
    client(async () => {
      throw new ApiError(404, 'not found');
    });
    await flushOutbox('c1');
    mockCaps = { listening_sync: false };
    expect(usesListeningSync('c1')).toBe(false);
    await appendEvents('c1', [listen('new')]);
    client(async (body) => answer(body));
    await flushOutbox('c1');
    expect(keepServerFlag).toHaveBeenCalledWith('c1', 'listening_sync');
    mockCaps = { listening_sync: true };
    expect(usesListeningSync('c1')).toBe(true);
  });

  it('an event the server takes alone after a rollback takes the sync route again too', async () => {
    // The batch is refused as a whole (a 400), then each event is taken alone: that proves
    // the route as a taken batch does.
    await appendEvents('c1', [listen('old')]);
    client(async () => {
      throw new ApiError(404, 'not found');
    });
    await flushOutbox('c1');
    mockCaps = { listening_sync: false };
    expect(usesListeningSync('c1')).toBe(false);
    await appendEvents('c1', [listen('one'), listen('two')]);
    client(async (body) => {
      if (body.events.length > 1) throw new ApiError(400, 'invalid request');
      return answer(body);
    });
    await flushOutbox('c1');
    expect(keepServerFlag).toHaveBeenCalledWith('c1', 'listening_sync');
    mockCaps = { listening_sync: true };
    expect(usesListeningSync('c1')).toBe(true);
  });

  it('a sync answer changes no flag when the cached /server agrees or is unknown', async () => {
    for (const caps of [{ listening_sync: true }, undefined]) {
      mockCaps = caps;
      await appendEvents('c1', [listen(`a${caps ? 1 : 2}`)]);
      client(async (body) => answer(body));
      await flushOutbox('c1');
    }
    expect(keepServerFlag).not.toHaveBeenCalled();
  });

  it("a confirmed rollback keeps the server's own answer; an unconfirmed one keeps nothing", async () => {
    await appendEvents('c1', [listen('b')]);
    client(
      async () => {
        throw new ApiError(404, 'not found');
      },
      async () => ({ capabilities: { listening_sync: true } }),
    );
    await flushOutbox('c1');
    expect(keepServerAnswer).not.toHaveBeenCalled();
    resetOutboxForTests();
    const info = { capabilities: { queue: true } };
    client(
      async () => {
        throw new ApiError(404, 'not found');
      },
      async () => info,
    );
    await flushOutbox('c1');
    expect(keepServerAnswer).toHaveBeenCalledWith('c1', info);
  });

  it('a 404 from a server that was reset rolls nothing back (fe#270)', async () => {
    // Another server_id at the address: keepServerAnswer flags the reset and keeps nothing.
    jest.mocked(keepServerAnswer).mockReturnValueOnce(false);
    await appendEvents('c1', [listen('c')]);
    const c = client(
      async () => {
        throw new ApiError(404, 'not found');
      },
      async () => ({ capabilities: {} }),
    );
    await flushOutbox('c1');
    expect(keepServerAnswer).toHaveBeenCalled();
    expect(c.saveProgress).not.toHaveBeenCalled();
    expect((await outboxEvents('c1')).map((e) => e.event.id)).toEqual(['c']);
    expect(usesListeningSync('c1')).toBe(true);
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

// Stay wins (row 9c-2): a `stay` the server kept the stored row over (another device's Stay
// holds it) is named, so the player offers the kept place at once.
describe('staysHeld', () => {
  it('names only a stay the server answered diverged, kept: stored', () => {
    const sent = [
      listen('a', { start: 'stay' }),
      listen('b', { start: 'jump' }),
      listen('c', { start: 'stay' }),
      listen('d', { start: 'stay' }),
    ];
    const results = new Map<string, ListeningSyncResult>([
      ['a', { id: 'a', status: 'diverged', kept: 'stored' }],
      ['b', { id: 'b', status: 'diverged', kept: 'stored' }],
      ['c', { id: 'c', status: 'diverged', kept: 'event' }],
      ['d', { id: 'd', status: 'applied' }],
    ]);
    expect(staysHeld(sent, results).map((e) => e.id)).toEqual(['a']);
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
  it("gives up at the server's own bound, the 90 days the list says (fe#211)", () => {
    expect(GIVE_UP_AGE_MS).toBe(90 * 24 * 60 * 60_000);
  });

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

  // fe#258: the finish waited in the store's memory for its span's close to land, where a
  // kill or the page going lost it (the server unfinished, this device finished).
  it('an event appended in turn lands behind a close queued before it, on its base then', async () => {
    await recoverOpenSpan();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    // The close waits its turn behind the base read of the span before it.
    const order: string[] = [];
    const closing = closeSpan(span({ id: 'close' })).then(() => order.push('close'));
    const finishing = appendInTurn(
      'c1',
      [{ id: 'fin', kind: 'finish', library_id: 3, path: 'Author/Book', at: 'x' }],
      async () => {
        await held;
        return 57;
      },
    ).then(() => order.push('finish'));
    release();
    await Promise.all([closing, finishing]);
    expect(order).toEqual(['close', 'finish']);
    const events = (await outboxEvents('c1')).map((e) => e.event);
    expect(events.map((e) => e.id)).toEqual(['close', 'fin']);
    expect(events[1]).toMatchObject({ base_version: 57 });
  });

  it('the page going carries a finish still waiting behind its close', async () => {
    await recoverOpenSpan();
    const c = client(async (body) => answer(body));
    const closing = closeSpan(span({ id: 'queued' }));
    const finishing = appendInTurn('c1', [
      { id: 'fin', kind: 'finish', library_id: 3, path: 'Author/Book', at: 'x' },
    ]);
    sendOnPageHide([], 'dev');
    expect(sent(c).map((b) => b.events.map((e) => e.id))).toEqual([['queued', 'fin']]);
    await Promise.all([closing, finishing]);
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

  // A finish waiting its turn is in no stored outbox yet: it is not one another tab took
  // back.
  it('the page going carries a finish still waiting its turn', async () => {
    await appendEvents('c1', [listen('a')]);
    await recoverOpenSpan();
    const c = client(async (body) => answer(body));
    const closing = closeSpan(span({ id: 'queued' }));
    const finishing = appendInTurn('c1', [
      { id: 'fin', kind: 'finish', library_id: 3, path: 'Author/Book', at: 'x' },
    ]);
    sendOnPageHide([], 'dev');
    expect(sent(c).map((b) => b.events.map((e) => e.id))).toEqual([['a', 'queued', 'fin']]);
    await Promise.all([closing, finishing]);
  });

  it('the sync state takes its lease too', async () => {
    await discardFailed('c1', 'x');
    const storage = g.localStorage as { setItem: jest.Mock };
    expect(storage.setItem).toHaveBeenCalledWith(`audiosilo-lock:${SYNC}`, expect.any(String));
  });
});
