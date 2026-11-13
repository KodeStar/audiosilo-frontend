import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { View } from 'react-native';

import { ApiError } from '@/api/client';
import type { BridgeJob, Library, LibrivoxHit, LibrivoxWork } from '@/api/types';
import { librivoxHit, librivoxJob, librivoxRecording } from '@/testing/librivox-fixtures';
import { mountWithPortal } from '@/testing/render-overlay';

jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('@/api/provider', () => ({ useOptionalApi: () => null }));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
const mockOpenBook = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openBook: (...a: unknown[]) => mockOpenBook(...a) }),
}));
const mockOpenUrl = jest.fn();
jest.mock('@/lib/support', () => ({ openExternalUrl: (u: string) => mockOpenUrl(u) }));

type ReadState<T> = { data?: T; isError?: boolean; error?: unknown; isPending?: boolean };
let mockLibraries: Library[] = [];
let mockSearch: ReadState<{ results: LibrivoxHit[] }> = {};
const mockAsked: string[] = [];
const mockSearchRefetch = jest.fn();
let mockWork: ReadState<LibrivoxWork> = {};
const mockWorkAsked: (string | null)[] = [];
let mockJobs: Record<number, ReadState<BridgeJob>> = {};
const mockAdd = jest.fn();
const mockCancel = jest.fn();
const mockInvalidateLists = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    qk: { librivoxWorks: (cid: string) => ['librivoxWork', cid] },
    librariesQuery: (cid: string) => ({
      queryKey: ['libraries', cid],
      queryFn: () => Promise.resolve(mockLibraries),
    }),
    useLibrivoxSearch: (q: string) => {
      mockAsked.push(q);
      return q
        ? {
            isPending: false,
            isFetching: false,
            isError: false,
            refetch: mockSearchRefetch,
            ...mockSearch,
          }
        : { isPending: true, isFetching: false, isError: false, refetch: mockSearchRefetch };
    },
    useLibrivoxWork: (id: string | null) => {
      mockWorkAsked.push(id);
      return { refetch: jest.fn(), isError: false, ...mockWork };
    },
    useLibrivoxJob: (id: number | undefined) =>
      id === undefined ? {} : (mockJobs[id] ?? { isPending: true }),
    useAddLibrivox: () => ({ mutateAsync: mockAdd, isPending: false }),
    useCancelBridgeJob: () => ({ mutate: mockCancel, isPending: false }),
    invalidateLibraryLists: (...a: unknown[]) => mockInvalidateLists(...a),
  };
});

/* eslint-disable import/first */
import { DONE_RECHECK_MS } from './librivox-model';
import { LibrivoxSearch } from './librivox-search';
/* eslint-enable import/first */

const library = (id: number, name: string, kind?: string): Library => ({
  id,
  name,
  kind,
  default_view: 'computed',
  sort_order: id,
});

const work = (over: Partial<LibrivoxWork['recordings'][number]> = {}): LibrivoxWork => ({
  work: {
    id: 'johnny-crows-garden',
    title: "Johnny Crow's Garden",
    authors: [{ id: 'b', name: 'L. Leslie Brooke' }],
    language: 'en',
  },
  recordings: [librivoxRecording(over)],
});

async function mount(libraryId = 3) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await mountWithPortal(
    <QueryClientProvider client={qc}>
      <LibrivoxSearch connectionId="c1" libraryId={libraryId} header={<View testID="header" />} />
    </QueryClientProvider>,
  );
  return qc;
}

async function search(text: string) {
  await fireEvent.changeText(screen.getByTestId('librivox-search-input'), text);
  await fireEvent.press(screen.getByTestId('librivox-search-submit'));
}

/** Search, then open the first result's recordings. */
async function openWork() {
  await search('crow');
  await fireEvent.press(screen.getByTestId('librivox-hit'));
}

beforeEach(() => {
  mockLibraries = [library(3, 'Books')];
  mockSearch = { data: { results: [librivoxHit()] } };
  mockAsked.length = 0;
  mockWorkAsked.length = 0;
  mockSearchRefetch.mockReset();
  mockWork = { data: work() };
  mockJobs = {};
  mockAdd.mockReset();
  mockCancel.mockReset();
  mockToast.mockReset();
  mockOpenBook.mockReset();
  mockOpenUrl.mockReset();
  mockInvalidateLists.mockReset();
});

describe('LibrivoxSearch', () => {
  it('searches only when submitted, and lists the works found', async () => {
    await mount();
    await fireEvent.changeText(screen.getByTestId('librivox-search-input'), 'crow');
    expect(mockAsked.at(-1)).toBe('');
    await fireEvent.press(screen.getByTestId('librivox-search-submit'));
    expect(mockAsked.at(-1)).toBe('crow');
    expect(screen.getByText("Johnny Crow's Garden")).toBeTruthy();
    expect(screen.getByText('L. Leslie Brooke · 2006 · EN')).toBeTruthy();
    expect(screen.getByTestId('header')).toBeTruthy();
  });

  it('says when nothing matches', async () => {
    mockSearch = { data: { results: [] } };
    await mount();
    await search('zzz');
    expect(screen.getByText('Nothing found')).toBeTruthy();
  });

  it('words a failed search and asks again on Search again', async () => {
    mockSearch = { isError: true, error: new ApiError(404, 'off', 'metadata_off') };
    await mount();
    await search('crow');
    expect(screen.getByText('Community metadata is off on this server.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Search again'));
    expect(mockSearchRefetch).toHaveBeenCalled();
  });

  it("opens a work's recordings under it, with the reader, facts and LibriVox page", async () => {
    await mount();
    await openWork();
    expect(mockWorkAsked).toContain('johnny-crows-garden');
    expect(screen.getByText('Read by Kara Shallenberg')).toBeTruthy();
    expect(screen.getByText(/3 sections · Project 192/)).toBeTruthy();
    await fireEvent.press(screen.getByText('LibriVox page'));
    expect(mockOpenUrl).toHaveBeenCalledWith(
      'https://librivox.org/johnny-crows-garden-by-l-leslie-brooke/',
    );
  });

  it('adds to the one books library, then follows the queued job', async () => {
    mockAdd.mockResolvedValue({ job: librivoxJob({ state: 'queued' }) });
    mockJobs = {
      41: { data: librivoxJob({ progress: { step: 'download', done: 2, total: 3 } }) },
    };
    await mount();
    await openWork();
    const add = await screen.findByText('Add to Books');
    await fireEvent.press(add);
    expect(mockAdd).toHaveBeenCalledWith({ libraryId: 3, librivoxId: 192 });
    expect(await screen.findByText('Adding')).toBeTruthy();
    expect(screen.getByText('Downloading · 2 of 3')).toBeTruthy();
    expect(screen.queryByTestId('librivox-add')).toBeNull();
    await fireEvent.press(screen.getByTestId('librivox-cancel'));
    expect(mockCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 41 }), expect.anything());
  });

  it("toasts a refused Add in the app's words", async () => {
    mockAdd.mockRejectedValue(new ApiError(409, 'English', 'in_library'));
    await mount();
    await openWork();
    await fireEvent.press(await screen.findByText('Add to Books'));
    expect(mockToast).toHaveBeenCalledWith({ title: 'That recording is already in a library.' });
  });

  it('shows a recording on this server as in your library, with Open', async () => {
    mockWork = { data: work({ in_library: [{ library_id: 3, path: 'Brooke/Johnny' }] }) };
    await mount();
    await openWork();
    expect(screen.getByText('In your library')).toBeTruthy();
    expect(screen.queryByTestId('librivox-add')).toBeNull();
    await fireEvent.press(screen.getByText('Open'));
    expect(mockOpenBook).toHaveBeenCalledWith('c1', 3, 'Brooke/Johnny');
  });

  it("follows the work's open job, and says why a failed one stopped, with Add again", async () => {
    mockWork = { data: work({ job: { id: 41, state: 'running' } }) };
    mockJobs = {
      41: { data: librivoxJob({ state: 'failed', result: { code: 'exists' }, error: 'exists' }) },
    };
    await mount();
    await openWork();
    expect(screen.getByText("Couldn't add it")).toBeTruthy();
    expect(screen.getByText('A book is already at that place in the library.')).toBeTruthy();
    expect(await screen.findByText('Add to Books')).toBeTruthy();
    expect(screen.queryByTestId('librivox-cancel')).toBeNull();
  });

  it('says a parked fetch needs attention, in its own words', async () => {
    mockWork = { data: work({ job: { id: 41, state: 'needs_attention' } }) };
    mockJobs = {
      41: {
        data: librivoxJob({ state: 'needs_attention', progress: { park: { code: 'disk_full' } } }),
      },
    };
    await mount();
    await openWork();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText("The library's disk is full.")).toBeTruthy();
    expect(screen.queryByTestId('librivox-add')).toBeNull();
  });

  it("reads the library's lists again once a fetch is done", async () => {
    mockWork = { data: work({ job: { id: 41, state: 'running' } }) };
    mockJobs = { 41: { data: librivoxJob({ state: 'done', library_id: 3 }) } };
    const qc = await mount();
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    await openWork();
    expect(screen.getByText('Added')).toBeTruthy();
    expect(mockInvalidateLists).toHaveBeenCalledWith(qc, 'c1', 3);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['librivoxWork', 'c1'] });
    expect(screen.queryByTestId('librivox-add')).toBeNull();
  });

  it('asks the works once more a moment after a fetch is done (the book is recorded just after)', async () => {
    jest.useFakeTimers();
    try {
      mockWork = { data: work({ job: { id: 41, state: 'running' } }) };
      mockJobs = { 41: { data: librivoxJob({ state: 'done', library_id: 3 }) } };
      const qc = await mount();
      const invalidate = jest.spyOn(qc, 'invalidateQueries');
      await openWork();
      const worksAsks = () =>
        invalidate.mock.calls.filter(
          ([f]) => JSON.stringify(f?.queryKey) === '["librivoxWork","c1"]',
        ).length;
      expect(worksAsks()).toBe(1);
      await act(async () => {
        jest.advanceTimersByTime(DONE_RECHECK_MS - 1);
      });
      expect(worksAsks()).toBe(1);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(worksAsks()).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('picks among the books libraries only, the one the page opened from first', async () => {
    mockLibraries = [library(3, 'Books'), library(4, 'Fiction'), library(5, 'Shows', 'podcasts')];
    await mount(4);
    await openWork();
    expect(await screen.findByText('Add to Fiction')).toBeTruthy();
    expect(screen.getByTestId('librivox-library')).toBeTruthy();
  });

  it('asks for a books library first when the server has none', async () => {
    mockLibraries = [library(5, 'Shows', 'podcasts')];
    await mount(5);
    await openWork();
    expect(await screen.findByText('Add a books library first.')).toBeTruthy();
    expect(screen.queryByTestId('librivox-add')).toBeNull();
  });

  it('says the work has no recording yet', async () => {
    mockWork = { data: { ...work(), recordings: [] } };
    await mount();
    await openWork();
    expect(screen.getByText('This book has no LibriVox recording yet.')).toBeTruthy();
  });
});
