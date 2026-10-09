import { setConnectionAliases } from '@/lib/connection-id';

import type { CarNative } from './car-native';

// The native module, faked: a binary with the car functions. Its events are captured by name.
type Handler = (event: Record<string, unknown>) => void;
const mockHandlers = new Map<string, Handler>();
const mockModule = {
  setCarSnapshot: jest.fn(async () => {}),
  getLoadedBook: jest.fn(async (): Promise<unknown> => null),
  consumePendingBookmarks: jest.fn(async (): Promise<unknown[]> => []),
  addListener: jest.fn((name: string, fn: Handler) => {
    mockHandlers.set(name, fn);
    return { remove: jest.fn() };
  }),
};
jest.mock('../../modules/audiosilo-player', () => ({
  __esModule: true,
  get default() {
    return mockModule;
  },
}));

let carNative: CarNative;
beforeAll(() => {
  // Required here, not imported: the seam reads the module's functions as it loads.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  carNative = (require('./car-native.native') as { carNative: CarNative }).carNative;
});
beforeEach(() => setConnectionAliases({ srv: 'srv.3' }));
afterEach(() => setConnectionAliases({}));

describe('car-native (iOS and Android): old connection ids from the native side', () => {
  it("the service's loaded book (a play spec from an old snapshot) names the new connection", async () => {
    mockModule.getLoadedBook.mockResolvedValueOnce({
      connectionId: 'srv',
      libraryId: 2,
      path: 'D',
      trackIndex: 1,
      position: 3,
      playing: true,
      rate: 1,
    });
    expect(await carNative.getLoadedBook()).toEqual({
      connectionId: 'srv.3',
      libraryId: 2,
      path: 'D',
      trackIndex: 1,
      position: 3,
      playing: true,
      rate: 1,
    });
    mockModule.getLoadedBook.mockResolvedValueOnce(null);
    expect(await carNative.getLoadedBook()).toBeNull();
  });

  it("a bookmark press names the engine's book on its new connection", () => {
    const pressed = jest.fn();
    carNative.onBookmark(pressed);
    mockHandlers.get('onRemoteBookmark')!({
      trackIndex: 0,
      position: 9,
      connectionId: 'srv',
      libraryId: 2,
      path: 'D',
    });
    expect(pressed).toHaveBeenCalledWith(0, 9, { connectionId: 'srv.3', libraryId: 2, path: 'D' });
  });
});
