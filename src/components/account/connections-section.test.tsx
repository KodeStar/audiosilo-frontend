import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));
jest.mock('@/api/provider', () => ({ useApiRegistry: () => ({ clients: new Map() }) }));
jest.mock('@/playback/store', () => ({ teardownBeforeTokenRevoke: jest.fn() }));
let mockDownloaded = 0;
jest.mock('@/downloads/store', () => ({
  downloadedCountFor: () => mockDownloaded,
  useDownloads: { getState: () => ({ entries: {} }) },
}));

let mockServed: string | null = null;
jest.mock('@/lib/base-url', () => ({
  ...jest.requireActual('@/lib/base-url'),
  servedOrigin: () => mockServed,
}));

/* eslint-disable import/first */
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';
import { mountWithPortal } from '@/testing/render-overlay';
import { expectNativeTarget } from '@/testing/touch-target';

import { ConnectionsSection, useConnectionRemoval } from './connections-section';
/* eslint-enable import/first */

beforeEach(() => {
  mockServed = null;
  mockDownloaded = 0;
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

  it('offers no other server on the player the server serves', async () => {
    mockServed = 'https://books.example';
    await render(<ConnectionsSection onRemove={jest.fn()} />);
    expect(screen.getByLabelText('Manage Hearthside')).toBeTruthy();
    expect(screen.queryByText('Add a server')).toBeNull();
  });

  it('still adds servers on a web build hosted beside its servers', async () => {
    mockServed = 'https://player.example';
    await render(<ConnectionsSection onRemove={jest.fn()} />);
    expect(screen.getByText('Add a server')).toBeTruthy();
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

// frontend#143: removing a server always asks first, and says what is lost.
describe('removing a server', () => {
  function Pane() {
    const { onRemove, dialog } = useConnectionRemoval();
    return (
      <>
        <ConnectionsSection onRemove={onRemove} />
        {dialog}
      </>
    );
  }
  const remove = jest.fn(async () => {});
  beforeEach(() => {
    remove.mockClear();
    useSession.setState({ removeConnection: remove } as never);
  });

  it('confirms first, naming the sign-in and the way back to the first step', async () => {
    await mountWithPortal(<Pane />);
    await fireEvent.press(screen.getByLabelText('Remove Hearthside'));
    expect(screen.getByText('Remove Hearthside?')).toBeTruthy();
    expect(screen.getByText(/signs this device out of Hearthside/)).toBeTruthy();
    expect(screen.getByText(/goes back to its first step/)).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(remove).not.toHaveBeenCalled();
    expect(useSession.getState().connections).toHaveLength(1);
  });

  it('names the downloads it deletes, and removes on confirm', async () => {
    mockDownloaded = 3;
    useSession.setState({
      connections: [
        ...useSession.getState().connections,
        { id: 'c2', name: 'Attic', serverUrl: 'https://attic', token: 't', user: {} as never },
      ],
    });
    await mountWithPortal(<Pane />);
    await fireEvent.press(screen.getByLabelText('Remove Hearthside'));
    expect(screen.getByText(/deletes 3 downloaded books/)).toBeTruthy();
    expect(screen.queryByText(/first step/)).toBeNull();
    await fireEvent.press(screen.getByText('Remove server'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('c1'));
  });
});
