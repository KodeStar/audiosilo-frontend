const mockItem = jest.fn();
const mockChapters = jest.fn();
let mockClient: object | null;
jest.mock('@/api/connection-clients', () => ({ resolveClient: () => mockClient }));
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({}),
);
const mockPlayBook = jest.fn();
jest.mock('@/playback/store', () => ({
  usePlayer: { getState: () => ({ playBook: (...a: unknown[]) => mockPlayBook(...a) }) },
}));

/* eslint-disable import/first */
import { queryClient } from '@/api/provider';

import { startBookInPlace } from './start-book';
/* eslint-enable import/first */

const target = { connectionId: 'c1', libraryId: 2, path: 'Weir/Project Hail Mary' };

beforeEach(() => {
  queryClient.clear();
  mockClient = {
    item: (...a: unknown[]) => mockItem(...a),
    chapters: (...a: unknown[]) => mockChapters(...a),
  };
  mockItem.mockReset().mockResolvedValue({ rel_path: target.path });
  mockChapters.mockReset().mockResolvedValue({ chapters: [], files: [] });
  mockPlayBook.mockReset().mockResolvedValue(undefined);
});

describe('startBookInPlace', () => {
  it('plays the book with its item and chapters, from the saved place', async () => {
    await expect(startBookInPlace(target)).resolves.toBe(true);
    expect(mockItem).toHaveBeenCalledWith(2, target.path, expect.anything());
    expect(mockPlayBook).toHaveBeenCalledWith(
      'c1',
      2,
      { rel_path: target.path },
      { chapters: [], files: [] },
    );
  });

  it('does nothing when the connection is gone', async () => {
    mockClient = null;
    await expect(startBookInPlace(target)).resolves.toBe(false);
    expect(mockPlayBook).not.toHaveBeenCalled();
  });

  it('rejects, without playing, when the book cannot be fetched', async () => {
    mockChapters.mockRejectedValue(new Error('offline'));
    await expect(startBookInPlace(target)).rejects.toThrow('offline');
    expect(mockPlayBook).not.toHaveBeenCalled();
  });
});
