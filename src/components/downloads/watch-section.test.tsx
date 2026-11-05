import { act, fireEvent, screen } from '@testing-library/react-native';

import type { User } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';
import type { WatchState, WatchStatus } from '@/watch/watch-model';

const mockRead = jest.fn();
const mockSendBook = jest.fn();
const mockSendRemove = jest.fn();
jest.mock('@/watch/link', () => ({
  watchLink: {
    supported: true,
    read: () => mockRead(),
    subscribe: () => {},
    sendPair: async () => {},
    sendBook: (m: unknown) => mockSendBook(m),
    sendRemove: (m: unknown) => mockSendRemove(m),
  },
}));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'iPhone' }));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('@/api/hooks', () => ({ useServerInfo: () => ({ data: { renditions: ['watch'] } }) }));
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => ({ pair: async () => ({ base_url: 'https://b', pairing_token: 't' }) }),
}));
let mockParams: { watch?: string; at?: string } = {};
jest.mock('@/lib/route-params', () => ({ useRouteParams: () => mockParams }));
const mockPushInShell = jest.fn();
jest.mock('@/lib/open', () => ({
  openDownloads: jest.fn(),
  pushInShell: (h: unknown) => mockPushInShell(h),
}));
let mockLayout: 'phone' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
let mockUser: Partial<User> = { id: 7, username: 'ada' };
const connectionOf = (id: string, serverId: string, name: string, user: Partial<User>) => ({
  id,
  serverId,
  serverUrl: 'https://books.example',
  name,
  user,
});
let mockDefaultId = 'srv.7';
jest.mock('@/stores/profiles', () => ({
  useProfileConnections: () => [
    connectionOf('srv.7', 'srv', 'Hearthside', mockUser),
    connectionOf('two.9', 'two', 'Second', { id: 9, username: 'bea' }),
  ],
}));
jest.mock('@/stores/session', () => ({
  useSession: (select: (s: unknown) => unknown) => select({ defaultConnectionId: mockDefaultId }),
  onConnectionRemoved: () => () => {},
}));

/* eslint-disable import/first */
import { useWatchLedger } from '@/watch/watch-ledger';
import { useWatchStore } from '@/watch/watch-store';

import { WatchSection } from './watch-section';
/* eslint-enable import/first */

const W = 'watch-1';
const here = (books: WatchState['books'] = []): WatchState => ({
  signed_in: true,
  server_id: 'srv',
  user_id: 7,
  books,
  unsent_events: 0,
  couldnt_sync: 0,
});
const base: WatchStatus = {
  paired: true,
  installed: true,
  state: here(),
  watchId: W,
  transfers: [],
};
const NOW = Date.UTC(2026, 10, 5, 12);
const row = (p = {}) => ({
  library_id: 1,
  path: 'A/B',
  title: 'Sent book',
  sent_at: NOW - 1000,
  handed_over: true,
  ...p,
});

async function mount(status: WatchStatus, rows: object[] = [], onReveal = jest.fn()) {
  mockRead.mockResolvedValue(status);
  await act(async () => {
    useWatchStore.setState({ status, pairUntil: {} });
    useWatchLedger.setState({ ledger: { [W]: { 'srv.7': rows as never[] } } });
  });
  await mountWithPortal(<WatchSection onReveal={onReveal} />);
  await act(async () => {});
  return onReveal;
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  mockParams = {};
  mockLayout = 'desktop';
  mockDefaultId = 'srv.7';
  mockUser = { id: 7, username: 'ada' };
  mockToast.mockReset();
  mockPushInShell.mockReset();
  mockSendBook.mockReset().mockResolvedValue(undefined);
  mockSendRemove.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('WatchSection', () => {
  it('is not there without the app on a paired watch', async () => {
    await mount({ ...base, installed: false });
    expect(screen.queryByTestId('downloads-watch')).toBeNull();
    await mount({ ...base, paired: false, installed: false });
    expect(screen.queryByTestId('downloads-watch')).toBeNull();
  });

  it('is not there for a kid or a demo account', async () => {
    mockUser = { id: 7, member_kind: 'kid' };
    await mount(base);
    expect(screen.queryByTestId('downloads-watch')).toBeNull();
    mockUser = { id: 7, is_demo: true };
    await mount(base);
    expect(screen.queryByTestId('downloads-watch')).toBeNull();
  });

  it('says what to do with nothing on the watch', async () => {
    await mount(base);
    expect(screen.getByText('On your Apple Watch')).toBeTruthy();
    expect(screen.getByText(/No books on your watch yet/)).toBeTruthy();
  });

  it('shows a row the moment it is sent, in the words of each state', async () => {
    await mount(base, [row({ handed_over: false })]);
    expect(screen.getByText('Sent, not delivered yet')).toBeTruthy();
  });

  it('tells not delivered from delivered', async () => {
    const book = { type: 'book', account: 'srv.7', library_id: 1, path: 'A/B', failed: false };
    await mount({ ...base, transfers: [book as never] }, [row()]);
    expect(screen.getByText('Sent, not delivered yet')).toBeTruthy();
    await mount(base, [row()]);
    expect(screen.getByText('Delivered. Open AudioSilo on your watch.')).toBeTruthy();
  });

  it('shows the watch’s own word, and the size once ready', async () => {
    await mount({
      ...base,
      state: here([
        { library_id: 1, path: 'P', title: 'Preparing book', state: 'preparing' },
        { library_id: 1, path: 'D', title: 'Busy book', state: 'downloading' },
        { library_id: 1, path: 'R', title: 'Ready book', state: 'ready', bytes: 1048576 },
      ]),
    });
    expect(screen.getByText('Preparing on the server. This can take a few minutes.')).toBeTruthy();
    expect(screen.getByText('Downloading to your watch')).toBeTruthy();
    expect(screen.getByText('On your watch')).toBeTruthy();
    expect(screen.getByText('Hearthside · 1 MB')).toBeTruthy();
  });

  it('stops claiming progress after 7 days and offers Send again', async () => {
    await mount(base, [row({ sent_at: NOW - 7 * 24 * 60 * 60 * 1000 })]);
    expect(screen.getByText(/hasn't taken this in 7 days/)).toBeTruthy();
    await act(async () =>
      fireEvent.press(screen.getByLabelText('Send Sent book to your watch again')),
    );
    expect(mockSendBook).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'book', library_id: 1, path: 'A/B', title: 'Sent book' }),
    );
  });

  it('says it is on another account rather than showing an empty list, or that account’s books', async () => {
    await mount({
      ...base,
      state: {
        ...here([{ library_id: 1, path: 'X', title: 'Their book', state: 'ready' }]),
        user_id: 8,
      },
    });
    expect(screen.getByText(/signed in to another account/)).toBeTruthy();
    expect(screen.queryByText('Their book')).toBeNull();
    expect(screen.queryByText(/No books on your watch yet/)).toBeNull();
    await act(async () => fireEvent.press(screen.getByText('Go to your account')));
    expect(mockPushInShell).toHaveBeenCalled();
  });

  it('says a signed-out watch is not signed in here, with what was sent still shown', async () => {
    await mount(
      { ...base, state: { ...here(), signed_in: false, server_id: undefined, user_id: undefined } },
      [row()],
    );
    expect(screen.getByText(/isn't signed in to Hearthside yet/)).toBeTruthy();
    expect(screen.getByText(/It starts once your watch is signed in here/)).toBeTruthy();
  });

  it('never shows a stale watch state for an unread watch id', async () => {
    useWatchLedger.setState({ ledger: { other: { 'srv.7': [row()] as never[] } } });
    useWatchStore.setState({ status: base, pairUntil: {} });
    mockRead.mockResolvedValue(base);
    await mountWithPortal(<WatchSection onReveal={jest.fn()} />);
    await act(async () => {});
    expect(screen.queryByText('Sent book')).toBeNull();
  });

  describe('Remove', () => {
    // The phone's row action is its icon alone, so the one "Remove" is the confirm's.
    beforeEach(() => {
      mockLayout = 'phone';
    });

    const listed = here([
      { library_id: 1, path: 'A/B', title: 'Sent book', state: 'ready', bytes: 5 },
    ]);

    it('asks first, then sends the message and says removing', async () => {
      await mount({ ...base, state: listed }, [row({ seen: true })]);
      await act(async () =>
        fireEvent.press(screen.getByLabelText('Remove Sent book from your watch')),
      );
      expect(mockSendRemove).not.toHaveBeenCalled();
      expect(screen.getByText('Remove from your watch?')).toBeTruthy();
      await act(async () => fireEvent.press(screen.getByText('Remove')));
      expect(mockSendRemove).toHaveBeenCalledWith({
        v: 1,
        type: 'remove',
        server_id: 'srv',
        user_id: 7,
        library_id: 1,
        path: 'A/B',
      });
      expect(screen.getByText('Removing. Open AudioSilo on your watch to finish.')).toBeTruthy();
    });

    it('offers Remove again on a delivered row, through the confirm, and goes on removing', async () => {
      await mount({ ...base, state: listed }, [row({ seen: true, remove_at: NOW - 1000 })]);
      expect(screen.getByText('Removing. Open AudioSilo on your watch to finish.')).toBeTruthy();
      await act(async () =>
        fireEvent.press(screen.getByLabelText('Remove Sent book from your watch')),
      );
      expect(mockSendRemove).not.toHaveBeenCalled();
      expect(screen.getByText('Remove from your watch?')).toBeTruthy();
      await act(async () => fireEvent.press(screen.getByText('Remove')));
      expect(mockSendRemove).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Removing. Open AudioSilo on your watch to finish.')).toBeTruthy();
    });

    it('goes on saying removing when the link refuses the repeat', async () => {
      mockSendRemove.mockRejectedValue(new Error('ERR_NO_WATCH'));
      await mount({ ...base, state: listed }, [row({ seen: true, remove_at: NOW - 1000 })]);
      await act(async () =>
        fireEvent.press(screen.getByLabelText('Remove Sent book from your watch')),
      );
      await act(async () => fireEvent.press(screen.getByText('Remove')));
      expect(mockToast).toHaveBeenCalledWith({
        title: "Couldn't reach your watch. Nothing was sent, so try again.",
      });
      expect(screen.getByText('Removing. Open AudioSilo on your watch to finish.')).toBeTruthy();
    });

    it('sends nothing when the book has gone while the confirm was open', async () => {
      await mount({ ...base, state: listed }, [row({ seen: true, remove_at: NOW - 1000 })]);
      await act(async () =>
        fireEvent.press(screen.getByLabelText('Remove Sent book from your watch')),
      );
      await act(async () => {
        useWatchStore.setState({ status: base });
        useWatchLedger.setState({ ledger: {} });
      });
      await act(async () => fireEvent.press(screen.getByText('Remove')));
      expect(mockSendRemove).not.toHaveBeenCalled();
    });

    it('sends nothing when the confirm is cancelled', async () => {
      await mount({ ...base, state: listed }, [row({ seen: true })]);
      await act(async () =>
        fireEvent.press(screen.getByLabelText('Remove Sent book from your watch')),
      );
      await act(async () => fireEvent.press(screen.getByText('Cancel')));
      expect(mockSendRemove).not.toHaveBeenCalled();
    });

    it('can remove a book the phone never sent', async () => {
      await mount({ ...base, state: listed });
      await act(async () =>
        fireEvent.press(screen.getByLabelText('Remove Sent book from your watch')),
      );
      await act(async () => fireEvent.press(screen.getByText('Remove')));
      expect(mockSendRemove).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Removing. Open AudioSilo on your watch to finish.')).toBeTruthy();
    });

    it('keeps the row and says it has not reached a watch that is away', async () => {
      const remove = {
        type: 'remove',
        account: 'srv.7',
        library_id: 1,
        path: 'A/B',
        failed: false,
      };
      await mount({ ...base, state: listed, transfers: [remove as never] }, [
        row({ seen: true, remove_at: NOW }),
      ]);
      expect(screen.getByText('Removing once your watch is in reach')).toBeTruthy();
      expect(screen.queryByLabelText('Remove Sent book from your watch')).toBeNull();
    });

    it('says the link failed, without claiming anything', async () => {
      mockSendRemove.mockRejectedValue(new Error('ERR_NO_WATCH'));
      await mount({ ...base, state: listed }, [row({ seen: true })]);
      await act(async () =>
        fireEvent.press(screen.getByLabelText('Remove Sent book from your watch')),
      );
      await act(async () => fireEvent.press(screen.getByText('Remove')));
      expect(mockToast).toHaveBeenCalledWith({
        title: "Couldn't reach your watch. Nothing was sent, so try again.",
      });
      expect(screen.getByText('On your watch')).toBeTruthy();
    });

    it('explains a refusal, and the row can be cleared', async () => {
      await mount(
        {
          ...base,
          state: { ...here(), signed_in: false, server_id: undefined, user_id: undefined },
        },
        [row({ remove_refused: true })],
      );
      expect(screen.getByText(/Not removed: your watch isn't signed in/)).toBeTruthy();
      await act(async () => fireEvent.press(screen.getByLabelText('Stop showing Sent book here')));
      expect(screen.queryByText('Sent book')).toBeNull();
    });
  });

  describe('which connection', () => {
    it('is the default one, without a link', async () => {
      await mount(base);
      expect(screen.queryByText(/signed in to another account/)).toBeNull();
    });

    it('is the one a link names, when the person holds it', async () => {
      mockParams = { watch: 'two.9' };
      await mount(base);
      expect(screen.getByText(/signed in to another account/)).toBeTruthy();
    });

    it('ignores a link to a connection the person does not hold', async () => {
      mockParams = { watch: 'someone.else' };
      await mount(base);
      expect(screen.queryByText(/signed in to another account/)).toBeNull();
    });

    it('scrolls to the section once when a link brought the listener', async () => {
      mockParams = { watch: 'srv.7' };
      const onReveal = await mount(base);
      expect(onReveal).not.toHaveBeenCalled();
      const section = screen.getByTestId('downloads-watch');
      await act(async () =>
        fireEvent(section, 'layout', {
          nativeEvent: { layout: { x: 0, y: 420, width: 1, height: 1 } },
        }),
      );
      expect(onReveal).toHaveBeenCalledWith(420);
      await act(async () =>
        fireEvent(section, 'layout', {
          nativeEvent: { layout: { x: 0, y: 900, width: 1, height: 1 } },
        }),
      );
      expect(onReveal).toHaveBeenCalledTimes(1);
    });

    it('scrolls again for the next link, to the same connection too', async () => {
      mockParams = { watch: 'srv.7', at: '1' };
      const onReveal = await mount(base);
      const section = screen.getByTestId('downloads-watch');
      const laidOut = (y: number) =>
        fireEvent(section, 'layout', { nativeEvent: { layout: { x: 0, y, width: 1, height: 1 } } });
      await act(async () => laidOut(420));
      expect(onReveal).toHaveBeenCalledTimes(1);
      mockParams = { watch: 'srv.7', at: '2' };
      await act(async () => laidOut(421));
      expect(onReveal).toHaveBeenCalledTimes(2);
      expect(onReveal).toHaveBeenLastCalledWith(421);
    });

    it('does not scroll without a link', async () => {
      const onReveal = await mount(base);
      const section = screen.getByTestId('downloads-watch');
      await act(async () =>
        fireEvent(section, 'layout', {
          nativeEvent: { layout: { x: 0, y: 420, width: 1, height: 1 } },
        }),
      );
      expect(onReveal).not.toHaveBeenCalled();
    });
  });
});
