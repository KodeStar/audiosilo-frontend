import { fireEvent, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { AuthSession, HouseholdMember, MyDevice, PairingPayload } from '@/api/types';
import { householdMember } from '@/testing/household-fixtures';
import { mountWithPortal } from '@/testing/render-overlay';

// The dialogs portal to the root host, which the app's ApiProvider wraps (its query
// client); the tests' host has none, so the client is a stand-in.
const mockInvalidate = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
const mockOpenCollection = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openCollection: (...a: unknown[]) => mockOpenCollection(...a) }),
}));
const mockRemoveRequest = jest.fn();
jest.mock('@/components/profiles/use-remove-person', () => ({
  useRemovePerson: () => ({ request: (...a: unknown[]) => mockRemoveRequest(...a), dialog: null }),
}));
const mockAddHere = jest.fn();
const mockSignedInHere = jest.fn();
jest.mock('@/components/connect/add-member-here', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/household-fixtures').addMemberHereMock({
    addMemberHere: (...a: unknown[]) => mockAddHere(...a),
    memberSignedInHere: (...a: unknown[]) => mockSignedInHere(...a),
  }),
);

let mockDevices: { data?: MyDevice[]; isPending: boolean; isError: boolean; refetch: jest.Mock };
const mockDevicesAsked = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockRevoke = jest.fn();
const mockPair = jest.fn();
const mockSession = jest.fn();
const mockCreate = jest.fn();
const mockDeleteCollection = jest.fn();
/** Collections the owner has besides Bedtime and Dinosaurs (a test's own). */
let mockMoreCollections: object[] = [];
jest.mock('@/api/hooks', () => {
  const actual = jest.requireActual('@/api/hooks');
  const mutation = (fn: jest.Mock) => ({ mutateAsync: fn, isPending: false });
  return {
    CapabilityError: actual.CapabilityError,
    qk: actual.qk,
    useMemberDevices: (...a: unknown[]) => {
      mockDevicesAsked(...a);
      return mockDevices;
    },
    useUpdateMember: () => mutation(mockUpdate),
    useDeleteMember: () => mutation(mockDelete),
    useRevokeMemberDevice: () => mutation(mockRevoke),
    useMemberPairing: () => mutation(mockPair),
    useMemberSession: () => mutation(mockSession),
    useCapability: () => true,
    useCollections: () => ({
      data: [
        {
          id: 4,
          name: 'Bedtime',
          owned: true,
          item_count: 2,
          owner: { id: 1, username: 'adam' },
        },
        {
          id: 5,
          name: 'Dinosaurs',
          owned: true,
          item_count: 7,
          owner: { id: 1, username: 'adam' },
        },
        ...mockMoreCollections,
      ],
      isLoading: false,
      error: null,
    }),
    useCreateCollection: () => mutation(mockCreate),
    useDeleteCollection: () => mutation(mockDeleteCollection),
  };
});

/* eslint-disable import/first */
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

import { AccessPicker } from './access-picker';
import { MemberCard } from './member-card';
/* eslint-enable import/first */

const owner = {
  id: 'a.1',
  serverId: 'a',
  name: 'Hearthside',
  serverUrl: 'u',
  token: 't',
  user: { id: 1, username: 'adam' },
} as unknown as Connection;

/** Evie, with Bedtime shared and signed in on one device. */
const member = (over: Partial<HouseholdMember> = {}): HouseholdMember =>
  householdMember({ collections: [{ id: 4, name: 'Bedtime', items: 2 }], devices: 1, ...over });
const device = (over: Partial<MyDevice> = {}): MyDevice => ({
  id: 70,
  kind: 'session',
  name: 'Kitchen iPad',
  client: { app: 'AudioSilo', version: '2.1.0', platform: 'ios' },
  created_at: '2026-10-13T10:00:00Z',
  last_seen: new Date().toISOString(),
  last_ip: '',
  current: false,
  ...over,
});
const payload = { qr_png_data_uri: 'data:image/png;base64,AAAA', web_url: 'w' } as PairingPayload;

const mount = (m: HouseholdMember = member()) =>
  mountWithPortal(<MemberCard connection={owner} member={m} />);

beforeEach(() => {
  jest.clearAllMocks();
  mockMoreCollections = [];
  resetProfilesForTests();
  mockDevices = { data: [device()], isPending: false, isError: false, refetch: jest.fn() };
  mockUpdate.mockImplementation(async ({ id, body }) => ({ ...member({ id }), ...body }));
  mockDelete.mockResolvedValue(undefined);
  mockRevoke.mockResolvedValue(undefined);
  mockPair.mockResolvedValue(payload);
  mockSession.mockResolvedValue({ token: 's', user: { id: 12, username: 'evie' } } as AuthSession);
  mockAddHere.mockResolvedValue({ connectionId: 'a.12', profileId: 'p' });
  mockSignedInHere.mockReturnValue(false);
  useSession.setState({ connections: [owner] });
  useProfiles.setState({
    hydrated: true,
    profiles: [{ id: 'adam', name: 'Adam', connectionIds: ['a.1'] }],
    activeProfileId: 'adam',
  });
});

describe('MemberCard', () => {
  it('says who they are and what they can listen to, each collection opening its page', async () => {
    await mount();
    expect(screen.getByRole('header', { name: 'Evie' })).toBeTruthy();
    expect(screen.getByText('Kid · evie')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Open Bedtime' }));
    expect(mockOpenCollection).toHaveBeenCalledWith('a.1', 4);
  });

  it('says "Everything you can listen to" for an all member, and none shared yet', async () => {
    await mount(member({ access: 'all', collections: undefined, kind: 'grownup' }));
    expect(screen.getByText('Everything you can listen to')).toBeTruthy();
    expect(screen.getByText('Grown-up · evie')).toBeTruthy();
    await mount(member({ collections: [] }));
    expect(screen.getByText('Only collections you share, and none is shared yet.')).toBeTruthy();
  });

  it('confirms before making a grown-up a kid, then changes the kind', async () => {
    await mount(member({ kind: 'grownup', access: 'all', collections: undefined }));
    await fireEvent(screen.getByTestId('member-kid-12'), 'checkedChange', true);
    expect(screen.getByText('Make Evie a kids account?')).toBeTruthy();
    expect(
      screen.getByText(
        "Their password and API keys will be removed. Devices they're signed in on stay signed in.",
      ),
    ).toBeTruthy();
    expect(mockUpdate).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Make it a kids account' }));
    expect(mockUpdate).toHaveBeenCalledWith({ id: 12, body: { kind: 'kid' } });
  });

  it('makes a kid a grown-up at once (nothing is removed)', async () => {
    await mount();
    await fireEvent(screen.getByTestId('member-kid-12'), 'checkedChange', false);
    expect(mockUpdate).toHaveBeenCalledWith({ id: 12, body: { kind: 'grownup' } });
  });

  it('says a refused change changed nothing', async () => {
    mockUpdate.mockRejectedValue(new ApiError(500, 'x'));
    await mount();
    await fireEvent(screen.getByTestId('member-kid-12'), 'checkedChange', false);
    expect(mockToast).toHaveBeenCalledWith({
      title: "Couldn't change Evie's account",
      description: "Hearthside didn't answer, so nothing changed. Try again.",
    });
  });

  it('changes what they can listen to: the collections as the full set', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Change what Evie can listen to' }));
    expect(screen.getByRole('radio', { name: /^Only collections I share/ })).toBeChecked();
    expect(screen.getByTestId('pick-collection-4')).toBeChecked();
    await fireEvent.press(screen.getByTestId('pick-collection-5'));
    await fireEvent.press(screen.getByTestId('member-access-save'));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: 12,
      body: { access: 'collections', collection_ids: [4, 5] },
    });
  });

  it('asks "What can Evie listen to?" once: the picker has no heading of its own there', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Change what Evie can listen to' }));
    expect(screen.getByText('What can Evie listen to?')).toBeTruthy();
    expect(screen.queryByText('What can they listen to?')).toBeNull();
  });

  it('creates "<Name>\'s books" only on Save, before the change, and never on Cancel', async () => {
    mockCreate.mockResolvedValue({ id: 9, name: "Evie's books" });
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Change what Evie can listen to' }));
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    expect(screen.getByTestId('pick-new-books')).toBeChecked();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockCreate).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Change what Evie can listen to' }));
    expect(screen.queryByTestId('pick-new-books')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    await fireEvent.press(screen.getByTestId('member-access-save'));
    expect(mockCreate).toHaveBeenCalledWith({ name: "Evie's books" });
    expect(mockUpdate).toHaveBeenCalledWith({
      id: 12,
      body: { access: 'collections', collection_ids: [4, 9] },
    });
    expect(mockDeleteCollection).not.toHaveBeenCalled();
    expect(screen.queryByTestId('member-access-dialog')).toBeNull();
  });

  it('deletes the new collection again when the change is refused', async () => {
    mockCreate.mockResolvedValue({ id: 9, name: "Evie's books" });
    mockDeleteCollection.mockResolvedValue(undefined);
    mockUpdate.mockRejectedValue(new ApiError(400, 'bad', 'invalid_collections'));
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Change what Evie can listen to' }));
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    await fireEvent.press(screen.getByTestId('member-access-save'));
    expect(mockDeleteCollection).toHaveBeenCalledWith(9);
    expect(mockToast).toHaveBeenCalledWith({
      title: "Couldn't change Evie's account",
      description:
        "One of those collections can't be shared from this account any more. Check them and try again.",
    });
    // Still open, to try again.
    expect(screen.getByTestId('member-access-dialog')).toBeTruthy();
  });

  it('changes them to everything without sending collections', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Change what Evie can listen to' }));
    await fireEvent.press(screen.getByRole('radio', { name: /^Everything I can listen to/ }));
    await fireEvent.press(screen.getByTestId('member-access-save'));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: 12,
      body: { access: 'all', collection_ids: undefined },
    });
  });

  it('renames them on the server', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Rename Evie' }));
    expect(
      screen.getByText('Their name on Hearthside. Their username stays the same.'),
    ).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('rename-field'), 'Evelyn ');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(mockUpdate).toHaveBeenCalledWith({ id: 12, body: { name: 'Evelyn' } });
  });

  it("never sends a name the server's rule refuses (a control character)", async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Rename Evie' }));
    await fireEvent.changeText(screen.getByTestId('rename-field'), 'Ev\u0007ie');
    expect(screen.getByText('Use a name of up to 40 characters.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('renames their profile on this device too when they are here', async () => {
    const here = { ...owner, id: 'a.12', user: { id: 12, username: 'evie' } } as Connection;
    useSession.setState({ connections: [owner, here] });
    useProfiles.setState({
      profiles: [
        { id: 'adam', name: 'Adam', connectionIds: ['a.1'] },
        { id: 'evie', name: 'Evie', connectionIds: ['a.12'] },
      ],
    });
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Rename Evie' }));
    expect(
      screen.getByText(
        'Their name on Hearthside and on this device. Their username stays the same.',
      ),
    ).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('rename-field'), 'Evelyn');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(mockUpdate).toHaveBeenCalledWith({ id: 12, body: { name: 'Evelyn' } });
    expect(useProfiles.getState().profiles.find((p) => p.id === 'evie')?.name).toBe('Evelyn');
    // The owner's own profile keeps its name.
    expect(useProfiles.getState().profiles.find((p) => p.id === 'adam')?.name).toBe('Adam');
  });

  it("leaves this device's profile alone when the server refuses the new name", async () => {
    const here = { ...owner, id: 'a.12', user: { id: 12, username: 'evie' } } as Connection;
    useSession.setState({ connections: [owner, here] });
    useProfiles.setState({
      profiles: [
        { id: 'adam', name: 'Adam', connectionIds: ['a.1'] },
        { id: 'evie', name: 'Evie', connectionIds: ['a.12'] },
      ],
    });
    mockUpdate.mockRejectedValue(new ApiError(400, 'bad', 'invalid_name'));
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Rename Evie' }));
    await fireEvent.changeText(screen.getByTestId('rename-field'), 'Evelyn');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(useProfiles.getState().profiles.find((p) => p.id === 'evie')?.name).toBe('Evie');
  });

  it('lists their devices and signs one out after a confirmation', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign Evie out of Kitchen iPad' }));
    expect(screen.getByText('Sign Evie out of Kitchen iPad?')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out device' }));
    expect(mockRevoke).toHaveBeenCalledWith({ id: 12, deviceId: 70 });
    expect(mockToast).toHaveBeenCalledWith({ title: 'Signed Evie out of Kitchen iPad' });
  });

  it('says a device signed out already, and too many tries, in words', async () => {
    mockRevoke.mockRejectedValueOnce(new ApiError(404, 'device not found'));
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign Evie out of Kitchen iPad' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out device' }));
    expect(mockToast).toHaveBeenLastCalledWith({ title: 'Kitchen iPad was already signed out' });

    mockRevoke.mockRejectedValueOnce(new ApiError(429, 'too many attempts, try again later'));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign Evie out of Kitchen iPad' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out device' }));
    expect(mockToast).toHaveBeenLastCalledWith({
      title: "Couldn't sign out Kitchen iPad",
      description: 'Too many tries. Wait a few minutes and try again.',
    });
  });

  it('asks for no devices of a member the list says is signed in nowhere', async () => {
    mockDevices = { isPending: true, isError: false, refetch: jest.fn() };
    await mount(member({ devices: 0 }));
    expect(screen.getByText("Evie isn't signed in anywhere yet.")).toBeTruthy();
    expect(screen.queryByTestId('member-devices-loading-12')).toBeNull();
    expect(mockDevicesAsked).toHaveBeenCalledWith(12, 'a.1', { enabled: false });
  });

  it('says when they are signed in nowhere, and shows loading and errors', async () => {
    mockDevices = { data: [], isPending: false, isError: false, refetch: jest.fn() };
    await mount();
    expect(screen.getByText("Evie isn't signed in anywhere yet.")).toBeTruthy();
    mockDevices = { isPending: true, isError: false, refetch: jest.fn() };
    await mount();
    expect(screen.getByTestId('member-devices-loading-12')).toBeTruthy();
    mockDevices = { isPending: false, isError: true, refetch: jest.fn() };
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockDevices.refetch).toHaveBeenCalled();
  });

  it("shows their own device's pairing code", async () => {
    await mount();
    await fireEvent.press(
      screen.getByRole('button', { name: "Show a code to set up Evie's own device" }),
    );
    expect(mockPair).toHaveBeenCalledWith(12);
    expect(screen.getByText('Show Evie this code')).toBeTruthy();
    expect(screen.getByRole('image', { name: 'Pairing code for Evie on Hearthside' })).toBeTruthy();
    // Done is the dialog's, in its footer (the code has none of its own here).
    expect(screen.getAllByRole('button', { name: 'Done' })).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('member-qr-done-12'));
    expect(screen.queryByText('Show Evie this code')).toBeNull();
  });

  it("says too many tries when the server's limiter refuses a code, never its own words", async () => {
    mockPair.mockRejectedValue(new ApiError(429, 'too many attempts, try again later'));
    await mount();
    await fireEvent.press(
      screen.getByRole('button', { name: "Show a code to set up Evie's own device" }),
    );
    expect(screen.queryByText('too many attempts, try again later')).toBeNull();
    expect(screen.getByText('Too many tries. Wait a few minutes and try again.')).toBeTruthy();
  });

  it("says a member the admin disabled can't be paired or signed in here, never to try again", async () => {
    mockPair.mockRejectedValue(new ApiError(409, 'disabled', 'member_disabled'));
    await mount();
    await fireEvent.press(
      screen.getByRole('button', { name: "Show a code to set up Evie's own device" }),
    );
    expect(
      screen.getByText(
        "This account is turned off on Hearthside. Only the server's admin can turn it back on.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/didn't answer/)).toBeNull();
    await fireEvent.press(screen.getByTestId('member-qr-done-12'));

    mockSession.mockRejectedValue(new ApiError(409, 'disabled', 'member_disabled'));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign Evie in on this device' }));
    expect(mockToast).toHaveBeenLastCalledWith({
      title: "Evie's account is turned off on this server. Only its admin can turn it back on.",
    });
  });

  it('says a member no longer in the household (404) is gone, never to try again', async () => {
    mockSession.mockRejectedValue(new ApiError(404, 'member not found'));
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign Evie in on this device' }));
    expect(mockToast).toHaveBeenLastCalledWith({
      title: "Evie isn't in your household on this server any more.",
    });
    mockPair.mockRejectedValue(new ApiError(404, 'member not found'));
    await fireEvent.press(
      screen.getByRole('button', { name: "Show a code to set up Evie's own device" }),
    );
    expect(
      screen.getByText("That person isn't in your household on Hearthside any more."),
    ).toBeTruthy();
  });

  it('lists their API keys with their sessions, each with Sign out (the list counts both)', async () => {
    mockDevices = {
      data: [device(), device({ id: 71, kind: 'api', name: 'Home script', client: undefined })],
      isPending: false,
      isError: false,
      refetch: jest.fn(),
    };
    await mount(member({ devices: 2 }));
    expect(screen.getByTestId('member-device-71')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign Evie out of Home script' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out device' }));
    expect(mockRevoke).toHaveBeenCalledWith({ id: 12, deviceId: 71 });

    // Only an API key: still listed, never "signed in nowhere".
    mockDevices = {
      data: [device({ id: 71, kind: 'api', name: 'Home script', client: undefined })],
      isPending: false,
      isError: false,
      refetch: jest.fn(),
    };
    await mount();
    expect(screen.queryByText("Evie isn't signed in anywhere yet.")).toBeNull();
    expect(screen.getByTestId('member-device-71')).toBeTruthy();
  });

  it("keeps the new collection when the change got no answer (it may have landed), saying it's there", async () => {
    mockCreate.mockResolvedValue({ id: 9, name: "Evie's books" });
    mockUpdate.mockRejectedValue(new TypeError('Network request failed'));
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Change what Evie can listen to' }));
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    await fireEvent.press(screen.getByTestId('member-access-save'));
    expect(mockDeleteCollection).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith({
      title: "Couldn't change Evie's account",
      description:
        "Hearthside didn't answer, so nothing changed. Try again. Evie's books was created and is still in your collections.",
    });
  });

  it('says too many tries when signing them in here is refused by the limiter', async () => {
    mockSession.mockRejectedValue(new ApiError(429, 'too many attempts, try again later'));
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign Evie in on this device' }));
    expect(mockToast).toHaveBeenLastCalledWith({
      title: 'Too many tries. Wait a few minutes and try again.',
    });
  });

  it('signs them in on this device, never minting a session when they are already here', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign Evie in on this device' }));
    expect(mockSignedInHere).toHaveBeenCalledWith('a', 12);
    expect(mockSession).toHaveBeenCalledWith(12);
    expect(mockAddHere).toHaveBeenCalledWith(expect.objectContaining({ token: 's' }), {
      name: 'Evie',
    });
    expect(mockToast).toHaveBeenLastCalledWith({
      title: 'Evie is signed in on this device too.',
    });

    jest.clearAllMocks();
    mockSignedInHere.mockReturnValue(true);
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign Evie in on this device' }));
    expect(mockSession).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenLastCalledWith({
      title: 'Evie is already signed in on this device.',
    });
  });

  it('deletes their account only after two confirmations, the second by typing the name', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: "Delete Evie's account" }));
    expect(screen.getByText("Delete Evie's account?")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(mockDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Type Evie to delete their account')).toBeTruthy();
    expect(screen.getByTestId('member-delete-confirm')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('member-delete-field'), 'Evi');
    expect(screen.getByTestId('member-delete-confirm')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('member-delete-field'), 'evie');
    await fireEvent.press(screen.getByTestId('member-delete-confirm'));
    expect(mockDelete).toHaveBeenCalledWith(12);
    expect(mockToast).toHaveBeenCalledWith({ title: "Deleted Evie's account" });
  });

  it('never deletes when the first confirmation is cancelled', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: "Delete Evie's account" }));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Type Evie to delete their account')).toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('offers "Remove from this device" apart from deleting, only when they are here', async () => {
    const { unmount } = await mount();
    expect(screen.queryByTestId('member-remove-12')).toBeNull();
    await unmount();
    const here = { ...owner, id: 'a.12', user: { id: 12, username: 'evie' } } as Connection;
    useSession.setState({ connections: [owner, here] });
    useProfiles.setState({
      profiles: [
        { id: 'adam', name: 'Adam', connectionIds: ['a.1'] },
        { id: 'evie', name: 'Evie', connectionIds: ['a.12'], kids: { bedtime: '19:30' } },
      ],
    });
    await mount();
    expect(screen.getByText('On this device')).toBeTruthy();
    // Already here: no way to sign them in again.
    expect(screen.queryByTestId('member-here-12')).toBeNull();
    // Labelled with the action, not the confirm dialog's question.
    expect(screen.getByTestId('member-remove-12').props.accessibilityLabel).toBe(
      'Remove Evie from this device',
    );
    await fireEvent.press(screen.getByTestId('member-remove-12'));
    expect(mockRemoveRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 'evie' }), 'Evie');
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('AccessPicker while its form is saved', () => {
  const picker = (saving: boolean, fns: { onNewBooks: jest.Mock; onCollections: jest.Mock }) => (
    <AccessPicker
      connectionId="a.1"
      serverName="Hearthside"
      name="Evie"
      access="collections"
      collectionIds={[]}
      newBooks
      saving={saving}
      onAccess={jest.fn()}
      onCollections={fns.onCollections}
      onNewBooks={fns.onNewBooks}
    />
  );

  it('never takes the "<Name>\'s books" its own save created for one to pick instead', async () => {
    // The save created "Evie's books" and the list read again holds it.
    mockMoreCollections = [
      {
        id: 9,
        name: "Evie's books",
        owned: true,
        item_count: 0,
        owner: { id: 1, username: 'adam' },
      },
    ];
    const saving = { onNewBooks: jest.fn(), onCollections: jest.fn() };
    await mountWithPortal(picker(true, saving));
    // A refused save deletes it again: had the form taken its id, every retry would be
    // refused (a collection that is gone, which the picker can't show to untick).
    expect(saving.onNewBooks).not.toHaveBeenCalled();
    expect(saving.onCollections).not.toHaveBeenCalled();

    // Not saving: one of that name already there is ticked instead of making a second.
    const idle = { onNewBooks: jest.fn(), onCollections: jest.fn() };
    await mountWithPortal(picker(false, idle));
    expect(idle.onNewBooks).toHaveBeenCalledWith(false);
    expect(idle.onCollections).toHaveBeenCalledWith([9]);
  });
});
