import { act, renderHook } from '@testing-library/react-native';

import type { Rating } from '@/api/types';

let mockExact: Rating | null | undefined;
let mockMine: Rating[] | undefined;
const mockMineOpts = jest.fn();
const mockSet = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('@/api/hooks', () => ({
  ...jest.requireActual('@/api/hooks'),
  useRating: () => ({ data: mockExact }),
  useMyRatings: (_cid: string, opts: { enabled?: boolean }) => {
    mockMineOpts(opts);
    return { data: opts.enabled ? mockMine : undefined, isError: false };
  },
  useSetRating: () => ({ mutateAsync: mockSet, isPending: false }),
}));
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));

/* eslint-disable import/first */
import { useBookRating } from './use-book-rating';
/* eslint-enable import/first */

const rating = (over: Partial<Rating>): Rating =>
  ({ library_id: 1, path: 'A/Book', rating: 4, note: 'Loved it', ...over }) as Rating;

async function mount(path = 'A/Book') {
  const { result } = await renderHook(() => useBookRating('c', 1, path));
  return result;
}

beforeEach(() => {
  mockExact = undefined;
  mockMine = [];
  mockMineOpts.mockReset();
  mockSet.mockClear();
});

describe('useBookRating', () => {
  it("waits for the book's own rating, and never asks for the whole list beside it", async () => {
    let r = await mount();
    expect(r.current.ready).toBe(false);
    expect(mockMineOpts).toHaveBeenLastCalledWith({ enabled: false });
    mockExact = rating({});
    r = await mount();
    expect(r.current).toMatchObject({ value: 4, ready: true });
    expect(mockMineOpts).toHaveBeenLastCalledWith({ enabled: false });
  });

  // A part or disc path: the server rates its book, which the list holds.
  it("asks the list only when the path has none, and keeps the parent book's note", async () => {
    mockExact = null;
    mockMine = [rating({ path: 'A/Book', rating: 3 })];
    const r = await mount('A/Book/Disc 1');
    expect(mockMineOpts).toHaveBeenLastCalledWith({ enabled: true });
    expect(r.current).toMatchObject({ value: 3, ready: true });
    await act(async () => r.current.rate(5));
    expect(mockSet).toHaveBeenCalledWith({
      libraryId: 1,
      path: 'A/Book/Disc 1',
      rating: 5,
      note: 'Loved it',
    });
    expect(r.current.value).toBe(5);
  });
});
