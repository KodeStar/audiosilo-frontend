import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { User } from '@/api/types';
import type { WatchState, WatchStatus } from '@/watch/watch-model';
import { useWatchStore } from '@/watch/watch-store';

const mockRead = jest.fn();
const mockSendPair = jest.fn();
jest.mock('@/watch/link', () => ({
  watchLink: {
    supported: true,
    read: () => mockRead(),
    subscribe: () => {},
    sendPair: (m: unknown) => mockSendPair(m),
    sendBook: jest.fn(),
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
jest.mock('@/stores/session', () => ({
  useSession: (select: (s: unknown) => unknown) =>
    select({
      connections: [
        {
          id: 'srv.7',
          serverId: 'srv',
          serverUrl: 'https://books.example',
          name: 'Hearthside',
          user: mockUser,
        },
      ],
    }),
}));

/* eslint-disable import/first */
import { AppleWatchCard } from './apple-watch-card';
/* eslint-enable import/first */

const installed: WatchStatus = { paired: true, installed: true, state: null };
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
  await render(<AppleWatchCard connectionId="srv.7" />);
  await act(async () => {});
}

beforeEach(() => {
  mockServer = { renditions: ['watch'] };
  mockUser = { id: 7, username: 'ada' };
  mockPair.mockReset().mockResolvedValue({ base_url: 'https://b', pairing_token: 't' });
  mockSendPair.mockReset().mockResolvedValue(undefined);
});

describe('AppleWatchCard', () => {
  it('is not there without a paired watch', async () => {
    await mount({ paired: false, installed: false, state: null });
    expect(screen.queryByTestId('apple-watch-card')).toBeNull();
  });

  it('is not there for a kid or a demo account', async () => {
    mockUser = { id: 7, member_kind: 'kid' };
    await mount(installed);
    expect(screen.queryByTestId('apple-watch-card')).toBeNull();
    mockUser = { id: 7, is_demo: true };
    await mount(installed);
    expect(screen.queryByTestId('apple-watch-card')).toBeNull();
  });

  it('asks to install the app first, with nothing to press', async () => {
    await mount({ paired: true, installed: false, state: null });
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
    expect(screen.getByText('Ready book')).toBeTruthy();
    expect(screen.getByText('Downloading')).toBeTruthy();
    expect(screen.getByText('Send again')).toBeTruthy();
  });

  it('says only that it has not synced yet on a freshly signed-in watch', async () => {
    await mount({ ...installed, state: here });
    expect(screen.getByText(/No books on your watch yet/)).toBeTruthy();
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
