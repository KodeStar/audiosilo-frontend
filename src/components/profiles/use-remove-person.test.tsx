import { act, screen } from '@testing-library/react-native';

import type { Connection } from '@/stores/session';

jest.mock('@/api/provider', () => ({ useApiRegistry: () => ({ clients: new Map() }) }));
const mockSignOut = jest.fn(async (..._a: unknown[]) => {});
jest.mock('@/components/account/use-sign-out', () => ({
  freshAccountUser: async (u: unknown) => u,
  signOutConnection: (...a: unknown[]) => mockSignOut(...a),
}));
jest.mock('@/lib/account', () => ({
  managerName: () => null,
  needsPasswordWarning: () => false,
}));
jest.mock('@/lib/profile-pin', () => ({ clearPin: jest.fn(async () => {}) }));
const mockDeleteProfile = jest.fn();
jest.mock('@/stores/profiles', () => ({
  connectionsOfProfile: (all: Connection[], ids: string[]) => all.filter((c) => ids.includes(c.id)),
  deleteProfile: (id: string) => mockDeleteProfile(id),
  devicePeople: () => [],
}));
const mockConnections = [
  { id: 'c1', name: 'Home', user: null },
  { id: 'c2', name: 'Work', user: null },
] as unknown as Connection[];
jest.mock('@/stores/session', () => {
  const state = () => ({ connections: mockConnections, setConnectionUser: jest.fn() });
  const useSession = (selector: (s: unknown) => unknown) => selector(state());
  useSession.getState = state;
  return { useSession };
});
// Sync v2: listens this device has not yet sent, per server.
const mockUnsent = jest.fn(async (cid: string) => (cid === 'c2' ? 3 : 0));
jest.mock('@/playback/listening-outbox', () => ({
  unsentListens: (cid: string) => mockUnsent(cid),
}));

/* eslint-disable import/first */
import type { Profile } from '@/stores/profiles';
import { mountWithPortal } from '@/testing/render-overlay';

import { useRemovePerson } from './use-remove-person';
/* eslint-enable import/first */

async function mount() {
  const ref: { value: ReturnType<typeof useRemovePerson> | null } = { value: null };
  function Probe() {
    ref.value = useRemovePerson();
    return ref.value.dialog;
  }
  await act(async () => {
    await mountWithPortal(<Probe />);
  });
  return () => ref.value!;
}

const evie = { id: 'evie', name: 'Evie', connectionIds: ['c1', 'c2'] } as Profile;

describe('useRemovePerson', () => {
  it('names the servers that still have unsynced listens before removing', async () => {
    const hook = await mount();
    await act(async () => {
      await hook().request(evie, 'Evie');
    });
    expect(mockUnsent).toHaveBeenCalledWith('c1');
    expect(mockUnsent).toHaveBeenCalledWith('c2');
    expect(screen.queryByTestId('remove-person-unsynced-c1')).toBeNull();
    expect(screen.getByTestId('remove-person-unsynced-c2')).toHaveTextContent(
      "3 listens haven't synced to Work and will be lost.",
    );
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('says nothing about listens when everything synced', async () => {
    mockUnsent.mockResolvedValue(0);
    const hook = await mount();
    await act(async () => {
      await hook().request(evie, 'Evie');
    });
    expect(screen.queryByTestId('remove-person-unsynced-c2')).toBeNull();
    expect(screen.getByTestId('remove-person-confirm')).toBeTruthy();
  });
});
