import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Favourite } from '@/api/types';

// useToggleFavourite on a folder `/fs` flags `pending_book` (server#193): the server
// derives a favourite's is_book from its index, so the hook also reads the book (the
// on-demand index the book screen also triggers) before the list is read again, or
// Favourites and Home would open it as a folder.
const calls: string[] = [];
const mockItem = jest.fn(async (_lib: number, path: string) => {
  calls.push(`item ${path}`);
  return {};
});
// The favourites cache as the add saw it: the optimistic stub, before the settle refetch.
let listAtAdd: Favourite[] | undefined;
const mockAdd = jest.fn(async (_lib: number, path: string) => {
  calls.push(`add ${path}`);
  listAtAdd = qc.getQueryData<Favourite[]>(qk.favourites('c'));
});
const mockList = jest.fn(async (): Promise<Favourite[]> => []);
const mockRemove = jest.fn(async (_lib: number, path: string) => {
  calls.push(`remove ${path}`);
});
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (options: unknown) => mockToast(options) }));
jest.mock('@/api/provider', () =>
  // `require` because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({
    c: {
      item: (l: number, p: string) => mockItem(l, p),
      addFavourite: (l: number, p: string) => mockAdd(l, p),
      removeFavourite: (l: number, p: string) => mockRemove(l, p),
      favourites: () => mockList(),
    },
  }),
);

/* eslint-disable import/first */
import { qk, type ToggleFavouriteVars, useFavourites, useToggleFavourite } from '@/api/hooks';
import { useFavouriteAction } from '@/components/library/use-favourite-action';
/* eslint-enable import/first */

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  calls.length = 0;
  mockToast.mockClear();
  listAtAdd = undefined;
  // Infinite gcTime on both, so no garbage-collection timer keeps Jest from exiting.
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
});
afterEach(() => qc.clear());

async function toggle(vars: ToggleFavouriteVars) {
  const { result } = await renderHook(() => useToggleFavourite(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync(vars);
  });
  return listAtAdd?.find((f) => f.path === vars.path);
}

describe('useToggleFavourite', () => {
  it('reads a pending book as it hearts it, and stubs it as a book', async () => {
    const stub = await toggle({ libraryId: 1, path: 'A/New Book', on: true, pendingBook: true });
    expect([...calls].sort()).toEqual(['add A/New Book', 'item A/New Book']);
    expect(stub?.is_book).toBe(true);
    // The read lands in the item cache, so the book screen opened next asks nothing.
    expect(qc.getQueryData(qk.item('c', 1, 'A/New Book'))).toEqual({});
  });

  it('still hearts a pending book when the read fails', async () => {
    mockItem.mockRejectedValueOnce(new Error('boom'));
    await toggle({ libraryId: 1, path: 'A/New Book', on: true, pendingBook: true });
    expect(calls).toEqual(['add A/New Book']);
  });

  it('hearts a plain folder without reading it, stubbed as a folder', async () => {
    const stub = await toggle({ libraryId: 1, path: 'A', on: true });
    expect(calls).toEqual(['add A']);
    expect(stub?.is_book).toBe(false);
  });

  it('sends an unheart tapped during the read after the add, and reads the list once', async () => {
    let finishRead!: () => void;
    mockItem.mockImplementationOnce(async (_lib: number, path: string) => {
      calls.push(`item ${path}`);
      await new Promise<void>((resolve) => (finishRead = resolve));
      return {};
    });
    const listReads = jest.spyOn(qc, 'invalidateQueries');
    const { result } = await renderHook(() => useToggleFavourite(), { wrapper });
    const vars = { libraryId: 1, path: 'A/New Book', pendingBook: true };
    let heart!: Promise<unknown>;
    let unheart!: Promise<unknown>;
    await act(async () => {
      heart = result.current.mutateAsync({ ...vars, on: true });
      unheart = result.current.mutateAsync({ ...vars, on: false });
    });
    // The unheart waits behind the heart's read.
    expect(calls).not.toContain('remove A/New Book');
    await act(async () => {
      finishRead();
      await Promise.all([heart, unheart]);
    });
    expect(calls.indexOf('remove A/New Book')).toBeGreaterThan(calls.indexOf('add A/New Book'));
    const favouriteReads = listReads.mock.calls.filter(
      ([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(qk.favourites('c')),
    );
    expect(favouriteReads).toHaveLength(1);
  });

  // A write that fails (in the app it is sent with no network too, and fails at once)
  // takes its heart back.
  describe('a toggle that fails', () => {
    it.each([true, false])(
      'tells the listener the change failed after its button unmounts (add: %s)',
      async (on) => {
        const book = { library_id: 1, path: 'A' } as Favourite;
        const before = on ? [] : [book];
        const key = qk.favourites('c');
        qc.setQueryData(key, before);
        let rejectWrite!: (e: Error) => void;
        (on ? mockAdd : mockRemove).mockImplementationOnce(
          () => new Promise<void>((_, reject) => (rejectWrite = reject)),
        );
        const button = await renderHook(() => useFavouriteAction('c'), { wrapper });
        await act(async () => button.result.current({ libraryId: 1, path: 'A', on }));
        expect(qc.getQueryData<Favourite[]>(key)?.map((f) => f.path)).toEqual(on ? ['A'] : []);
        expect(mockToast).not.toHaveBeenCalled();
        await button.unmount();
        await act(async () => rejectWrite(new TypeError('Network request failed')));
        expect(qc.getQueryData(key)).toEqual(before);
        expect(mockToast).toHaveBeenCalledTimes(1);
        expect(mockToast).toHaveBeenCalledWith({
          title: "Couldn't update your favourites. Try again.",
        });
      },
    );

    const fail = async (vars: ToggleFavouriteVars) => {
      mockAdd.mockRejectedValueOnce(new TypeError('Network request failed'));
      const { result } = await renderHook(() => useToggleFavourite(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync(vars).catch(() => undefined);
      });
    };

    it('puts the list back as it was read', async () => {
      const kept = [{ library_id: 1, path: 'Kept' } as Favourite];
      qc.setQueryData(qk.favourites('c'), kept);
      await fail({ libraryId: 1, path: 'A', on: true });
      expect(qc.getQueryData(qk.favourites('c'))).toEqual(kept);
    });

    // The list was never read (held for the network): the stub is no answer to keep.
    it('leaves no list behind when none was read', async () => {
      await fail({ libraryId: 1, path: 'A', on: true });
      expect(qc.getQueryData(qk.favourites('c'))).toBeUndefined();
    });

    // fe#154: offline, a pending book's read and its add both fail; the folder list's heart
    // must not stay on.
    it('leaves no heart behind for a pending book hearted offline', async () => {
      mockItem.mockRejectedValueOnce(new TypeError('Network request failed'));
      await fail({ libraryId: 1, path: 'A/New Book', on: true, pendingBook: true });
      expect(qc.getQueryData(qk.favourites('c'))).toBeUndefined();
    });

    // fe#154: the second toggle's onMutate ran before the first settled, so restoring the
    // first's snapshot would drop the second's heart, and the second's would bring back the
    // first's.
    it('with toggles overlapping, takes back only its own edit and the list ends as read', async () => {
      const kept = { library_id: 1, path: 'Kept' } as Favourite;
      const b = { library_id: 1, path: 'B' } as Favourite;
      qc.setQueryData(qk.favourites('c'), [kept]);
      // Read already: mounting the list asks nothing, only the last toggle's settle does.
      qc.setQueryDefaults(qk.favourites('c'), { staleTime: Infinity });
      let failAdd!: () => void;
      let saveAdd!: () => void;
      mockAdd
        .mockImplementationOnce(
          () => new Promise((_, reject) => (failAdd = () => reject(new Error('offline')))),
        )
        .mockImplementationOnce(() => new Promise<void>((resolve) => (saveAdd = resolve)));
      // The list as the server holds it once B is saved.
      mockList.mockResolvedValue([b, kept]);
      const { result } = await renderHook(
        () => ({ list: useFavourites(), toggle: useToggleFavourite() }),
        { wrapper },
      );
      let first!: Promise<unknown>;
      let second!: Promise<unknown>;
      await act(async () => {
        first = result.current.toggle.mutateAsync({ libraryId: 1, path: 'A', on: true });
        second = result.current.toggle.mutateAsync({ libraryId: 1, path: 'B', on: true });
      });
      await act(async () => {
        failAdd();
        await first.catch(() => undefined);
      });
      // A is taken back at once; B's heart stays while its add is on its way.
      const paths = () => qc.getQueryData<Favourite[]>(qk.favourites('c'))?.map((f) => f.path);
      expect(paths()).toEqual(['B', 'Kept']);
      expect(mockList).not.toHaveBeenCalled();
      await act(async () => {
        saveAdd();
        await second;
      });
      await waitFor(() => expect(result.current.list.isFetching).toBe(false));
      expect(mockList).toHaveBeenCalledTimes(1);
      expect(paths()).toEqual(['B', 'Kept']);
    });

    // The second toggle's snapshot holds the first's heart: when both fail, the second
    // (settling alone) must not bring the first's failed heart back.
    it('with both overlapping toggles failing, brings neither heart back', async () => {
      const kept = { library_id: 1, path: 'Kept' } as Favourite;
      // No list mounted: the last settle's read refetches nothing, so what is left is the
      // toggles' own work.
      qc.setQueryData(qk.favourites('c'), [kept]);
      let failFirst!: () => void;
      let failSecond!: () => void;
      mockAdd
        .mockImplementationOnce(
          () => new Promise((_, reject) => (failFirst = () => reject(new Error('down')))),
        )
        .mockImplementationOnce(
          () => new Promise((_, reject) => (failSecond = () => reject(new Error('down')))),
        );
      const { result } = await renderHook(() => useToggleFavourite(), { wrapper });
      let first!: Promise<unknown>;
      let second!: Promise<unknown>;
      await act(async () => {
        first = result.current.mutateAsync({ libraryId: 1, path: 'A', on: true });
        second = result.current.mutateAsync({ libraryId: 1, path: 'B', on: true });
      });
      await act(async () => {
        failFirst();
        await first.catch(() => undefined);
      });
      await act(async () => {
        failSecond();
        await second.catch(() => undefined);
      });
      const paths = () => qc.getQueryData<Favourite[]>(qk.favourites('c'))?.map((f) => f.path);
      expect(paths()).toEqual(['Kept']);
    });

    // fe#358: with the list unread, the second toggle's snapshot is the first's optimistic
    // list; when both fail the list goes back to unread, not an empty answer.
    it('with both overlapping toggles failing over an unread list, leaves it unread', async () => {
      let failFirst!: () => void;
      let failSecond!: () => void;
      mockAdd
        .mockImplementationOnce(
          () => new Promise((_, reject) => (failFirst = () => reject(new Error('down')))),
        )
        .mockImplementationOnce(
          () => new Promise((_, reject) => (failSecond = () => reject(new Error('down')))),
        );
      const { result } = await renderHook(() => useToggleFavourite(), { wrapper });
      let first!: Promise<unknown>;
      let second!: Promise<unknown>;
      await act(async () => {
        first = result.current.mutateAsync({ libraryId: 1, path: 'A', on: true });
        second = result.current.mutateAsync({ libraryId: 1, path: 'B', on: true });
      });
      await act(async () => {
        failFirst();
        await first.catch(() => undefined);
      });
      await act(async () => {
        failSecond();
        await second.catch(() => undefined);
      });
      expect(qc.getQueryData(qk.favourites('c'))).toBeUndefined();
      // The next run over a read list takes back only its own edit again.
      const kept = [{ library_id: 1, path: 'Kept' } as Favourite];
      qc.setQueryData(qk.favourites('c'), kept);
      await fail({ libraryId: 1, path: 'C', on: true });
      expect(qc.getQueryData(qk.favourites('c'))).toEqual(kept);
    });

    it('puts an unheart that fails back in its place', async () => {
      const list = ['X', 'Y', 'Z'].map((path) => ({ library_id: 1, path }) as Favourite);
      qc.setQueryData(qk.favourites('c'), list);
      mockRemove.mockRejectedValueOnce(new TypeError('Network request failed'));
      const { result } = await renderHook(() => useToggleFavourite(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ libraryId: 1, path: 'Y', on: false }).catch(() => {});
      });
      expect(qc.getQueryData(qk.favourites('c'))).toEqual(list);
    });
  });

  it('never reads the book when removing a pending favourite', async () => {
    await toggle({ libraryId: 1, path: 'A/New Book', on: false, pendingBook: true });
    expect(calls).toEqual(['remove A/New Book']);
  });
});
