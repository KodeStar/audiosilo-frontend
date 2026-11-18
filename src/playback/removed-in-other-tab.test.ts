const mockUnsubscribe = jest.fn();
let mockStep: ((id: string) => Promise<void>) | null = null;
jest.mock('@/stores/session', () => ({
  onConnectionRemovedInOtherTab: (fn: (id: string) => Promise<void>) => {
    mockStep = fn;
    return mockUnsubscribe;
  },
}));
const mockStopAndClose = jest.fn(async (_id: string) => {});
let mockNowPlaying: { connectionId: string } | null = null;
jest.mock('./store', () => ({
  stopPlaybackAndCloseSpan: (id: string) => mockStopAndClose(id),
  usePlayer: { getState: () => ({ nowPlaying: mockNowPlaying }) },
}));

/* eslint-disable import/first */
import { startRemovedInOtherTab } from './removed-in-other-tab';
/* eslint-enable import/first */

beforeEach(() => {
  mockStopAndClose.mockClear();
  mockUnsubscribe.mockClear();
  mockNowPlaying = null;
});

describe('startRemovedInOtherTab', () => {
  it('stops playing through the removed connection, past its span close, then lets go', async () => {
    mockNowPlaying = { connectionId: 'srv.1' };
    const stop = startRemovedInOtherTab();
    await mockStep!('srv.1');
    expect(mockStopAndClose).toHaveBeenCalledWith('srv.1');
    stop();
    expect(mockUnsubscribe).toHaveBeenCalled();
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
});
