const mockUnsubscribe = jest.fn();
let mockStep: ((id: string) => Promise<void>) | null = null;
let mockGoing: ((id: string) => Promise<void> | null) | null = null;
jest.mock('@/stores/session', () => ({
  onConnectionRemovedInOtherTab: (fn: (id: string) => Promise<void>) => {
    mockStep = fn;
    return mockUnsubscribe;
  },
  onConnectionGoingInOtherTab: (fn: (id: string) => Promise<void> | null) => {
    mockGoing = fn;
    return mockUnsubscribe;
  },
}));
const mockOrder: string[] = [];
const mockStopAndClose = jest.fn(async (id: string) => {
  mockOrder.push(`stop ${id}`);
});
const mockFlush = jest.fn(async (id: string) => {
  mockOrder.push(`flush ${id}`);
});
let mockNowPlaying: { connectionId: string } | null = null;
jest.mock('./store', () => ({
  stopPlaybackAndCloseSpan: (id: string) => mockStopAndClose(id),
  flushConnectionSaves: (id: string) => mockFlush(id),
  usePlayer: { getState: () => ({ nowPlaying: mockNowPlaying }) },
}));

/* eslint-disable import/first */
import { startRemovedInOtherTab } from './removed-in-other-tab';
/* eslint-enable import/first */

beforeEach(() => {
  mockStopAndClose.mockClear();
  mockFlush.mockClear();
  mockUnsubscribe.mockClear();
  mockOrder.length = 0;
  mockNowPlaying = null;
});

describe('startRemovedInOtherTab', () => {
  it('stops playing through the removed connection, past its span close, then lets go', async () => {
    mockNowPlaying = { connectionId: 'srv.1' };
    const stop = startRemovedInOtherTab();
    await mockStep!('srv.1');
    expect(mockStopAndClose).toHaveBeenCalledWith('srv.1');
    stop();
    // Both of its steps let go.
    expect(mockUnsubscribe).toHaveBeenCalledTimes(2);
  });

  // Every open tab is told: one with nothing loaded through the connection must not queue
  // on the span lock the tabs share.
  it('does nothing in a tab with no book loaded through it', async () => {
    startRemovedInOtherTab();
    await mockStep!('srv.1');
    mockNowPlaying = { connectionId: 'srv.2' };
    await mockStep!('srv.1');
    expect(mockStopAndClose).not.toHaveBeenCalled();
  });

  // Another tab is about to revoke the token: this tab's stop and saves go first, while it
  // still works.
  it('before the token goes: stops, then sends its saves', async () => {
    mockNowPlaying = { connectionId: 'srv.1' };
    startRemovedInOtherTab();
    await mockGoing!('srv.1');
    expect(mockOrder).toEqual(['stop srv.1', 'flush srv.1']);
  });

  it('has no work before the token goes in a tab not playing through it', () => {
    startRemovedInOtherTab();
    expect(mockGoing!('srv.1')).toBeNull();
    mockNowPlaying = { connectionId: 'srv.2' };
    expect(mockGoing!('srv.1')).toBeNull();
    expect(mockStopAndClose).not.toHaveBeenCalled();
    expect(mockFlush).not.toHaveBeenCalled();
  });
});
