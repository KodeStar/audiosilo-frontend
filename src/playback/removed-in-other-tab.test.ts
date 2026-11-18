const mockUnsubscribe = jest.fn();
let mockStep: ((id: string) => Promise<void>) | null = null;
jest.mock('@/stores/session', () => ({
  onConnectionRemovedInOtherTab: (fn: (id: string) => Promise<void>) => {
    mockStep = fn;
    return mockUnsubscribe;
  },
}));
const mockStopAndClose = jest.fn(async (_id: string) => {});
jest.mock('./store', () => ({
  stopPlaybackAndCloseSpan: (id: string) => mockStopAndClose(id),
}));

/* eslint-disable import/first */
import { startRemovedInOtherTab } from './removed-in-other-tab';
/* eslint-enable import/first */

describe('startRemovedInOtherTab', () => {
  it('stops playing through the removed connection, past its span close, then lets go', async () => {
    const stop = startRemovedInOtherTab();
    await mockStep!('srv.1');
    expect(mockStopAndClose).toHaveBeenCalledWith('srv.1');
    stop();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
