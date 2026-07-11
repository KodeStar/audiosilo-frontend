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

  it('rejects a blank server_id instead of filing the connection under an empty id', async () => {
    await expect(
      useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: '', token: 't', user: mkUser('a') }),
    ).rejects.toThrow(/server_id/);
    // Threw before mutating state: no half-built connection under an empty id, and
    // nothing written to storage.
    expect(useSession.getState().connections).toHaveLength(0);
    expect(await AsyncStorage.getItem('audiosilo.connections')).toBeNull();
    expect(await SecureStore.getItemAsync('audiosilo.token.')).toBeNull();
  });

  it('removing the default connection falls back to another, then to unauthenticated', async () => {
    // Sign-out routes through removeConnection (after teardownBeforeTokenRevoke), not a
    // separate logout() - so this covers removing whichever connection is the default.
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 't', user: mkUser('a') });
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://b', serverId: 'srv-b', token: 't', user: mkUser('b') });
    const removeDefault = () =>
      useSession.getState().removeConnection(useSession.getState().defaultConnectionId!);
    await removeDefault(); // removes b (the default = last added)
    const s = useSession.getState();
    expect(s.connections).toHaveLength(1);
    expect(s.defaultConnectionId).toBe('srv-a'); // falls back to the remaining one
    expect(s.user?.username).toBe('a'); // mirror follows the new default
    expect(s.status).toBe('authenticated');
    await removeDefault(); // removes the last one
    expect(useSession.getState().status).toBe('unauthenticated');
  });

  describe('resetStaleStorage (split auth/cache versions)', () => {
    const CACHE_VERSION_KEY = 'audiosilo.cacheVersion';
    const CACHE_STORAGE_VERSION = 1;

    // Seed a connection + its token directly (bypassing setSession, which would stamp the
    // current versions), so a test can control exactly what versions are recorded.
    const seedConnection = async (id: string, token: string) => {
      await AsyncStorage.setItem(
        'audiosilo.connections',
        JSON.stringify([{ id, serverUrl: `https://${id}`, name: id, user: mkUser(id) }]),
      );
      await AsyncStorage.setItem('audiosilo.activeConnection', JSON.stringify(id));
      await SecureStore.setItemAsync(`audiosilo.token.${id}`, token);
    };

    it('clears old connections + scoped state once on an auth-version bump, then is a no-op', async () => {
      // Seed old-format data with NO version marker (a pre-v2 install: an auth bump).
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'old-a', token: 't', user: mkUser('a') });
      await AsyncStorage.setItem('audiosilo.downloads', JSON.stringify({ 'old-a:1:x': {} }));
      await AsyncStorage.removeItem('audiosilo.storageVersion');
      await AsyncStorage.removeItem(CACHE_VERSION_KEY);

      const res = await resetStaleStorage();
      expect(res.authReset).toBe(true);

      // Connections, their tokens, and scoped state are gone; both versions are recorded.
      expect(await AsyncStorage.getItem('audiosilo.connections')).toBeNull();
      expect(await AsyncStorage.getItem('audiosilo.downloads')).toBeNull();
      expect(await SecureStore.getItemAsync('audiosilo.token.old-a')).toBeNull();
      expect(await AsyncStorage.getItem('audiosilo.storageVersion')).not.toBeNull();
      expect(await AsyncStorage.getItem(CACHE_VERSION_KEY)).not.toBeNull();

      // A second run must not wipe freshly-paired data.
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://b', serverId: 'srv-b', token: 't', user: mkUser('b') });
      const res2 = await resetStaleStorage();
      expect(res2.authReset).toBe(false);
      expect(res2.cacheReset).toBe(false);
      expect(await AsyncStorage.getItem('audiosilo.connections')).not.toBeNull();
    });

    it('does NOT log out an existing v2 install (adopts the cache version without wiping)', async () => {
      // A pre-existing, healthy v2 install: auth version recorded, cache version never
      // written (it predates the split). Its cache + logins must survive untouched.
      await seedConnection('srv-a', 'tokA');
      await AsyncStorage.setItem('audiosilo.storageVersion', JSON.stringify(2));
      await AsyncStorage.setItem('audiosilo.downloads', JSON.stringify({ 'srv-a:1:x': {} }));
      await AsyncStorage.removeItem(CACHE_VERSION_KEY);

      const res = await resetStaleStorage();

      expect(res.authReset).toBe(false);
      expect(res.cacheReset).toBe(false);
      // Connection + token survive.
      expect(await AsyncStorage.getItem('audiosilo.connections')).not.toBeNull();
      expect(await SecureStore.getItemAsync('audiosilo.token.srv-a')).toBe('tokA');
      // Scoped cache survives (adopted, not wiped).
      expect(await AsyncStorage.getItem('audiosilo.downloads')).not.toBeNull();
      // Cache version now stamped so future launches are no-ops.
      expect(JSON.parse((await AsyncStorage.getItem(CACHE_VERSION_KEY))!)).toBe(
        CACHE_STORAGE_VERSION,
      );
    });

    it('a cache-version bump wipes the scoped cache but keeps every login', async () => {
      // Auth is current (v2), but the recorded cache version differs - a cache-schema bump.
      await seedConnection('srv-a', 'tokA');
      await AsyncStorage.setItem('audiosilo.storageVersion', JSON.stringify(2));
      await AsyncStorage.setItem(CACHE_VERSION_KEY, JSON.stringify(CACHE_STORAGE_VERSION - 1));
      await AsyncStorage.setItem('audiosilo.downloads', JSON.stringify({ 'srv-a:1:x': {} }));

      const res = await resetStaleStorage();

      expect(res.cacheReset).toBe(true);
      expect(res.authReset).toBe(false);
      // Scoped cache gone.
      expect(await AsyncStorage.getItem('audiosilo.downloads')).toBeNull();
      // But the connection + its token survive - nobody is logged out.
      expect(await AsyncStorage.getItem('audiosilo.connections')).not.toBeNull();
      expect(await SecureStore.getItemAsync('audiosilo.token.srv-a')).toBe('tokA');
      // Cache version advanced.
      expect(JSON.parse((await AsyncStorage.getItem(CACHE_VERSION_KEY))!)).toBe(
        CACHE_STORAGE_VERSION,
      );
    });

    it('an auth-version bump wipes connections + tokens (regression guard)', async () => {
      // Recorded auth version differs from the current one - the identity scheme changed.
      await seedConnection('srv-a', 'tokA');
      await AsyncStorage.setItem('audiosilo.storageVersion', JSON.stringify(1));
      await AsyncStorage.setItem(CACHE_VERSION_KEY, JSON.stringify(CACHE_STORAGE_VERSION));

      const res = await resetStaleStorage();

      expect(res.authReset).toBe(true);
      expect(await AsyncStorage.getItem('audiosilo.connections')).toBeNull();
      expect(await SecureStore.getItemAsync('audiosilo.token.srv-a')).toBeNull();
      expect(JSON.parse((await AsyncStorage.getItem('audiosilo.storageVersion'))!)).toBe(2);
    });

    it('a brand-new install records both versions without throwing', async () => {
      // Nothing pre-seeded: the wipes are harmless no-ops, versions get recorded.
      const res = await resetStaleStorage();

      expect(res.authReset).toBe(true); // no auth version recorded yet → auth axis stamps it
      expect(await AsyncStorage.getItem('audiosilo.connections')).toBeNull();
      expect(JSON.parse((await AsyncStorage.getItem('audiosilo.storageVersion'))!)).toBe(2);
      expect(JSON.parse((await AsyncStorage.getItem(CACHE_VERSION_KEY))!)).toBe(
        CACHE_STORAGE_VERSION,
      );
    });
  });

  describe('needsReconnect flag (dead-token / server-reset)', () => {
    const addA = () =>
      useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 't', user: mkUser('a') });

    it('marks a connection without removing it or dropping its token', async () => {
      await addA();
      useSession.getState().markNeedsReconnect('srv-a', 'auth');
      const c = useSession.getState().connections.find((x) => x.id === 'srv-a')!;
      expect(c.needsReconnect).toBe('auth');
      expect(c.token).toBe('t'); // token intact - only a re-pair replaces it
      expect(useSession.getState().connections).toHaveLength(1);
    });

    it('is a no-op for an unknown connection and idempotent for the same reason', async () => {
      await addA();
      useSession.getState().markNeedsReconnect('nope', 'auth'); // unknown → ignored
      expect(useSession.getState().connections.find((x) => x.id === 'nope')).toBeUndefined();
      useSession.getState().markNeedsReconnect('srv-a', 'auth');
      const ref1 = useSession.getState().connections;
      useSession.getState().markNeedsReconnect('srv-a', 'auth'); // same reason → no state churn
      expect(useSession.getState().connections).toBe(ref1); // same array reference (no set)
    });

    it('clearNeedsReconnect clears the flag and no-ops when unset', async () => {
      await addA();
      const ref0 = useSession.getState().connections;
      useSession.getState().clearNeedsReconnect('srv-a'); // nothing set → no set()
      expect(useSession.getState().connections).toBe(ref0);
      useSession.getState().markNeedsReconnect('srv-a', 'server-reset');
      useSession.getState().clearNeedsReconnect('srv-a');
      expect(
        useSession.getState().connections.find((x) => x.id === 'srv-a')!.needsReconnect,
      ).toBeUndefined();
    });

    it('re-pairing (setSession) clears the flag, and it never persists across a hydrate', async () => {
      await addA();
      useSession.getState().markNeedsReconnect('srv-a', 'auth');
      // Re-pair the same server (a successful reconnect).
      await useSession.getState().setSession({
        serverUrl: 'https://a',
        serverId: 'srv-a',
        token: 't2',
        user: mkUser('a'),
      });
      expect(
        useSession.getState().connections.find((x) => x.id === 'srv-a')!.needsReconnect,
      ).toBeUndefined();

      // Flag again, then hydrate from storage: the in-memory flag must not survive (it's
      // recomputed from the next failure, never persisted).
      useSession.getState().markNeedsReconnect('srv-a', 'auth');
      reset();
      await useSession.getState().hydrate();
      expect(
        useSession.getState().connections.find((x) => x.id === 'srv-a')!.needsReconnect,
      ).toBeUndefined();
    });

    it('setSession records the server in the durable known-servers list (no token)', async () => {
      await addA();
      const raw = await AsyncStorage.getItem('audiosilo.knownServers');
      expect(raw).not.toBeNull();
      const known = JSON.parse(raw!);
      expect(known).toEqual([{ serverUrl: 'https://a', name: 'a', serverId: 'srv-a' }]);
      expect(raw).not.toMatch(/token/i);
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
