import type { Book } from '@/api/types';

import type { PlaybackService, PlaybackSnapshot } from './types';

// Two of the store's races with the native bridge (Phase 6): the bridge is created once
// however many callers race to the first, and a remote move reported while a book loads
// belongs to the previous queue.

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
let remoteMove: ((trackIndex: number, positionInTrack: number) => void) | null = null;
const INITIAL: PlaybackSnapshot = {
  state: 'idle',
  trackIndex: 0,
  position: 0,
  duration: 0,
  rate: 1,
};
let finishSetup: () => void = () => {};
const mockSvc = {
  onRemoteSeek: jest.fn(),
  onRemoteMove: jest.fn((h: typeof remoteMove) => {
    remoteMove = h;
  }),
  setup: jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finishSetup = resolve;
      }),
  ),
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

const mockCreate = jest.fn(() => mockSvc);
jest.mock('./service', () => ({ createPlaybackService: () => mockCreate() }));

const mockSaveProgress = jest.fn(async (..._args: unknown[]) => {});
jest.mock('./progress-sync', () => ({
  saveProgress: (...args: unknown[]) => mockSaveProgress(...args),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  loadInitialProgress: jest.fn(async () => ({ kind: 'empty' })),
  readMirror: jest.fn(async () => null),
}));
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
jest.mock('@/lib/network', () => ({ canAutoDownload: jest.fn(async () => false) }));
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
import { usePlayer } from './store';
/* eslint-enable import/first */

const book = (path: string, duration = 100): Book => ({
  id: 1,
  library_id: 2,
  rel_path: path,
  is_folder: false,
  title: path,
  author: 'Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration,
  format: 'm4b',
  size: 0,
});

async function flush(turns = 10) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe('the native bridge', () => {
  it('is created once however many callers race to the first', async () => {
    const a = usePlayer.getState().toggle();
    const b = usePlayer.getState().toggle();
    await flush();
    finishSetup();
    await Promise.all([a, b]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockSvc.setup).toHaveBeenCalledTimes(1);
    expect(mockSvc.subscribe).toHaveBeenCalledTimes(1);
  });

  it("ignores a remote move reported while a book loads (it is the previous queue's)", async () => {
    // Book A plays, file 2 of 3 (100 s each).
    const startingA = usePlayer.getState().playBook('c1', 2, book('A', 300), {
      library_id: 2,
      path: 'A',
      duration: 300,
      is_folder: true,
      files: [0, 1, 2].map((i) => ({
        rel_path: `A/${i}.mp3`,
        seq: i,
        duration: 100,
        format: 'mp3',
        size: 1,
      })),
      chapters: [],
    });
    await flush();
    finishSetup(); // the bridge's setup, when this test runs on its own
    await startingA;
    pushSnapshot({ state: 'playing', trackIndex: 1, position: 40, duration: 100, rate: 1 });
    // B starts and its load is still out when A's late move arrives (file 2, 70 s).
    let landed!: () => void;
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          landed = resolve;
        }),
    );
    const starting = usePlayer.getState().playBook('c1', 2, book('B'), undefined, 50);
    await flush(30);
    expect(usePlayer.getState().loadingBook).not.toBeNull();
    mockSaveProgress.mockClear();
    remoteMove?.(2, 70);
    await flush();
    expect(mockSaveProgress).not.toHaveBeenCalled();
    landed();
    await starting;
  });
});
