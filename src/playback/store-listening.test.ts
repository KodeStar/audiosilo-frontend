import type { Book, ChaptersResponse, ListeningEvent, Progress } from '@/api/types';

import type { OpenSpan } from './listening-outbox';
import type { ResumeLookup } from './progress-sync';
import type { BookRef, PlaybackService, PlaybackSnapshot, PlaybackState } from './types';

// Sync v2's spans in the store (Track W1): what the store hands the outbox on a server with
// `listening_sync`, and that it hands it nothing (the PUT path, as before) without it. The
// engine is a fake whose snapshots a test pushes; the outbox's storage and sending are
// captured, its pure event builders are the real ones.

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
let remoteMove: (trackIndex: number, position: number, checkpoint?: boolean) => void = () => {};
let playAsked: () => void = () => {};
let landed: () => void = () => {};
/** The book the engine's last report named (`reportedBook`); null: it named none. */
let engineBook: BookRef | null = null;
const mockSvc = {
  reportedBook: jest.fn(() => engineBook),
  onRemoteSeek: jest.fn(),
  onPlayAsked: jest.fn((cb: () => void) => {
    playAsked = cb;
  }),
  onRemoteMove: jest.fn((cb: (trackIndex: number, position: number) => void) => {
    remoteMove = cb;
  }),
  onRateChange: jest.fn(),
  onSilenceSaved: jest.fn(),
  onLanded: jest.fn((cb: () => void) => {
    landed = cb;
  }),
  setup: jest.fn(async () => {}),
  configure: jest.fn(async () => {}),
  load: jest.fn(async () => {}),
  play: jest.fn(async () => {}),
  pause: jest.fn(async () => {}),
  seekTo: jest.fn(async () => {}),
  skipToTrack: jest.fn(async () => {}),
  setRate: jest.fn(async () => {}),
  setVolume: jest.fn(async () => {}),
  reset: jest.fn(async () => {}),
  getSnapshot: jest.fn(() => ({ ...INITIAL })),
  subscribe: jest.fn((listener: (s: PlaybackSnapshot) => void) => {
    pushSnapshot = listener;
    return () => {};
  }),
} as unknown as PlaybackService;

const INITIAL: PlaybackSnapshot = {
  state: 'idle',
  trackIndex: 0,
  position: 0,
  duration: 0,
  rate: 1,
};

jest.mock('./service', () => ({ createPlaybackService: () => mockSvc }));

const mockSaveProgress = jest.fn(async (..._a: unknown[]) => {});
const mockWriteMirror = jest.fn(async (..._a: unknown[]) => {});
const mockAckVersion = jest.fn(async (..._a: unknown[]) => {});
const mockRecoverOpenSpan = jest.fn(async () => {});
const mockLoadInitialProgress = jest.fn(async (..._a: unknown[]): Promise<ResumeLookup> => ({
  kind: 'empty',
}));
const mockReadMirror = jest.fn(async (..._a: unknown[]): Promise<unknown> => null);
// A change under the mirror's lock (`updateMirror`): made to the record `mockReadMirror`
// gives, each changed record kept here, in order.
const mockMirrorUpdates: unknown[] = [];
const mockUpdateMirror = jest.fn(
  async (cid: string, lib: number, path: string, change: (r: never) => unknown) => {
    const now = await mockReadMirror(cid, lib, path);
    if (!now) return;
    const next = change(now as never);
    if (next !== now) mockMirrorUpdates.push(next);
  },
);
const mockNoteUndone = jest.fn(async (..._a: unknown[]) => {});
const mockTellUndone = jest.fn((..._a: unknown[]) => {});
// Each Mark as finished's record as the mirror keeps it (`writeFinishedMirror`): the save,
// carrying the record it replaced (`mockReadMirror`'s) when that was a place, or what the
// finished record it replaced carried. Its write is `mockWriteMirror`'s too.
type MockRecord = { finished?: boolean; before?: unknown };
const mockFinishedRecords: unknown[] = [];
const mockWriteFinishedMirror = async (save: {
  connectionId: string;
  libraryId: number;
  path: string;
}) => {
  const existing = (await mockReadMirror(
    save.connectionId,
    save.libraryId,
    save.path,
  )) as MockRecord | null;
  const prior = existing && (existing.finished ? existing.before : existing);
  mockFinishedRecords.push(prior ? { ...save, before: prior } : save);
  return mockWriteMirror(save);
};
// Sessions whose guarded save the queue has PUT since (`guardSettled`).
const mockSettled = new Set<string>();
// The bookmarks waiting on the device: their last send before a removal (fe#356).
const mockSendBookmarks = jest.fn(async (_cid: string) => {});
jest.mock('./annotation-outbox', () => ({
  sendBookmarksBeforeRemoval: (cid: string) => mockSendBookmarks(cid),
}));
jest.mock('./finish-delivery', () => ({
  ...jest.requireActual('./finish-delivery'),
  tellFinishChangedElsewhere: (...a: unknown[]) => mockTellUndone(...a),
}));
jest.mock('./progress-sync', () => ({
  saveProgress: (...a: unknown[]) => mockSaveProgress(...a),
  writeMirror: (...a: unknown[]) => mockWriteMirror(...a),
  writeFinishedMirror: (save: { connectionId: string; libraryId: number; path: string }) =>
    mockWriteFinishedMirror(save),
  ackVersion: (...a: unknown[]) => mockAckVersion(...a),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  cachedDeviceId: () => 'dev-1',
  loadInitialProgress: (...a: unknown[]) => mockLoadInitialProgress(...a),
  readMirror: (...a: unknown[]) => mockReadMirror(...a),
  updateMirror: (cid: string, lib: number, path: string, change: (r: never) => unknown) =>
    mockUpdateMirror(cid, lib, path, change),
  noteUndoneFinish: (...a: unknown[]) => mockNoteUndone(...a),
  guardSettled: (id: string) => mockSettled.has(id),
  // No clock skew is known here: the two stamps as they are.
  mirrorIsNewest: async (record: { updated_at: string }, place: { updated_at: string }) =>
    Date.parse(record.updated_at) >= Date.parse(place.updated_at),
}));

// The outbox: the path choice is the test's, storage and sending are captured.
let mockSync = true;
let mockStay = false;
const mockClosed: OpenSpan[] = [];
const mockAppended: ListeningEvent[] = [];
const mockSendOnPageHide = jest.fn((..._a: unknown[]) => {});
const mockFlushOutbox = jest.fn(async (..._a: unknown[]) => {});
const mockStoreOpenSpan = jest.fn(async (..._a: unknown[]): Promise<OpenSpan | null> => null);
// The sign-in each connection is on (`connectionGeneration`).
let mockGeneration = 0;
// Whether events wait their turn behind a close (`waitingInTurn`).
let mockWaitingInTurn = false;
/** `appendInTurn` as the outbox does it, less the turn: the base read, then appended. */
async function appendedInTurn(
  _cid: string,
  events: ListeningEvent[],
  base?: () => Promise<number | undefined>,
) {
  const b = base ? await base() : undefined;
  mockAppended.push(...events.map((e) => (b === undefined ? e : { ...e, base_version: b })));
}
const mockAppendInTurn = jest.fn(appendedInTurn);
// A removal ends the connection's sign-in (`connection-generation`).
jest.mock('./connection-generation', () => ({ connectionGeneration: () => mockGeneration }));
jest.mock('./listening-outbox', () => {
  const actual = jest.requireActual('./listening-outbox');
  return {
    recoverOpenSpan: () => mockRecoverOpenSpan(),
    spanToEvent: actual.spanToEvent,
    spanIsBareMove: actual.spanIsBareMove,
    spanSaysSomething: actual.spanSaysSomething,
    movesNowhere: actual.movesNowhere,
    finishEvent: actual.finishEvent,
    newEventId: actual.newEventId,
    usesListeningSync: () => mockSync,
    usesListeningStay: () => mockSync && mockStay,
    closeSpan: jest.fn(async (span: OpenSpan) => {
      mockClosed.push(structuredClone(span));
    }),
    storeOpenSpan: (...a: unknown[]) => mockStoreOpenSpan(...a),
    appendEvents: jest.fn(async (_cid: string, events: ListeningEvent[]) => {
      mockAppended.push(...events);
    }),
    appendInTurn: (
      cid: string,
      events: ListeningEvent[],
      base?: () => Promise<number | undefined>,
    ) => mockAppendInTurn(cid, events, base),
    afterInTurn: (_cid: string, op: () => Promise<void>) => op(),
    waitingInTurn: () => mockWaitingInTurn,
    flushOutbox: (...a: unknown[]) => mockFlushOutbox(...a),
    sendOnPageHide: (...a: unknown[]) => mockSendOnPageHide(...a),
    withdrawFinish: (...a: unknown[]) => mockWithdraw(...a),
  };
});
// What an Undo's withdrawal took back (`unsent`: a finish the server never got).
const mockWithdraw = jest.fn(async (..._a: unknown[]) => ({
  unsent: true,
  restore: async () => {},
}));

jest.mock('./time-saved', () => ({ noteSilenceSaved: jest.fn(), flushTimeSaved: jest.fn() }));
jest.mock('@/api/provider', () => ({
  queryClient: {
    invalidateQueries: jest.fn(),
    setQueryData: jest.fn(),
    setQueryDefaults: jest.fn(),
    fetchQuery: jest.fn(async () => ({})),
    getQueryData: jest.fn(() => undefined),
    cancelQueries: jest.fn(async () => {}),
  },
}));
jest.mock('@/lib/network', () => ({ canAutoDownload: jest.fn(() => Promise.resolve(false)) }));
const mockClient = {
  coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
  streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
  authHeaders: () => ({ Authorization: 'Bearer x' }),
  addHistory: jest.fn(async () => {}),
};
jest.mock('@/api/connection-clients', () => ({
  resolveClient: () => mockClient,
  sessionReady: jest.fn(() => true),
}));

/* eslint-disable import/first */
import { Platform } from 'react-native';

import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import * as reachability from '@/api/reachability';
import { useSettings } from '@/stores/settings';
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';

import {
  finishTakesEvent,
  leaveFinishedBook,
  recordFinishEvent,
  reloadLeftBook,
  undoFinish,
} from './finish-route';
import { closeSpan } from './listening-outbox';
import { cutPlayingSpan } from './span-cut';
import { SPAN_RECOVERY_WAIT_MS, spanRecovered } from './span-recovery';
import {
  answerAfterSpan,
  cutListeningSpanNow,
  flushHistoryOnHide,
  holdSaves,
  localMoveCount,
  onOtherBookReported,
  pendingBookConfirmation,
  saveLoadedPlace,
  selectBookLength,
  selectBookPosition,
  standByPlace,
  teardownBeforeTokenRevoke,
  usePlayer,
} from './store';
/* eslint-enable import/first */

// A two-file folder book; the server now plays "2.mp3" before "10.mp3" (natural order).
const folder = 'A/Folder';
const order = ['A/Folder/2.mp3', 'A/Folder/10.mp3'];
const chapters: ChaptersResponse = {
  library_id: 2,
  path: folder,
  duration: 100,
  is_folder: true,
  files: order.map((rel_path, seq) => ({ rel_path, seq, duration: 50, format: 'mp3', size: 1 })),
  chapters: order.map((file_path, index) => ({
    index,
    title: `Chapter ${index + 1}`,
    file_index: index,
    file_path,
    start: 0,
    end: 50,
    book_offset: index * 50,
  })),
};
const book: Book = {
  id: 1,
  library_id: 2,
  rel_path: folder,
  is_folder: true,
  title: 'A Book',
  author: 'Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration: 100,
  format: 'mp3',
  size: 0,
};

const row = (p: Partial<Progress> = {}): Progress => ({
  library_id: 2,
  path: folder,
  position: 0,
  duration: 100,
  finished: false,
  playback_speed: 1,
  version: 0,
  device_id: 'dev-1',
  updated_at: '2026-01-01T00:00:00Z',
  ...p,
});

/** The book, downloaded on this device. */
const downloadedEntry = (): DownloadEntry => ({
  connectionId: 'c1',
  libraryId: 2,
  path: folder,
  title: 'A Book',
  status: 'downloaded',
  progress: 1,
  bytes: 0,
  totalBytes: 0,
  manifest: {
    book,
    chapters,
    files: order.map((relPath) => ({ relPath, localUri: `file:///d/${relPath}` })),
    coverUri: 'file:///d/cover.jpg',
    savedAt: '2026-01-01T00:00:00.000Z',
  },
});

/** The save loop's pace for a book this device holds (`saveIntervalMs`); a streamed one
 * saves every 15 s. */
const LOCAL_SAVE_MS = 60_000;

const snap = (state: PlaybackState, trackIndex: number, position: number): PlaybackSnapshot => ({
  state,
  trackIndex,
  position,
  duration: 50,
  rate: 1,
});

async function settle(turns = 8) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Start the book: resume (no place given), or at `at` seconds. */
async function start(at?: number) {
  await usePlayer.getState().playBook('c1', 2, book, chapters, at);
  await settle();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  engineBook = null;
  mockClosed.length = 0;
  mockAppended.length = 0;
  mockMirrorUpdates.length = 0;
  mockFinishedRecords.length = 0;
  mockGeneration = 0;
  mockAppendInTurn.mockImplementation(appendedInTurn);
  mockSync = true;
  mockStay = false;
  mockReadMirror.mockResolvedValue({ ack_version: 41 });
  mockLoadInitialProgress.mockResolvedValue({ kind: 'empty' });
  useSettings.setState({ autoDownloadNext: 'never' });
  usePlayer.setState({ nowPlaying: null, snapshot: { ...INITIAL }, rate: 1 });
  useDownloads.setState({ entries: {} });
});

afterEach(async () => {
  // Unload the book so the next test's start is a fresh span, not a switch.
  await usePlayer.getState().stop();
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('a play asked during launch recovery loads the last kept file place', async () => {
  let recovered!: () => void;
  const recovery = new Promise<void>((resolve) => (recovered = resolve));
  mockRecoverOpenSpan.mockImplementationOnce(async () => {
    await recovery;
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: row({ position: 62 }),
      file: { path: order[1], pos: 12 },
    });
  });
  const playing = start();
  await settle(50);
  expect(mockRecoverOpenSpan).toHaveBeenCalled();
  expect(mockLoadInitialProgress).not.toHaveBeenCalled();
  expect(mockSvc.load).not.toHaveBeenCalled();
  recovered();
  await playing;
  expect((mockSvc.load as jest.Mock).mock.lastCall.slice(1, 3)).toEqual([1, 12]);
});

it('a recovery that never ends holds the resume for a while only', async () => {
  // Another tab's span writes hold the lock the sweep waits for (the web's `spanOps`).
  mockRecoverOpenSpan.mockImplementationOnce(() => new Promise<void>(() => {}));
  mockLoadInitialProgress.mockResolvedValueOnce({
    kind: 'progress',
    progress: row({ position: 62 }),
    file: { path: order[1], pos: 12 },
  });
  const playing = start();
  await settle(50);
  expect(mockLoadInitialProgress).not.toHaveBeenCalled();
  jest.advanceTimersByTime(SPAN_RECOVERY_WAIT_MS);
  await playing;
  expect((mockSvc.load as jest.Mock).mock.lastCall.slice(1, 3)).toEqual([1, 12]);
});

it('a start at a place asked during launch recovery reads the finish it recovers', async () => {
  // A kill in the book's last seconds: the recovered span finishes the mirror's record.
  let recovered!: () => void;
  const recovery = new Promise<void>((resolve) => (recovered = resolve));
  mockRecoverOpenSpan.mockImplementationOnce(async () => {
    await recovery;
    mockReadMirror.mockResolvedValue({
      ack_version: 41,
      position: 100,
      finished: true,
      playback_speed: 1.5,
    });
  });
  const playing = start(40); // a chapter tap at launch
  await settle(50);
  expect(mockSvc.load).not.toHaveBeenCalled();
  recovered();
  await playing;
  pushSnapshot(snap('playing', 0, 40));
  pushSnapshot(snap('paused', 0, 45));
  await settle();
  expect(mockAppended).toEqual([
    expect.objectContaining({ kind: 'unfinish', library_id: 2, path: folder }),
  ]);
  expect(usePlayer.getState().rate).toBe(1.5);
});

it('a start at a place waits for a recovery that never ends for a while only', async () => {
  mockRecoverOpenSpan.mockImplementationOnce(() => new Promise<void>(() => {}));
  const playing = start(40);
  await settle(50);
  expect(mockSvc.load).not.toHaveBeenCalled();
  jest.advanceTimersByTime(SPAN_RECOVERY_WAIT_MS);
  await playing;
  expect(mockSvc.load).toHaveBeenCalled();
});

it('a start after a reader waited out a recovery that never ends waits no longer', async () => {
  // One recovery per launch (`recoverOpenSpan` keeps it): Previously on waits, then starts.
  const never = new Promise<void>(() => {});
  mockRecoverOpenSpan.mockImplementation(() => never);
  try {
    const waited = spanRecovered();
    jest.advanceTimersByTime(SPAN_RECOVERY_WAIT_MS);
    await waited;
    await start(40);
    expect(mockSvc.load).toHaveBeenCalled();
  } finally {
    mockRecoverOpenSpan.mockImplementation(async () => {});
  }
});

describe('without listening_sync (the PUT path, unchanged)', () => {
  it('saves by PUT and hands the outbox nothing', async () => {
    mockSync = false;
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(21_000); // one 15 s save, and long enough for a history span
    pushSnapshot(snap('paused', 0, 20));
    await settle();
    expect(mockSaveProgress).toHaveBeenCalledTimes(2);
    expect(mockSaveProgress.mock.calls[1][1]).toMatchObject({ position: 20 });
    expect(mockClosed).toEqual([]);
    expect(mockAppended).toEqual([]);
    expect(mockClient.addHistory).toHaveBeenCalled(); // POST /history as before
  });
});

// fe#198: a session that began where the server was not checked guards its PUT saves.
describe('the replay guard on the PUT path', () => {
  const guards = () =>
    mockSaveProgress.mock.calls.map((c) => (c[1] as { guard?: boolean }).guard === true);

  beforeEach(() => {
    mockSync = false;
    mockSettled.clear();
  });

  /** `tick`: the save loop's pace for the book (`LOCAL_SAVE_MS` for a downloaded one). */
  async function playedTwoSaves(outcome: string, tick = 15_000) {
    mockSaveProgress.mockResolvedValueOnce(outcome as never);
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(tick);
    await settle();
    pushSnapshot(snap('playing', 0, 25));
    jest.advanceTimersByTime(tick);
    await settle();
  }

  it('an unchecked resume guards its saves until one is PUT', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    await playedTwoSaves('saved');
    expect(guards()).toEqual([true, false]);
  });

  it('a queued save replayed later lifts the guard (no read before every later save)', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    mockSaveProgress.mockResolvedValueOnce('queued' as never);
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000);
    await settle();
    const first = mockSaveProgress.mock.calls[0]?.[1] as { guard_session?: string };
    expect(first.guard_session).toEqual(expect.any(String));
    mockSettled.add(first.guard_session as string);
    pushSnapshot(snap('playing', 0, 25));
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(guards()).toEqual([true, false]);
  });

  it('a held save keeps the guard on', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    await playedTwoSaves('held');
    expect(guards()).toEqual([true, true]);
  });

  const stamps = () =>
    mockSaveProgress.mock.calls.map((c) => (c[1] as { updated_at: string }).updated_at);

  // A sign-out's stop saves the paused place again. Dated the sign-out, the guard's read (the
  // server's row behind it, another device's move back) lets it through, and last-write-wins
  // it then replaced that newer move.
  it("a paused book's sign-out save keeps the stamp of the held capture that took its place", async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(10_000);
    mockSaveProgress.mockResolvedValueOnce('held' as never);
    pushSnapshot(snap('paused', 0, 51));
    await settle();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    const [held] = stamps();
    jest.advanceTimersByTime(18_000);
    await teardownBeforeTokenRevoke('c1');
    expect(mockSaveProgress).toHaveBeenCalledTimes(2);
    expect(mockSaveProgress.mock.calls[1][1]).toMatchObject({
      position: 51,
      guard: true,
      updated_at: held,
    });
  });

  it("a book resumed and left paused, never captured, saves and signs out under its resume row's stamp", async () => {
    const resumed = '2026-11-20T15:23:18.591Z';
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 51, updated_at: resumed }),
      unchecked: true,
    });
    await start();
    // The engine's first report is a pause (a refused autoplay): its capture is the resume's
    // place, not a new one.
    pushSnapshot(snap('paused', 0, 51));
    await settle();
    jest.advanceTimersByTime(18_000);
    await teardownBeforeTokenRevoke('c1');
    expect(mockSaveProgress).toHaveBeenCalledTimes(2);
    for (const [, save] of mockSaveProgress.mock.calls) {
      expect(save).toMatchObject({ position: 51, guard: true, updated_at: resumed });
    }
  });

  it("a resumed book's speed set while paused, after its first capture, is dated now", async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 51, updated_at: '2026-11-20T15:23:18.591Z' }),
      unchecked: true,
    });
    await start();
    pushSnapshot(snap('paused', 0, 51));
    await settle();
    jest.advanceTimersByTime(5_000);
    const setAt = new Date().toISOString();
    await usePlayer.getState().setRate(1.5);
    await settle();
    expect(mockSaveProgress).toHaveBeenCalledTimes(2);
    expect(stamps()[1]).toBe(setAt);
  });

  it("a paused book's sign-out save away from its last capture is dated the stop", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(10_000);
    pushSnapshot(snap('paused', 0, 51));
    await settle();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    // The engine reports another place while paused, with no capture of it.
    pushSnapshot(snap('paused', 0, 80));
    await settle();
    jest.advanceTimersByTime(18_000);
    const stoppedAt = new Date().toISOString();
    await teardownBeforeTokenRevoke('c1');
    const last = mockSaveProgress.mock.calls.at(-1)?.[1] as { position: number };
    expect(last.position).toBe(80);
    expect(stamps().at(-1)).toBe(stoppedAt);
  });

  it("a rebuffering book's sign-out save at its last capture is dated the stop", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    pushSnapshot(snap('loading', 0, 5.3));
    await settle();
    jest.advanceTimersByTime(2_000);
    const stoppedAt = new Date().toISOString();
    await teardownBeforeTokenRevoke('c1');
    expect(stamps().at(-1)).toBe(stoppedAt);
  });

  it("a playing book's sign-out save is dated the stop: the listener was there until then", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(3_000);
    const stoppedAt = new Date().toISOString();
    await teardownBeforeTokenRevoke('c1');
    expect(mockSaveProgress).toHaveBeenCalledTimes(2);
    expect(stamps()[1]).toBe(stoppedAt);
  });

  // The other device was still playing: its row had moved on from the one the offer named,
  // so the Stay's own save was held again, and each save after it, with no new offer.
  it("Stay on a held save's offer lifts the guard, whatever the other device saved since", async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    mockSaveProgress.mockResolvedValueOnce('held' as never);
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(guards()).toEqual([true]);
    saveLoadedPlace();
    await settle();
    pushSnapshot(snap('playing', 0, 25));
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(guards()).toEqual([true, false, false]);
  });

  it('a downloaded book that could not ask its server (started at 0) is guarded too', async () => {
    mockLoadInitialProgress.mockResolvedValue({ kind: 'failed' });
    useDownloads.setState({
      entries: { [`c1:2:${folder}`]: downloadedEntry() },
    });
    await start();
    await playedTwoSaves('queued', LOCAL_SAVE_MS);
    expect(guards()).toEqual([true, true]);
  });

  it('an adopted book (its place never looked up) is guarded too', async () => {
    useDownloads.setState({ entries: { [`c1:2:${folder}`]: downloadedEntry() } });
    const adopted = await usePlayer.getState().adoptLoaded({
      connectionId: 'c1',
      libraryId: 2,
      path: folder,
      rate: 1,
      trackIndex: 0,
      position: 10,
      playing: true,
    });
    expect(adopted).toBe(true);
    pushSnapshot(snap('playing', 0, 25));
    jest.advanceTimersByTime(LOCAL_SAVE_MS);
    await settle();
    expect(guards()).toEqual([true]);
  });

  it('a checked resume and an explicit place are not guarded', async () => {
    mockLoadInitialProgress.mockResolvedValue({ kind: 'progress', progress: row({ position: 5 }) });
    await start();
    await playedTwoSaves('saved');
    await usePlayer.getState().stop();
    await start(5);
    await playedTwoSaves('saved');
    expect(guards().every((g) => !g)).toBe(true);
  });

  it("an earlier session's save PUT late does not lift the next session's guard", async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    let landed: (o: string) => void = () => {};
    mockSaveProgress.mockImplementationOnce(
      () => new Promise((resolve) => (landed = resolve as (o: string) => void)) as never,
    );
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000);
    await settle();
    await usePlayer.getState().stop();
    await start();
    landed('saved');
    await settle();
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 0, 25));
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(guards().at(-1)).toBe(true);
  });

  it('a finish is never held back', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 5 }),
      unchecked: true,
    });
    await start();
    pushSnapshot(snap('playing', 1, 45));
    await settle();
    usePlayer.getState().finishBook();
    await settle();
    expect(mockSaveProgress.mock.calls.at(-1)?.[1]).toMatchObject({ finished: true });
    expect(mockSaveProgress.mock.calls.at(-1)?.[1]).not.toHaveProperty('guard');
  });
});

describe('with listening_sync', () => {
  // A close with an event waiting its turn behind it (a finish, a paused move) leaves the
  // send to that event's caller, so both go in one batch rather than two requests.
  it('a close with an event waiting behind it leaves the send to that event', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    mockFlushOutbox.mockClear();
    mockWaitingInTurn = true;
    try {
      pushSnapshot(snap('paused', 0, 10));
      await settle();
    } finally {
      mockWaitingInTurn = false;
    }
    expect(mockClosed).toHaveLength(1);
    expect(mockFlushOutbox).not.toHaveBeenCalled();
  });

  // The stop's close waits its turn into the outbox: sent at once, the sign-out's send
  // found the outbox without the last span, which landed after the token was revoked.
  it('a sign-out sends the outbox only once the close of its stop has had its turn', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    mockFlushOutbox.mockClear();
    const order: string[] = [];
    let pass: () => void = () => {};
    mockAppendInTurn.mockImplementationOnce(async (_cid, events) => {
      order.push(`turn ${events.length}`);
      await new Promise<void>((r) => (pass = r));
    });
    mockFlushOutbox.mockImplementation(async () => void order.push('flush'));
    try {
      const leaving = teardownBeforeTokenRevoke('c1');
      await settle();
      expect(mockClosed).toHaveLength(1);
      // Waiting behind the close (which sends by itself when nothing waits behind it); the
      // sign-out's own send has not gone.
      expect(order.at(-1)).toBe('turn 0');
      pass();
      await leaving;
      expect(order.slice(order.indexOf('turn 0'))).toEqual(['turn 0', 'flush']);
      // Its last send, whatever wait a 429 asked: the purge after it drops what is left.
      expect(mockFlushOutbox).toHaveBeenLastCalledWith('c1', { lastChance: true });
    } finally {
      pass();
      mockFlushOutbox.mockImplementation(async () => {});
    }
  });

  // A sign-out's or a removal's last send (`unsentListens`) cuts the span playing through
  // its connection, so that listening is sent or counted before the confirm.
  it("the outbox's last send cuts the span playing through its connection only", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(4_000);
    pushSnapshot(snap('playing', 0, 9));
    cutPlayingSpan('c2');
    await settle();
    expect(mockClosed).toHaveLength(0);
    cutPlayingSpan('c1');
    // Closed at the call, before any await: the outbox's last send waits its turn behind it.
    expect(mockClosed.map((s) => [s.from.pos, s.to.pos])).toEqual([[5, 9]]);
    await settle();
    // Still playing: the next span opens where the cut ended.
    jest.advanceTimersByTime(3_000);
    pushSnapshot(snap('paused', 0, 12));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['resume', 5, 9],
      ['continue', 9, 12],
    ]);
  });

  it('a play to a pause is one span with both file places, and no PUT and no POST /history', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 1, 10));
    pushSnapshot(snap('paused', 1, 10));
    await settle();
    expect(mockClosed).toHaveLength(1);
    expect(mockClosed[0]).toMatchObject({
      connectionId: 'c1',
      libraryId: 2,
      path: folder,
      from: { pos: 5, file: 'A/Folder/2.mp3', filePos: 5 },
      to: { pos: 60, file: 'A/Folder/10.mp3', filePos: 10 },
      duration: 100,
      start: 'resume',
      baseVersion: 41,
    });
    expect(mockSaveProgress).not.toHaveBeenCalled();
    expect(mockClient.addHistory).not.toHaveBeenCalled();
    // The local place is still mirrored, with its file (fe#188).
    expect(mockWriteMirror).toHaveBeenCalledWith(
      expect.objectContaining({ position: 60, file: 'A/Folder/10.mp3', file_pos: 10 }),
    );
    expect(mockFlushOutbox).toHaveBeenCalledWith('c1');
  });

  // (c), data loss: the car (Android) started another book in the engine while this one was
  // paused. Its `playing` opened a span for this book at the other book's place, and the
  // switch to the adopted book closed it: a listen of this book that never happened. A
  // report that names another book is none of this book's.
  it("another book's play opens no span for this book", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    pushSnapshot(snap('paused', 0, 10));
    await settle();
    mockClosed.length = 0;
    mockStoreOpenSpan.mockClear();
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'Another' };
    pushSnapshot(snap('playing', 1, 40));
    jest.advanceTimersByTime(20_000);
    pushSnapshot(snap('playing', 1, 60));
    await settle();
    await usePlayer.getState().stop();
    await settle();
    expect(mockClosed).toEqual([]);
    expect(mockStoreOpenSpan).not.toHaveBeenCalled();
  });

  // The car switched to another book while this one played: this book's listening ends at
  // the other book's first report, where this book was last heard, not when the adoption
  // lands seconds later; and none opens again while the engine plays the other book (the
  // save loop's cut and the open span's keep would reopen one).
  it("another book's first report ends this book's span there", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(5_000);
    pushSnapshot(snap('playing', 0, 10));
    await settle();
    mockStoreOpenSpan.mockClear();
    const switchedAt = Date.now();
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'Another' };
    pushSnapshot(snap('playing', 1, 40));
    await settle();
    expect(mockClosed).toHaveLength(1);
    jest.advanceTimersByTime(30_000);
    pushSnapshot(snap('playing', 1, 70));
    await settle();
    await usePlayer.getState().stop();
    await settle();
    expect(mockClosed).toHaveLength(1);
    expect(mockClosed[0]).toMatchObject({
      path: folder,
      from: { pos: 5 },
      to: { pos: 10 },
      endedAt: new Date(switchedAt).toISOString(),
    });
    expect(mockStoreOpenSpan).not.toHaveBeenCalled();
  });

  describe('an Android Auto start before the store adopts the car book', () => {
    const os = Platform.OS;
    const own = { connectionId: 'c1', libraryId: 2, path: 'Phone' };
    const car = { connectionId: 'c1', libraryId: 2, path: folder };
    const phoneBook = { ...book, rel_path: own.path, duration: 4000 };
    const phoneChapters: ChaptersResponse = {
      ...chapters,
      path: own.path,
      duration: 4000,
      files: [1400, 1400, 1200].map((duration, seq) => ({
        rel_path: `Phone/${seq + 1}.mp3`,
        seq,
        duration,
        format: 'mp3',
        size: 1,
      })),
      chapters: [],
    };
    const phoneTick = (state: PlaybackState, position: number) => ({
      ...snap(state, 0, position),
      duration: 1400,
    });

    /** The car sync's listener, as a binary with the car functions always has one. */
    let offCarSync = () => {};

    beforeEach(() => {
      Platform.OS = 'android';
      offCarSync = onOtherBookReported(() => {});
      const entry = downloadedEntry();
      const third = { rel_path: `${folder}/3.mp3`, seq: 2, duration: 300, format: 'mp3', size: 1 };
      entry.manifest = {
        ...entry.manifest,
        book: { ...book, duration: 400 },
        chapters: { ...chapters, duration: 400, files: [...chapters.files, third], chapters: [] },
        files: [...entry.manifest.files, { relPath: third.rel_path, localUri: 'file:///d/3.mp3' }],
      };
      useDownloads.setState({ entries: { [`c1:2:${folder}`]: entry } });
    });
    afterEach(() => {
      offCarSync();
      Platform.OS = os;
    });

    it.each([
      { state: 'paused', stood: 188.003, jumped: 2977.41, move: true, phoneNamed: true },
      { state: 'paused', stood: 268.936, jumped: 3085.62, move: false, phoneNamed: true },
      { state: 'playing', stood: 350.134, jumped: 2919.09, move: true, phoneNamed: true },
      { state: 'playing', stood: 350.134, jumped: 2919.09, move: true, phoneNamed: false },
    ] as const)(
      'keeps the $state book at $stood through adoption (phone reports named $phoneNamed)',
      async ({ state, stood, jumped, move, phoneNamed }) => {
        await usePlayer.getState().playBook('c1', 2, phoneBook, phoneChapters, stood);
        engineBook = phoneNamed ? own : null;
        pushSnapshot(phoneTick('playing', stood));
        pushSnapshot(phoneTick(state, stood));
        await settle();
        const moves = localMoveCount();
        const told = jest.fn();
        const off = onOtherBookReported(told);
        const shown = new Set<number>();
        const unwatch = usePlayer.subscribe((s) => {
          if (s.nowPlaying?.path === own.path) shown.add(selectBookPosition(s));
        });
        try {
          engineBook = null;
          if (state === 'paused' && move) playAsked();
          // Media3 can report the new queue's position before the car asks to play.
          const position = jumped - 2800; // file 3 on the phone book's timeline
          const carTick = { ...snap(state, 2, position), duration: 300 };
          pushSnapshot(carTick);
          if (state === 'paused' && !move) playAsked();
          if (move) remoteMove(2, position);
          pushSnapshot({ ...carTick, state: 'playing' });
          await settle();
          expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 0, position: stood });
          expect(localMoveCount()).toBe(moves);
          expect(told).toHaveBeenCalled();
          jest.advanceTimersByTime(8_000);
          expect(
            await usePlayer.getState().adoptLoaded({
              ...car,
              trackIndex: 2,
              position,
              rate: 1,
              playing: true,
            }),
          ).toBe(true);
          await settle();
          expect(usePlayer.getState().nowPlaying?.path).toBe(car.path);
          expect([...shown].every((position) => position === stood)).toBe(true);
          expect(mockClosed.filter((s) => s.path === own.path).map((s) => s.to.pos)).toEqual([
            stood,
          ]);
          expect(mockAppended).toEqual([]);
          expect(mockWriteMirror.mock.calls.map(([save]) => save)).not.toContainEqual(
            expect.objectContaining({ path: own.path, position: jumped }),
          );
          pushSnapshot({ ...carTick, state: 'paused', position: position + 1 });
          await settle();
          expect(mockClosed.at(-1)).toMatchObject({
            path: car.path,
            to: { filePos: position + 1 },
          });
        } finally {
          unwatch();
          off();
        }
      },
    );

    it("counts the car UI's seek on the phone book while an outside play is pending", async () => {
      await usePlayer.getState().playBook('c1', 2, phoneBook, phoneChapters, 188.003);
      engineBook = own;
      pushSnapshot(phoneTick('playing', 188.003));
      pushSnapshot(phoneTick('paused', 188.003));
      playAsked();
      const moves = localMoveCount();
      remoteMove(0, 42);
      pushSnapshot(phoneTick('paused', 42));
      await settle();
      expect(localMoveCount()).toBe(moves + 1);
      expect(usePlayer.getState().snapshot.position).toBe(42);
      expect(mockAppended).toContainEqual(
        expect.objectContaining({ path: own.path, from_pos: 42, to_pos: 42 }),
      );
    });

    it('counts a seek on the queue that lost its name once the read confirms the book', async () => {
      await usePlayer.getState().playBook('c1', 2, phoneBook, phoneChapters, 300);
      engineBook = own;
      pushSnapshot(phoneTick('playing', 300));
      await settle();
      // The engine holds the phone book again in a queue that names none, and is moved back.
      engineBook = null;
      const moves = localMoveCount();
      remoteMove(0, 100);
      pushSnapshot(phoneTick('playing', 100));
      expect(usePlayer.getState().snapshot.position).toBe(300);
      pendingBookConfirmation()?.({ ...own, trackIndex: 0, position: 101, rate: 1, playing: true });
      await settle();
      expect(localMoveCount()).toBe(moves + 1);
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', position: 101 });
    });

    it('takes an unnamed outside play of the paused book while no car sync listens', async () => {
      offCarSync();
      await usePlayer.getState().playBook('c1', 2, phoneBook, phoneChapters, 188.003);
      engineBook = null;
      pushSnapshot(phoneTick('playing', 188.003));
      pushSnapshot(phoneTick('paused', 188.003));
      await settle();
      // A headset play on a binary without the car functions: nothing could identify it.
      playAsked();
      pushSnapshot(phoneTick('playing', 189));
      await settle();
      expect(pendingBookConfirmation()).toBeNull();
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', position: 189 });
    });

    it('counts an unnamed seek once the engine confirms the paused book owns it', async () => {
      await usePlayer
        .getState()
        .adoptLoaded({ ...car, trackIndex: 0, position: 30, rate: 1, playing: false });
      playAsked();
      pushSnapshot(snap('loading', 0, 30));
      const beforeSeek = pendingBookConfirmation();
      const moves = localMoveCount();
      remoteMove(0, 15);
      pushSnapshot(snap('playing', 0, 15));
      const afterSeek = pendingBookConfirmation();
      const confirmed = { ...car, trackIndex: 0, position: 16, rate: 1, playing: true };
      beforeSeek?.({ ...confirmed, position: 30 });
      expect(localMoveCount()).toBe(moves);
      expect(usePlayer.getState().snapshot.position).toBe(30);
      afterSeek?.(confirmed);
      await settle();
      expect(localMoveCount()).toBe(moves + 1);
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', position: 16 });
      expect(mockAppended).toContainEqual(expect.objectContaining({ path: car.path, to_pos: 16 }));
    });

    it('keeps a seek in the app made while the engine was identifying the book', async () => {
      const loaded = { ...car, trackIndex: 0, position: 30, rate: 1, playing: false };
      await usePlayer.getState().adoptLoaded(loaded);
      playAsked();
      pushSnapshot(snap('loading', 0, 30));
      const confirm = pendingBookConfirmation();
      const moves = localMoveCount();
      await usePlayer.getState().seekBook(12);
      expect(mockSvc.skipToTrack).not.toHaveBeenCalled();
      confirm?.(loaded);
      await settle();
      expect(mockSvc.skipToTrack).toHaveBeenCalledWith(0, 12);
      expect(localMoveCount()).toBe(moves + 1);
      expect(usePlayer.getState().snapshot.position).toBe(12);
    });

    it('keeps the book ended when the read confirms an engine that played it out', async () => {
      const loaded = { ...car, trackIndex: 0, position: 30, rate: 1, playing: false };
      await usePlayer.getState().adoptLoaded(loaded);
      playAsked();
      pushSnapshot(snap('loading', 0, 30));
      const end = { ...snap('ended', 2, 300), duration: 300 };
      pushSnapshot(end);
      const confirm = pendingBookConfirmation();
      (mockSvc.getSnapshot as jest.Mock).mockImplementation(() => ({ ...end }));
      try {
        confirm?.({ ...loaded, trackIndex: 2, position: 300 });
        await settle();
        expect(usePlayer.getState().snapshot).toMatchObject({ state: 'ended', trackIndex: 2 });
      } finally {
        (mockSvc.getSnapshot as jest.Mock).mockImplementation(() => ({ ...INITIAL }));
      }
    });

    it('requires adoption before taking a confirmed place in a different file order', async () => {
      const loaded = { ...car, trackIndex: 0, position: 30, rate: 1, playing: false };
      await usePlayer.getState().adoptLoaded(loaded);
      playAsked();
      pushSnapshot(snap('playing', 2, 45));
      const confirm = pendingBookConfirmation();
      expect(
        confirm?.({ ...loaded, trackIndex: 2, position: 45, files: [`${folder}/3.mp3`, ...order] }),
      ).toBe('adopt');
      expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 0, position: 30 });
    });
  });

  it('the 15 s tick cuts the span while reachable; the next one continues', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 20));
    jest.advanceTimersByTime(21_000);
    await settle();
    pushSnapshot(snap('paused', 0, 30));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['resume', 5, 20],
      ['continue', 20, 30],
    ]);
    // Past the history minimum, still no POST /history: the spans are the history.
    expect(mockClient.addHistory).not.toHaveBeenCalled();
  });

  it('a seek while playing ends the span where it was; the next begins with the move', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    await settle();
    await usePlayer.getState().seekBook(70);
    pushSnapshot(snap('playing', 1, 20));
    await usePlayer.getState().seekBook(10);
    pushSnapshot(snap('playing', 0, 10));
    pushSnapshot(snap('paused', 0, 12));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['resume', 30, 30],
      ['jump', 70, 70],
      ['moved_back', 10, 12],
    ]);
  });

  it('a seek while paused sends the move as a span of its own', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    pushSnapshot(snap('paused', 0, 30));
    await settle();
    await usePlayer.getState().seekBook(80);
    await settle();
    expect(mockAppended).toEqual([
      expect.objectContaining({
        kind: 'listen',
        from_pos: 80,
        to_pos: 80,
        to_file: 'A/Folder/10.mp3',
        to_file_pos: 30,
        start: 'jump',
        base_version: 41,
      }),
    ]);
  });

  it('a pause right behind a seek: the next play begins with the move too', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    await settle();
    jest.advanceTimersByTime(5_000);
    await usePlayer.getState().seekBook(10);
    // Nothing heard after the move: a bare move, sent as one.
    pushSnapshot(snap('paused', 0, 10));
    await settle();
    pushSnapshot(snap('playing', 0, 10));
    jest.advanceTimersByTime(4_000);
    pushSnapshot(snap('paused', 0, 14));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['resume', 30, 30],
      ['moved_back', 10, 10],
      ['moved_back', 10, 14],
    ]);
    // Taken once: the play after that is a resume.
    pushSnapshot(snap('playing', 0, 14));
    jest.advanceTimersByTime(2_000);
    pushSnapshot(snap('paused', 0, 16));
    await settle();
    expect(mockClosed.at(-1)?.start).toBe('resume');
  });

  it('a cut right behind a seek carries the move; Stay asked for there still begins a jump', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    await settle();
    await usePlayer.getState().seekBook(10);
    pushSnapshot(snap('playing', 0, 10));
    cutListeningSpanNow();
    jest.advanceTimersByTime(3_000);
    pushSnapshot(snap('playing', 0, 13));
    await usePlayer.getState().seekBook(40);
    pushSnapshot(snap('playing', 0, 40));
    standByPlace();
    jest.advanceTimersByTime(2_000);
    pushSnapshot(snap('paused', 0, 42));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['resume', 30, 30],
      ['moved_back', 10, 10],
      ['moved_back', 10, 13],
      ['jump', 40, 40],
      ['jump', 40, 42],
    ]);
  });

  it('a move to where the place already is (Previous at the start) sends nothing', async () => {
    await start();
    pushSnapshot(snap('paused', 0, 0));
    await settle();
    await usePlayer.getState().seekBook(0);
    // A seek lands a hair off the place it was asked for.
    await usePlayer.getState().seekInTrack(0.004);
    await usePlayer.getState().goToTrack(0);
    await settle();
    expect(mockAppended).toEqual([]);
    expect(mockClosed).toEqual([]);
  });

  it('playing, a move to where the place is leaves the span open', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 20));
    await settle();
    await usePlayer.getState().seekBook(20);
    expect(mockClosed).toEqual([]);
    jest.advanceTimersByTime(5_000);
    pushSnapshot(snap('paused', 0, 25));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 20, 25]]);
  });

  it('a seek still on its way: a move back to where the engine reports is a move', async () => {
    await start();
    pushSnapshot(snap('paused', 0, 0));
    await settle();
    // The engine has not reported the first seek's landing when the second is asked for.
    await usePlayer.getState().seekBook(30);
    await usePlayer.getState().seekBook(0);
    await settle();
    expect(mockAppended.map((e) => e.kind === 'listen' && [e.start, e.to_pos])).toEqual([
      ['jump', 30],
      ['moved_back', 0],
    ]);
  });

  it('two seeks before the first landing close each playing span at its own target', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 0));
    let land = () => {};
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (land = resolve)),
    );
    const first = usePlayer.getState().seekBook(30);
    await settle();
    await usePlayer.getState().seekBook(0);
    pushSnapshot(snap('playing', 0, 0)); // stationary before either landing
    pushSnapshot(snap('playing', 0, 30)); // the first seek reports late
    land();
    await first;
    usePlayer.getState().finishBook();
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['resume', 0, 0],
      ['jump', 30, 30],
      ['moved_back', 0, 0],
    ]);
  });

  it('two skip presses while the first seek is out add up across files', async () => {
    await start();
    pushSnapshot(snap('paused', 0, 0));
    await Promise.all([usePlayer.getState().skipSeconds(30), usePlayer.getState().skipSeconds(30)]);
    expect(mockSvc.seekTo).toHaveBeenCalledWith(30);
    expect(mockSvc.skipToTrack).toHaveBeenCalledWith(1, 10);
  });

  it('a seek refused after a save tick leaves Retry at the heard place', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    let refuse = () => {};
    (mockSvc.skipToTrack as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((_, reject) => (refuse = () => reject(new Error('refused')))),
    );
    const seeking = usePlayer.getState().seekBook(90);
    await settle();
    jest.advanceTimersByTime(15_000);
    expect(mockWriteMirror).not.toHaveBeenCalledWith(expect.objectContaining({ position: 90 }));
    refuse();
    await expect(seeking).rejects.toThrow('refused');
    pushSnapshot(snap('error', 0, 6));
    await settle();
    expect(mockWriteMirror.mock.lastCall?.[0]).toMatchObject({ position: 6 });
    await usePlayer.getState().retry();
    expect((mockSvc.load as jest.Mock).mock.lastCall.slice(1, 3)).toEqual([0, 6]);
  });

  it('a Cast checkpoint saves the receiver without choosing a place or interrupting a seek', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 10));
    const moves = localMoveCount();
    remoteMove(0, 10, true);
    await settle();
    expect(mockWriteMirror.mock.lastCall?.[0]).toMatchObject({ position: 10 });
    expect(localMoveCount()).toBe(moves);
    await usePlayer.getState().seekBook(30);
    remoteMove(0, 10, true);
    await usePlayer.getState().seekBook(0);
    pushSnapshot(snap('paused', 0, 0));
    expect(localMoveCount()).toBe(moves + 2);
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['resume', 10, 10],
      ['jump', 30, 30],
      ['moved_back', 0, 0],
    ]);
  });

  it('a move to zero during Retry is measured from the reload target', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    pushSnapshot(snap('error', 0, 30));
    let loaded = () => {};
    (mockSvc.load as jest.Mock).mockImplementationOnce(() => {
      pushSnapshot(snap('loading', 0, 0));
      return new Promise<void>((resolve) => (loaded = resolve));
    });
    const retry = usePlayer.getState().retry();
    await settle();
    expect(usePlayer.getState().snapshot.position).toBe(0);
    await usePlayer.getState().seekBook(0);
    loaded();
    await retry;
    expect(mockAppended.map((e) => e.kind === 'listen' && [e.start, e.to_pos])).toEqual([
      ['moved_back', 0],
    ]);
  });

  it('a refused second seek leaves the first outstanding move as the place', async () => {
    await start();
    pushSnapshot(snap('paused', 0, 0));
    let land = () => {};
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (land = resolve)),
    );
    const first = usePlayer.getState().seekBook(30);
    (mockSvc.skipToTrack as jest.Mock).mockRejectedValueOnce(new Error('refused'));
    await expect(usePlayer.getState().seekBook(60)).rejects.toThrow('refused');
    await usePlayer.getState().seekBook(0);
    land();
    await first;
    expect(mockAppended.at(-1)).toMatchObject({ start: 'moved_back', to_pos: 0 });
  });

  it.each([false, true])(
    'normal saves and span cuts resume when playback passes a hung seek (overlap %s)',
    async (overlap) => {
      await start();
      pushSnapshot(snap('playing', 0, 10));
      if (overlap) {
        (mockSvc.seekTo as jest.Mock).mockImplementationOnce(() => new Promise<void>(() => {}));
        void usePlayer.getState().seekBook(18);
      }
      (mockSvc.seekTo as jest.Mock).mockImplementationOnce(() => new Promise<void>(() => {}));
      void usePlayer.getState().seekBook(20);
      await settle();
      if (overlap) pushSnapshot(snap('playing', 0, 20));
      jest.setSystemTime(Date.now() + 15_000);
      pushSnapshot(snap('playing', 0, 34));
      await settle();
      expect(mockWriteMirror.mock.lastCall?.[0]).toMatchObject({ position: 34 });
      expect(mockClosed.at(-1)).toMatchObject({
        start: 'jump',
        from: { pos: 20 },
        to: { pos: 34 },
      });
    },
  );

  it.each([40, 2])(
    'a hung seek to %i the engine never took gives way to the place it plays on at',
    async (target) => {
      await start();
      pushSnapshot(snap('playing', 0, 10));
      (mockSvc.seekTo as jest.Mock).mockImplementationOnce(() => new Promise<void>(() => {}));
      void usePlayer.getState().seekBook(target);
      await settle();
      jest.setSystemTime(Date.now() + 15_000);
      pushSnapshot(snap('playing', 0, 25));
      await settle();
      jest.setSystemTime(Date.now() + 15_000);
      pushSnapshot(snap('playing', 0, 40.5));
      await settle();
      expect(mockWriteMirror.mock.lastCall?.[0]).toMatchObject({ position: 40.5 });
      expect(mockClosed.at(-1)).toMatchObject({ to: { pos: 40.5 } });
    },
  );

  // Given up on, the seek's call can still land: the engine goes to the listener's target, far
  // behind the place it played on to. That is the listener's move, not a slip back, and the
  // span opened at the target before it was given up claims nothing the engine played.
  it('a hung seek back that lands after it was given up is the listener’s move', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 100));
    await settle();
    let land = () => {};
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (land = resolve)),
    );
    void usePlayer.getState().seekBook(2);
    await settle();
    jest.setSystemTime(Date.now() + 15_000);
    pushSnapshot(snap('playing', 0, 115));
    await settle();
    jest.setSystemTime(Date.now() + 15_000);
    pushSnapshot(snap('playing', 0, 130));
    await settle();
    expect(mockWriteMirror.mock.lastCall?.[0]).toMatchObject({ position: 130 });
    land();
    await settle();
    pushSnapshot(snap('playing', 0, 2));
    await settle();
    jest.setSystemTime(Date.now() + 15_000);
    pushSnapshot(snap('playing', 0, 17));
    await settle();
    expect(mockWriteMirror.mock.lastCall?.[0]).toMatchObject({ position: 17 });
    const spans = mockClosed.map((c) => [c.from.pos, c.to.pos, c.start]);
    expect(spans).toContainEqual([2, 2, 'moved_back']);
    expect(spans).toContainEqual([115, 130, 'jump']);
    expect(spans).toContainEqual([2, 17, 'moved_back']);
    expect(spans.filter(([from, to]) => from === 2 && to === 115)).toEqual([]);
  });

  it('a stop while a seek is still landing saves the place its span closed at', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 10));
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(() => new Promise<void>(() => {}));
    void usePlayer.getState().seekBook(40);
    await settle();
    await usePlayer.getState().stop();
    expect(mockClosed.at(-1)).toMatchObject({ start: 'jump', to: { pos: 40 } });
    expect(mockWriteMirror.mock.lastCall?.[0]).toMatchObject({ position: 40 });
  });

  it('a switch to another book while a seek is still landing saves its target', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 10));
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(() => new Promise<void>(() => {}));
    void usePlayer.getState().seekBook(40);
    await settle();
    mockWriteMirror.mockClear();
    await usePlayer
      .getState()
      .playBook('c1', 2, { ...book, rel_path: 'Other/Book', title: 'Other' }, undefined);
    await settle();
    expect(mockWriteMirror).toHaveBeenCalledWith(
      expect.objectContaining({ path: folder, position: 40 }),
    );
  });

  it('a refused seek never brings back an older call a later landed seek superseded', async () => {
    await start();
    pushSnapshot(snap('paused', 0, 0));
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(() => new Promise<void>(() => {}));
    void usePlayer.getState().seekBook(10);
    await settle();
    await usePlayer.getState().seekBook(30);
    pushSnapshot(snap('paused', 0, 30));
    (mockSvc.seekTo as jest.Mock).mockRejectedValueOnce(new Error('refused'));
    await expect(usePlayer.getState().seekBook(40)).rejects.toThrow('refused');
    await usePlayer.getState().stop();
    expect(mockWriteMirror.mock.lastCall?.[0]).toMatchObject({ position: 30 });
  });

  it('a paused seek still waiting after ten seconds keeps its target across stale reports', async () => {
    await start();
    pushSnapshot(snap('paused', 0, 30));
    let land = () => {};
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (land = resolve)),
    );
    const first = usePlayer.getState().seekBook(15);
    await settle();
    jest.advanceTimersByTime(20_000);
    pushSnapshot(snap('paused', 0, 30));
    await usePlayer.getState().seekBook(20);
    land();
    await first;
    expect(mockAppended.map((e) => e.kind === 'listen' && [e.start, e.to_pos])).toEqual([
      ['moved_back', 15],
      ['jump', 20],
    ]);
  });

  describe('a book whose file lengths are unknown (every file starts at 0)', () => {
    const unknown: ChaptersResponse = {
      ...chapters,
      duration: 0,
      files: chapters.files.map((f) => ({ ...f, duration: 0 })),
      chapters: [],
    };
    const startUnknown = async () => {
      await usePlayer.getState().playBook('c1', 2, { ...book, duration: 0 }, unknown);
      await settle();
    };

    it('two skips use the pending file position on a book without lengths', async () => {
      await startUnknown();
      pushSnapshot({ ...snap('paused', 0, 0), duration: 0 });
      await Promise.all([
        usePlayer.getState().skipSeconds(30),
        usePlayer.getState().skipSeconds(30),
      ]);
      expect((mockSvc.seekTo as jest.Mock).mock.calls).toEqual([[30], [60]]);
    });

    it('paused, a move to the next file is a move', async () => {
      await startUnknown();
      pushSnapshot(snap('paused', 0, 0));
      await settle();
      await usePlayer.getState().goToTrack(1);
      await settle();
      expect(mockAppended.map((e) => e.kind === 'listen' && [e.start, e.to_file])).toEqual([
        ['jump', order[1]],
      ]);
    });

    it('playing, a move to the next file closes the span in the file it left', async () => {
      await startUnknown();
      pushSnapshot(snap('playing', 0, 0));
      await settle();
      await usePlayer.getState().goToTrack(1);
      await settle();
      expect(mockClosed.map((s) => [s.start, s.from.file, s.to.file])).toEqual([
        ['resume', order[0], order[0]],
      ]);
    });
  });

  // fe#211: the native engine tells the store of the move before its landed place reaches
  // the snapshot (`service.native.ts`); the move's save waits for that place.
  it('saves a lock-screen move at its landed place, told before the snapshot takes it', async () => {
    mockSync = false;
    await start();
    pushSnapshot(snap('playing', 0, 10));
    await settle();
    mockSaveProgress.mockClear();
    remoteMove(0, 40);
    pushSnapshot(snap('playing', 0, 40));
    await settle();
    expect(mockSaveProgress.mock.calls.map((c) => (c[1] as { position: number }).position)).toEqual(
      [40],
    );
  });

  // A pause inside the native engine's wait for a jump's move: the pause saves the place
  // before the jump, and the place the engine then lands at with no move told is saved too.
  it('saves a place that lands after the pause, with no move told', async () => {
    mockSync = false;
    await start();
    pushSnapshot(snap('playing', 0, 10));
    pushSnapshot(snap('paused', 0, 10));
    await settle();
    expect(mockSaveProgress.mock.calls.map((c) => (c[1] as { position: number }).position)).toEqual(
      [10],
    );
    mockSaveProgress.mockClear();
    pushSnapshot(snap('paused', 0, 70));
    landed();
    await settle();
    expect(mockSaveProgress.mock.calls.map((c) => (c[1] as { position: number }).position)).toEqual(
      [70],
    );
  });

  // The tick that landed was another book's (the car started it in the engine): nothing of
  // this book moved, so nothing of it is saved again, dated now.
  it("saves nothing when the place that lands is another book's", async () => {
    mockSync = false;
    await start();
    pushSnapshot(snap('playing', 0, 10));
    pushSnapshot(snap('paused', 0, 10));
    await settle();
    mockSaveProgress.mockClear();
    engineBook = { connectionId: 'c1', libraryId: 2, path: 'Another' };
    pushSnapshot(snap('paused', 0, 70));
    landed();
    await settle();
    expect(mockSaveProgress).not.toHaveBeenCalled();
  });

  it('paused, a lock-screen move the engine already made is sent', async () => {
    await start();
    pushSnapshot(snap('paused', 0, 20));
    await settle();
    pushSnapshot(snap('paused', 0, 5));
    remoteMove(0, 5);
    await settle();
    expect(mockAppended.map((e) => e.kind === 'listen' && [e.start, e.to_pos])).toEqual([
      ['jump', 5],
    ]);
  });

  it('an explicit 0 is a restart; an explicit place is a jump', async () => {
    await start(0);
    pushSnapshot(snap('playing', 0, 1));
    pushSnapshot(snap('paused', 0, 4));
    await settle();
    await usePlayer.getState().stop();
    await start(40);
    pushSnapshot(snap('playing', 0, 40));
    pushSnapshot(snap('paused', 0, 45));
    await settle();
    expect(mockClosed.map((s) => s.start)).toEqual(['restart', 'jump']);
  });

  it('a finished book started again sends unfinish, then a restart span', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 100, finished: true, version: 9, device_id: 'phone' }),
    });
    await start();
    pushSnapshot(snap('playing', 0, 0.5));
    await settle();
    pushSnapshot(snap('paused', 0, 6));
    await settle();
    expect(mockAppended).toEqual([
      expect.objectContaining({ kind: 'unfinish', library_id: 2, path: folder, base_version: 41 }),
    ]);
    // In turn: behind a finish of the book still waiting its own (`appendInTurn`).
    expect(mockAppendInTurn).toHaveBeenCalledWith(
      'c1',
      [expect.objectContaining({ kind: 'unfinish' })],
      expect.any(Function),
    );
    expect(mockFlushOutbox).toHaveBeenCalledWith('c1');
    expect(mockClosed.map((s) => s.start)).toEqual(['restart']);
    // Resumed from the server's row: its version is acknowledged.
    expect(mockAckVersion).toHaveBeenCalledWith('c1', 2, folder, 9, expect.anything());
  });

  it('the natural end closes the span, then sends finish once', async () => {
    await start();
    pushSnapshot(snap('playing', 1, 45));
    await settle();
    pushSnapshot(snap('ended', 1, 50));
    await settle();
    usePlayer.getState().finishBook();
    await settle();
    expect(mockClosed).toHaveLength(1);
    expect(mockAppended.filter((e) => e.kind === 'finish')).toHaveLength(1);
  });

  // server#359: a 12 s book's finish was sent before its only span, in a batch of its own.
  // fe#258: the finish then waited in memory for the close to land, where neither a kill
  // nor the page's keepalive saw it; now it is the outbox's at once, behind the close.
  it('a short book ends: its span closes, then the finish goes to the outbox behind it at once', async () => {
    const order: string[] = [];
    let land = () => {};
    (closeSpan as jest.Mock).mockImplementationOnce((closing: OpenSpan) => {
      order.push('close');
      mockClosed.push(structuredClone(closing));
      return new Promise<void>((resolve) => (land = resolve));
    });
    mockAppendInTurn.mockImplementationOnce(async (...a) => {
      order.push(...a[1].map((e) => e.kind));
      await appendedInTurn(...a);
    });
    await start();
    pushSnapshot(snap('playing', 0, 0));
    await settle();
    jest.advanceTimersByTime(12_000);
    pushSnapshot(snap('ended', 1, 50));
    await settle(20);
    // The close has not landed: the finish waits behind it in the outbox, not here.
    expect(order).toEqual(['close', 'finish']);
    land();
    await settle();
    expect(mockAppended).toEqual([
      expect.objectContaining({ kind: 'finish', library_id: 2, path: folder, base_version: 41 }),
    ]);
    // The finish is dated at or after the span's end.
    const finish = mockAppended[0] as { at: string };
    expect(Date.parse(finish.at)).toBeGreaterThanOrEqual(Date.parse(mockClosed[0].endedAt));
    expect(mockFlushOutbox).toHaveBeenCalledWith('c1');
  });

  // The web reports `paused` for the last file before `ended`: that pause's close was still
  // on its way into the outbox when the end's finish was appended, and went after it.
  it('a close still on its way at the end goes before the finish', async () => {
    const order: string[] = [];
    (closeSpan as jest.Mock).mockImplementationOnce((closing: OpenSpan) => {
      order.push('close');
      mockClosed.push(structuredClone(closing));
      return new Promise<void>(() => {}); // never lands while the finish is handed over
    });
    mockAppendInTurn.mockImplementationOnce(async (...a) => {
      order.push(...a[1].map((e) => e.kind));
      await appendedInTurn(...a);
    });
    await start();
    pushSnapshot(snap('playing', 0, 0));
    await settle();
    jest.advanceTimersByTime(12_000);
    pushSnapshot(snap('paused', 1, 50));
    pushSnapshot(snap('ended', 1, 50));
    await settle(30);
    expect(order).toEqual(['close', 'finish']);
    expect(mockClosed).toHaveLength(1);
  });

  it('a finish still goes when its span could not be stored', async () => {
    (closeSpan as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('storage full');
    });
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('ended', 1, 50));
    await settle(12);
    expect(mockAppended.map((e) => e.kind)).toEqual(['finish']);
    expect(mockFlushOutbox).toHaveBeenCalledWith('c1');
  });

  it('after Stay, the next span begins as a jump', async () => {
    await start();
    standByPlace();
    pushSnapshot(snap('playing', 0, 5));
    pushSnapshot(snap('paused', 0, 9));
    await settle();
    expect(mockClosed.map((s) => s.start)).toEqual(['jump']);
  });

  // Stay wins (row 9c-2): on a `listening_stay` server the Stay is a `stay` span.
  describe('Stay on a listening_stay server', () => {
    beforeEach(() => {
      mockStay = true;
    });

    // Waiting for the next cut let the other device's sync answers offer this place from
    // before the Stay meanwhile (and use up its once-in-10-minutes offer).
    it('playing, the Stay is sent at once on the version answered; the play goes on as a jump', async () => {
      await start();
      pushSnapshot(snap('playing', 0, 30));
      await settle();
      jest.advanceTimersByTime(4_000);
      pushSnapshot(snap('playing', 0, 34));
      mockReadMirror.mockResolvedValue({ ack_version: 57 });
      // The span closing ahead of it goes into the outbox first: the Stay is handed over
      // after it, to wait its turn behind it there (`appendInTurn`).
      const order: string[] = [];
      (closeSpan as jest.Mock).mockImplementationOnce(async (span: OpenSpan) => {
        order.push('close');
        mockClosed.push(structuredClone(span));
      });
      mockAppendInTurn.mockImplementationOnce(async (...a) => {
        order.push('stay');
        await appendedInTurn(...a);
      });
      standByPlace();
      await settle();
      expect(order).toEqual(['close', 'stay']);
      // The copy waiting its turn (the web's `pagehide` sends it) carries the closed span's
      // base, not 0: on 0 the server read the Stay as made before every write it holds.
      expect(mockAppendInTurn.mock.calls[0][1][0]).toMatchObject({ base_version: 41 });
      expect(mockAppended).toHaveLength(1);
      expect(mockAppended[0]).toMatchObject({
        kind: 'listen',
        start: 'stay',
        from_pos: 34,
        to_pos: 34,
        base_version: 57,
      });
      const e = mockAppended[0] as Extract<ListeningEvent, { kind: 'listen' }>;
      expect(e.started_at).toBe(e.ended_at);
      expect(mockFlushOutbox).toHaveBeenCalledWith('c1');
      jest.advanceTimersByTime(3_000);
      pushSnapshot(snap('paused', 0, 37));
      await settle();
      // Nothing heard twice: the span before ends where the Stay is, the next begins there.
      expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
        ['resume', 30, 34],
        ['jump', 34, 37],
      ]);
    });

    it('paused, a span that moved nowhere is sent at once on the version answered', async () => {
      await start();
      pushSnapshot(snap('paused', 1, 20));
      await settle();
      mockReadMirror.mockResolvedValue({ ack_version: 57 });
      standByPlace();
      await settle();
      expect(mockAppended).toHaveLength(1);
      expect(mockAppended[0]).toMatchObject({
        kind: 'listen',
        start: 'stay',
        from_pos: 70,
        to_pos: 70,
        from_file: 'A/Folder/10.mp3',
        from_file_pos: 20,
        base_version: 57,
      });
      const e = mockAppended[0] as Extract<ListeningEvent, { kind: 'listen' }>;
      expect(e.started_at).toBe(e.ended_at);
      expect(mockFlushOutbox).toHaveBeenCalledWith('c1');
      // A bare move: the next play carries it, as a jump (the Stay went; a second `stay`
      // at a later play would beat what another device chose since).
      pushSnapshot(snap('playing', 1, 20));
      jest.advanceTimersByTime(2_000);
      pushSnapshot(snap('paused', 1, 22));
      await settle();
      expect(mockClosed.map((s) => s.start)).toEqual(['jump']);
    });

    it('a playing Stay paused before anything was heard gives the next play a jump', async () => {
      await start();
      pushSnapshot(snap('playing', 0, 30));
      await settle();
      jest.advanceTimersByTime(4_000);
      pushSnapshot(snap('playing', 0, 34));
      standByPlace();
      pushSnapshot(snap('paused', 0, 34));
      await settle();
      pushSnapshot(snap('playing', 0, 34));
      jest.advanceTimersByTime(2_000);
      pushSnapshot(snap('paused', 0, 36));
      await settle();
      expect(mockAppended.map((e) => e.kind === 'listen' && e.start)).toEqual(['stay']);
      expect(mockClosed.map((s) => s.start)).toEqual(['resume', 'jump', 'jump']);
    });

    it('paused with no place to send, nothing goes and the next play is a jump', async () => {
      await start();
      pushSnapshot(snap('paused', 0, NaN));
      await settle();
      standByPlace();
      await settle();
      expect(mockAppended).toEqual([]);
      pushSnapshot(snap('playing', 0, 5));
      jest.advanceTimersByTime(2_000);
      pushSnapshot(snap('paused', 0, 7));
      await settle();
      expect(mockClosed.map((s) => s.start)).toEqual(['jump']);
    });

    // Playing with no span open (the load held the place): the Stay waits for the one the
    // keep opens, but only while this play goes on.
    const playingWithNoneOpen = async () => {
      (mockSvc.load as jest.Mock).mockImplementationOnce(async () => {
        pushSnapshot(snap('playing', 0, 5)); // Android keeps playWhenReady through a load
      });
      await start();
      pushSnapshot(snap('playing', 0, 8));
    };

    it('playing with none open, the Stay goes at once and the span that opens is a jump', async () => {
      await playingWithNoneOpen();
      standByPlace();
      await settle();
      expect(mockAppended.map((e) => e.kind === 'listen' && [e.start, e.from_pos])).toEqual([
        ['stay', 8],
      ]);
      jest.advanceTimersByTime(5_000);
      await settle();
      pushSnapshot(snap('paused', 0, 25));
      await settle();
      expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['jump', 8, 25]]);
    });

    // Playing with no place to send now (not a place: the engine's NaN): the next span is the
    // Stay, but only while this play goes on.
    it('playing with no place to send, the span that opens is the stay', async () => {
      await playingWithNoneOpen();
      pushSnapshot(snap('playing', 0, NaN));
      standByPlace();
      await usePlayer.getState().setRate(1.5); // a cut with none open leaves it waiting
      await settle();
      expect(mockAppended).toEqual([]);
      pushSnapshot(snap('playing', 0, 8));
      jest.advanceTimersByTime(5_000);
      await settle();
      pushSnapshot(snap('paused', 0, 25));
      await settle();
      expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['stay', 8, 25]]);
    });

    it('a play that ends before that span opened leaves the next play a jump', async () => {
      await playingWithNoneOpen();
      pushSnapshot(snap('playing', 0, NaN));
      standByPlace();
      pushSnapshot(snap('paused', 0, 9));
      await settle();
      // Much later: a `stay` now would beat what another device chose since.
      jest.advanceTimersByTime(60 * 60_000);
      pushSnapshot(snap('playing', 0, 9));
      jest.advanceTimersByTime(2_000);
      pushSnapshot(snap('paused', 0, 11));
      await settle();
      expect(mockAppended).toEqual([]);
      expect(mockClosed.map((s) => s.start)).toEqual(['jump']);
    });
  });

  it('without listening_stay a paused Stay is sent at once as a jump', async () => {
    await start();
    pushSnapshot(snap('paused', 0, 20));
    await settle();
    standByPlace();
    await settle();
    expect(mockAppended.map((e) => e.kind === 'listen' && [e.start, e.from_pos])).toEqual([
      ['jump', 20],
    ]);
  });

  it('the web page going closes the span and sends it with keepalive', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 25));
    flushHistoryOnHide(true);
    expect(mockSendOnPageHide).toHaveBeenCalledTimes(1);
    const [extra, deviceId] = mockSendOnPageHide.mock.calls[0] as [
      { connectionId: string; event: ListeningEvent }[],
      string,
    ];
    expect(deviceId).toBe('dev-1');
    expect(extra).toEqual([
      {
        connectionId: 'c1',
        event: expect.objectContaining({ kind: 'listen', from_pos: 5, to_pos: 25 }),
      },
    ]);
    expect(mockClient.addHistory).not.toHaveBeenCalled();
  });
});

// fe#208: the book page's Mark as finished is a `finish` event on a Sync v2 server.
describe('Mark as finished outside the player (finish-route)', () => {
  const ref = { connectionId: 'c1', libraryId: 2, path: folder, position: 100, duration: 100 };
  const undoRef = { connectionId: 'c1', libraryId: 2, path: 'Other/Book', position: 48 };

  it('finishing a still-playing book immediately after a seek ends the move at its target', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    await usePlayer.getState().seekBook(10);
    await expect(recordFinishEvent(ref)).resolves.toEqual(expect.any(Object));
    expect(mockClosed.at(-1)).toMatchObject({
      start: 'moved_back',
      from: { pos: 10 },
      to: { pos: 10 },
    });
    expect(mockAppended.map((e) => e.kind)).toEqual(['finish']);
    // A play that remained loaded past the finish resumes. The seek was already heard.
    pushSnapshot(snap('playing', 0, 10));
    jest.advanceTimersByTime(5_000);
    pushSnapshot(snap('paused', 0, 14));
    await settle();
    expect(mockClosed.at(-1)).toMatchObject({
      start: 'resume',
      from: { pos: 10 },
      to: { pos: 14 },
    });
  });

  it('the loaded, playing book: its span closes first, then the finish; the mirror reads finished', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 9));
    await expect(recordFinishEvent(ref)).resolves.toEqual(expect.any(Object));
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 5, 9]]);
    expect(mockAppended.map((e) => e.kind)).toEqual(['finish']);
    expect(mockWriteMirror).toHaveBeenCalledWith(
      expect.objectContaining({ path: folder, finished: true, position: 100, duration: 100 }),
    );
    expect(mockSaveProgress).not.toHaveBeenCalled();
    // Playback continued past the Mark before the periodic keep or save ran.
    pushSnapshot(snap('playing', 0, 13));
    jest.advanceTimersByTime(4_000);
    pushSnapshot(snap('paused', 0, 24));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['resume', 5, 9],
      ['resume', 9, 24],
    ]);
  });

  // fe#258: left playing, the book recorded listening past its finish, and a later save of
  // the engine's place (a reconcile's held save on reconnect) put the device record back in
  // progress after an offline finish was delivered.
  it('marked from the book page, the loaded book stops and unloads before the finish', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 9));
    const release = holdSaves(); // a reconcile check out (the server coming back)
    await leaveFinishedBook(ref);
    await expect(recordFinishEvent(ref)).resolves.toEqual(expect.any(Object));
    await settle();
    expect(usePlayer.getState().nowPlaying).toBeNull();
    expect(mockSvc.reset).toHaveBeenCalled();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 5, 9]]);
    expect(mockAppended.map((e) => e.kind)).toEqual(['finish']);
    expect(mockWriteMirror.mock.calls.at(-1)?.[0]).toMatchObject({ finished: true });
    // Nothing after it: the held save released, the save loop's time, a late engine event.
    release();
    pushSnapshot(snap('playing', 0, 12));
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(mockClosed).toHaveLength(1);
    expect(mockAppended.map((e) => e.kind)).toEqual(['finish']);
    expect(mockWriteMirror.mock.calls.at(-1)?.[0]).toMatchObject({ finished: true });
  });

  it('on the PUT path, its place is saved before the finish the caller saves next', async () => {
    mockSync = false;
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 9));
    mockSaveProgress.mockClear();
    let saved = () => {};
    mockSaveProgress.mockImplementationOnce(
      () => new Promise<void>((r) => (saved = () => r('saved' as never))),
    );
    let left = false;
    const leaving = leaveFinishedBook(ref).then((at) => {
      left = true;
      return at;
    });
    await settle();
    expect(usePlayer.getState().nowPlaying).toBeNull();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ position: 9, finished: false });
    // The caller records the finish once that save is over: after it, a PUT included.
    expect(left).toBe(false);
    saved();
    // With the place saved: where an Undo goes back to.
    await expect(leaving).resolves.toBe(9);
    expect(left).toBe(true);
  });

  // FE-1: the same race as `stop()`. The unload's reset came before the load landed in the
  // engine, which then stayed loaded with the book just marked finished.
  it('marked finished while its files load: the engine is reset once the load lands', async () => {
    let loaded = () => {};
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (loaded = resolve)),
    );
    const starting = usePlayer.getState().playBook('c1', 2, book, chapters);
    await settle();
    expect(usePlayer.getState().nowPlaying?.path).toBe(folder);
    await leaveFinishedBook(ref);
    (mockSvc.reset as jest.Mock).mockClear();
    loaded();
    await starting;
    await settle();
    expect(mockSvc.reset).toHaveBeenCalledTimes(1);
    expect(mockSvc.play).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).toBeNull();
  });

  it('marked finished while its loaded start sets the speed: the start plays nothing', async () => {
    let rateSet = () => {};
    (mockSvc.setRate as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (rateSet = resolve)),
    );
    const starting = usePlayer.getState().playBook('c1', 2, book, chapters);
    await settle();
    expect(mockSvc.setRate).toHaveBeenCalled();
    await leaveFinishedBook(ref);
    rateSet();
    await starting;
    await settle();
    expect(mockSvc.play).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).toBeNull();
  });

  it('marked finished while its start looks up the place: the start loads nothing', async () => {
    let looked: (r: ResumeLookup) => void = () => {};
    mockLoadInitialProgress.mockImplementationOnce(
      () => new Promise<ResumeLookup>((resolve) => (looked = resolve)),
    );
    const starting = usePlayer.getState().playBook('c1', 2, book, chapters);
    await settle();
    expect(usePlayer.getState().nowPlaying).toBeNull();
    await leaveFinishedBook(ref);
    looked({ kind: 'empty' });
    await starting;
    await settle();
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(mockSvc.play).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).toBeNull();
  });

  // The called-off start reset the engine (and dropped the intent to play) of a book started
  // after the Mark, which had loaded and played while its place was still looked up.
  it('a start called off after another book has taken the player leaves that book playing', async () => {
    let looked: (r: ResumeLookup) => void = () => {};
    mockLoadInitialProgress.mockImplementationOnce(
      () => new Promise<ResumeLookup>((resolve) => (looked = resolve)),
    );
    const starting = usePlayer.getState().playBook('c1', 2, book, chapters);
    await settle();
    await leaveFinishedBook(ref);
    await usePlayer
      .getState()
      .playBook('c1', 2, { ...book, rel_path: 'Other/Book', title: 'Other' }, undefined);
    await settle();
    expect(usePlayer.getState().nowPlaying?.path).toBe('Other/Book');
    (mockSvc.reset as jest.Mock).mockClear();
    looked({ kind: 'empty' });
    await starting;
    await settle();
    expect(mockSvc.reset).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying?.path).toBe('Other/Book');
  });

  it("another book's Mark as finished leaves a start on its way alone", async () => {
    let looked: (r: ResumeLookup) => void = () => {};
    mockLoadInitialProgress.mockImplementationOnce(
      () => new Promise<ResumeLookup>((resolve) => (looked = resolve)),
    );
    const starting = usePlayer.getState().playBook('c1', 2, book, chapters);
    await settle();
    await leaveFinishedBook({ ...ref, path: 'Other/Book' });
    looked({ kind: 'empty' });
    await starting;
    await settle();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect(mockSvc.play).toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying?.path).toBe(folder);
  });

  // FE-1: unloaded first, a finish (a progress edit) that then failed left the listening
  // stopped for nothing.
  it('a finish that failed loads the book it left again, paused where it was', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 9));
    await leaveFinishedBook(ref);
    expect(usePlayer.getState().nowPlaying).toBeNull();
    (mockSvc.load as jest.Mock).mockClear();
    (mockSvc.play as jest.Mock).mockClear();
    // Its resume finds the place saved as it was left (whole-book 9 s: the first file).
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: row({ position: 9, version: 9, device_id: 'phone' }),
    });
    await reloadLeftBook(ref);
    await settle();
    expect(usePlayer.getState().nowPlaying?.path).toBe(folder);
    expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([0, 9]);
    expect(mockSvc.play).not.toHaveBeenCalled();
    // Resumed there, not a `jump` to it: the next play here never sends the place over one
    // another device reached meanwhile.
    pushSnapshot(snap('playing', 0, 9));
    await settle();
    pushSnapshot(snap('paused', 0, 12));
    await settle();
    expect(mockClosed.at(-1)?.start).toBe('resume');
    // Once only: a second failure has nothing left to load.
    await usePlayer.getState().stop();
    (mockSvc.load as jest.Mock).mockClear();
    await reloadLeftBook(ref);
    expect(mockSvc.load).not.toHaveBeenCalled();
  });

  it('a finish that failed after another book was loaded leaves that book playing', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    await leaveFinishedBook(ref);
    await usePlayer
      .getState()
      .playBook('c1', 2, { ...book, rel_path: 'Other/Book', title: 'Other' }, undefined);
    await settle();
    (mockSvc.load as jest.Mock).mockClear();
    await reloadLeftBook(ref);
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying?.path).toBe('Other/Book');
  });

  it("a finish that failed while another book's start is on its way loads nothing", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    await leaveFinishedBook(ref);
    let looked: (r: ResumeLookup) => void = () => {};
    mockLoadInitialProgress.mockImplementationOnce(
      () => new Promise<ResumeLookup>((resolve) => (looked = resolve)),
    );
    const starting = usePlayer
      .getState()
      .playBook('c1', 2, { ...book, rel_path: 'Other/Book', title: 'Other' }, undefined);
    await settle();
    (mockSvc.load as jest.Mock).mockClear();
    await reloadLeftBook(ref);
    expect(mockSvc.load).not.toHaveBeenCalled();
    looked({ kind: 'empty' });
    await starting;
    await settle();
    expect(usePlayer.getState().nowPlaying?.path).toBe('Other/Book');
  });

  it('another book loaded plays on', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    await leaveFinishedBook({ ...ref, path: 'Other/Book' });
    await settle();
    expect(usePlayer.getState().nowPlaying?.path).toBe(folder);
    expect(mockClosed).toEqual([]);
  });

  // The server applies a batch in time order (request order only breaks ties): a finish
  // dated before its book's last span was applied first, as server#359's was.
  it("the finish is dated no earlier than the loaded book's last span", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, 9));
    // A clock that ticks between any two readings.
    let n = 0;
    const iso = jest
      .spyOn(Date.prototype, 'toISOString')
      .mockImplementation(() => `2026-10-25T08:00:00.${String(n++).padStart(3, '0')}Z`);
    try {
      await recordFinishEvent(ref);
    } finally {
      iso.mockRestore();
    }
    const finish = mockAppended.find((e) => e.kind === 'finish') as { at: string };
    expect(mockClosed).toHaveLength(1);
    expect(finish.at >= (mockClosed[0].endedAt ?? '')).toBe(true);
  });

  // An offline Mark as finished then Undo: the PATCH would fail, and the finish put back
  // went out on reconnect and finished the book after all.
  it('Undo of a finish that never left: the mirror goes back to before it, no edit', async () => {
    const before = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 48,
      duration: 100,
      finished: false,
      playback_speed: 1.2,
      device_id: 'dev-1',
      updated_at: '2026-01-01T00:00:00Z',
      ack_version: 7,
    };
    mockReadMirror.mockResolvedValue(before);
    try {
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      expect(mockWriteMirror).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: 'Other/Book', finished: true }),
      );
      // The mirror holds the finish's record by the Undo, carrying the record before it,
      // acknowledged since.
      const finishedRec = {
        ...(mockFinishedRecords.at(-1) as object),
        ack_version: 9,
        ignored: ['watch|a'],
      };
      expect(finishedRec).toMatchObject({ finished: true, before });
      mockReadMirror.mockResolvedValue(finishedRec);
      const writes = mockWriteMirror.mock.calls.length;
      const edit = jest.fn(async () => {});
      await expect(undoFinish(undoRef, edit)).resolves.toBe('undone');
      expect(mockWithdraw).toHaveBeenCalledWith('c1', 2, 'Other/Book');
      expect(edit).not.toHaveBeenCalled();
      // The record before it as it was, its own stamp: the server never got the finish and
      // holds that place, so a place another device saved after it, read next, is newer and
      // wins (stamped after the finish, it was refused). Under the mirror's lock
      // (`updateMirror`), never a write from a read made outside it; its Sync v2 fields are
      // the mirror's own (the ack since the finish is newer).
      expect(mockWriteMirror).toHaveBeenCalledTimes(writes);
      expect(mockMirrorUpdates).toEqual([{ ...before, ack_version: 9, ignored: ['watch|a'] }]);
      // A read of the finished row still on its way is held off (fe#258, fe#272).
      expect(mockNoteUndone).toHaveBeenCalledWith('c1', 2, 'Other/Book');
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: qk.progress('c1', 2, 'Other/Book'),
      });
      // The other tabs are told once the record went back, so they read it again.
      expect(mockTellUndone).toHaveBeenCalledTimes(1);
      expect(mockTellUndone).toHaveBeenCalledWith(expect.objectContaining({ path: 'Other/Book' }));
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  it('a no-edit Undo captures the live book heard past the Mark before the next save', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 10));
    await settle();
    const before = {
      ...ref,
      finished: false,
      position: 10,
      updated_at: '2026-01-01T00:00:00Z',
      device_id: 'dev-1',
      playback_speed: 1,
    };
    mockReadMirror.mockResolvedValue(before);
    try {
      await recordFinishEvent(ref);
      mockReadMirror.mockResolvedValue(mockFinishedRecords.at(-1));
      pushSnapshot(snap('playing', 0, 18));
      const edit = jest.fn(async () => {});
      await expect(undoFinish({ ...ref, position: 10 }, edit)).resolves.toBe('undone');
      expect(edit).not.toHaveBeenCalled();
      expect(mockWriteMirror).toHaveBeenLastCalledWith(
        expect.objectContaining({
          finished: false,
          position: 18,
          file: order[0],
          file_pos: 18,
        }),
        { advanceOnly: true },
      );
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  // The record before a finish is kept for its Undo, and stays once the toast is gone: a
  // Mark as not finished later put the mirror back to that old place, while its edit set
  // the server to its own.
  it('Mark as not finished goes to its own place, not the record before an earlier finish', async () => {
    const before = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 48,
      duration: 100,
      finished: false,
      playback_speed: 1,
      device_id: 'dev-1',
      updated_at: '2026-01-01T00:00:00Z',
    };
    mockReadMirror.mockResolvedValue(before);
    try {
      mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      const finishedRec = mockWriteMirror.mock.calls.at(-1)?.[0] as { updated_at: string };
      mockReadMirror.mockResolvedValue(finishedRec);
      const edit = jest.fn(async () => {});
      await expect(undoFinish({ ...undoRef, position: 0, atPosition: true }, edit)).resolves.toBe(
        'undone',
      );
      expect(edit).toHaveBeenCalledTimes(1);
      expect(mockMirrorUpdates.at(-1)).toMatchObject({ finished: false, position: 0 });
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  // An offline Mark as finished, then Mark as not finished: the finish never reached the
  // server, which kept the place before it, while the mirror went to the place asked for (the
  // start, for a book read finished at its end) with no edit to put the server there.
  describe('Mark as not finished of a finish that never left', () => {
    const before = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 48,
      duration: 100,
      finished: false,
      playback_speed: 1,
      device_id: 'dev-1',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const notFinished = { ...undoRef, position: 0, atPosition: true };
    beforeEach(async () => {
      mockReadMirror.mockResolvedValue(before);
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
    });
    afterEach(() => mockReadMirror.mockImplementation(async () => null));

    it('the mirror goes back to the place the server holds, with no edit', async () => {
      mockReadMirror.mockResolvedValue(mockFinishedRecords.at(-1));
      const edit = jest.fn(async () => {});
      await expect(undoFinish(notFinished, edit)).resolves.toBe('undone');
      expect(edit).not.toHaveBeenCalled();
      expect(mockMirrorUpdates.at(-1)).toMatchObject({ finished: false, position: 48 });
    });

    // Another tab's finish (or one after a reload): the mirror holds a finished record this
    // device did not write, so the place before it is not known here.
    it('one this device does not know the place before: the edit, then its own place', async () => {
      mockReadMirror.mockResolvedValue({
        ...before,
        position: 100,
        finished: true,
        updated_at: '2026-01-03T00:00:00Z',
      });
      const edit = jest.fn(async () => {});
      await expect(undoFinish(notFinished, edit)).resolves.toBe('undone');
      expect(edit).toHaveBeenCalledTimes(1);
      expect(mockMirrorUpdates.at(-1)).toMatchObject({ finished: false, position: 0 });
    });
  });

  // Its stored copy for the other tabs behind a lock that may refuse (Web Locks): the hold
  // stays in this tab, and the record still goes back.
  it('Undo whose cross-tab hold could not be stored: the mirror still goes back', async () => {
    mockReadMirror.mockResolvedValue(null);
    try {
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      const finishedRec = mockWriteMirror.mock.calls.at(-1)?.[0] as { updated_at: string };
      mockReadMirror.mockResolvedValue(finishedRec);
      mockNoteUndone.mockRejectedValueOnce(new Error('lock refused'));
      await expect(
        undoFinish(
          undoRef,
          jest.fn(async () => {}),
        ),
      ).resolves.toBe('undone');
      expect(mockMirrorUpdates.at(-1)).toMatchObject({ finished: false, position: 48 });
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  it('Undo here with no record before the finish: only the finished record is undone', async () => {
    const finishedRec = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 100,
      duration: 100,
      finished: true,
      device_id: 'dev-1',
      updated_at: '2026-01-02T00:00:00Z',
      file: 'Other/Book/9.mp3',
      file_pos: 50,
    };
    try {
      mockReadMirror.mockResolvedValue(null);
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      mockReadMirror.mockResolvedValue(finishedRec);
      await undoFinish(
        undoRef,
        jest.fn(async () => {}),
      );
      // At the place before it, with no file place: the finished record's was the end's.
      const { file: _file, file_pos: _filePos, ...rest } = finishedRec;
      expect(mockMirrorUpdates).toEqual([
        { ...rest, finished: false, position: 48, updated_at: '2026-01-02T00:00:00.001Z' },
      ]);
      // A place saved since the finish is not undone.
      mockReadMirror.mockResolvedValue(null);
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      mockReadMirror.mockResolvedValue({ ...finishedRec, finished: false, position: 70 });
      await undoFinish(
        undoRef,
        jest.fn(async () => {}),
      );
      expect(mockMirrorUpdates).toHaveLength(1);
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  // The edit's answer only reaches the query caches: the mirror kept the finish's record
  // (finished, at the end), and the next offline Play started the book again at 0.
  it('Undo of a finish the server has: the edit, then the mirror back to before it', async () => {
    const before = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 48,
      duration: 100,
      finished: false,
      playback_speed: 1,
      device_id: 'dev-1',
      updated_at: '2026-01-01T00:00:00Z',
      file: 'Other/Book/3.mp3',
      file_pos: 12,
    };
    mockReadMirror.mockResolvedValue(before);
    try {
      mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
      const mark = await recordFinishEvent({ ...ref, path: 'Other/Book' });
      expect(mark).toEqual({ before });
      // The server answered for the finish and its row was read again: a downloaded book's
      // record is that row by now, stamped by the server's clock, later than the finish's
      // own time. A record stamped with the finish's time was refused as older.
      const echo = {
        ...(mockWriteMirror.mock.calls.at(-1)?.[0] as object),
        updated_at: '2999-01-01T00:00:00.000Z',
        ignored: ['watch|a'],
      };
      mockReadMirror.mockResolvedValue(echo);
      const edit = jest.fn(async () => {});
      await expect(undoFinish({ ...undoRef, ...(mark || {}) }, edit)).resolves.toBe('undone');
      expect(edit).toHaveBeenCalledTimes(1);
      // The row read back replaced the record that carried the place before the finish
      // (`ProgressSave.before`): the tab that marked it still knows that place, so the Undo
      // keeps its file place too. On the position alone, a downloaded book opened offline
      // at the wrong file.
      expect(echo).not.toHaveProperty('before');
      expect(mockMirrorUpdates.at(-1)).toMatchObject({
        path: 'Other/Book',
        finished: false,
        position: 48,
        file: 'Other/Book/3.mp3',
        file_pos: 12,
        updated_at: '2999-01-01T00:00:00.001Z',
        ignored: ['watch|a'],
      });
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  it("keeps the edit's chosen seconds when the device's old file place differs", async () => {
    const prior = {
      ...ref,
      position: 21,
      finished: false,
      file: 'old.mp3',
      file_pos: 21,
      device_id: 'here',
      updated_at: '2026-01-01T00:00:00Z',
      playback_speed: 1,
    };
    const marked = { ...prior, position: 100, finished: true, before: prior };
    mockReadMirror.mockResolvedValue(marked);
    mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
    try {
      const edit = jest.fn(async () => {});
      await undoFinish({ ...ref, position: 60 }, edit);
      expect(edit).toHaveBeenCalledTimes(1);
      expect(mockMirrorUpdates.at(-1)).toMatchObject({ position: 60, finished: false });
      expect(mockMirrorUpdates.at(-1)).not.toHaveProperty('file');
      expect(mockMirrorUpdates.at(-1)).not.toHaveProperty('file_pos');
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  it("keeps the device's file place when the edit's seconds differ only in the last digits", async () => {
    // The page reads the place on the chapters' timeline (`positionOn`), summing file
    // lengths, so its seconds can miss the record's by a rounding step.
    const prior = {
      ...ref,
      position: 21,
      finished: false,
      file: 'old.mp3',
      file_pos: 21,
      device_id: 'here',
      updated_at: '2026-01-01T00:00:00Z',
      playback_speed: 1,
    };
    const marked = { ...prior, position: 100, finished: true, before: prior };
    mockReadMirror.mockResolvedValue(marked);
    mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
    try {
      const edit = jest.fn(async () => {});
      await undoFinish({ ...ref, position: 21.000000000000004 }, edit);
      expect(edit).toHaveBeenCalledTimes(1);
      expect(mockMirrorUpdates.at(-1)).toMatchObject({
        position: 21,
        finished: false,
        file: 'old.mp3',
        file_pos: 21,
      });
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  it('Undo after a place saved since the finish: that place stays', async () => {
    const before = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 48,
      duration: 100,
      finished: false,
      playback_speed: 1,
      device_id: 'dev-1',
      updated_at: '2026-01-01T00:00:00Z',
    };
    mockReadMirror.mockResolvedValue(before);
    try {
      mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      const writes = mockWriteMirror.mock.calls.length;
      mockReadMirror.mockResolvedValue({
        ...before,
        position: 70,
        updated_at: '2999-01-01T00:00:00.000Z',
      });
      await undoFinish(
        undoRef,
        jest.fn(async () => {}),
      );
      expect(mockWriteMirror).toHaveBeenCalledTimes(writes);
      expect(mockMirrorUpdates).toEqual([]);
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  // The mirror is written finished before the finish has had its turn: left so when the
  // finish was never queued, the book loaded again after the failure started over at 0.
  it('a finish that could not be queued: the mirror goes back to the record before it', async () => {
    const before = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'Other/Book',
      position: 48,
      duration: 100,
      finished: false,
      playback_speed: 1.2,
      device_id: 'dev-1',
      updated_at: '2026-01-01T00:00:00Z',
    };
    mockReadMirror.mockResolvedValue(before);
    mockWriteMirror.mockImplementationOnce(async () => {
      mockReadMirror.mockResolvedValue(mockFinishedRecords.at(-1));
    });
    mockAppendInTurn.mockImplementationOnce(async () => {
      throw new Error('no turn');
    });
    try {
      await expect(recordFinishEvent({ ...ref, path: 'Other/Book' })).rejects.toThrow('no turn');
      const finished = mockWriteMirror.mock.calls.at(-1)?.[0] as { updated_at: string };
      expect(finished).toMatchObject({ path: 'Other/Book', finished: true });
      // As it was: the finish never left this device.
      expect(mockMirrorUpdates).toEqual([before]);
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  // With no record before the finish there was nothing to put back, and the book stayed
  // finished on this device with no finish queued.
  it('a finish that could not be queued on a book with no record: its record goes', async () => {
    mockReadMirror.mockResolvedValue(null);
    mockWriteMirror.mockImplementationOnce(async (rec: unknown) => {
      mockReadMirror.mockResolvedValue(rec);
    });
    mockAppendInTurn.mockImplementationOnce(async () => {
      throw new Error('no turn');
    });
    try {
      await expect(recordFinishEvent({ ...ref, path: 'Other/Book' })).rejects.toThrow('no turn');
      expect(mockWriteMirror.mock.calls.at(-1)?.[0]).toMatchObject({
        path: 'Other/Book',
        finished: true,
      });
      expect(mockMirrorUpdates).toEqual([null]);
    } finally {
      mockReadMirror.mockImplementation(async () => null);
    }
  });

  it('Undo whose edit failed: the mirror keeps the finish (it is sent again)', async () => {
    mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
    await recordFinishEvent({ ...ref, path: 'Other/Book' });
    const writes = mockWriteMirror.mock.calls.length;
    mockReadMirror.mockResolvedValueOnce({ finished: true, updated_at: '2026-01-02T00:00:00Z' });
    await expect(
      undoFinish(
        undoRef,
        jest.fn(async () => {
          throw new Error('refused');
        }),
      ),
    ).rejects.toThrow('refused');
    expect(mockWriteMirror).toHaveBeenCalledTimes(writes);
    expect(mockUpdateMirror).not.toHaveBeenCalled();
  });

  // fe#258: a sign-out while the Mark or its Undo was on its way left a record of the old
  // sign-in in the mirror, which stood for the next sign-in to the same account.
  it('signed out while the finish was recorded: no mirror record, nothing appended', async () => {
    // Every read of the mirror waits (the finish's base and the record before it alike).
    let read: (v: unknown) => void = () => {};
    const held = new Promise((resolve) => (read = resolve));
    mockReadMirror.mockImplementation(() => held);
    const recording = recordFinishEvent({ ...ref, path: 'Other/Book' });
    await settle();
    mockGeneration = 1; // the connection removed
    read(null);
    await recording;
    expect(mockWriteMirror).not.toHaveBeenCalled();
    // The finish was handed over before the sign-out: the outbox drops it for the sign-in
    // it was made in (its own test), as it does a close.
    expect(mockAppendInTurn).toHaveBeenCalledTimes(1);
  });

  it('signed out while the Undo was out: the mirror is left alone', async () => {
    mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
    await recordFinishEvent({ ...ref, path: 'Other/Book' });
    mockReadMirror.mockResolvedValueOnce({ finished: true, updated_at: '2026-01-02T00:00:00Z' });
    await undoFinish(undoRef, async () => {
      mockGeneration = 1;
    });
    expect(mockUpdateMirror).not.toHaveBeenCalled();
    expect(mockNoteUndone).not.toHaveBeenCalled();
  });

  // Marked finished from its page while loaded and paused, then undone: the player's own
  // Mark as finished was taken for a second finish of the same end, and sent nothing.
  it('after an Undo the player can finish the loaded book again', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('paused', 0, 9));
    await settle();
    mockWithdraw.mockResolvedValueOnce({ unsent: false, restore: async () => {} });
    await recordFinishEvent(ref);
    await undoFinish(
      { connectionId: 'c1', libraryId: 2, path: folder, position: 9 },
      jest.fn(async () => {}),
    );
    mockAppended.length = 0;
    usePlayer.getState().finishBook();
    await settle();
    expect(mockAppended.map((e) => e.kind)).toEqual(['finish']);
  });

  it("keeps the book's own speed in the mirror (the book page gives none)", async () => {
    mockReadMirror.mockResolvedValue({ ack_version: 41, playback_speed: 1.6 });
    await recordFinishEvent({ ...ref, path: 'Other/Book' });
    expect(mockWriteMirror).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Other/Book', finished: true, playback_speed: 1.6 }),
    );
  });

  it('a book that is not loaded: only the finish, queued even with its server away', async () => {
    const reach = jest.spyOn(reachability, 'isReachable').mockReturnValue(false);
    try {
      await start();
      pushSnapshot(snap('playing', 0, 5));
      await settle();
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      expect(mockClosed).toEqual([]);
      expect(mockAppended).toEqual([
        expect.objectContaining({ kind: 'finish', path: 'Other/Book' }),
      ]);
    } finally {
      reach.mockRestore();
    }
  });

  it('a flush without a delivery does not read the unfinished server lists', async () => {
    await start();
    let sent: () => void = () => {};
    mockFlushOutbox.mockImplementation(() => new Promise<void>((resolve) => (sent = resolve)));
    try {
      const invalidate = queryClient.invalidateQueries as jest.Mock;
      invalidate.mockClear();
      await recordFinishEvent({ ...ref, path: 'Other/Book' });
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: qk.allProgress('c1') });
      sent();
      await settle();
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: qk.allProgress('c1') });
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: qk.progress('c1', 2, 'Other/Book') });
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: qk.myStatsAll('c1') });
    } finally {
      mockFlushOutbox.mockImplementation(async () => {});
    }
  });

  it('a server without listening events: not recorded, the caller saves by PUT', async () => {
    mockSync = false;
    expect(finishTakesEvent('c1')).toBe(false);
    await expect(recordFinishEvent(ref)).resolves.toBe(false);
    expect(mockAppended).toEqual([]);
    expect(mockWriteMirror).not.toHaveBeenCalled();
  });
});

describe('a span opens whenever the book plays', () => {
  const historyBody = (call: number) =>
    (mockClient.addHistory.mock.calls[call] as unknown[])[2] as {
      from_pos: number;
      to_pos: number;
    };

  // The 5 s keep opens it (`keepOpenSpan`), not the save loop's tick, which may be a minute
  // away (`saveIntervalMs`): what plays before a span opens is in no listening event.
  it('a play the engine reports while the load holds the place opens its span within the keep', async () => {
    (mockSvc.load as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('playing', 0, 5)); // Android keeps playWhenReady through a load
    });
    await start();
    pushSnapshot(snap('playing', 0, 8));
    jest.advanceTimersByTime(5_000);
    await settle();
    pushSnapshot(snap('paused', 0, 25));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 8, 25]]);
  });

  it('a play on its way to a pause opens none: the pause is asked for, the engine yet to report it', async () => {
    (mockSvc.load as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('playing', 0, 5));
    });
    await start();
    pushSnapshot(snap('playing', 0, 8));
    // As a tab that gives way does: the intent dropped and the engine told to pause, its
    // snapshot still `playing` (a Cast receiver takes a second or two to confirm).
    await usePlayer.getState().toggle();
    jest.advanceTimersByTime(5_000);
    await settle();
    pushSnapshot(snap('paused', 0, 9));
    await settle();
    expect(mockClosed).toEqual([]);
  });

  it('a server that takes listening events only since the book began gets a span within the keep', async () => {
    mockSync = false;
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    jest.advanceTimersByTime(15_000); // a PUT save
    mockSync = true; // its `/server` was read while the book played
    pushSnapshot(snap('playing', 0, 30));
    jest.advanceTimersByTime(5_000);
    await settle();
    pushSnapshot(snap('paused', 0, 40));
    await settle();
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 30, 40]]);
    // What the PUT path began goes by POST /history, up to where the span took over.
    expect(mockClient.addHistory).toHaveBeenCalledTimes(1);
    expect(historyBody(0)).toMatchObject({ from_pos: 5, to_pos: 30 });
  });

  it('a finished book started again from a place sends unfinish; the row it saw is acknowledged', async () => {
    const cached = row({
      position: 100,
      finished: true,
      version: 12,
      device_id: 'phone',
      updated_at: '2026-02-01T00:00:00Z',
    });
    const key = JSON.stringify(qk.progress('c1', 2, folder));
    (queryClient.getQueryData as jest.Mock).mockImplementation((k: unknown) =>
      JSON.stringify(k) === key ? cached : undefined,
    );
    try {
      await start(40); // a chapter tap on the book page
      pushSnapshot(snap('playing', 0, 40));
      pushSnapshot(snap('paused', 0, 45));
      await settle();
    } finally {
      (queryClient.getQueryData as jest.Mock).mockImplementation(() => undefined);
    }
    expect(mockAppended).toEqual([
      expect.objectContaining({ kind: 'unfinish', library_id: 2, path: folder }),
    ]);
    expect(mockClosed.map((s) => s.start)).toEqual(['jump']);
    expect(mockAckVersion).toHaveBeenCalledWith('c1', 2, folder, 12, cached);
  });

  describe('an adopted book (adoptLoaded)', () => {
    const loaded = { connectionId: 'c1', libraryId: 2, path: folder, rate: 1 };
    beforeEach(() => useDownloads.setState({ entries: { [`c1:2:${folder}`]: downloadedEntry() } }));

    it('a playing one opens its span at once (the store set its `playing`)', async () => {
      const adopted = await usePlayer
        .getState()
        .adoptLoaded({ ...loaded, trackIndex: 1, position: 10, playing: true });
      expect(adopted).toBe(true);
      pushSnapshot(snap('playing', 1, 20));
      pushSnapshot(snap('paused', 1, 20));
      await settle();
      expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 60, 70]]);
    });

    it('a paused one reloaded in its order opens its span on its first play', async () => {
      (queryClient.fetchQuery as jest.Mock).mockRejectedValueOnce(
        new TypeError('Network request failed'),
      );
      // The engine plays 10.mp3 first (an older order): reloaded in the download's, where it
      // is the second file.
      const adopted = await usePlayer.getState().adoptLoaded({
        ...loaded,
        files: ['A/Folder/10.mp3', 'A/Folder/2.mp3'],
        trackIndex: 0,
        position: 10,
        playing: false,
      });
      expect(adopted).toBe(true);
      expect((mockSvc.load as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([1, 10]);
      pushSnapshot(snap('paused', 1, 10));
      await settle();
      pushSnapshot(snap('playing', 1, 10));
      pushSnapshot(snap('paused', 1, 20));
      await settle();
      expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 60, 70]]);
    });
  });
});

describe('what a span carries', () => {
  it("sends the audio's length, not a timeline a chapter overhangs", async () => {
    const overhang: ChaptersResponse = {
      ...chapters,
      chapters: [...chapters.chapters, { ...chapters.chapters[1], index: 2, start: 50, end: 80 }],
    };
    await usePlayer.getState().playBook('c1', 2, book, overhang, undefined);
    await settle();
    expect(usePlayer.getState().nowPlaying?.queue.total).toBeGreaterThan(100);
    pushSnapshot(snap('playing', 0, 5));
    pushSnapshot(snap('paused', 0, 20));
    await settle();
    expect(mockClosed.map((s) => s.duration)).toEqual([100]);
  });

  // Pixel 6a: a download that ends before its book played from its own copy sent the
  // downloaded part's length, and the server refused every listen (duration_mismatch).
  describe('over a download that ends before its book does (D3)', () => {
    const withEnd = (bookDuration?: number): DownloadEntry => {
      const e = downloadedEntry();
      return {
        ...e,
        manifest: {
          ...e.manifest,
          endsBefore: 'A/Folder/30.mp3',
          ...(bookDuration === undefined ? {} : { bookDuration }),
        },
      };
    };
    const playOffline = async (entry: DownloadEntry) => {
      useDownloads.setState({ entries: { [`c1:2:${folder}`]: entry } });
      const reach = jest.spyOn(reachability, 'isReachable').mockReturnValue(false);
      try {
        await usePlayer.getState().playBook('c1', 2, book, chapters, undefined);
        await settle();
      } finally {
        reach.mockRestore();
      }
      pushSnapshot(snap('playing', 0, 5));
      pushSnapshot(snap('paused', 0, 20));
      await settle();
    };

    it('a book-page jump inside a retained file survives tied offsets and a different offline order', async () => {
      const entry = withEnd(160);
      const own = entry.manifest.chapters!;
      const files = own.files.map((f) => ({ ...f, duration: 0 }));
      entry.manifest.chapters = { ...own, files };
      useDownloads.setState({ entries: { [`c1:2:${folder}`]: entry } });
      const reach = jest.spyOn(reachability, 'isReachable').mockReturnValue(false);
      try {
        const target = { path: files[1].rel_path, pos: 17 };
        const served = { ...own, files: [...files].reverse().map((f, seq) => ({ ...f, seq })) };
        await usePlayer.getState().playBook('c1', 2, book, served, 17, target);
        expect((mockSvc.load as jest.Mock).mock.lastCall.slice(1, 3)).toEqual([1, 17]);
        pushSnapshot(snap('playing', 1, 17));
        await usePlayer.getState().seekBook(9, { path: files[0].rel_path, pos: 9 });
        expect(mockSvc.skipToTrack).toHaveBeenCalledWith(0, 9);
      } finally {
        reach.mockRestore();
      }
    });

    it("sends the book's length on its server, and saves it", async () => {
      await playOffline(withEnd(160));
      expect(usePlayer.getState().nowPlaying?.queue.audio).toBe(100);
      expect(mockClosed.map((s) => s.duration)).toEqual([160]);
      await usePlayer.getState().pause();
      await settle();
      const durations = mockWriteMirror.mock.calls.map(
        (c) => (c[0] as { duration: number }).duration,
      );
      expect(durations.length).toBeGreaterThan(0);
      expect(durations.every((d) => d === 160)).toBe(true);
      // The player's percent is of the same length, so it reads as Home's.
      expect(selectBookLength(usePlayer.getState())).toBe(160);
    });

    it.each([true, false])(
      'a forced finish saves the whole length (listening sync %s)',
      async (sync) => {
        mockSync = sync;
        await playOffline(withEnd(160));
        usePlayer.getState().finishBook();
        await settle();
        const saved = sync
          ? mockWriteMirror.mock.lastCall?.[0]
          : mockSaveProgress.mock.lastCall?.[1];
        expect(saved).toMatchObject({ finished: true, position: 160, duration: 160 });
        expect(saved).not.toHaveProperty('file');
        expect(saved).not.toHaveProperty('partial');
      },
    );

    it('sends no length when the download does not know it (the server checks none)', async () => {
      await playOffline(withEnd());
      expect(mockClosed.map((s) => s.duration)).toEqual([0]);
      expect(selectBookLength(usePlayer.getState())).toBe(100);
    });
  });

  it('never takes a place that is not a number', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 5));
    await settle();
    pushSnapshot(snap('playing', 0, Number.NaN));
    jest.advanceTimersByTime(15_000); // a cut while the engine reports NaN
    await settle();
    await usePlayer.getState().seekBook(Number.NaN);
    pushSnapshot(snap('paused', 0, Number.NaN));
    await settle();
    expect(mockClosed.length).toBeGreaterThan(0);
    const numbers = mockClosed.flatMap((s) => [s.from.pos, s.to.pos, s.from.filePos ?? 0]);
    expect(numbers.every(Number.isFinite)).toBe(true);
    expect(mockAppended.every((e) => e.kind !== 'listen' || Number.isFinite(e.to_pos))).toBe(true);
    const saved = mockWriteMirror.mock.calls.map((c) => (c[0] as { position: number }).position);
    expect(saved.every(Number.isFinite)).toBe(true);
  });
});

describe('a long offline run', () => {
  it('is cut every hour of wall clock, though no server is there to cut it', async () => {
    const reach = jest.spyOn(reachability, 'isReachable').mockReturnValue(false);
    try {
      await start();
      pushSnapshot(snap('playing', 0, 1));
      await settle();
      for (let i = 0; i < 8 * 60 + 2; i++) {
        pushSnapshot(snap('playing', 0, 1 + (i % 40)));
        jest.advanceTimersByTime(15_000);
        await settle(2);
      }
      await settle();
      // Two hours and half a minute of ticks: two whole-hour spans closed, one still open.
      expect(mockClosed.map((s) => s.start)).toEqual(['resume', 'continue']);
      const hours = mockClosed.map((s) => Date.parse(s.endedAt) - Date.parse(s.startedAt));
      expect(hours.every((ms) => ms >= 60 * 60_000 && ms < 61 * 60_000)).toBe(true);
    } finally {
      reach.mockRestore();
    }
  });
});

// W2 F1: a force-stop between two 15 s cuts lost the open span, which lived only in memory.
describe('the open span is kept every 5 s', () => {
  const stored = () =>
    mockStoreOpenSpan.mock.calls.map((c) => {
      const span = c[0] as OpenSpan;
      return [span.start, span.from.pos, span.to.pos];
    });

  it('online too, up to where the engine is, from the span the last cut opened', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 1));
    await settle();
    pushSnapshot(snap('playing', 0, 6));
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(stored()).toEqual([['resume', 1, 6]]);
    pushSnapshot(snap('playing', 0, 16));
    jest.advanceTimersByTime(10_000); // the 15 s cut, then the next span is kept
    await settle();
    pushSnapshot(snap('playing', 0, 23));
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(stored().at(-1)).toEqual(['continue', 16, 23]);
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 1, 16]]);
  });

  it.each([5_000, 10_000])(
    'a kill during a reconcile hold after %i ms keeps the previous span and time',
    async (beforeHold) => {
      await start();
      pushSnapshot(snap('playing', 0, 1));
      await settle();
      pushSnapshot(snap('playing', 0, 6));
      jest.advanceTimersByTime(beforeHold);
      await settle();
      const before = structuredClone(mockStoreOpenSpan.mock.lastCall?.[0]) as OpenSpan;
      expect(before.to.pos).toBe(6);
      jest.advanceTimersByTime(3_000);
      const release = holdSaves();
      try {
        pushSnapshot(snap('playing', 0, 11));
        jest.advanceTimersByTime(2_000);
        await settle();
        expect(mockClosed).toHaveLength(0);
        expect(mockStoreOpenSpan.mock.lastCall?.[0]).toMatchObject({
          to: before.to,
          endedAt: before.endedAt,
        });
      } finally {
        release({ flush: false });
      }
      pushSnapshot(snap('playing', 0, 14));
      jest.advanceTimersByTime(5_000);
      await settle();
      expect(mockStoreOpenSpan.mock.lastCall?.[0]).toMatchObject({ to: { pos: 14 } });
    },
  );

  it('a reconcile hold keeps the span through a background, reconnect or hidden cut', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 1));
    await settle();
    pushSnapshot(snap('playing', 0, 6));
    jest.advanceTimersByTime(5_000);
    await settle();
    const before = structuredClone(mockStoreOpenSpan.mock.lastCall?.[0]) as OpenSpan;
    const release = holdSaves();
    try {
      pushSnapshot(snap('playing', 0, 9));
      cutListeningSpanNow(); // the app going to the background
      cutListeningSpanNow('c1'); // its server coming back
      flushHistoryOnHide(false); // the web page hidden
      await settle();
      expect(mockClosed).toHaveLength(0);
      expect(mockStoreOpenSpan.mock.lastCall?.[0]).toMatchObject({
        to: before.to,
        endedAt: before.endedAt,
      });
      // A sign-out's last send still takes the span.
      cutPlayingSpan('c1');
      await settle();
      expect(mockClosed.map((s) => [s.from.pos, s.to.pos])).toEqual([[1, 9]]);
    } finally {
      release({ flush: false });
    }
  });

  it('the hold ending with no move makes the cut asked while it held', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 1));
    await settle();
    const release = holdSaves();
    pushSnapshot(snap('playing', 0, 9));
    cutListeningSpanNow(); // the app going to the background
    await settle();
    expect(mockClosed).toHaveLength(0);
    release();
    await settle();
    expect(mockClosed.map((s) => [s.from.pos, s.to.pos])).toEqual([[1, 9]]);
  });

  it('the hold ending in a move owes no cut: the move cut the span', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 1));
    await settle();
    const release = holdSaves();
    pushSnapshot(snap('playing', 0, 9));
    cutListeningSpanNow();
    release({ flush: false });
    await settle();
    expect(mockClosed).toHaveLength(0);
  });

  // A native lock-screen move: the engine's landed place reaches the store before the move.
  it('never moves the span back: a remote move landing as the keep is due ends where it was', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 1));
    await settle();
    pushSnapshot(snap('playing', 0, 6));
    jest.advanceTimersByTime(5_000);
    await settle();
    jest.advanceTimersByTime(4_950); // the next keep is due (within its slack)
    pushSnapshot(snap('playing', 0, 2)); // landed 4 s back: the keep runs on this snapshot
    remoteMove(0, 2);
    await settle();
    // The keep, then the move's own span stored as it opens (fe#321).
    expect(stored().slice(-2)).toEqual([
      ['resume', 1, 6],
      ['moved_back', 2, 2],
    ]);
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([['resume', 1, 6]]);
    pushSnapshot(snap('paused', 0, 3));
    await settle();
    expect(mockClosed.at(-1)).toMatchObject({ start: 'moved_back', from: { pos: 2 } });
  });

  // fe#211 review: the keep's rule on the cut froze the span at a stale place.
  it('the 15 s cut ends where the engine is, after a seek back and a late old place', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 40));
    await settle();
    await usePlayer.getState().seekBook(10);
    jest.advanceTimersByTime(4_950); // the keep is due
    pushSnapshot(snap('playing', 0, 40)); // a late event from before the seek
    pushSnapshot(snap('playing', 0, 12));
    jest.advanceTimersByTime(10_000); // the cut is due
    pushSnapshot(snap('playing', 0, 22));
    await settle();
    pushSnapshot(snap('paused', 0, 24));
    await settle();
    expect(mockClosed.slice(1).map((s) => [s.start, s.from.pos, s.to.pos])).toEqual([
      ['moved_back', 10, 22],
      ['continue', 22, 24],
    ]);
  });

  // fe#321: a kill within 5 s of a move lost the move, which lived only in memory.
  it('a seek while playing stores the span it opens at once, before any keep', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    await settle();
    mockStoreOpenSpan.mockClear();
    await usePlayer.getState().seekBook(70);
    await settle();
    expect(stored()).toEqual([['jump', 70, 70]]);
  });

  it('a playing Stay stores the span it opens at once', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    await settle();
    mockStoreOpenSpan.mockClear();
    standByPlace();
    await settle();
    expect(stored()).toEqual([['jump', 30, 30]]);
  });

  // fe#285: the span a Jump's cut opens begins again where the engine is once the answer is
  // in; a kill before the next keep recovers that copy, not a keep's from the place left.
  it("an offer's answer stores the span it begins again at once", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    await settle();
    let release: () => void = () => {};
    const answered = answerAfterSpan(
      { connectionId: 'c1', libraryId: 2, path: folder },
      () => new Promise<void>((r) => (release = r)),
    );
    // A keep while the answer waits stores the cut's span from the place left.
    pushSnapshot(snap('playing', 0, 35));
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(stored().at(-1)).toEqual(['continue', 30, 35]);
    pushSnapshot(snap('playing', 0, 36));
    release();
    await answered;
    await settle();
    expect(stored().at(-1)).toEqual(['continue', 36, 36]);
  });

  // A kill between a copy stored at the place left and the move recovered that copy, stamped
  // after the answer, and moved this device's record back there over the row just answered.
  it("an offer's answer with a move stores nothing at the place left", async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    await settle();
    let release: () => void = () => {};
    const answered = answerAfterSpan(
      { connectionId: 'c1', libraryId: 2, path: folder },
      () => new Promise<void>((r) => (release = r)),
      () => usePlayer.getState().seekBook(70),
    );
    await settle();
    pushSnapshot(snap('playing', 0, 36));
    mockStoreOpenSpan.mockClear();
    release();
    await answered;
    await settle();
    expect(stored()).toEqual([['jump', 70, 70]]);
    // What it heard while the answer waited closes on nothing: begun again at the answer.
    expect(mockClosed.map((s) => [s.start, s.from.pos, s.to.pos])).not.toContainEqual([
      'continue',
      30,
      36,
    ]);
  });

  it('a cut stores nothing at once: the keep does', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 30));
    await settle();
    mockStoreOpenSpan.mockClear();
    cutListeningSpanNow();
    await settle();
    expect(mockStoreOpenSpan).not.toHaveBeenCalled();
  });

  it('stops with the playing: a pause stores nothing more', async () => {
    await start();
    pushSnapshot(snap('playing', 0, 1));
    await settle();
    pushSnapshot(snap('paused', 0, 3));
    await settle();
    mockStoreOpenSpan.mockClear();
    jest.advanceTimersByTime(20_000);
    await settle();
    expect(mockStoreOpenSpan).not.toHaveBeenCalled();
  });
});

describe('resume by file (fe#188)', () => {
  it("lands in the saved file at its own seconds, though the server's order moved it", async () => {
    // Saved on the download's old order (10.mp3 first): 10 s into 10.mp3 was book second
    // 10 there, which is 2.mp3 in the order the server plays now.
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 10 }),
      file: { path: 'A/Folder/10.mp3', pos: 10 },
    });
    await start();
    const [, index, positionInTrack] = (mockSvc.load as jest.Mock).mock.calls[0];
    expect([index, positionInTrack]).toEqual([1, 10]);
  });

  it('a file the queue no longer has resumes by the book position', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 10 }),
      file: { path: 'A/Folder/gone.mp3', pos: 30 },
    });
    await start();
    const [, index, positionInTrack] = (mockSvc.load as jest.Mock).mock.calls[0];
    expect([index, positionInTrack]).toEqual([0, 10]);
  });

  it('clamps the seconds to the file length', async () => {
    mockLoadInitialProgress.mockResolvedValue({
      kind: 'progress',
      progress: row({ position: 10 }),
      file: { path: 'A/Folder/2.mp3', pos: 400 },
    });
    await start();
    const [, index, positionInTrack] = (mockSvc.load as jest.Mock).mock.calls[0];
    expect([index, positionInTrack]).toEqual([0, 50]);
  });
});
