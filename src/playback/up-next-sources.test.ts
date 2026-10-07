import { onlineManager, QueryObserver } from '@tanstack/react-query';

import type { ApiClient } from '@/api/client';
import type { QueueEntry } from '@/api/types';

jest.mock('@/api/provider', () =>
  // `require` (not an import) because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({}),
);

/* eslint-disable import/first */
import { qk, queueQuery } from '@/api/hooks';
import { queryClient } from '@/api/provider';

import { upNextSources } from './up-next-sources';
/* eslint-enable import/first */

/** Where a read stands once everything it can do by itself has run: its value, its
 * error, or still `'pending'` (held, waiting on the browser). */
async function settle<T>(read: Promise<T>) {
  const out: { now: { value: T } | { error: unknown } | 'pending' } = { now: 'pending' };
  read.then(
    (value) => (out.now = { value }),
    (error: unknown) => (out.now = { error }),
  );
  await jest.advanceTimersByTimeAsync(30_000);
  return out.now;
}

beforeEach(() => {
  jest.useFakeTimers();
  queryClient.clear();
  // The browser says it is offline: TanStack's default network mode would hold a read.
  onlineManager.setOnline(false);
});
afterEach(() => {
  queryClient.clear();
  onlineManager.setOnline(true);
  jest.useRealTimers();
});

// The end of a book (in a background tab, or offline) waits on these reads, and the
// resolver only falls back from one that ends.
describe('upNextSources', () => {
  it('asks the server even while the browser says it is offline, so every read settles', async () => {
    const fail = () => Promise.reject(new TypeError('offline'));
    const client = { queue: jest.fn(fail), allProgress: jest.fn(fail), nextBook: jest.fn(fail) };
    const sources = upNextSources(client as unknown as ApiClient, 'c1');
    const failed = { error: expect.any(TypeError) };
    expect(await settle(sources.queue())).toEqual(failed);
    expect(await settle(sources.finished())).toEqual(failed);
    expect(await settle(sources.nextBook(1, 'A/Book'))).toEqual(failed);
    expect(client.queue).toHaveBeenCalledTimes(1);
    expect(client.allProgress).toHaveBeenCalledTimes(1);
    expect(client.nextBook).toHaveBeenCalledTimes(1);
  });

  it('reads the queue past a refetch that Up next holds for the network', async () => {
    const fresh: QueueEntry[] = [{ library_id: 1, path: 'B/Next', added_at: '' }];
    const client = { queue: jest.fn(async () => fresh) } as unknown as ApiClient;
    queryClient.setQueryData(qk.queue('c1'), []);
    const stop = new QueryObserver(queryClient, queueQuery('c1', client)).subscribe(() => {});
    expect(queryClient.getQueryState(qk.queue('c1'))?.fetchStatus).toBe('paused');
    expect(await settle(upNextSources(client, 'c1').queue())).toEqual({ value: fresh });
    stop();
  });
});
