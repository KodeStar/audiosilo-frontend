import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import type { User } from '@/api/types';
import { onConnectionRemoved, resetStaleStorage, useSession } from '@/stores/session';

const mkUser = (name: string): User => ({
  id: 1,
  username: name,
  role: 'user',
  disabled: false,
  has_password: false,
  has_recovery: false,
});

const reset = () =>
  useSession.setState({
    status: 'loading',
    connections: [],
    defaultConnectionId: null,
    pendingServerUrl: null,
    user: null,
  });

// Exercises the real session store over the in-memory storage mocks (jest.setup).
describe('session store (multi-connection)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    reset();
  });

  it('hydrates to unauthenticated when nothing is stored', async () => {
    await useSession.getState().hydrate();
    expect(useSession.getState().status).toBe('unauthenticated');
  });

  it('fails safe (unauthenticated + hydrateFailed) instead of hanging when a keychain read throws', async () => {
    // A native SecureStore/keychain read rejecting used to leave status stuck on
    // 'loading' forever, deadlocking whenSessionReady() and every read that awaits it.
    // A persisted connection makes hydrate read the keychain (for its token).
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 't', user: mkUser('a') });
    reset();
    // Swap getItemAsync manually (not jest.spyOn - its mockRestore doesn't reliably
    // clear a queued rejection under the expo-secure-store mock, leaking into later tests).
    const store = SecureStore as unknown as { getItemAsync: (k: string) => Promise<string | null> };
    const original = store.getItemAsync;
    store.getItemAsync = () => Promise.reject(new Error('keychain locked'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(useSession.getState().hydrate()).resolves.toBeUndefined();
      expect(useSession.getState().status).toBe('unauthenticated'); // not stuck on 'loading'
    } finally {
      store.getItemAsync = original;
      warn.mockRestore();
    }
  });

  it('adds connections and restores them (with tokens) on a fresh hydrate', async () => {
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 'tokA', user: mkUser('a') });
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://b', serverId: 'srv-b', token: 'tokB', user: mkUser('b') });
    expect(useSession.getState().connections).toHaveLength(2);
    expect(useSession.getState().defaultConnectionId).toBe('srv-b'); // last added is the default
    expect(useSession.getState().user?.username).toBe('b'); // mirror follows the default

    reset();
    await useSession.getState().hydrate();
    const s = useSession.getState();
    expect(s.status).toBe('authenticated');
    expect(s.connections.map((c) => c.id).sort()).toEqual(['srv-a', 'srv-b']);
    expect(s.connections.every((c) => c.token)).toBe(true);
  });

  it('re-adding the same server (same serverId) updates rather than duplicates, even at a new URL', async () => {
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 't1', user: mkUser('a') });
    // Same server identity, a different URL (e.g. an https upgrade) + a new token.
    await useSession.getState().setSession({
      serverUrl: 'https://a.example',
      serverId: 'srv-a',
      token: 't2',
      user: mkUser('a2'),
    });
    const s = useSession.getState();
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0].token).toBe('t2');
    expect(s.connections[0].serverUrl).toBe('https://a.example'); // URL refreshed, no orphan
  });

  it('logout removes the default connection, falling back to another', async () => {
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 't', user: mkUser('a') });
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://b', serverId: 'srv-b', token: 't', user: mkUser('b') });
    await useSession.getState().logout(); // removes b (the default = last added)
    const s = useSession.getState();
    expect(s.connections).toHaveLength(1);
    expect(s.defaultConnectionId).toBe('srv-a'); // falls back to the remaining one
    expect(s.user?.username).toBe('a'); // mirror follows the new default
    expect(s.status).toBe('authenticated');
    await useSession.getState().logout(); // removes the last one
    expect(useSession.getState().status).toBe('unauthenticated');
  });

  describe('resetStaleStorage (clean slate on a storage-version bump)', () => {
    it('clears old connections + scoped state once, then is a no-op', async () => {
      // Seed old-format data with NO version marker (a pre-upgrade install).
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'old-a', token: 't', user: mkUser('a') });
      await AsyncStorage.setItem('audiosilo.downloads', JSON.stringify({ 'old-a:1:x': {} }));
      await AsyncStorage.removeItem('audiosilo.storageVersion');

      await resetStaleStorage();

      // Connections, their tokens, and scoped state are gone; the version is recorded.
      expect(await AsyncStorage.getItem('audiosilo.connections')).toBeNull();
      expect(await AsyncStorage.getItem('audiosilo.downloads')).toBeNull();
      expect(await SecureStore.getItemAsync('audiosilo.token.old-a')).toBeNull();
      const version = await AsyncStorage.getItem('audiosilo.storageVersion');
      expect(version).not.toBeNull();

      // A second run must not wipe freshly-paired data.
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://b', serverId: 'srv-b', token: 't', user: mkUser('b') });
      await resetStaleStorage();
      expect(await AsyncStorage.getItem('audiosilo.connections')).not.toBeNull();
    });
  });

  // Owners of connection-scoped state (downloads, progress mirror/queue, query cache,
  // scroll memory) register a purge here; removeConnection must fan out to all of them.
  describe('onConnectionRemoved cleanups', () => {
    const unsubs: (() => void)[] = [];
    afterEach(() => {
      while (unsubs.length) unsubs.pop()!(); // unregister so cleanups don't leak across tests
    });

    it('runs every registered cleanup with the removed connection id', async () => {
      const id = await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 't', user: mkUser('a') });
      const cleanup = jest.fn();
      unsubs.push(onConnectionRemoved(cleanup));

      await useSession.getState().removeConnection(id);

      expect(cleanup).toHaveBeenCalledWith(id);
      expect(useSession.getState().connections).toHaveLength(0);
    });

    it('does not run a cleanup after it has been unsubscribed', async () => {
      const cleanup = jest.fn();
      onConnectionRemoved(cleanup)(); // register then immediately unsubscribe
      const id = await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 't', user: mkUser('a') });

      await useSession.getState().removeConnection(id);

      expect(cleanup).not.toHaveBeenCalled();
    });

    it('a rejecting cleanup neither blocks removal nor the other cleanups', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const id = await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 't', user: mkUser('a') });
      const failing = jest.fn().mockRejectedValue(new Error('cleanup boom'));
      const other = jest.fn();
      unsubs.push(onConnectionRemoved(failing));
      unsubs.push(onConnectionRemoved(other));

      // Removal resolves despite a rejecting cleanup (they run via Promise.allSettled).
      await expect(useSession.getState().removeConnection(id)).resolves.toBeUndefined();

      expect(failing).toHaveBeenCalledWith(id);
      expect(other).toHaveBeenCalledWith(id); // a sibling cleanup still ran
      expect(useSession.getState().connections).toHaveLength(0); // the connection is gone
      expect(warn).toHaveBeenCalled(); // the rejection was warned, not thrown
      warn.mockRestore();
    });
  });
});
