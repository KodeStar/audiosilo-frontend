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
jest.mock('@/api/hooks', () => ({
  useCapability: (flag: string) => mockCaps[flag],
  useAuthors: () => ({
    data: mockCaps.browse_people ? { people: [{}, {}], unknown: 0 } : undefined,
  }),
  useNarrators: () => ({ data: undefined }),
  useSeriesList: () => ({ data: mockCaps.browse_people ? [{}] : undefined }),
  useCollections: () => ({ data: undefined }),
}));

type Group = {
  connectionId: string;
  connectionName: string;
  libraryIds: number[];
  libraries: { id: number; name: string; connectionId: string; connectionName: string }[];
  status: 'ready';
};
const lib = (connectionId: string, id: number, name: string) => ({
  id,
  name,
  connectionId,
  connectionName: connectionId === 'a' ? 'Hearthside' : "Maya's Shelf",
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
});
