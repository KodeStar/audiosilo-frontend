import { fireEvent, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';

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
jest.mock('@/components/library/books/book-actions', () => ({
  BookActionsMenu: ({ trigger, omit }: { trigger: ReactElement; omit: readonly string[] }) => {
    mockOmit = omit;
    return trigger;
  },
}));
jest.mock('@/components/library/download-control', () => ({ DownloadControl: () => null }));

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({
  toast: (t: unknown) => mockToast(t),
}));

/* eslint-disable import/first */
import { HeroActions } from './hero-actions';
/* eslint-enable import/first */

const BOOK = { title: 'The Book', rel_path: 'A/Book', series: 'S' } as Book;
const entry = (path: string): QueueEntry => ({ library_id: 1, path }) as QueueEntry;

async function mount() {
  await mountWithPortal(
    <HeroActions
      connectionId="home"
      libraryId={1}
      book={BOOK}
      chaptersLoading={false}
      primary={{ kind: 'start' }}
      onPrimary={jest.fn()}
      stacked={false}
    />,
  );
}

beforeEach(() => {
  mockCaps = { queue: true, progress_edit: true };
  mockQueue = [entry('Other/One'), entry('Other/Two')];
  mockAdd.mockReset();
  mockRemove.mockReset();
  mockQueueEnd.mockReset();
  mockToast.mockReset();
});

describe('HeroActions', () => {
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
