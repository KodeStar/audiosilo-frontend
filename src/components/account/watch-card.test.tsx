import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { User } from '@/api/types';
import { NO_WATCH, type WatchState, type WatchStatus } from '@/watch/watch-model';
import { useWatchStore } from '@/watch/watch-store';

const mockRead = jest.fn();
const mockSendPair = jest.fn();
const mockLink: { kind: 'apple' | 'wear'; openInstallOnWatch?: () => Promise<void> } = {
  kind: 'apple',
};
jest.mock('@/watch/link', () => ({
  watchLink: {
    supported: true,
    get kind() {
      return mockLink.kind;
    },
    get openInstallOnWatch() {
      return mockLink.openInstallOnWatch;
    },
    read: () => mockRead(),
    subscribe: () => {},
    sendPair: (m: unknown) => mockSendPair(m),
    sendBook: jest.fn(),
    sendRemove: jest.fn(),
  },
}));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'iPhone' }));
let mockServer: { renditions?: string[] } | undefined = { renditions: ['watch'] };
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({ data: mockServer }),
}));
const mockPair = jest.fn();
jest.mock('@/api/provider', () => ({ useOptionalApi: () => ({ pair: mockPair }) }));
let mockUser: Partial<User> = { id: 7, username: 'ada' };
let mockOtherConnections: ReturnType<typeof mockConnections> = [];
function mockConnections() {
  return [
    {
      id: 'srv.7',
      serverId: 'srv',
      serverUrl: 'https://books.example',
      name: 'Hearthside',
      user: mockUser,
    },
  ];
}
jest.mock('@/stores/session', () => ({
  useSession: Object.assign(
    (select: (s: unknown) => unknown) =>
      select({ connections: [...mockConnections(), ...mockOtherConnections] }),
    { getState: () => ({ connections: [...mockConnections(), ...mockOtherConnections] }) },
  ),
  onConnectionRemoved: () => () => {},
}));

const mockOpenDownloads = jest.fn();
jest.mock('@/lib/open', () => ({ openDownloads: (c: string) => mockOpenDownloads(c) }));

/* eslint-disable import/first */
import { WatchCard } from './watch-card';
/* eslint-enable import/first */

const installed: WatchStatus = { ...NO_WATCH, paired: true, installed: true };
const here: WatchState = {
  signed_in: true,
  server_id: 'srv',
  user_id: 7,
  books: [],
  unsent_events: 0,
  couldnt_sync: 0,
};

async function mount(status: WatchStatus, pairUntil: Record<string, number> = {}) {
  mockRead.mockResolvedValue(status);
  useWatchStore.setState({ status, pairUntil });
  await render(<WatchCard connectionId="srv.7" />);
  await act(async () => {});
}

beforeEach(() => {
  mockLink.kind = 'apple';
  mockLink.openInstallOnWatch = undefined;
  mockServer = { renditions: ['watch'] };
  mockUser = { id: 7, username: 'ada' };
  mockOtherConnections = [];
  mockPair.mockReset().mockResolvedValue({ base_url: 'https://b', pairing_token: 't' });
  mockSendPair.mockReset().mockResolvedValue(undefined);
});

describe('WatchCard', () => {
  it('identifies a same-name server in its body and the watch account message', async () => {
    mockOtherConnections = [
      {
        ...mockConnections()[0],
        id: 'other.7',
        serverId: 'other',
        serverUrl: 'https://other.example',
      },
    ];
    await mount(installed);
    expect(screen.getByText(/Hearthside \(books.example\)/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Set up Apple Watch'));
    expect(mockSendPair).toHaveBeenCalledWith(
      expect.objectContaining({
        server_name: 'Hearthside (books.example)',
        server_id: 'srv',
        user_id: 7,
      }),
    );
  });

  it('is not there without a paired watch', async () => {
    await mount(NO_WATCH);
    expect(screen.queryByTestId('watch-card')).toBeNull();
  });

  it('is not there for a kid or a demo account', async () => {
    mockUser = { id: 7, member_kind: 'kid' };
    await mount(installed);
    expect(screen.queryByTestId('watch-card')).toBeNull();
    mockUser = { id: 7, is_demo: true };
    await mount(installed);
    expect(screen.queryByTestId('watch-card')).toBeNull();
  });

  it('asks to install the app first, with nothing to press', async () => {
    await mount({ ...NO_WATCH, paired: true });
    expect(screen.getByText(/Install AudioSilo on your watch/)).toBeTruthy();
    expect(screen.queryByText('Set up Apple Watch')).toBeNull();
  });

  it('sets up with a 10-minute token, then says to open the watch', async () => {
    await mount(installed);
    await act(async () => fireEvent.press(screen.getByText('Set up Apple Watch')));
    expect(mockPair).toHaveBeenCalledWith({ ttlSeconds: 600 });
    expect(mockSendPair).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Open AudioSilo on your watch/)).toBeTruthy();
    expect(screen.getByText('Send again')).toBeTruthy();
  });

  it('says a pair ran out in transit, and offers to send again', async () => {
    await mount(installed, { 'srv.7': Date.now() - 1 });
    expect(screen.getByText(/ran out before your watch took it/)).toBeTruthy();
    expect(screen.getByText('Send again')).toBeTruthy();
  });

  it('does not say everything synced while a listen could not sync', async () => {
    await mount({
      ...installed,
      state: {
        ...here,
        unsent_events: 0,
        couldnt_sync: 1,
        last_sync_at: new Date(Date.now() - 120_000).toISOString(),
      },
    });
    expect(screen.getByText(/1 listen couldn't sync/)).toBeTruthy();
    expect(screen.queryByText('Everything from your watch has synced')).toBeNull();
  });

  it('shows who, the books, what waits and the last sync once signed in here', async () => {
    await mount({
      ...installed,
      state: {
        ...here,
        unsent_events: 2,
        couldnt_sync: 1,
        last_sync_at: new Date(Date.now() - 120_000).toISOString(),
        books: [
          { library_id: 1, path: 'A/B', title: 'Ready book', state: 'ready', bytes: 1048576 },
          { library_id: 1, path: 'A/C', title: 'Busy book', state: 'downloading' },
        ],
      },
    });
    expect(screen.getByText('Signed in as ada on Hearthside')).toBeTruthy();
    expect(screen.getByText('2 listens waiting on your watch')).toBeTruthy();
    expect(screen.getByText(/1 listen couldn't sync/)).toBeTruthy();
    expect(screen.getByText(/^Last synced /)).toBeTruthy();
    expect(screen.getByText('Send again')).toBeTruthy();
  });

  it('leaves the books to Downloads, and links there', async () => {
    await mount({
      ...installed,
      state: {
        ...here,
        books: [
          { library_id: 1, path: 'A/B', title: 'Ready book', state: 'ready', bytes: 1048576 },
        ],
      },
    });
    expect(screen.queryByText('Ready book')).toBeNull();
    await act(async () => fireEvent.press(screen.getByText('Books on your watch')));
    expect(mockOpenDownloads).toHaveBeenCalledWith('srv.7');
  });

  it('has no link to Downloads before the app is on the watch', async () => {
    await mount({ ...NO_WATCH, paired: true });
    expect(screen.queryByText('Books on your watch')).toBeNull();
  });

  it('says only that it has not synced yet on a freshly signed-in watch', async () => {
    await mount({ ...installed, state: here });
    expect(screen.getByText('Not synced from your watch yet')).toBeTruthy();
    expect(screen.queryByText('Everything from your watch has synced')).toBeNull();
  });

  it('says everything has synced once a sync has happened and nothing waits', async () => {
    await mount({
      ...installed,
      state: { ...here, last_sync_at: new Date(Date.now() - 120_000).toISOString() },
    });
    expect(screen.getByText('Everything from your watch has synced')).toBeTruthy();
    expect(screen.getByText(/^Last synced /)).toBeTruthy();
    expect(screen.queryByText('Not synced from your watch yet')).toBeNull();
  });

  it('counts what waits on a watch that has not synced yet', async () => {
    await mount({ ...installed, state: { ...here, unsent_events: 2 } });
    expect(screen.getByText('2 listens waiting on your watch')).toBeTruthy();
    expect(screen.getByText('Not synced from your watch yet')).toBeTruthy();
    expect(screen.queryByText('Everything from your watch has synced')).toBeNull();
  });

  it('names another account, offering to set up here', async () => {
    await mount({ ...installed, state: { ...here, user_id: 8 } });
    expect(screen.getByText(/signed in to another account/)).toBeTruthy();
    expect(screen.getByText('Set up Apple Watch')).toBeTruthy();
  });

  it('offers nothing to send on a server without the watch rendition', async () => {
    mockServer = { renditions: [] };
    await mount(installed);
    expect(screen.getByText(/can't prepare books for a watch/)).toBeTruthy();
    expect(screen.queryByText('Set up Apple Watch')).toBeNull();
  });

  it('says a kid cannot pair if the server refuses it', async () => {
    mockPair.mockRejectedValue(new ApiError(403, 'no', 'kid_account'));
    await mount(installed);
    await act(async () => fireEvent.press(screen.getByText('Set up Apple Watch')));
    expect(screen.getByText(/A kid's account can't pair a device/)).toBeTruthy();
    expect(mockSendPair).not.toHaveBeenCalled();
  });

  it('says the watch was not reached when the link fails', async () => {
    mockSendPair.mockRejectedValue(new Error('ERR_NO_WATCH'));
    await mount(installed);
    await act(async () => fireEvent.press(screen.getByText('Set up Apple Watch')));
    expect(screen.getByText(/Couldn't reach your watch/)).toBeTruthy();
  });
});

describe('WatchCard on Android (Wear OS)', () => {
  const mockInstall = jest.fn();
  beforeEach(() => {
    mockLink.kind = 'wear';
    mockLink.openInstallOnWatch = () => mockInstall();
    mockInstall.mockReset().mockResolvedValue(undefined);
  });

  it('says your watch, never Apple Watch', async () => {
    await mount(installed);
    expect(screen.getByText('Wear OS watch')).toBeTruthy();
    expect(screen.getByText('Set up your watch')).toBeTruthy();
    expect(screen.queryByText(/Apple/)).toBeNull();
  });

  it('offers Install on watch, which opens Play there', async () => {
    await mount({ ...NO_WATCH, paired: true });
    expect(screen.getByText(/from Google Play/)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('Install on watch')));
    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Google Play opens there/)).toBeTruthy();
    expect(screen.queryByText('Set up your watch')).toBeNull();
  });

  it('says so when Play could not open on the watch', async () => {
    mockInstall.mockRejectedValue(new Error('ERR_NO_WATCH'));
    await mount({ ...NO_WATCH, paired: true });
    await act(async () => fireEvent.press(screen.getByText('Install on watch')));
    expect(screen.getByText(/Couldn't open Google Play on your watch/)).toBeTruthy();
  });

  it('does not ask for the watch app to be opened after Set up: it signs in by itself', async () => {
    await mount(installed);
    await act(async () => fireEvent.press(screen.getByText('Set up your watch')));
    expect(mockSendPair).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/signs in as soon as it gets this/)).toBeTruthy();
    expect(screen.queryByText(/Open AudioSilo/)).toBeNull();
  });

  it('is still not there for a kid or a demo account', async () => {
    mockUser = { id: 7, member_kind: 'kid' };
    await mount(installed);
    expect(screen.queryByTestId('watch-card')).toBeNull();
    mockUser = { id: 7, is_demo: true };
    await mount(installed);
    expect(screen.queryByTestId('watch-card')).toBeNull();
  });
});

it('offers no Install button on an iPhone (the Watch app installs it)', async () => {
  await mount({ ...NO_WATCH, paired: true });
  expect(screen.queryByText('Install on watch')).toBeNull();
});
