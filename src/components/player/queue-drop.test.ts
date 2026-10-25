import type { QueueEntry } from '@/api/types';

const mockRemove = jest.fn();
jest.mock('@/api/hooks', () => ({
  ...jest.requireActual('@/api/hooks'),
  removeFromQueue: (cid: string, _client: unknown, v: unknown) => mockRemove(cid, v),
}));
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({}),
);
const mockQueueRead = jest.fn();
let mockClient: object | null;
jest.mock('@/api/connection-clients', () => ({ resolveClient: () => mockClient }));

/* eslint-disable import/first */
import { QueryObserver } from '@tanstack/react-query';

import { CapabilityError, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';

import { dropFromQueue, QUEUE_DROP_FRESH_MS } from './queue-drop';
/* eslint-enable import/first */

const entry = (path: string): QueueEntry => ({ library_id: 1, path, added_at: '' });
const finished = { library_id: 1, path: 'Series/Book 1' };
const queued = { library_id: 1, path: 'Other/Queued' };

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryDefaults(qk.queue('c1'), { gcTime: Infinity });
  queryClient.setQueryDefaults(qk.server('c1'), { gcTime: Infinity });
  queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
  mockClient = { queue: () => mockQueueRead() };
  mockQueueRead.mockReset().mockResolvedValue([entry('Series/Book 1')]);
  mockRemove.mockReset().mockResolvedValue(undefined);
});

/** Until the first remove is on its way (the queue read before it settles first). */
async function removeStarted() {
  for (let i = 0; i < 50 && mockRemove.mock.calls.length === 0; i++) await Promise.resolve();
}

describe('dropFromQueue', () => {
  it('removes the stored entries that hold the books, by their own paths', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued'), entry('Series')]);
    await dropFromQueue('c1', [{ library_id: 1, path: 'Series/Book 1' }, queued]);
    expect(mockRemove.mock.calls).toEqual([
      ['c1', { libraryId: 1, path: 'Other/Queued' }],
      ['c1', { libraryId: 1, path: 'Series' }],
    ]);
    expect(mockQueueRead).not.toHaveBeenCalled();
  });

  it('reads the queue once when it is not cached', async () => {
    await dropFromQueue('c1', [finished]);
    expect(mockQueueRead).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledWith('c1', { libraryId: 1, path: 'Series/Book 1' });
  });

  // fe#128: with Up next closed nothing observes the queue, so starts in a row must not
  // read /queue each time; but a read must not outlive its window either, or a book queued
  // on another device later never leaves Up next when it starts here.
  describe('the freshness window', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      queryClient.setQueryDefaults(qk.queue('c1'), {}); // the app's defaults
    });
    afterEach(() => jest.useRealTimers());

    it('reads the queue once for drops inside the window', async () => {
      mockQueueRead.mockResolvedValue([entry('Other/Queued')]);
      await dropFromQueue('c1', [finished]);
      jest.advanceTimersByTime(QUEUE_DROP_FRESH_MS - 60_000);
      await dropFromQueue('c1', [finished]);
      await dropFromQueue('c1', [finished]);
      expect(mockQueueRead).toHaveBeenCalledTimes(1);
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('reads it again past the window, and drops a book queued elsewhere meanwhile', async () => {
      mockQueueRead.mockResolvedValueOnce([entry('Other/Queued')]);
      await dropFromQueue('c1', [finished]);
      // A view holding the queue (it is never collected): only its age may decide.
      const held = new QueryObserver(queryClient, { queryKey: qk.queue('c1'), enabled: false });
      const unsubscribe = held.subscribe(() => {});
      // Another device queues the book; this one starts it after the window.
      mockQueueRead.mockResolvedValueOnce([entry('Other/Queued'), entry('Series/Book 1')]);
      jest.advanceTimersByTime(QUEUE_DROP_FRESH_MS + 1_000);
      await dropFromQueue('c1', [finished]);
      unsubscribe();
      expect(mockQueueRead).toHaveBeenCalledTimes(2);
      expect(mockRemove).toHaveBeenCalledWith('c1', { libraryId: 1, path: 'Series/Book 1' });
    });

    it('keeps the window from its read: taking a book off the cached queue does not extend it', async () => {
      mockQueueRead.mockResolvedValueOnce([entry('Other/Queued'), entry('Series/Book 1')]);
      const held = new QueryObserver(queryClient, { queryKey: qk.queue('c1'), enabled: false });
      const unsubscribe = held.subscribe(() => {});
      await dropFromQueue('c1', [queued]);
      jest.advanceTimersByTime(QUEUE_DROP_FRESH_MS - 60_000);
      await dropFromQueue('c1', [finished]); // from the cache, inside the window
      // Another device queues a book; this one starts it once the first read is too old.
      mockQueueRead.mockResolvedValueOnce([entry('Series/Book 2')]);
      jest.advanceTimersByTime(61_000);
      await dropFromQueue('c1', [{ library_id: 1, path: 'Series/Book 2' }]);
      unsubscribe();
      expect(mockQueueRead).toHaveBeenCalledTimes(2);
      expect(mockRemove).toHaveBeenLastCalledWith('c1', { libraryId: 1, path: 'Series/Book 2' });
    });

    it('reads it again inside the window once this device invalidated it (its own write)', async () => {
      mockQueueRead.mockResolvedValueOnce([entry('Other/Queued')]);
      await dropFromQueue('c1', [finished]);
      mockQueueRead.mockResolvedValueOnce([entry('Series/Book 1')]);
      await queryClient.invalidateQueries({ queryKey: qk.queue('c1') });
      await dropFromQueue('c1', [finished]);
      expect(mockRemove).toHaveBeenCalledWith('c1', { libraryId: 1, path: 'Series/Book 1' });
    });
  });

  it('sends nothing for a book not queued, a server without a queue or a gone connection', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued')]);
    await dropFromQueue('c1', [finished]);
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: false } });
    await dropFromQueue('c1', [queued]);
    mockClient = null;
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
    await dropFromQueue('c1', [queued]);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('takes a removed entry out of the cached queue, so a second drop sends nothing', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued'), entry('Series/Book 1')]);
    await dropFromQueue('c1', [finished]);
    expect(queryClient.getQueryData(qk.queue('c1'))).toEqual([entry('Other/Queued')]);
    // The credits opened on return drop the same finished book again.
    await dropFromQueue('c1', [finished]);
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('is quiet about a refused remove', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Series/Book 1')]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockRemove.mockRejectedValueOnce(new CapabilityError('queue'));
    await expect(dropFromQueue('c1', [finished])).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    mockRemove.mockRejectedValueOnce(new Error('offline'));
    await expect(dropFromQueue('c1', [finished])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('sends one remove when two drops of the same book overlap (a start and the end of a book)', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued')]);
    let release: () => void = () => {};
    mockRemove.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = dropFromQueue('c1', [queued]);
    const second = dropFromQueue('c1', [queued]);
    await removeStarted();
    release();
    await Promise.all([first, second]);
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(qk.queue('c1'))).toEqual([]);
  });

  it('sends one remove for an entry a drop reaches later, when another drop asks for it meanwhile', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Series/Book 1'), entry('Other/Queued')]);
    let release: () => void = () => {};
    mockRemove.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const both = dropFromQueue('c1', [finished, queued]);
    const second = dropFromQueue('c1', [queued]);
    await removeStarted();
    release();
    await Promise.all([both, second]);
    expect(mockRemove.mock.calls).toEqual([
      ['c1', { libraryId: 1, path: 'Series/Book 1' }],
      ['c1', { libraryId: 1, path: 'Other/Queued' }],
    ]);
  });
});
