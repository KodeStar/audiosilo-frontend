const mockCalls: string[] = [];
let mockStep: ((id: string) => Promise<void>) | null = null;
const mockUnsubscribe = jest.fn();
jest.mock('@/stores/session', () => ({
  onConnectionRemovedInOtherTab: (fn: (id: string) => Promise<void>) => {
    mockStep = fn;
    return mockUnsubscribe;
  },
}));
jest.mock('./store', () => ({
  stopPlaybackForConnection: async (id: string) => void mockCalls.push(`stop ${id}`),
}));
jest.mock('./listening-outbox', () => ({
  appendInTurn: async (id: string, events: unknown[]) =>
    void mockCalls.push(`turn ${id} ${events.length}`),
}));

/* eslint-disable import/first */
import { startRemovedInOtherTab } from './removed-in-other-tab';
/* eslint-enable import/first */

describe('startRemovedInOtherTab', () => {
  it('stops playing through the removed connection, past its span close, then lets go', async () => {
    const stop = startRemovedInOtherTab();
    await mockStep!('srv.1');
    expect(mockCalls).toEqual(['stop srv.1', 'turn srv.1 0']);
    stop();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
