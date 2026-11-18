import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { User } from '@/api/types';
import { tabChannel } from '@/lib/tab-channel';
import { fakeBrowser } from '@/testing/fake-browser';

/**
 * The web player's tabs share the stored connections and tokens, each holding its own list
 * in memory. Two tabs here are two copies of the session store (`jest.isolateModules`) over
 * the same storage, told of each other's removals on a fake browser's channel.
 */

type Session = typeof import('@/stores/session');

const REMOVAL_CHANNEL = 'audiosilo-connection-removed';

function openTab(browser: ReturnType<typeof fakeBrowser>): Session {
  let tab!: Session;
  jest.isolateModules(() => {
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      __esModule: true,
      default: AsyncStorage,
    }));
    jest.doMock('expo-secure-store', () => SecureStore);
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    tab = require('@/stores/session') as Session;
  });
  // The channel is the web's: made as on the web, the rest of the store as on the device
  // the tests run as (its tokens in the secure store both tabs share).
  const os = Platform.OS;
  Platform.OS = 'web';
  try {
    tab.setRemovalChannelForTests(tabChannel(REMOVAL_CHANNEL, browser.tab()));
  } finally {
    Platform.OS = os;
  }
  return tab;
}

const mkUser = (id: number, name: string): User => ({
  id,
  username: name,
  role: 'user',
  disabled: false,
  has_password: false,
  has_recovery: false,
});

const settle = () => new Promise((r) => setTimeout(r, 10));

/** Tabs A and B, both signed in to `alex` (made the default) and `sam`. */
async function twoTabs(browser = fakeBrowser()) {
  const b = openTab(browser);
  await b.useSession.getState().hydrate();
  const sam = await b.useSession
    .getState()
    .setSession({ serverUrl: 'https://s', serverId: 'srv', token: 'ts', user: mkUser(2, 'sam') });
  const alex = await b.useSession
    .getState()
    .setSession({ serverUrl: 'https://s', serverId: 'srv', token: 'ta', user: mkUser(1, 'alex') });
  const a = openTab(browser);
  await a.useSession.getState().hydrate();
  expect(a.useSession.getState().defaultConnectionId).toBe(alex);
  return { a, b, alex, sam, browser };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  for (const id of ['srv.1', 'srv.2']) await SecureStore.deleteItemAsync(`audiosilo.token.${id}`);
});

describe('a connection removed in another tab (web)', () => {
  it('is forgotten here too: the list, the default, and every removal cleanup', async () => {
    const { a, b, alex, sam } = await twoTabs();
    const order: string[] = [];
    a.onConnectionRemovedInOtherTab((id) => void order.push(`step ${id}`));
    a.onConnectionRemoved((id) => void order.push(`cleanup ${id}`));
    await b.useSession.getState().removeConnection(alex);
    await settle();
    const s = a.useSession.getState();
    expect(s.connections.map((c) => c.id)).toEqual([sam]);
    // The screens follow the default the removing tab moved to.
    expect(s.defaultConnectionId).toBe(sam);
    expect(s.user?.username).toBe('sam');
    // The player stops before the purges run (`removed-in-other-tab.ts`).
    expect(order).toEqual([`step ${alex}`, `cleanup ${alex}`]);
  });

  it('the last connection: this tab is signed out too', async () => {
    const { a, b, alex, sam } = await twoTabs();
    await b.useSession.getState().removeConnection(sam);
    await b.useSession.getState().removeConnection(alex);
    await settle();
    expect(a.useSession.getState().connections).toEqual([]);
    expect(a.useSession.getState().status).toBe('unauthenticated');
  });

  it('is not forgotten here once signed in again before the word arrived', async () => {
    const { a, b, alex, browser } = await twoTabs();
    const cleanup = jest.fn();
    a.onConnectionRemoved(cleanup);
    const release = browser.hold();
    await b.useSession.getState().removeConnection(alex);
    await b.useSession.getState().setSession({
      serverUrl: 'https://s',
      serverId: 'srv',
      token: 'ta2',
      user: mkUser(1, 'alex'),
    });
    release();
    await settle();
    expect(a.useSession.getState().connections.map((c) => c.id)).toContain(alex);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('the removing tab runs its own cleanups once, not again on its own word', async () => {
    const { b, alex } = await twoTabs();
    const cleanup = jest.fn();
    b.onConnectionRemoved(cleanup);
    await b.useSession.getState().removeConnection(alex);
    await settle();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
