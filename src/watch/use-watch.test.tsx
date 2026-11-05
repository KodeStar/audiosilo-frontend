import { act, renderHook } from '@testing-library/react-native';

import type { User } from '@/api/types';

const mockSendPair = jest.fn();
const mockSendBook = jest.fn();
const mockRead = jest.fn();
let mockListener: ((s: unknown) => void) | null = null;
jest.mock('./link', () => ({
  watchLink: {
    supported: true,
    read: () => mockRead(),
    subscribe: (l: (s: unknown) => void) => {
      mockListener = l;
    },
    sendPair: (m: unknown) => mockSendPair(m),
    sendBook: (m: unknown) => mockSendBook(m),
  },
}));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'iPhone' }));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
let mockRenditions: string[] | undefined = ['watch'];
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({ data: { renditions: mockRenditions } }),
}));
const mockPair = jest.fn();
jest.mock('@/api/provider', () => ({ useOptionalApi: () => ({ pair: mockPair }) }));
let mockUser: Partial<User> = { id: 7, username: 'ada' };
jest.mock('@/stores/session', () => ({
  useSession: (select: (s: unknown) => unknown) =>
    select({ connections: [{ id: 'srv.7', serverId: 'srv', name: 'Hearthside', user: mockUser }] }),
}));

/* eslint-disable import/first */
import { useSendToWatch, useWatchStatus } from './use-watch';
import { useWatchStore } from './watch-store';
/* eslint-enable import/first */

const installed = { paired: true, installed: true, state: null };
const book = { rel_path: 'A/B', title: 'B', author: 'A' };

beforeEach(() => {
  mockRenditions = ['watch'];
  mockUser = { id: 7, username: 'ada' };
  mockRead.mockReset().mockResolvedValue(installed);
  mockPair.mockReset().mockResolvedValue({ base_url: 'https://b', pairing_token: 't' });
  mockSendPair.mockReset().mockResolvedValue(undefined);
  mockSendBook.mockReset().mockResolvedValue(undefined);
  mockToast.mockReset();
  useWatchStore.setState({ status: installed, pairUntil: {} });
});

describe('useWatchStatus', () => {
  it('reads the watch once, then follows its events', async () => {
    const { result } = await renderHook(() => useWatchStatus());
    await act(async () => {});
    expect(mockRead).toHaveBeenCalledTimes(1);
    const next = { paired: true, installed: false, state: null };
    await act(async () => mockListener?.(next));
    expect(result.current).toEqual(next);
  });
});

describe('useSendToWatch', () => {
  const mount = () => renderHook(() => useSendToWatch('srv.7', 3));

  it('is offered for a paired watch with the app on a server that serves it', async () => {
    const { result } = await mount();
    expect(result.current).not.toBeNull();
  });

  it('is not offered on a server without the watch rendition', async () => {
    mockRenditions = [];
    const { result } = await mount();
    expect(result.current).toBeNull();
  });

  it('is not offered to a kid', async () => {
    mockUser = { id: 7, member_kind: 'kid' };
    const { result } = await mount();
    expect(result.current).toBeNull();
  });

  it('says what may be left to do when it had to sign the watch in', async () => {
    const { result } = await mount();
    await act(async () => result.current!(book));
    expect(mockSendPair).toHaveBeenCalledTimes(1);
    expect(mockSendBook).toHaveBeenCalledTimes(1);
    // True whether the watch app is closed or open and already signing in: the phone can't tell yet.
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Sent to your watch',
      description: "If AudioSilo isn't open on your watch, open it to finish signing in.",
    });
  });

  it('names the book when the watch was signed in', async () => {
    const here = {
      ...installed,
      state: {
        signed_in: true,
        server_id: 'srv',
        user_id: 7,
        books: [],
        unsent_events: 0,
        couldnt_sync: 0,
      },
    };
    mockRead.mockResolvedValue(here);
    const { result } = await mount();
    await act(async () => result.current!(book));
    expect(mockSendPair).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith({ title: 'Sent to your watch', description: 'B' });
  });

  it('says the watch was not reached when the link fails, not the server', async () => {
    mockSendBook.mockRejectedValue(new Error('ERR_NO_WATCH'));
    const { result } = await mount();
    await act(async () => result.current!(book));
    expect(mockToast).toHaveBeenCalledWith({
      title: "Couldn't reach your watch. Nothing was sent, so try again.",
    });
  });

  it('says the server was not reached when the token could not be made', async () => {
    mockPair.mockRejectedValue(new Error('offline'));
    const { result } = await mount();
    await act(async () => result.current!(book));
    expect(mockSendBook).not.toHaveBeenCalled();
    expect(mockToast.mock.calls[0][0].title).toContain('Hearthside');
  });
});
