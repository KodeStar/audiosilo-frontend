import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { FsEntry } from '@/api/types';
import { colors } from '@/theme/tokens';

// Link (asChild) just renders its child so the pressable mounts, recording the href
// it was given so a test can check where the row leads.
const mockHrefs: unknown[] = [];
jest.mock('expo-router', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: unknown }) => {
    mockHrefs.push(href);
    return children;
  },
}));

const mockMutate = jest.fn();
let mockFavourites: { library_id: number; path: string }[] = [];
jest.mock('@/api/hooks', () => ({
  useSavedProgress: () => undefined,
  useFavourites: () => ({ data: mockFavourites }),
  useToggleFavourite: () => ({ mutate: mockMutate }),
}));

/* eslint-disable import/first */
import { EntryRow } from './entry-row';
/* eslint-enable import/first */

const dir: FsEntry = {
  name: 'Brandon Sanderson',
  path: 'Brandon Sanderson',
  is_dir: true,
  is_audio: false,
  size: 0,
  mod_time: 0,
};
const file: FsEntry = {
  name: 'Chapter 1.mp3',
  path: 'Book/Chapter 1.mp3',
  is_dir: false,
  is_audio: true,
  size: 1000,
  mod_time: 0,
  duration: 120,
};

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

const bookFolder: FsEntry = {
  ...dir,
  name: 'Mistborn',
  path: 'Brandon Sanderson/Mistborn',
  is_book: true,
  title: 'The Final Empire',
};
const pendingFolder: FsEntry = {
  ...dir,
  name: 'New Book',
  path: 'Brandon Sanderson/New Book',
  pending_book: true,
};

function lastHref() {
  return mockHrefs[mockHrefs.length - 1];
}

beforeEach(() => {
  mockHrefs.length = 0;
  mockMutate.mockClear();
  mockFavourites = [];
});

describe('EntryRow', () => {
  it('renders a folder entry with the add-to-favourites affordance', async () => {
    await mount(<EntryRow entry={dir} connectionId="c1" libraryId={1} />);
    expect(screen.getByText('Brandon Sanderson')).toBeTruthy();
    expect(screen.getByLabelText('Add to favourites')).toBeTruthy();
  });

  it('renders a file entry and toggles the favourite on press', async () => {
    await mount(<EntryRow entry={file} connectionId="c1" libraryId={1} />);
    expect(screen.getByText('Chapter 1.mp3')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Add to favourites'));
    expect(mockMutate).toHaveBeenCalledWith({ libraryId: 1, path: 'Book/Chapter 1.mp3', on: true });
  });

  // The hook reads a pending book before hearting it, so the favourite is saved as a
  // book (Favourites and Home then open it as one, not as a folder).
  it('hearts a pending book folder as a pending book', async () => {
    await mount(<EntryRow entry={pendingFolder} connectionId="c1" libraryId={1} />);
    fireEvent.press(screen.getByLabelText('Add to favourites'));
    expect(mockMutate).toHaveBeenCalledWith({
      libraryId: 1,
      path: 'Brandon Sanderson/New Book',
      on: true,
      pendingBook: true,
    });
  });

  it('shows the remove label when the entry is already a favourite', async () => {
    mockFavourites = [{ library_id: 1, path: 'Brandon Sanderson' }];
    await mount(<EntryRow entry={dir} connectionId="c1" libraryId={1} />);
    expect(screen.getByLabelText('Remove from favourites')).toBeTruthy();
  });

  // One pink thing per view: a list of folders must not spend it on every row's glyph.
  it("draws a folder's glyph tile in muted ink, not pink", async () => {
    await mount(<EntryRow entry={dir} connectionId="c1" libraryId={1} />);
    const tile = screen.getByTestId('glyph-tile');
    expect(String(tile.props.className)).toContain('bg-muted');
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).not.toContain('bg-brand');
    expect(tree.toLowerCase()).not.toContain(colors.light.brand.toLowerCase());
  });

  // server#193: a folder the scan has not reached yet that the server would read as a
  // book opens the book screen (which reads it on demand), captioned so the listener
  // knows why it has no title or author yet.
  it('opens a pending book folder as a book, captioned "Not scanned yet"', async () => {
    await mount(<EntryRow entry={pendingFolder} connectionId="c1" libraryId={1} />);
    expect(lastHref()).toEqual({
      pathname: '/book/[libraryId]',
      params: { libraryId: '1', connection: 'c1', path: 'Brandon Sanderson/New Book' },
    });
    expect(screen.getByText('New Book')).toBeTruthy();
    expect(screen.getByText('Not scanned yet')).toBeTruthy();
  });

  it('drills into a plain folder without the caption', async () => {
    await mount(<EntryRow entry={dir} connectionId="c1" libraryId={1} />);
    expect(lastHref()).toEqual({
      pathname: '/library/[libraryId]',
      params: { libraryId: '1', connection: 'c1', path: 'Brandon Sanderson' },
    });
    expect(screen.queryByText('Not scanned yet')).toBeNull();
  });

  it('opens an indexed book folder as a book with its title, not the caption', async () => {
    await mount(<EntryRow entry={bookFolder} connectionId="c1" libraryId={1} />);
    expect(lastHref()).toEqual({
      pathname: '/book/[libraryId]',
      params: { libraryId: '1', connection: 'c1', path: 'Brandon Sanderson/Mistborn' },
    });
    expect(screen.getByText('The Final Empire')).toBeTruthy();
    expect(screen.queryByText('Not scanned yet')).toBeNull();
  });
});
