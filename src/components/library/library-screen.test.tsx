import { fireEvent, render, screen } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

let mockParams: { mode?: string } = {};
const mockSetParams = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  router: { setParams: (p: unknown) => mockSetParams(p) },
}));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));

let mockCaps: Record<string, boolean | undefined> = {};
// The connection each book list was asked for ('' asks nothing).
const mockBookListCids: string[] = [];
const mockShowsEnabled: boolean[] = [];
jest.mock('@/api/hooks', () => ({
  useSavedProgress: () => undefined,
  useCapability: (flag: string) => mockCaps[flag],
  useAuthors: (_lib: number, cid: string) => {
    mockBookListCids.push(cid);
    return { data: mockCaps.browse_people && cid ? { people: [{}, {}], unknown: 0 } : undefined };
  },
  useNarrators: () => ({ data: undefined }),
  useSeriesList: (_lib: number, cid: string) => {
    mockBookListCids.push(cid);
    return { data: mockCaps.browse_people && cid ? [{}] : undefined };
  },
  useCollections: () => ({ data: undefined }),
  usePodcastShows: (_lib: number, _cid: string, opts: { enabled: boolean }) => {
    mockShowsEnabled.push(opts.enabled);
    return { data: opts.enabled ? [{}, {}, {}] : undefined };
  },
}));
jest.mock('@/components/podcasts/shows-mode', () => ({
  PodcastShowsMode: ({ connectionId, libraryId }: { connectionId: string; libraryId: number }) => {
    const { Text: T } = jest.requireActual('react-native');
    return <T>{`Shows of ${connectionId}/${libraryId}`}</T>;
  },
}));

type Group = {
  connectionId: string;
  connectionName: string;
  libraryIds: number[];
  libraries: {
    id: number;
    name: string;
    connectionId: string;
    connectionName: string;
    kind?: string;
  }[];
  status: 'ready';
};
const lib = (connectionId: string, id: number, name: string, kind?: string) => ({
  id,
  name,
  connectionId,
  connectionName: connectionId === 'a' ? 'Hearthside' : "Maya's Shelf",
  ...(kind ? { kind } : {}),
});
let mockGroups: Group[] = [];
let mockSelection: { connectionId: string; libraryId: number } | null = null;
const mockSelect = jest.fn();
jest.mock('./use-selected-library', () => ({
  useSelectedLibrary: () => ({
    groups: mockGroups,
    selection: mockSelection,
    library: mockSelection
      ? mockGroups
          .find((g) => g.connectionId === mockSelection!.connectionId)
          ?.libraries.find((l) => l.id === mockSelection!.libraryId)
      : null,
    select: mockSelect,
    isLoading: false,
  }),
}));
jest.mock('./modes/folders-mode', () => ({
  FoldersMode: () => {
    const { Text: T } = jest.requireActual('react-native');
    return <T>Folders body</T>;
  },
}));
// The Books and Collections bodies (their own tests) need the player and the stores.
jest.mock('./modes/books-mode', () => ({
  BooksMode: () => {
    const { Text: T } = jest.requireActual('react-native');
    return <T>Books body</T>;
  },
}));
jest.mock('./modes/collections-mode', () => ({
  CollectionsMode: () => {
    const { Text: T } = jest.requireActual('react-native');
    return <T>Collections body</T>;
  },
}));
jest.mock('./modes/authors-mode', () => ({
  AuthorsMode: ({ connectionId, libraryId }: { connectionId: string; libraryId: number }) => {
    const { Text: T } = jest.requireActual('react-native');
    return <T>{`Authors of ${connectionId}/${libraryId}`}</T>;
  },
}));
// The other mode bodies (their own tests cover them) pull in the player chrome.
jest.mock('./modes/series-mode', () => ({ SeriesMode: () => null }));
jest.mock('./modes/narrators-mode', () => ({ NarratorsMode: () => null }));

/* eslint-disable import/first */
import { LibraryPicker } from './library-picker';
import { LibraryScreen } from './library-screen';
/* eslint-enable import/first */

const group = (connectionId: string, libs: [number, string][]): Group => ({
  connectionId,
  connectionName: connectionId === 'a' ? 'Hearthside' : "Maya's Shelf",
  libraryIds: libs.map(([id]) => id),
  libraries: libs.map(([id, name]) => lib(connectionId, id, name)),
  status: 'ready',
});

describe('LibraryScreen', () => {
  beforeEach(() => {
    mockParams = {};
    mockCaps = {};
    mockLayout = 'phone';
    mockGroups = [group('a', [[1, 'Audiobooks']])];
    mockSelection = { connectionId: 'a', libraryId: 1 };
    mockSetParams.mockReset();
  });

  it('offers only the modes the server supports, Books first', async () => {
    await render(<LibraryScreen />);
    expect(screen.getAllByRole('radio').map((r) => r.props.accessibilityLabel)).toEqual([
      'Books',
      'Folders',
    ]);
    mockCaps = { browse_people: true, collections: true };
    await render(<LibraryScreen />);
    expect(screen.getAllByRole('radio').map((r) => r.props.accessibilityLabel)).toEqual([
      'Books',
      'Authors, 2',
      'Series, 1',
      'Narrators',
      'Collections',
      'Folders',
    ]);
  });

  it('switches the mode through the route param (Books leaves it bare)', async () => {
    mockParams = { mode: 'folders' };
    await render(<LibraryScreen />);
    expect(screen.getByText('Folders body')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Folders', checked: true })).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'Books' }));
    expect(mockSetParams).toHaveBeenCalledWith({ mode: undefined });
  });

  it('shows a mode for the selected library', async () => {
    mockCaps = { browse_people: true };
    mockParams = { mode: 'authors' };
    await render(<LibraryScreen />);
    expect(screen.getByText('Authors of a/1')).toBeTruthy();
  });

  it('falls back to Books once the server is known to lack a linked mode', async () => {
    mockParams = { mode: 'authors' };
    mockCaps = { browse_people: undefined };
    await render(<LibraryScreen />);
    expect(screen.getByRole('radio', { name: 'Authors', checked: true })).toBeTruthy();
    mockCaps = { browse_people: false };
    await render(<LibraryScreen />);
    expect(screen.getByRole('radio', { name: 'Books', checked: true })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Authors/ })).toBeNull();
  });

  // Bridge Phase 2d-1: a podcast library has its shows, never the book lists.
  describe('a podcast library', () => {
    beforeEach(() => {
      mockGroups = [
        {
          ...group('a', [[1, 'Audiobooks']]),
          libraries: [lib('a', 1, 'Audiobooks'), lib('a', 7, 'Podcasts', 'podcasts')],
          libraryIds: [1, 7],
        },
      ];
      mockSelection = { connectionId: 'a', libraryId: 7 };
      mockCaps = { browse_people: true, collections: true };
      mockBookListCids.length = 0;
      mockShowsEnabled.length = 0;
    });

    it('offers Shows and Folders, counts its shows, and never asks the book lists', async () => {
      await mountWithPortal(<LibraryScreen />);
      expect(screen.getAllByRole('radio').map((r) => r.props.accessibilityLabel)).toEqual([
        'Shows, 3',
        'Folders',
      ]);
      expect(screen.getByText('Shows of a/7')).toBeTruthy();
      expect(mockBookListCids.every((cid) => cid === '')).toBe(true);
      expect(mockShowsEnabled).toContain(true);
    });

    it('lands a book mode link on Shows', async () => {
      mockParams = { mode: 'authors' };
      await mountWithPortal(<LibraryScreen />);
      expect(screen.getByRole('radio', { name: 'Shows, 3', checked: true })).toBeTruthy();
      expect(screen.getByText('Shows of a/7')).toBeTruthy();
    });

    it('never offers Shows on a books library, nor asks for shows', async () => {
      mockSelection = { connectionId: 'a', libraryId: 1 };
      mockParams = { mode: 'shows' };
      await mountWithPortal(<LibraryScreen />);
      expect(screen.queryByRole('radio', { name: /Shows/ })).toBeNull();
      expect(screen.getByText('Books body')).toBeTruthy();
      expect(mockShowsEnabled.every((e) => !e)).toBe(true);
    });
  });

  it('says so when there is no library', async () => {
    mockGroups = [];
    mockSelection = null;
    await render(<LibraryScreen />);
    expect(screen.getByText('No libraries are shared with your account yet.')).toBeTruthy();
  });
});

describe('LibraryPicker', () => {
  beforeEach(() => {
    mockSelect.mockReset();
  });

  it('is hidden with a single library', async () => {
    mockGroups = [group('a', [[1, 'Audiobooks']])];
    mockSelection = { connectionId: 'a', libraryId: 1 };
    const r = await render(<LibraryPicker />);
    expect(r.toJSON()).toBeNull();
  });

  it('groups libraries by server and selects one', async () => {
    mockGroups = [
      group('a', [
        [1, 'Audiobooks'],
        [2, 'Kids'],
      ]),
      group('b', [[1, 'Audiobooks']]),
    ];
    mockSelection = { connectionId: 'a', libraryId: 2 };
    await mountWithPortal(<LibraryPicker />);
    expect(screen.getByText('Kids · Hearthside')).toBeTruthy();
    await fireEvent.press(screen.getByRole('combobox', { name: 'Library' }));
    expect(screen.getByText("Maya's Shelf")).toBeTruthy();
    await fireEvent.press(screen.getByText("Audiobooks · Maya's Shelf"));
    expect(mockSelect).toHaveBeenCalledWith({ connectionId: 'b', libraryId: 1 });
  });
  it('in server mode names the server only and is hidden with one server', async () => {
    mockGroups = [
      group('a', [
        [1, 'Audiobooks'],
        [2, 'Kids'],
      ]),
    ];
    mockSelection = { connectionId: 'a', libraryId: 2 };
    const r = await render(<LibraryPicker by="server" />);
    expect(r.toJSON()).toBeNull();
  });

  it('in server mode switches to the first library of the picked server', async () => {
    mockGroups = [
      group('a', [
        [1, 'Audiobooks'],
        [2, 'Kids'],
      ]),
      group('b', [
        [3, 'Shelf'],
        [4, 'Other'],
      ]),
    ];
    mockSelection = { connectionId: 'a', libraryId: 2 };
    await mountWithPortal(<LibraryPicker by="server" />);
    expect(screen.queryByText('Kids · Hearthside')).toBeNull();
    await fireEvent.press(screen.getByRole('combobox', { name: 'Server' }));
    expect(screen.queryByText('Audiobooks · Hearthside')).toBeNull();
    // The trigger and the open list both say the current server's name.
    expect(screen.getAllByText('Hearthside')).toHaveLength(2);
    await fireEvent.press(screen.getByText("Maya's Shelf"));
    expect(mockSelect).toHaveBeenCalledWith({ connectionId: 'b', libraryId: 3 });
  });
});
