import type { ApiClient } from '@/api/client';

// The framework-free queue remove (the end of a book): the provider's module-level
// QueryClient is the real cache it reads the server's flags from and refreshes.
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({}),
);

/* eslint-disable import/first */
import { CapabilityError, qk, removeFromQueue } from '@/api/hooks';
import { queryClient } from '@/api/provider';
/* eslint-enable import/first */

const remove = jest.fn(async () => undefined);
const client = { removeFromQueue: remove } as unknown as ApiClient;

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryDefaults(qk.server('c1'), { gcTime: Infinity });
  remove.mockClear();
});

describe('removeFromQueue', () => {
  it('removes on a server with a queue and refreshes its queue', async () => {
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    await removeFromQueue('c1', client, { libraryId: 1, path: 'A/Book' });
    expect(remove).toHaveBeenCalledWith(1, 'A/Book');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.queue('c1'), exact: true });
    // One connection's queue writes run one at a time, like useRemoveFromQueue's.
    expect(queryClient.getMutationCache().getAll()[0]?.options.scope).toEqual({ id: 'queue:c1' });
  });

  it('never lets a queue read started before the remove put the entry back (fe#155)', async () => {
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
    queryClient.setQueryDefaults(qk.queue('c1'), { gcTime: Infinity });
    queryClient.setQueryData(qk.queue('c1'), [{ path: 'A/Book' }, { path: 'B/Book' }]);
    // A read in flight from before the remove, answering the old queue late; a read made
    // after it gets the server's queue without the removed entry.
    let answerStale!: (q: unknown) => void;
    let reads = 0;
    const queryFn = () =>
      ++reads === 1
        ? new Promise((r) => (answerStale = r))
        : Promise.resolve([{ path: 'B/Book' }, { path: 'C/Book' }]);
    // Its caller asked for a fresh queue, as the end of a book does (`resolveUpNext`).
    const fresh = queryClient.fetchQuery({ queryKey: qk.queue('c1'), queryFn, staleTime: 0 });
    await removeFromQueue('c1', client, { libraryId: 1, path: 'A/Book' });
    await new Promise((r) => setTimeout(r, 0));
    answerStale([{ path: 'A/Book' }, { path: 'stale answer' }]);
    // The caller gets the read made after the remove, never the queue cached before its
    // read, and the stale answer never reaches the cache.
    await expect(fresh).resolves.toEqual([{ path: 'B/Book' }, { path: 'C/Book' }]);
    expect(queryClient.getQueryData(qk.queue('c1'))).toEqual([
      { path: 'B/Book' },
      { path: 'C/Book' },
    ]);
    expect(reads).toBe(2);
  });

  it('cancels a first queue read in flight at the remove and reads it again', async () => {
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
    queryClient.setQueryDefaults(qk.queue('c1'), { gcTime: Infinity });
    // Nothing cached yet: the read in flight is cancelled, never answering into the cache.
    let answer!: (q: unknown) => void;
    const first = queryClient
      .fetchQuery({
        queryKey: qk.queue('c1'),
        queryFn: () => new Promise((r) => (answer = r)),
      })
      .catch((e: unknown) => e);
    await removeFromQueue('c1', client, { libraryId: 1, path: 'A/Book' });
    await new Promise((r) => setTimeout(r, 0));
    answer([{ path: 'A/Book' }, { path: 'stale answer' }]);
    expect(await first).toMatchObject({ revert: true });
    expect(queryClient.getQueryData(qk.queue('c1'))).toBeUndefined();
    expect(queryClient.getQueryState(qk.queue('c1'))?.isInvalidated).toBe(true);
  });

  it('sends nothing while the server is unknown or without a queue', async () => {
    await expect(removeFromQueue('c1', client, { libraryId: 1, path: 'A' })).rejects.toEqual(
      new CapabilityError('queue', true),
    );
    queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: false } });
    await expect(removeFromQueue('c1', client, { libraryId: 1, path: 'A' })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    expect(remove).not.toHaveBeenCalled();
  });
});
