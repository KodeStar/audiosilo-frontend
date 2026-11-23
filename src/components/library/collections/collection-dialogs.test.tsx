import { fireEvent, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { Collection, CollectionDetail, HouseholdMember, HouseholdMembers } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

let mockOnline = true;
let mockPaused = false;
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  useDeviceOnline: () => mockOnline,
}));
beforeEach(() => {
  mockOnline = true;
  mockPaused = false;
});
let mockCollections: Collection[] | undefined = [];
let mockDetailError: Error | null = null;
const mockDetailRetry = jest.fn();
let mockDetailPaused = false;
let mockDetails: Record<number, CollectionDetail> = {};
const mockAdd = jest.fn();
const mockRemove = jest.fn();
const mockCreate = jest.fn();
let mockTargets: { id: number; username: string }[] | undefined = [];
let mockMembers: HouseholdMembers | undefined;
const mockSetShares = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  const mutation = (fn: jest.Mock) => ({ mutateAsync: fn, isPending: false });
  return {
    CapabilityError,
    useCollections: () => ({
      data: mockCollections,
      isPaused: mockPaused,
      isLoading: false,
      error: null,
    }),
    useCollection: (id: number) => ({
      data: mockDetails[id],
      error: mockDetailError,
      isPaused: mockDetailPaused,
      refetch: mockDetailRetry,
    }),
    useAddCollectionItem: () => mutation(mockAdd),
    useRemoveCollectionItem: () => mutation(mockRemove),
    useCreateCollection: () => mutation(mockCreate),
    useUpdateCollection: () => mutation(jest.fn()),
    useShareTargets: () => ({ data: mockTargets, isPaused: mockPaused, error: null }),
    useSetCollectionShares: () => mutation(mockSetShares),
    // A server without household_members hands back no data.
    useHouseholdMembers: () => ({ data: mockMembers }),
  };
});

/* eslint-disable import/first */
import { AddToCollectionDialog, ShareCollectionDialog } from './collection-dialogs';
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
    mockDetailError = null;
    mockDetailPaused = false;
    mockDetailRetry.mockClear();
    // The book is in Road trip under its book path (an add resolves a part path).
    mockDetails = { 1: detail(road, ['Author/Book']), 2: detail(comfort, ['Other']) };
    [mockToast, mockAdd, mockRemove, mockCreate].forEach((m) => m.mockReset());
  });

  it('explains a held collection list and keeps New collection disabled', async () => {
    mockCollections = undefined;
    mockPaused = true;
    await mount();
    expect(screen.getByText("You're offline. Reconnect to change collections.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New collection' })).toBeDisabled();
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByText(/no collections/i)).toBeNull();
  });

  it('shows a list not read yet as loading, never as "no collections"', async () => {
    mockCollections = undefined;
    await mount();
    expect(screen.queryByText(/no collections/i)).toBeNull();
    expect(screen.queryByText("You're offline. Reconnect to change collections.")).toBeNull();
  });

  it('names a collection whose membership is held without offering a toggle', async () => {
    mockCollections = [road];
    mockDetails = {};
    mockDetailPaused = true;
    await mount();
    expect(screen.getByText('Road trip')).toBeTruthy();
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('can retry the collection whose membership failed online', async () => {
    mockCollections = [road];
    mockDetails = {};
    mockDetailError = new Error('unavailable');
    await mount();
    expect(screen.getByText("Couldn't load Road trip.")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockDetailRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps known membership visible without sending changes offline', async () => {
    mockOnline = false;
    await mount();
    const checked = screen.getByRole('checkbox', { name: /^Road trip/ });
    expect(checked).toBeChecked();
    expect(checked).toBeDisabled();
    await fireEvent.press(checked);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('keeps an open create form and blocks keyboard submission when the connection drops', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'New collection' }));
    mockOnline = false;
    const name = screen.getByLabelText('Name');
    await fireEvent.changeText(name, 'Winter');
    expect(screen.getByRole('button', { name: 'Create and add' })).toBeDisabled();
    await fireEvent(name, 'submitEditing');
    expect(mockCreate).not.toHaveBeenCalled();
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

describe('ShareCollectionDialog: household members (8b-1)', () => {
  const member = (
    id: number,
    name: string,
    access: HouseholdMember['access'],
  ): HouseholdMember => ({
    id,
    name,
    username: name.toLowerCase(),
    kind: 'kid',
    access,
    created_at: '',
    devices: 0,
    last_listened_at: null,
  });
  const mountShare = (c = collection(4, 'Bedtime')) =>
    mountWithPortal(
      <ShareCollectionDialog open onOpenChange={jest.fn()} connectionId="a.1" collection={c} />,
    );

  beforeEach(() => {
    mockTargets = [
      { id: 12, username: 'evie' },
      { id: 13, username: 'ellis' },
      { id: 20, username: 'sam' },
    ];
    mockMembers = {
      allowed: true,
      max: 6,
      members: [member(12, 'Evie', 'collections'), member(13, 'Ellis', 'all')],
    };
  });

  it.each([false, true])(
    'explains why sharing cannot be saved offline (cached people: %s)',
    async (cached) => {
      if (!cached) mockTargets = undefined;
      mockPaused = true;
      await mountShare();
      expect(screen.getByText("You're offline. Reconnect to save sharing changes.")).toBeTruthy();
      expect(!!screen.queryByRole('checkbox', { name: 'evie' })).toBe(cached);
      const save = screen.getByRole('button', { name: 'Save' });
      expect(save).toBeDisabled();
      await fireEvent.press(save);
      expect(mockSetShares).not.toHaveBeenCalled();
      expect(screen.queryByText('Retry')).toBeNull();
    },
  );

  it('says a picked member on "Only collections I share" can listen to all of it', async () => {
    await mountShare();
    expect(screen.queryByTestId('share-member-note')).toBeNull();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'evie' }));
    expect(screen.getByText('Evie can listen to everything in this collection.')).toBeTruthy();
  });

  it('says nothing for a member on everything, or someone who is not a member', async () => {
    await mountShare();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'ellis' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'sam' }));
    expect(screen.queryByTestId('share-member-note')).toBeNull();
  });

  it('says it for a member it is already shared with', async () => {
    await mountShare(collection(4, 'Bedtime', { shared_with: [{ id: 12, username: 'evie' }] }));
    expect(screen.getByText('Evie can listen to everything in this collection.')).toBeTruthy();
  });

  it('says nothing on a server without household members', async () => {
    mockMembers = undefined;
    await mountShare(collection(4, 'Bedtime', { shared_with: [{ id: 12, username: 'evie' }] }));
    expect(screen.queryByTestId('share-member-note')).toBeNull();
  });
});
