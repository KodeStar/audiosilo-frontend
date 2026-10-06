import { fireEvent, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { Collection, CollectionDetail } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

let mockCollections: Collection[] = [];
let mockDetails: Record<number, CollectionDetail> = {};
const mockAdd = jest.fn();
const mockRemove = jest.fn();
const mockCreate = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  const mutation = (fn: jest.Mock) => ({ mutateAsync: fn, isPending: false });
  return {
    CapabilityError,
    useCollections: () => ({ data: mockCollections, isLoading: false, error: null }),
    useCollection: (id: number) => ({ data: mockDetails[id] }),
    useAddCollectionItem: () => mutation(mockAdd),
    useRemoveCollectionItem: () => mutation(mockRemove),
    useCreateCollection: () => mutation(mockCreate),
  };
});

/* eslint-disable import/first */
import { AddToCollectionDialog } from './collection-dialogs';
/* eslint-enable import/first */

const collection = (id: number, name: string, over: Partial<Collection> = {}): Collection => ({
  id,
  name,
  description: '',
  owner: { id: 1, username: 'alex' },
  owned: true,
  shared_with: [],
  item_count: 1,
  preview: [],
  created_at: '',
  updated_at: '',
  ...over,
});
const detail = (c: Collection, paths: string[]): CollectionDetail => ({
  collection: c,
  items: paths.map((path) => ({ library_id: 1, path, added_at: '' })),
});

const road = collection(1, 'Road trip');
const comfort = collection(2, 'Comfort');
const shared = collection(3, "Sam's picks", { owned: false });

function mount() {
  return mountWithPortal(
    <AddToCollectionDialog
      open
      onOpenChange={() => {}}
      connectionId="c"
      libraryId={1}
      path="Author/Book/Disc 1"
      title="Book"
    />,
  );
}

describe('AddToCollectionDialog', () => {
  beforeEach(() => {
    mockCollections = [road, comfort, shared];
    // The book is in Road trip under its book path (an add resolves a part path).
    mockDetails = { 1: detail(road, ['Author/Book']), 2: detail(comfort, ['Other']) };
    [mockToast, mockAdd, mockRemove, mockCreate].forEach((m) => m.mockReset());
  });

  it("lists only the listener's own collections, checked where the book is", async () => {
    await mount();
    expect(screen.getByRole('checkbox', { name: /^Road trip/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Comfort/ })).not.toBeChecked();
    expect(screen.queryByText("Sam's picks")).toBeNull();
  });

  it("takes the book out by the item's own path, and adds it by the path it was given", async () => {
    mockRemove.mockResolvedValue(undefined);
    mockAdd.mockResolvedValue(detail(comfort, ['Other', 'Author/Book']));
    await mount();
    await fireEvent.press(screen.getByRole('checkbox', { name: /^Road trip/ }));
    expect(mockRemove).toHaveBeenCalledWith({ id: 1, libraryId: 1, path: 'Author/Book' });
    await fireEvent.press(screen.getByRole('checkbox', { name: /^Comfort/ }));
    expect(mockAdd).toHaveBeenCalledWith({ id: 2, libraryId: 1, path: 'Author/Book/Disc 1' });
  });

  it('says a collection is full on a 409', async () => {
    mockAdd.mockRejectedValue(new ApiError(409, 'collection is full'));
    await mount();
    await fireEvent.press(screen.getByRole('checkbox', { name: /^Comfort/ }));
    expect(mockToast).toHaveBeenLastCalledWith({
      title: 'This collection is full. Remove a book to add another.',
    });
  });

  it('creates a collection and puts the book in it', async () => {
    const winter = collection(4, 'Winter');
    mockCreate.mockResolvedValue(winter);
    mockAdd.mockResolvedValue(detail(winter, ['Author/Book']));
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'New collection' }));
    await fireEvent.changeText(screen.getByLabelText('Name'), '  Winter ');
    await fireEvent.press(screen.getByRole('button', { name: 'Create and add' }));
    expect(mockCreate).toHaveBeenCalledWith({ name: 'Winter', description: '' });
    expect(mockAdd).toHaveBeenCalledWith({ id: 4, libraryId: 1, path: 'Author/Book/Disc 1' });
    expect(mockToast).toHaveBeenLastCalledWith({ title: 'Added to Winter' });
  });
});
