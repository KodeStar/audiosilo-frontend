import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));
jest.mock('@/api/provider', () => ({ useApiRegistry: () => ({ clients: new Map() }) }));
jest.mock('@/playback/store', () => ({ teardownBeforeTokenRevoke: jest.fn() }));
jest.mock('@/downloads/store', () => ({
  downloadedCountFor: () => 0,
  useDownloads: { getState: () => ({ entries: {} }) },
}));

/* eslint-disable import/first */
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';
import { expectNativeTarget } from '@/testing/touch-target';

import { ConnectionsSection } from './connections-section';
/* eslint-enable import/first */

beforeEach(() => {
  jest.clearAllMocks();
  resetProfilesForTests();
  useSession.setState({
    connections: [
      {
        id: 'c1',
        name: 'Hearthside',
        serverUrl: 'https://books.example',
        token: 't',
        user: { username: 'chris' } as never,
      },
    ],
    defaultConnectionId: 'c1',
  });
});

describe('ConnectionsSection', () => {
  it("lists only the person listening's servers (Settings > Servers is theirs)", async () => {
    useSession.setState({
      connections: [
        {
          id: 'a.1',
          name: 'Hearthside',
          serverUrl: 'h',
          token: 't',
          user: { username: 'chris' } as never,
        },
        {
          id: 'b.2',
          name: "Sam's box",
          serverUrl: 's',
          token: 't',
          user: { username: 'sam' } as never,
        },
      ],
    });
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'chris', name: 'Chris', connectionIds: ['a.1'] },
        { id: 'sam', name: 'Sam', connectionIds: ['b.2'] },
      ],
      activeProfileId: 'chris',
    });
    await render(<ConnectionsSection onRemove={jest.fn()} />);
    expect(screen.getByLabelText('Manage Hearthside')).toBeTruthy();
    expect(screen.queryByLabelText("Manage Sam's box")).toBeNull();
  });

  it("opens a server's account, removes it, and adds another", async () => {
    const onRemove = jest.fn();
    await render(<ConnectionsSection onRemove={onRemove} />);
    expect(screen.getByText('chris · https://books.example')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Manage Hearthside'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/account',
      params: { connection: 'c1' },
    });
    await fireEvent.press(screen.getByLabelText('Remove Hearthside'));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
    await fireEvent.press(screen.getByText('Add a server'));
    expect(mockRouter.push).toHaveBeenCalledWith('/connect?add=1');
  });

  it('gives the remove button a 44 pt target on native', async () => {
    const prev = Platform.OS;
    try {
      Platform.OS = 'android';
      await render(<ConnectionsSection onRemove={jest.fn()} />);
      expectNativeTarget(screen.getByLabelText('Remove Hearthside'));
    } finally {
      Platform.OS = prev;
    }
  });
});
