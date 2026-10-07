import type { QueueEntry } from '@/api/types';
import type { UpNextBook } from '@/playback/up-next-resolver';

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
const mockStart = jest.fn();
jest.mock('./start-book', () => ({ startBookInPlace: (t: unknown) => mockStart(t) }));

/* eslint-disable import/first */
import { CapabilityError, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';

import { advanceTo, dropFromQueue } from './end-of-book';
/* eslint-enable import/first */

const entry = (path: string): QueueEntry => ({ library_id: 1, path, added_at: '' });
const finished = { library_id: 1, path: 'Series/Book 1' };
const next: UpNextBook = {
  connectionId: 'c1',
  libraryId: 1,
  path: 'Other/Queued',
  title: 'Queued',
  author: '',
  duration: 0,
  source: 'queue',
  queueEntry: { library_id: 1, path: 'Other/Queued' },
};

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryDefaults(qk.queue('c1'), { gcTime: Infinity });
  queryClient.setQueryDefaults(qk.server('c1'), { gcTime: Infinity });
  queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
  mockClient = { queue: () => mockQueueRead() };
  mockQueueRead.mockReset().mockResolvedValue([entry('Series/Book 1')]);
  mockRemove.mockReset().mockResolvedValue(undefined);
  mockStart.mockReset().mockResolvedValue(true);
});

describe('dropFromQueue', () => {
  it('removes the stored entries that hold the books, by their own paths', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued'), entry('Series')]);
    await dropFromQueue('c1', [{ library_id: 1, path: 'Series/Book 1' }, next.queueEntry!]);
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

  it('sends nothing for a book not queued, a server without a queue or a gone connection', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued')]);
    await dropFromQueue('c1', [finished]);
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: false } });
    await dropFromQueue('c1', [next.queueEntry!]);
    mockClient = null;
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
    await dropFromQueue('c1', [next.queueEntry!]);
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
});

describe('advanceTo', () => {
  it('starts the next book in place, then takes it off Up next', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued'), entry('Series/Book 1')]);
    await expect(advanceTo(next)).resolves.toBe(true);
    expect(mockStart).toHaveBeenCalledWith(next);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRemove.mock.calls).toEqual([['c1', { libraryId: 1, path: 'Other/Queued' }]]);
  });

  it('leaves Up next alone when the book does not start', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued'), entry('Series/Book 1')]);
    mockStart.mockResolvedValueOnce(false);
    await expect(advanceTo(next)).resolves.toBe(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockStart.mockRejectedValueOnce(new Error('offline'));
    await expect(advanceTo(next)).resolves.toBe(false);
    warn.mockRestore();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
