import { act, renderHook } from '@testing-library/react-native';

import type { Book, ChaptersResponse } from '@/api/types';

const np = { connectionId: 'c', libraryId: 1, path: 'A/B' };
jest.mock('@/playback/store', () => ({
  usePlayer: (select: (s: { nowPlaying: typeof np }) => unknown) => select({ nowPlaying: np }),
}));
jest.mock('@/api/hooks', () => ({
  qk: jest.requireActual('@/api/hooks').qk,
  useCapability: () => true,
}));
jest.mock('@/api/address-route', () => ({
  useActiveAddress: () => ({ url: 'https://example.test' }),
}));
jest.mock('./cast-state', () => ({
  useCast: () => ({ supported: true, status: 'idle', deviceName: undefined }),
}));
const mockModel = jest.fn((input: { book?: Book; chapters?: ChaptersResponse }) => input);
jest.mock('./cast-button-model', () => ({
  castButtonModel: (input: { book?: Book; chapters?: ChaptersResponse }) => mockModel(input),
}));

/* eslint-disable import/first */
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';

import { useCastButton } from './use-cast-button';
/* eslint-enable import/first */

afterEach(() => queryClient.clear());

it("follows the playing book's item and chapters as they land in the cache", async () => {
  const { result } = await renderHook(() => useCastButton() as unknown as { book?: Book });
  expect(result.current.book).toBeUndefined();
  const item = { rel_path: 'A/B', title: 'B' } as Book;
  // Nothing else renders the button: the cache's own news must.
  await act(async () => void queryClient.setQueryData(qk.item('c', 1, 'A/B'), item));
  expect(result.current.book).toBe(item);
  const chapters = { chapters: [], files: [] } as unknown as ChaptersResponse;
  await act(async () => void queryClient.setQueryData(qk.chapters('c', 1, 'A/B'), chapters));
  expect(mockModel).toHaveBeenLastCalledWith(expect.objectContaining({ book: item, chapters }));
});
