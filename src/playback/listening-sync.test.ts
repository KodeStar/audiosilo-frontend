import { AppState, type AppStateStatus } from 'react-native';

import { beginNetworkCheck, endNetworkCheck } from '@/api/address-route';

// Sync v2's triggers (`listening-sync.ts`): when each outbox is sent and the playing span cut.

const mockFlushAll = jest.fn(async () => {});
const mockFlushOutbox = jest.fn(async (..._a: unknown[]) => {});
jest.mock('./listening-outbox', () => ({
  flushAllOutboxes: () => mockFlushAll(),
  flushOutbox: (...a: unknown[]) => mockFlushOutbox(...a),
}));
const mockCut = jest.fn((..._a: unknown[]) => {});
jest.mock('./store', () => ({ cutListeningSpanNow: (...a: unknown[]) => mockCut(...a) }));
jest.mock('@/api/connection-clients', () => ({ sessionReady: () => true }));
let mockReconnect: ((cid: string) => void) | null = null;
jest.mock('@/api/reachability', () => ({
  onReconnect: (cb: (cid: string) => void) => {
    mockReconnect = cb;
    return () => {
      mockReconnect = null;
    };
  },
}));
jest.mock('@/stores/session', () => ({ useSession: { subscribe: () => () => {} } }));

/* eslint-disable import/first */
import { startListeningSync } from './listening-sync';
/* eslint-enable import/first */

let appState: ((s: AppStateStatus) => void) | null = null;
let release: () => void = () => {};

async function settle(turns = 8) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(AppState, 'currentState', { get: () => 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (s: AppStateStatus) => void,
  ) => {
    appState = handler;
    return { remove: () => {} };
  }) as unknown as typeof AppState.addEventListener);
  release = startListeningSync();
});

afterEach(() => {
  release();
  endNetworkCheck();
  jest.restoreAllMocks();
});

it('sends every outbox at launch, and the server coming back cuts its span and sends', async () => {
  expect(mockFlushAll).toHaveBeenCalledTimes(1);
  mockReconnect?.('c1');
  expect(mockCut).toHaveBeenCalledWith('c1');
  expect(mockFlushOutbox).toHaveBeenCalledWith('c1');
});

it("cuts the span on leaving; on coming back, sends only after the address runner's network check", async () => {
  mockFlushAll.mockClear();
  appState?.('background');
  expect(mockCut).toHaveBeenCalledTimes(1);
  // The device may be on another network now: a home address checked on the old one goes
  // first, so the token never reaches whatever holds that address here.
  beginNetworkCheck();
  appState?.('active');
  await settle();
  expect(mockFlushAll).not.toHaveBeenCalled();
  endNetworkCheck();
  await settle();
  expect(mockFlushAll).toHaveBeenCalledTimes(1);
});
