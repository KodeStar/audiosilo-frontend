import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactElement } from 'react';
import { Platform } from 'react-native';

import type { Book, QueueEntry } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';

// The hero's action row: Up next's Play next / Add to the end (with Undo back to where
// the book was), the favourite, and which book-menu items it leaves to its own buttons.

let mockCaps: Record<string, boolean | undefined> = {};
let mockQueue: QueueEntry[] = [];
const mockToggleFavourite = jest.fn();
jest.mock('@/api/hooks', () => ({
  useCapability: (flag: string) => mockCaps[flag],
  useFavourites: () => ({ data: [{ library_id: 1, path: 'A/Book' }] }),
  useToggleFavourite: () => ({ mutate: mockToggleFavourite }),
  useQueue: () => ({ data: mockQueue }),
}));

const mockAdd = jest.fn();
const mockRemove = jest.fn();
const mockQueueEnd = jest.fn();
jest.mock('@/components/library/use-queue-actions', () => ({
  ...jest.requireActual('@/components/library/use-queue-actions'),
  useQueueActions: () => ({
    supported: mockCaps.queue === true,
    add: { mutateAsync: mockAdd },
    remove: { mutateAsync: mockRemove },
    queue: mockQueueEnd,
    unqueue: jest.fn(),
    fail: jest.fn(),
    pending: false,
  }),
}));

let mockOmit: readonly string[] = [];
let mockExtra: { key: string; label: string; onPress: () => void }[] = [];
jest.mock('@/components/library/books/book-actions', () => ({
  BookActionsMenu: ({
    trigger,
    omit,
    extra,
  }: {
    trigger: ReactElement;
    omit: readonly string[];
    extra?: { key: string; label: string; onPress: () => void }[];
  }) => {
    mockOmit = omit;
    mockExtra = extra ?? [];
    return trigger;
  },
}));
jest.mock('@/components/library/download-control', () => ({ DownloadControl: () => null }));

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({
  toast: (t: unknown) => mockToast(t),
}));

// Which modules the book's server has on (Bridge Phase 2a): `useModulesOn` has its own
// suite; here a module is on for the connection `mockModulesOn` names it under.
let mockModulesOn: Record<string, string[]> = {};
const mockUseModulesOn = jest.fn();
jest.mock('@/modules/registry', () => ({
  ...jest.requireActual('@/modules/registry'),
  useModulesOn: (cid: string, list: readonly { id: string }[]) => {
    mockUseModulesOn(cid);
    return list.filter((m) => mockModulesOn[cid]?.includes(m.id));
  },
}));

/* eslint-disable import/first */
import type { PlayerModule } from '@/modules/registry';

import { HeroActions, type HeroActionsProps } from './hero-actions';
/* eslint-enable import/first */

const BOOK = { title: 'The Book', rel_path: 'A/Book', series: 'S' } as Book;
const entry = (path: string): QueueEntry => ({ library_id: 1, path }) as QueueEntry;

async function mount(stacked = false, generate?: HeroActionsProps['generate']) {
  await mountWithPortal(
    <HeroActions
      connectionId="home"
      libraryId={1}
      book={BOOK}
      chaptersLoading={false}
      primary={{ kind: 'start' }}
      onPrimary={jest.fn()}
      stacked={stacked}
      generate={generate}
    />,
  );
}

beforeEach(() => {
  mockModulesOn = {};
  mockUseModulesOn.mockClear();
  mockCaps = { queue: true, progress_edit: true };
  mockQueue = [entry('Other/One'), entry('Other/Two')];
  mockAdd.mockReset();
  mockRemove.mockReset();
  mockQueueEnd.mockReset();
  mockToast.mockReset();
});

describe('HeroActions', () => {
  // At 400 a wide download button ("100% · Cancel", "Downloaded") wrapped the "..." onto
  // its own row: a phone's secondary row never wraps, and the download gives way.
  it("keeps a phone's secondary actions on one row, the download giving way", async () => {
    mockCaps = { queue: true, progress_edit: true, collections: true };
    await mount(true);
    const row = screen.getByTestId('hero-secondary-row');
    expect(String(row.props.className)).not.toMatch(/flex-wrap/);
    expect(String(screen.getByTestId('hero-download-slot').props.className)).toMatch(
      /min-w-0 flex-1/,
    );
    expect(screen.getByRole('button', { name: 'More for The Book' })).toBeTruthy();
  });

  // PLAYER-09: at 390 (and 360) the collection button left "Download" no room for its word.
  it('puts Add to collection in the menu on a phone, and keeps the button on a wider page', async () => {
    mockCaps = { queue: true, progress_edit: true, collections: true };
    await mount(true);
    expect(screen.queryByRole('button', { name: 'Add to collection...' })).toBeNull();
    expect(mockOmit).toEqual(['play', 'queue', 'download']);
    expect(mockOmit).not.toContain('collect');
  });

  it('keeps the Add to collection button off the menu at tablet and desktop widths', async () => {
    mockCaps = { queue: true, progress_edit: true, collections: true };
    await mount(false);
    expect(screen.getByRole('button', { name: 'Add to collection...' })).toBeTruthy();
    expect(mockOmit).toEqual(['play', 'queue', 'collect', 'download']);
  });

  it('plays a book next, with an Undo that takes it off again', async () => {
    mockAdd.mockResolvedValue([entry('A/Book'), ...mockQueue]);
    mockRemove.mockResolvedValue([]);
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Up next for The Book' }));
    await fireEvent.press(screen.getByText('Play next'));
    expect(mockAdd).toHaveBeenCalledWith({ libraryId: 1, path: 'A/Book', position: 0 });
    const { title, action } = mockToast.mock.calls[0][0];
    expect(title).toBe('Plays next');
    action.onPress();
    expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: 'A/Book' });
  });

  it('moves a queued book to the front, and Undo puts it back in its place', async () => {
    mockQueue = [entry('Other/One'), entry('A/Book')];
    mockAdd.mockResolvedValue([entry('A/Book'), entry('Other/One')]);
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Up next for The Book' }));
    // Already queued: the other choice takes it off.
    expect(screen.getByText('Remove from Up next')).toBeTruthy();
    await fireEvent.press(screen.getByText('Play next'));
    mockToast.mock.calls[0][0].action.onPress();
    expect(mockAdd).toHaveBeenLastCalledWith({ libraryId: 1, path: 'A/Book', position: 1 });
  });

  it('adds to the end of Up next', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Up next for The Book' }));
    await fireEvent.press(screen.getByText('Add to the end of Up next'));
    expect(mockQueueEnd).toHaveBeenCalledWith(1, 'A/Book');
  });

  it('hides Up next without the capability, and leaves its own actions out of the menu', async () => {
    mockCaps = { queue: false, progress_edit: true };
    await mount();
    expect(screen.queryByRole('button', { name: 'Up next for The Book' })).toBeNull();
    expect(mockOmit).toEqual(['play', 'queue', 'collect', 'download']);
  });

  it('turns the favourite off from the book page', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove from favourites' }));
    expect(mockToggleFavourite).toHaveBeenCalledWith({ libraryId: 1, path: 'A/Book', on: false });
  });
});

// An admin's Bridge action (Phase 1a): the page decides what the book offers; the row
// shows Generate as a button, Regenerate quietly in the book menu, and nothing otherwise.
describe('HeroActions generate', () => {
  it('shows Generate as a button when the page offers it', async () => {
    const onPress = jest.fn();
    await mount(false, { offer: 'generate', onPress });
    await fireEvent.press(screen.getByRole('button', { name: 'Generate characters and recaps' }));
    expect(onPress).toHaveBeenCalled();
    expect(mockExtra).toEqual([]);
  });

  it('puts Regenerate in the book menu, not the row', async () => {
    const onPress = jest.fn();
    await mount(true, { offer: 'regenerate', onPress });
    expect(screen.queryByTestId('generate-action')).toBeNull();
    expect(mockExtra.map((a) => a.label)).toEqual(['Regenerate characters and recaps']);
    mockExtra[0].onPress();
    expect(onPress).toHaveBeenCalled();
  });

  it('offers neither when the page offers nothing', async () => {
    await mount();
    expect(screen.queryByTestId('generate-action')).toBeNull();
    expect(mockExtra).toEqual([]);
  });
});

// A module's book actions (Bridge Phase 2a): in the book menu, after the page's own, for a
// book on a server that has the module on.
describe('HeroActions module actions', () => {
  const onContribute = jest.fn();
  const FAKE: PlayerModule = {
    id: 'contributions',
    bookActions: ({ connectionId, book }) => [
      {
        key: 'contribute',
        icon: 'sparkles',
        label: `Contribute ${book.title} on ${connectionId}`,
        onPress: onContribute,
        group: true,
      },
    ],
  };
  const mountWith = async (generate?: HeroActionsProps['generate']) => {
    await mountWithPortal(
      <HeroActions
        connectionId="home"
        libraryId={1}
        book={BOOK}
        chaptersLoading={false}
        primary={{ kind: 'start' }}
        onPrimary={jest.fn()}
        stacked={false}
        generate={generate}
        modules={[FAKE]}
      />,
    );
  };

  it('renders as before with the empty registry, asking nothing', async () => {
    await mount();
    expect(mockExtra).toEqual([]);
    expect(mockUseModulesOn).not.toHaveBeenCalled();
  });

  it("follows Regenerate in the book menu while the book's server has the module on", async () => {
    mockModulesOn = { home: ['contributions'] };
    await mountWith({ offer: 'regenerate', onPress: jest.fn() });
    expect(mockUseModulesOn).toHaveBeenCalledWith('home');
    expect(mockExtra.map((a) => a.label)).toEqual([
      'Regenerate characters and recaps',
      'Contribute The Book on home',
    ]);
    // Keyed by the module, so its keys never meet the menu's own.
    expect(mockExtra.map((a) => a.key)).toEqual(['regenerate', 'contributions:contribute']);
    mockExtra[1].onPress();
    expect(onContribute).toHaveBeenCalled();
  });

  it('offers nothing while only another server has the module on', async () => {
    mockModulesOn = { other: ['contributions'] };
    await mountWith();
    expect(mockExtra).toEqual([]);
  });
});

// Read (Bridge Phase 3b-1): the web reader, for a book with an ebook on a server with the
// reader; the app's own reader host is Phase 3b-2.
describe('HeroActions Read', () => {
  const EBOOK_BOOK = { ...BOOK, ebook: { path: 'A/Book/Book.epub', size: 1000 } } as Book;
  const mountBook = (book: Book, stacked = false) =>
    mountWithPortal(
      <HeroActions
        connectionId="home"
        libraryId={1}
        book={book}
        chaptersLoading={false}
        primary={{ kind: 'start' }}
        onPrimary={jest.fn()}
        stacked={stacked}
      />,
    );
  const onWeb = () => jest.replaceProperty(Platform, 'OS', 'web');

  afterEach(() => jest.restoreAllMocks());

  it.each([false, true])(
    'opens the reader on the web for a book with an ebook (stacked: %s)',
    async (stacked) => {
      onWeb();
      mockCaps = { ebooks: true };
      const push = jest.spyOn(router, 'push').mockImplementation(() => {});
      await mountBook(EBOOK_BOOK, stacked);
      fireEvent.press(screen.getByTestId('read-action'));
      const href = push.mock.calls[0][0] as { pathname: string; params: Record<string, unknown> };
      expect(href.pathname).toBe('/read');
      expect(href.params).toMatchObject({ connection: 'home', libraryId: '1' });
    },
  );

  it('hides Read without the capability', async () => {
    onWeb();
    mockCaps = { ebooks: false };
    await mountBook(EBOOK_BOOK);
    expect(screen.queryByTestId('read-action')).toBeNull();
  });

  it('hides Read for a book without an ebook', async () => {
    onWeb();
    mockCaps = { ebooks: true };
    await mountBook(BOOK);
    expect(screen.queryByTestId('read-action')).toBeNull();
  });

  it('hides Read in the app until its reader host lands', async () => {
    mockCaps = { ebooks: true };
    await mountBook(EBOOK_BOOK);
    expect(screen.queryByTestId('read-action')).toBeNull();
  });
});
