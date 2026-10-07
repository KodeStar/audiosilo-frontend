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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.queue('c1') });
    // One connection's queue writes run one at a time, like useRemoveFromQueue's.
    expect(queryClient.getMutationCache().getAll()[0]?.options.scope).toEqual({ id: 'queue:c1' });
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
