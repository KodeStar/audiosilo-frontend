import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type {
  AuthSession,
  Collection,
  HouseholdMember,
  HouseholdMembers as Members,
  PairingPayload,
} from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
// The member card has its own suite.
jest.mock('./member-card', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    MemberCard: ({ member }: { member: HouseholdMember }) => <Text>{`card-${member.name}`}</Text>,
  };
});
jest.mock('@/components/profiles/pin-dialog', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    PinDialog: ({ open, mode, name }: { open: boolean; mode: string; name: string }) =>
      open ? <Text>{`pin-dialog ${mode} ${name}`}</Text> : null,
  };
});
const mockReadPin = jest.fn();
jest.mock('@/lib/profile-pin', () => ({
  readPinMirrored: (p: { id: string }) => mockReadPin(p.id),
}));

// addMemberHere belongs to workstream P: here it is a mock.
const mockAddHere = jest.fn();
const mockSignedInHere = jest.fn();
jest.mock('@/components/connect/add-member-here', () => {
  class AddMemberHereError extends Error {
    readonly code: string;
    constructor(mockCode: string) {
      super(mockCode);
      this.code = mockCode;
    }
  }
  return {
    AddMemberHereError,
    addMemberHere: (...a: unknown[]) => mockAddHere(...a),
    memberSignedInHere: (...a: unknown[]) => mockSignedInHere(...a),
  };
});

type Query<T> = { data?: T; isError?: boolean; refetch?: jest.Mock };
const mockCaps: Record<string, { household_members?: boolean; collections?: boolean }> = {};
let mockMembers: Record<string, Query<Members>> = {};
let mockCollections: Collection[] = [];
const mockAddMember = jest.fn();
const mockCreate = jest.fn();
const mockDeleteCollection = jest.fn();
const mockPair = jest.fn();
const mockSession = jest.fn();
jest.mock('@/api/hooks', () => {
  const actual = jest.requireActual('@/api/hooks');
  const mutation = (fn: jest.Mock) => ({ mutateAsync: fn, isPending: false });
  return {
    CapabilityError: actual.CapabilityError,
    qk: actual.qk,
    useCapabilitiesAll: () => mockCaps,
    useCapability: (flag: 'collections', cid: string) => mockCaps[cid]?.[flag] ?? false,
    useHouseholdMembers: (cid: string) => ({ refetch: jest.fn(), ...mockMembers[cid] }),
    useAddMember: () => mutation(mockAddMember),
    useCollections: () => ({ data: mockCollections, isLoading: false, error: null }),
    useCreateCollection: () => mutation(mockCreate),
    useDeleteCollection: () => mutation(mockDeleteCollection),
    useMemberPairing: () => mutation(mockPair),
    useMemberSession: () => mutation(mockSession),
  };
});

/* eslint-disable import/first */
import { AddMemberHereError } from '@/components/connect/add-member-here';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

import { HouseholdMembers } from './members-section';
/* eslint-enable import/first */

const conn = (id: string, name: string) =>
  ({
    id,
    serverId: id.split('.')[0],
    name,
    serverUrl: 'u',
    token: 't',
    user: { id: Number(id.split('.')[1]), username: 'adam' },
  }) as unknown as Connection;

const member = (over: Partial<HouseholdMember> = {}): HouseholdMember => ({
  id: 12,
  name: 'Evie',
  username: 'evie',
  kind: 'kid',
  access: 'collections',
  created_at: '2026-10-13T10:00:00.000Z',
  collections: [],
  devices: 0,
  last_listened_at: null,
  ...over,
});
const list = (over: Partial<Members> = {}): Query<Members> => ({
  data: { allowed: true, max: 6, members: [], ...over },
});
const collection = (id: number, name: string): Collection => ({
  id,
  name,
  description: '',
  owner: { id: 1, username: 'adam' },
  owned: true,
  shared_with: [],
  item_count: 2,
  preview: [],
  created_at: '',
  updated_at: '',
});
const session = { token: 'kid-token', user: { id: 12, username: 'evie' } } as AuthSession;
const payload: PairingPayload = {
  server_name: 'Hearthside',
  base_url: 'https://books.example',
  pairing_token: 'tok',
  uri: 'audiosilo://connect?token=tok',
  web_url: 'https://books.example/web/connect?token=tok',
  qr_png_data_uri: 'data:image/png;base64,AAAA',
  links: { web: 'https://books.example/web', admin: 'https://books.example/admin' },
};

async function mount() {
  await mountWithPortal(<HouseholdMembers />);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLayout = 'phone';
  resetProfilesForTests();
  for (const k of Object.keys(mockCaps)) delete mockCaps[k];
  mockCaps['a.1'] = { household_members: true, collections: true };
  mockMembers = { 'a.1': list() };
  mockCollections = [collection(4, 'Bedtime'), collection(5, 'Dinosaurs')];
  mockAddMember.mockResolvedValue({ member: member(), session });
  mockAddHere.mockResolvedValue({ connectionId: 'a.12', profileId: 'p-evie' });
  mockSignedInHere.mockReturnValue(false);
  mockPair.mockResolvedValue(payload);
  mockSession.mockResolvedValue({ ...session, user: { id: 13, username: 'ellis' } });
  mockReadPin.mockResolvedValue(null);
  useSession.setState({
    status: 'authenticated',
    connections: [conn('a.1', 'Hearthside')],
    defaultConnectionId: 'a.1',
  });
  useProfiles.setState({
    hydrated: true,
    profiles: [{ id: 'adam', name: 'Adam', connectionIds: ['a.1'] }],
    activeProfileId: 'adam',
    askAtLaunch: false,
  });
});

const openAdd = async () => {
  await fireEvent.press(screen.getByRole('button', { name: 'Add someone to your household' }));
};
const typeName = async (name: string) => {
  await fireEvent.changeText(screen.getByTestId('add-member-name'), name);
};
const radio = (name: RegExp) => screen.getByRole('radio', { name });

describe('the members section', () => {
  it('is not there at all on a server without household_members (no add action)', async () => {
    mockCaps['a.1'] = { collections: true };
    await mount();
    expect(screen.queryByTestId('household-members')).toBeNull();
    expect(screen.queryByText('Add someone to your household')).toBeNull();
  });

  it('lists the members with a card each, and offers adding under the cap', async () => {
    mockMembers['a.1'] = list({ members: [member(), member({ id: 13, name: 'Ellis' })] });
    await mount();
    expect(screen.getByRole('header', { name: 'Your household' })).toBeTruthy();
    expect(screen.getByText('card-Evie')).toBeTruthy();
    expect(screen.getByText('card-Ellis')).toBeTruthy();
    expect(screen.getByText('2 of 6 added')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add someone to your household' })).toBeTruthy();
  });

  it('says what adding does when there is nobody yet', async () => {
    await mount();
    expect(screen.getByTestId('household-members-empty')).toBeTruthy();
  });

  it.each([
    ['feature_off', "Your server's admin has turned off adding people."],
    ['not_allowed', "Your server's admin hasn't let this account add people."],
    ['member', 'Only the person who manages your account can add people.'],
    ['demo', "Demo accounts can't add people."],
  ] as const)('explains %s instead of offering to add', async (reason, words) => {
    mockMembers['a.1'] = list({ allowed: false, reason });
    await mount();
    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.queryByText('Add someone to your household')).toBeNull();
  });

  it('tells a member who manages their account, instead of "People you\'ve added"', async () => {
    useSession.setState({
      connections: [
        {
          ...conn('a.1', 'Hearthside'),
          user: { id: 13, username: 'ellis', managed_by: { id: 1, username: 'adam' } },
        } as unknown as Connection,
      ],
    });
    mockMembers['a.1'] = list({ allowed: false, reason: 'member' });
    await mount();
    expect(screen.getByText('adam manages your account.')).toBeTruthy();
    expect(
      screen.queryByText("People you've added. You choose what each of them can listen to."),
    ).toBeNull();
    expect(
      screen.getByText('Only adam can add people or change what you can listen to.'),
    ).toBeTruthy();
  });

  it('explains the cap when the members fill it', async () => {
    mockMembers['a.1'] = list({ max: 1, members: [member()] });
    await mount();
    expect(screen.getByText("You've added the most people this server allows (1).")).toBeTruthy();
    expect(screen.queryByText('Add someone to your household')).toBeNull();
    // The owner still manages the members they have.
    expect(screen.getByText('card-Evie')).toBeTruthy();
  });

  it('shows loading, then an error with Retry', async () => {
    mockMembers['a.1'] = {};
    await mount();
    expect(screen.getByTestId('household-members-loading')).toBeTruthy();
    const refetch = jest.fn();
    mockMembers['a.1'] = { isError: true, refetch };
    await mount();
    expect(screen.getByText("Couldn't load your household from Hearthside.")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('names the server when the person listening has several with members', async () => {
    useSession.setState({ connections: [conn('a.1', 'Hearthside'), conn('b.1', "Maya's Shelf")] });
    useProfiles.setState({
      profiles: [{ id: 'adam', name: 'Adam', connectionIds: ['a.1', 'b.1'] }],
    });
    mockCaps['b.1'] = { household_members: true };
    mockMembers['b.1'] = list();
    await mount();
    expect(screen.getByRole('header', { name: 'Your household on Hearthside' })).toBeTruthy();
    expect(screen.getByRole('header', { name: "Your household on Maya's Shelf" })).toBeTruthy();
  });
});

describe('the add dialog', () => {
  it('starts on a kid with "Only collections I share" and follows the Kids switch', async () => {
    await mount();
    await openAdd();
    expect(screen.getByTestId('add-member-kids')).toBeChecked();
    expect(radio(/^Only collections I share/)).toBeChecked();
    expect(screen.getByTestId('collection-picker')).toBeTruthy();
    await fireEvent(screen.getByTestId('add-member-kids'), 'checkedChange', false);
    expect(radio(/^Everything I can listen to/)).toBeChecked();
    expect(screen.queryByTestId('collection-picker')).toBeNull();
    await fireEvent(screen.getByTestId('add-member-kids'), 'checkedChange', true);
    expect(radio(/^Only collections I share/)).toBeChecked();
  });

  it('keeps the access the owner picked whatever the Kids switch does', async () => {
    await mount();
    await openAdd();
    await fireEvent.press(radio(/^Everything I can listen to/));
    await fireEvent(screen.getByTestId('add-member-kids'), 'checkedChange', false);
    await fireEvent(screen.getByTestId('add-member-kids'), 'checkedChange', true);
    expect(radio(/^Everything I can listen to/)).toBeChecked();
  });

  it('adds a kid signed in here, with the collections picked, then keeps the owner listening', async () => {
    await mount();
    await openAdd();
    await typeName('  Evie ');
    await fireEvent.press(screen.getByTestId('pick-collection-5'));
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(mockAddMember).toHaveBeenCalledWith({
      name: 'Evie',
      kind: 'kid',
      access: 'collections',
      sign_in_here: true,
      collection_ids: [5],
    });
    expect(mockAddHere).toHaveBeenCalledWith(session, { name: 'Evie' });
    expect(screen.getByText('Evie is added')).toBeTruthy();
    expect(screen.getByTestId('add-kid-result')).toHaveTextContent(
      "Evie is signed in on this device, in kids mode. Choose them in Who's listening? when it's their turn.",
    );
    // The person listening never changed.
    expect(useProfiles.getState().activeProfileId).toBe('adam');
  });

  it("offers to set the owner's PIN when they have none, and sets it in the PIN dialog", async () => {
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(screen.getByTestId('add-kid-pin-offer')).toHaveTextContent(
      "Set a PIN for Adam, so Evie can't switch to you without it.",
    );
    await fireEvent.press(screen.getByTestId('add-kid-set-pin'));
    expect(mockReadPin).toHaveBeenCalledWith('adam');
    expect(screen.getByText('pin-dialog set Adam')).toBeTruthy();
  });

  it('offers no PIN when the owner has one', async () => {
    useProfiles.setState({
      profiles: [{ id: 'adam', name: 'Adam', connectionIds: ['a.1'], hasPin: true }],
    });
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(screen.queryByTestId('add-kid-pin-offer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('explains a kid this device already holds (already_here)', async () => {
    mockAddHere.mockRejectedValue(new AddMemberHereError('already_here'));
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(screen.getByTestId('add-kid-result')).toHaveTextContent(
      'Evie is already signed in on this device.',
    );
    expect(screen.queryByTestId('add-kid-pin-offer')).toBeNull();
  });

  it('says why addMemberHere refused otherwise, in our words', async () => {
    mockAddHere.mockRejectedValue(new AddMemberHereError('choose_adult'));
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(screen.getByTestId('add-kid-result')).toHaveTextContent(
      'Choose a grown-up before adding someone. Use Sign in on this device on their card.',
    );
  });

  it('adds a grown-up without signing in here, then shows their code', async () => {
    mockAddMember.mockResolvedValue({
      member: member({ id: 13, name: 'Ellis', kind: 'grownup', access: 'all' }),
    });
    await mount();
    await openAdd();
    await fireEvent(screen.getByTestId('add-member-kids'), 'checkedChange', false);
    await typeName('Ellis');
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(mockAddMember).toHaveBeenCalledWith({ name: 'Ellis', kind: 'grownup', access: 'all' });
    expect(mockAddHere).not.toHaveBeenCalled();
    expect(screen.getByText('Show Ellis this code')).toBeTruthy();
    expect(mockPair).toHaveBeenCalledWith(13);
    expect(
      screen.getByRole('image', { name: 'Pairing code for Ellis on Hearthside' }),
    ).toBeTruthy();
    // One Done, the dialog's (its footer), which closes it.
    expect(screen.getAllByRole('button', { name: 'Done' })).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('add-grownup-done'));
    expect(screen.queryByText('Show Ellis this code')).toBeNull();
  });

  it('"They\'ll also use this phone" signs the grown-up in here as an ordinary person', async () => {
    mockAddMember.mockResolvedValue({
      member: member({ id: 13, name: 'Ellis', kind: 'grownup', access: 'all' }),
    });
    await mount();
    await openAdd();
    await fireEvent(screen.getByTestId('add-member-kids'), 'checkedChange', false);
    await typeName('Ellis');
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    await fireEvent.press(screen.getByRole('button', { name: "They'll also use this phone" }));
    expect(mockSignedInHere).toHaveBeenCalledWith('a', 13);
    expect(mockSession).toHaveBeenCalledWith(13);
    expect(mockAddHere).toHaveBeenCalledWith(expect.objectContaining({ token: 'kid-token' }), {
      name: 'Ellis',
    });
    expect(screen.getByTestId('add-grownup-here')).toHaveTextContent(
      'Ellis is signed in on this device too.',
    );
  });

  it('never mints a session for a grown-up this device already holds', async () => {
    mockAddMember.mockResolvedValue({
      member: member({ id: 13, name: 'Ellis', kind: 'grownup', access: 'all' }),
    });
    mockSignedInHere.mockReturnValue(true);
    mockLayout = 'desktop';
    await mount();
    await openAdd();
    await fireEvent(screen.getByTestId('add-member-kids'), 'checkedChange', false);
    await typeName('Ellis');
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    // Not a phone: the device's own words.
    await fireEvent.press(screen.getByRole('button', { name: "They'll also use this device" }));
    expect(mockSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('add-grownup-here-error')).toHaveTextContent(
      'Ellis is already signed in on this device.',
    );
  });

  it('"Create <Name>\'s books" creates nothing at once: a ticked new collection, made on submit', async () => {
    mockCreate.mockResolvedValue(collection(9, "Evie's books"));
    await mount();
    await openAdd();
    expect(screen.getByTestId('create-member-books')).toBeDisabled();
    await typeName('Evie');
    await fireEvent.press(screen.getByTestId('pick-collection-4'));
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.getByTestId('pick-new-books')).toBeChecked();
    expect(screen.getByText('New collection, created when you save')).toBeTruthy();
    expect(screen.queryByTestId('create-member-books')).toBeNull();
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    // Created first, so its id is in the member's collections.
    expect(mockCreate).toHaveBeenCalledWith({ name: "Evie's books" });
    expect(mockAddMember).toHaveBeenCalledWith(expect.objectContaining({ collection_ids: [4, 9] }));
    expect(mockCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mockAddMember.mock.invocationCallOrder[0],
    );
    expect(mockDeleteCollection).not.toHaveBeenCalled();
  });

  it('offers the owner\'s own "Evie\'s books" ticked instead of a second one of that name (D10)', async () => {
    mockCollections = [collection(4, 'Bedtime'), collection(7, "evie's Books ")];
    await mount();
    await openAdd();
    await typeName('Evie');
    expect(screen.queryByRole('button', { name: "Create Evie's books" })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: "Share evie's Books" }));
    expect(screen.getByTestId('pick-collection-7')).toBeChecked();
    expect(screen.queryByTestId('use-member-books')).toBeNull();
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAddMember).toHaveBeenCalledWith(expect.objectContaining({ collection_ids: [7] }));
  });

  it('turns "Create" chosen before the name matched into the existing collection, ticked (D10)', async () => {
    mockCollections = [collection(4, 'Bedtime'), collection(7, "Evie's books")];
    await mount();
    await openAdd();
    await typeName('Evi');
    await fireEvent.press(screen.getByRole('button', { name: "Create Evi's books" }));
    expect(screen.getByTestId('pick-new-books')).toBeChecked();
    await typeName('Evie');
    await waitFor(() => expect(screen.queryByTestId('pick-new-books')).toBeNull());
    expect(screen.getByTestId('pick-collection-7')).toBeChecked();
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAddMember).toHaveBeenCalledWith(expect.objectContaining({ collection_ids: [7] }));
  });

  it('Cancel after "Create <Name>\'s books" leaves nothing behind', async () => {
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it('unticking the new collection takes it back, and switching to everything drops it', async () => {
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    await fireEvent.press(screen.getByTestId('pick-new-books'));
    expect(screen.queryByTestId('pick-new-books')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    await fireEvent.press(radio(/^Everything I can listen to/));
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAddMember).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'all', name: 'Evie' }),
    );
  });

  it('a refused add deletes the new collection again and says why', async () => {
    mockCreate.mockResolvedValue(collection(9, "Evie's books"));
    mockAddMember.mockRejectedValue(new ApiError(409, 'limit', 'member_limit'));
    mockDeleteCollection.mockResolvedValue(undefined);
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(mockDeleteCollection).toHaveBeenCalledWith(9);
    expect(screen.getByTestId('add-member-error')).toHaveTextContent(
      "You've added the most people this server allows.",
    );
    expect(mockAddHere).not.toHaveBeenCalled();
  });

  it('says so when the new collection could not be deleted again', async () => {
    mockCreate.mockResolvedValue(collection(9, "Evie's books"));
    mockAddMember.mockRejectedValue(new ApiError(500, 'oops'));
    mockDeleteCollection.mockRejectedValue(new TypeError('Network request failed'));
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(screen.getByTestId('add-member-error')).toHaveTextContent(
      "Hearthside didn't answer, so nothing changed. Try again. Evie's books was created and is still in your collections.",
    );
  });

  it('adds nobody when the new collection cannot be created', async () => {
    mockCreate.mockRejectedValue(new ApiError(409, 'too many', 'collections_full'));
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByRole('button', { name: "Create Evie's books" }));
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(mockAddMember).not.toHaveBeenCalled();
    expect(screen.getByTestId('add-member-error')).toHaveTextContent(
      'You have as many collections as this server allows. Delete one to make another.',
    );
  });

  it('needs a name the server takes', async () => {
    await mount();
    await openAdd();
    expect(screen.getByTestId('add-member-submit')).toBeDisabled();
    await typeName('x'.repeat(41));
    expect(screen.getByText('Use a name of up to 40 characters.')).toBeTruthy();
  });

  it.each([
    [409, "You've added the most people this server allows."],
    [400, "Hearthside didn't accept that name or those collections. Check them and try again."],
    [403, "Your server's admin doesn't let this account add people."],
    [500, "Hearthside didn't answer, so nothing changed. Try again."],
  ])('says why a %i refused the add, in the form, and signs nobody in', async (status, words) => {
    mockAddMember.mockRejectedValue(new ApiError(status, 'nope'));
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(screen.getByTestId('add-member-error')).toHaveTextContent(words);
    expect(mockAddHere).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'member_limit', "You've added the most people this server allows."],
    [
      409,
      'username_taken',
      "Hearthside couldn't make a username from that name. Try another name.",
    ],
    [400, 'invalid_name', "Hearthside didn't accept that name. Use up to 40 characters."],
    [
      400,
      'invalid_collections',
      "One of those collections can't be shared from this account any more. Check them and try again.",
    ],
    [403, 'feature_off', "Your server's admin has turned off adding people."],
    [403, 'not_allowed', "Your server's admin hasn't let this account add people."],
    [403, 'member_cannot_manage', 'Only the person who manages your account can do that.'],
  ])('reads the code of a %i %s, not only its status', async (status, code, words) => {
    mockAddMember.mockRejectedValue(new ApiError(status, 'nope', code));
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(screen.getByTestId('add-member-error')).toHaveTextContent(words);
  });

  it("says too many tries on a 429, never that the server didn't answer", async () => {
    mockAddMember.mockRejectedValue(new ApiError(429, 'too many attempts, try again later'));
    await mount();
    await openAdd();
    await typeName('Evie');
    await fireEvent.press(screen.getByTestId('add-member-submit'));
    expect(screen.getByTestId('add-member-error')).toHaveTextContent(
      'Too many tries. Wait a few minutes and try again.',
    );
  });
});
