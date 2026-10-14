import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { sessionReady } from '@/api/connection-clients';
import type { User } from '@/api/types';
import {
  hasExistingInstall,
  LOCKED_RETRY_MS,
  onConnectionRemoved,
  onConnectionReplaced,
  resetStaleStorage,
  sessionHydrateFailed,
  useSession,
} from '@/stores/session';

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

  describe('a hydrate that failed (a token read that threw)', () => {
    const store = SecureStore as unknown as {
      getItemAsync: (k: string) => Promise<string | null>;
    };
    let original: typeof store.getItemAsync;
    let onAppState: ((s: AppStateStatus) => void) | null = null;

    beforeEach(async () => {
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 'tA', user: mkUser('a') });
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://b', serverId: 'srv-b', token: 'tB', user: mkUser('b') });
      reset();
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(AppState, 'addEventListener').mockImplementation(((
        _type: string,
        handler: (s: AppStateStatus) => void,
      ) => {
        onAppState = handler;
        return { remove: () => (onAppState = null) };
      }) as unknown as typeof AppState.addEventListener);
      original = store.getItemAsync;
      store.getItemAsync = () => Promise.reject(new Error('keychain unreadable'));
      await useSession.getState().hydrate();
      store.getItemAsync = original; // readable from here on
    });

    afterEach(async () => {
      store.getItemAsync = original;
      await useSession.getState().hydrate(); // a clean end for the next test
      jest.restoreAllMocks();
    });

    it('loads the persisted servers again when the app next comes to the front', async () => {
      expect(useSession.getState().status).toBe('unauthenticated');
      expect(sessionHydrateFailed()).toBe(true);
      onAppState?.('active');
      await new Promise((r) => setTimeout(r, 0));
      const s = useSession.getState();
      expect(s.status).toBe('authenticated');
      expect(s.connections.map((c) => c.id).sort()).toEqual(['srv-a.1', 'srv-b.1']);
      expect(sessionHydrateFailed()).toBe(false);
    });

    it('a sign-in meanwhile keeps the servers that never loaded', async () => {
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://c', serverId: 'srv-c', token: 'tC', user: mkUser('c') });
      reset();
      await useSession.getState().hydrate();
      expect(
        useSession
          .getState()
          .connections.map((c) => c.id)
          .sort(),
      ).toEqual(['srv-a.1', 'srv-b.1', 'srv-c.1']);
    });

    it('is not ready for the offline replay until a read succeeds (it would drop every save)', async () => {
      expect(sessionReady()).toBe(false);
      await useSession.getState().hydrate();
      expect(sessionReady()).toBe(true);
    });

    it('a sign-in while the stored servers still cannot be read settles the session', async () => {
      store.getItemAsync = () => Promise.reject(new Error('unreadable'));
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://c', serverId: 'srv-c', token: 'tC', user: mkUser('c') });
      expect(useSession.getState().connections.map((c) => c.id)).toEqual(['srv-c.1']);
      expect(sessionHydrateFailed()).toBe(false);
      expect(onAppState).toBeNull();
    });
  });

  describe('a token read the locked phone refused (iOS: a CarPlay launch)', () => {
    const store = SecureStore as unknown as {
      getItemAsync: (k: string) => Promise<string | null>;
    };
    let original: typeof store.getItemAsync;
    const prevOS = Platform.OS;

    beforeEach(async () => {
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 'tA', user: mkUser('a') });
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://b', serverId: 'srv-b', token: 'tB', user: mkUser('b') });
      reset();
      Platform.OS = 'ios';
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.useFakeTimers();
      original = store.getItemAsync;
      // expo-secure-store's message for errSecInteractionNotAllowed.
      store.getItemAsync = () =>
        Promise.reject(
          new Error(
            "Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: User interaction is not allowed.",
          ),
        );
    });

    afterEach(async () => {
      store.getItemAsync = original;
      await useSession.getState().hydrate(); // a clean end for the next test
      jest.useRealTimers();
      Platform.OS = prevOS;
      jest.restoreAllMocks();
    });

    it('stays loading (never the connect screen) and reads them once the phone is unlocked', async () => {
      await useSession.getState().hydrate();
      expect(useSession.getState().status).toBe('loading');
      expect(sessionHydrateFailed()).toBe(true);
      expect(sessionReady()).toBe(false);

      // Still locked at the next try.
      await jest.advanceTimersByTimeAsync(LOCKED_RETRY_MS);
      expect(useSession.getState().status).toBe('loading');

      store.getItemAsync = original; // unlocked
      await jest.advanceTimersByTimeAsync(LOCKED_RETRY_MS);
      const s = useSession.getState();
      expect(s.status).toBe('authenticated');
      expect(s.connections.map((c) => c.id).sort()).toEqual(['srv-a.1', 'srv-b.1']);
      expect(sessionHydrateFailed()).toBe(false);
      expect(sessionReady()).toBe(true);
      expect(console.warn).toHaveBeenCalledTimes(1); // once for the streak, not every try
    });

    it('fails safe elsewhere: the same error on Android is not a locked phone', async () => {
      Platform.OS = 'android';
      await useSession.getState().hydrate();
      expect(useSession.getState().status).toBe('unauthenticated');
      expect(sessionHydrateFailed()).toBe(true);
    });
  });

  it('adds connections and restores them (with tokens) on a fresh hydrate', async () => {
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 'tokA', user: mkUser('a') });
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://b', serverId: 'srv-b', token: 'tokB', user: mkUser('b') });
    expect(useSession.getState().connections).toHaveLength(2);
    expect(useSession.getState().defaultConnectionId).toBe('srv-b.1'); // last added is the default
    expect(useSession.getState().user?.username).toBe('b'); // mirror follows the default

    reset();
    await useSession.getState().hydrate();
    const s = useSession.getState();
    expect(s.status).toBe('authenticated');
    expect(s.connections.map((c) => c.id).sort()).toEqual(['srv-a.1', 'srv-b.1']);
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
    expect(s.defaultConnectionId).toBe('srv-a.1'); // falls back to the remaining one
    expect(s.user?.username).toBe('a'); // mirror follows the new default
    expect(s.status).toBe('authenticated');
    await removeDefault(); // removes the last one
    expect(useSession.getState().status).toBe('unauthenticated');
  });

  describe('hasExistingInstall (the theme default signal)', () => {
    it('is false for a fresh install, even after resetStaleStorage wrote its version keys', async () => {
      expect(await hasExistingInstall()).toBe(false);
      await resetStaleStorage();
      expect(await hasExistingInstall()).toBe(false);
      await AsyncStorage.setItem('audiosilo.connections', JSON.stringify([]));
      expect(await hasExistingInstall()).toBe(false);
    });

    it('is true with a persisted connection', async () => {
      await AsyncStorage.setItem('audiosilo.connections', JSON.stringify([{ id: 's1' }]));
      expect(await hasExistingInstall()).toBe(true);
    });

    it('is true with only a remembered server (signed out of everything)', async () => {
      await AsyncStorage.setItem(
        'audiosilo.knownServers',
        JSON.stringify([{ serverUrl: 'https://a', name: 'A', serverId: 's1' }]),
      );
      expect(await hasExistingInstall()).toBe(true);
    });

    it('is true with a pre-multi-server session', async () => {
      await AsyncStorage.setItem('audiosilo.serverUrl', JSON.stringify('https://a'));
      expect(await hasExistingInstall()).toBe(true);
    });
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
      await AsyncStorage.setItem('audiosilo.offlineServers', JSON.stringify({ 'old-a': {} }));
      await AsyncStorage.removeItem('audiosilo.storageVersion');
      await AsyncStorage.removeItem(CACHE_VERSION_KEY);

      const res = await resetStaleStorage();
      expect(res.authReset).toBe(true);

      // Connections, their tokens, and scoped state are gone; both versions are recorded.
      expect(await AsyncStorage.getItem('audiosilo.connections')).toBeNull();
      expect(await AsyncStorage.getItem('audiosilo.downloads')).toBeNull();
      expect(await AsyncStorage.getItem('audiosilo.offlineServers')).toBeNull();
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
      await AsyncStorage.setItem('audiosilo.offlineServers', JSON.stringify({ 'srv-a': {} }));

      const res = await resetStaleStorage();

      expect(res.cacheReset).toBe(true);
      expect(res.authReset).toBe(false);
      // Scoped cache gone.
      expect(await AsyncStorage.getItem('audiosilo.downloads')).toBeNull();
      expect(await AsyncStorage.getItem('audiosilo.offlineServers')).toBeNull();
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
      useSession.getState().markNeedsReconnect('srv-a.1', 'auth');
      const c = useSession.getState().connections.find((x) => x.id === 'srv-a.1')!;
      expect(c.needsReconnect).toBe('auth');
      expect(c.token).toBe('t'); // token intact - only a re-pair replaces it
      expect(useSession.getState().connections).toHaveLength(1);
    });

    it('is a no-op for an unknown connection and idempotent for the same reason', async () => {
      await addA();
      useSession.getState().markNeedsReconnect('nope', 'auth'); // unknown → ignored
      expect(useSession.getState().connections.find((x) => x.id === 'nope')).toBeUndefined();
      useSession.getState().markNeedsReconnect('srv-a.1', 'auth');
      const ref1 = useSession.getState().connections;
      useSession.getState().markNeedsReconnect('srv-a.1', 'auth'); // same reason → no state churn
      expect(useSession.getState().connections).toBe(ref1); // same array reference (no set)
    });

    it('never downgrades server-reset to auth, but upgrades auth to server-reset', async () => {
      await addA();
      // server-reset is strictly more informative than the frequent authed-401 'auth'; an
      // 'auth' mark must not clobber it.
      useSession.getState().markNeedsReconnect('srv-a.1', 'server-reset');
      useSession.getState().markNeedsReconnect('srv-a.1', 'auth');
      expect(
        useSession.getState().connections.find((x) => x.id === 'srv-a.1')!.needsReconnect,
      ).toBe('server-reset');
      // The reverse (auth → server-reset) is a valid upgrade.
      useSession.getState().clearNeedsReconnect('srv-a.1');
      useSession.getState().markNeedsReconnect('srv-a.1', 'auth');
      useSession.getState().markNeedsReconnect('srv-a.1', 'server-reset');
      expect(
        useSession.getState().connections.find((x) => x.id === 'srv-a.1')!.needsReconnect,
      ).toBe('server-reset');
    });

    it('clearNeedsReconnect clears the flag and no-ops when unset', async () => {
      await addA();
      const ref0 = useSession.getState().connections;
      useSession.getState().clearNeedsReconnect('srv-a.1'); // nothing set → no set()
      expect(useSession.getState().connections).toBe(ref0);
      useSession.getState().markNeedsReconnect('srv-a.1', 'server-reset');
      useSession.getState().clearNeedsReconnect('srv-a.1');
      expect(
        useSession.getState().connections.find((x) => x.id === 'srv-a.1')!.needsReconnect,
      ).toBeUndefined();
    });

    it('re-pairing (setSession) clears the flag, and it never persists across a hydrate', async () => {
      await addA();
      useSession.getState().markNeedsReconnect('srv-a.1', 'auth');
      // Re-pair the same server (a successful reconnect).
      await useSession.getState().setSession({
        serverUrl: 'https://a',
        serverId: 'srv-a',
        token: 't2',
        user: mkUser('a'),
      });
      expect(
        useSession.getState().connections.find((x) => x.id === 'srv-a.1')!.needsReconnect,
      ).toBeUndefined();

      // Flag again, then hydrate from storage: the in-memory flag must not survive (it's
      // recomputed from the next failure, never persisted).
      useSession.getState().markNeedsReconnect('srv-a.1', 'auth');
      reset();
      await useSession.getState().hydrate();
      expect(
        useSession.getState().connections.find((x) => x.id === 'srv-a.1')!.needsReconnect,
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

  // A rebuilt server mints a new server_id at the same URL, so re-pairing must retire the
  // stale identity instead of leaving a zombie the reconnect banner keeps re-flagging.
  describe('re-pairing a reset server (same URL, new id)', () => {
    const unsubs: (() => void)[] = [];
    afterEach(() => {
      while (unsubs.length) unsubs.pop()!();
    });

    it('replaces a stale same-URL connection: drops its token + scoped state, keeps only the new id', async () => {
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 't1', user: mkUser('a') });
      useSession.getState().markNeedsReconnect('srv-a.1', 'server-reset');
      const cleanup = jest.fn();
      unsubs.push(onConnectionRemoved(cleanup));

      // Re-pair the SAME URL under a fresh server_id (the rebuilt server), as the person
      // whose identity it was (`retire`, named by the connect flow).
      await useSession.getState().setSession({
        serverUrl: 'https://a',
        serverId: 'srv-b',
        token: 't2',
        user: mkUser('b'),
        retire: ['srv-a.1'],
      });

      const s = useSession.getState();
      expect(s.connections).toHaveLength(1);
      expect(s.connections[0].id).toBe('srv-b.1');
      expect(s.connections[0].needsReconnect).toBeUndefined(); // fresh identity, no stale flag
      // The stale identity's scoped state is purged and its dead token deleted.
      expect(cleanup).toHaveBeenCalledWith('srv-a.1');
      expect(await SecureStore.getItemAsync('audiosilo.token.srv-a.1')).toBeNull();
      expect(await SecureStore.getItemAsync('audiosilo.token.srv-b.1')).toBe('t2');
      // Persisted connections carry only the new id.
      const persisted = JSON.parse((await AsyncStorage.getItem('audiosilo.connections'))!);
      expect(persisted.map((c: { id: string }) => c.id)).toEqual(['srv-b.1']);
    });

    it('names and matches servers with the shared URL helpers (hostOf, sameUrl)', async () => {
      await useSession.getState().setSession({
        serverUrl: 'HTTPS://Books.example.com/',
        serverId: 'srv-a',
        token: 't1',
        user: mkUser('a'),
      });
      // hostOf: the scheme is dropped whatever its case.
      expect(useSession.getState().connections[0].name).toBe('Books.example.com');
      // sameUrl: a trailing slash doesn't hide the stale identity at the same address.
      await useSession.getState().setSession({
        serverUrl: 'HTTPS://Books.example.com',
        serverId: 'srv-b',
        token: 't2',
        user: mkUser('b'),
        retire: ['srv-a.1'],
      });
      expect(useSession.getState().connections.map((c) => c.id)).toEqual(['srv-b.1']);
    });

    it('leaves connections to DIFFERENT URLs untouched when adding a new server', async () => {
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv-a', token: 'tA', user: mkUser('a') });
      const cleanup = jest.fn();
      unsubs.push(onConnectionRemoved(cleanup));

      await useSession
        .getState()
        .setSession({ serverUrl: 'https://b', serverId: 'srv-b', token: 'tB', user: mkUser('b') });

      const s = useSession.getState();
      expect(s.connections.map((c) => c.id).sort()).toEqual(['srv-a.1', 'srv-b.1']);
      expect(cleanup).not.toHaveBeenCalled(); // a distinct URL is not a stale identity
      expect(await SecureStore.getItemAsync('audiosilo.token.srv-a.1')).toBe('tA');
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

  // Home and away addresses (capability `addresses`): kept with the connection, never
  // erased by a pairing that doesn't carry them, and no storage-version bump.
  describe('addresses', () => {
    const HOME = 'http://192.168.1.20:8080';
    const AWAY = 'https://books.example.com';
    const pair = (addresses?: { home?: string; away?: string }, serverUrl = AWAY) =>
      useSession.getState().setSession({
        serverUrl,
        serverId: 'srv-a',
        token: 't',
        user: mkUser('a'),
        ...(addresses ? { addresses } : {}),
      });
    const addressesOf = () => useSession.getState().connections[0]?.addresses;

    it('stores them with the connection and restores them on a fresh hydrate', async () => {
      await pair({ home: HOME, away: AWAY });
      expect(addressesOf()).toEqual({ home: HOME, away: AWAY });
      reset();
      await useSession.getState().hydrate();
      expect(addressesOf()).toEqual({ home: HOME, away: AWAY });
      expect(useSession.getState().connections[0].serverUrl).toBe(AWAY); // never rewritten
    });

    it('loads a connection saved before addresses existed (no version bump)', async () => {
      await AsyncStorage.setItem('audiosilo.storageVersion', JSON.stringify(2));
      await AsyncStorage.setItem(
        'audiosilo.connections',
        JSON.stringify([{ id: 'srv-old', serverUrl: AWAY, name: 'Old', user: mkUser('o') }]),
      );
      await SecureStore.setItemAsync('audiosilo.token.srv-old', 'tok');
      const reset1 = await resetStaleStorage();
      expect(reset1.authReset).toBe(false);
      await useSession.getState().hydrate();
      const [c] = useSession.getState().connections;
      expect(c).toMatchObject({ id: 'srv-old', token: 'tok' });
      expect(c.addresses).toBeUndefined();
    });

    it('a re-pair without them keeps what the connection knew', async () => {
      await pair({ home: HOME, away: AWAY });
      await pair();
      expect(addressesOf()).toEqual({ home: HOME, away: AWAY });
    });

    it('a re-pair from outside the home network keeps the known home address', async () => {
      await pair({ home: HOME, away: AWAY });
      await pair({ away: 'https://new.example.com' });
      expect(addressesOf()).toEqual({ home: HOME, away: 'https://new.example.com' });
    });

    it('a sign-in again after signing out keeps the home address the device remembered', async () => {
      await pair({ home: HOME, away: AWAY });
      await useSession.getState().removeConnection('srv-a.1');
      expect(useSession.getState().connections).toHaveLength(0);
      // Signed in again through the away address: the answer cannot know home.
      await pair({ away: AWAY });
      expect(addressesOf()).toEqual({ home: HOME, away: AWAY });
      const known = JSON.parse((await AsyncStorage.getItem('audiosilo.knownServers'))!);
      expect(known[0].addresses).toEqual({ home: HOME, away: AWAY });
    });

    it('the remembered server follows learnAddresses', async () => {
      await pair({ home: HOME, away: AWAY });
      await useSession.getState().learnAddresses('srv-a.1', { away: 'https://new.example.com' });
      const known = JSON.parse((await AsyncStorage.getItem('audiosilo.knownServers'))!);
      expect(known[0].addresses).toEqual({ home: HOME, away: 'https://new.example.com' });
    });

    it('learnAddresses merges and persists them, and no-ops when nothing changes', async () => {
      await pair({ home: HOME });
      const before = useSession.getState().connections;
      await useSession.getState().learnAddresses('srv-a.1', { home: HOME });
      await useSession.getState().learnAddresses('srv-a.1', undefined); // nothing said
      expect(useSession.getState().connections).toBe(before); // nothing changed, no churn
      // An answer read away from home: the away address is new, the home one is kept.
      await useSession.getState().learnAddresses('srv-a.1', { away: AWAY });
      expect(addressesOf()).toEqual({ home: HOME, away: AWAY });
      // The server has no away address any more.
      await useSession.getState().learnAddresses('srv-a.1', {});
      expect(addressesOf()).toEqual({ home: HOME });
      await useSession.getState().learnAddresses('nope', { home: HOME }); // unknown: no-op
      reset();
      await useSession.getState().hydrate();
      expect(addressesOf()).toEqual({ home: HOME });
    });

    describe('learnAddresses called concurrently (the runner learns every connection at once)', () => {
      const HOME_B = 'http://192.168.1.30:8080';
      const pairBoth = async () => {
        await pair();
        await useSession.getState().setSession({
          serverUrl: 'https://b.example.com',
          serverId: 'srv-b',
          token: 't',
          user: mkUser('b'),
        });
      };
      const persisted = async () =>
        JSON.parse((await AsyncStorage.getItem('audiosilo.connections'))!) as {
          id: string;
          addresses?: unknown;
        }[];
      const known = async () =>
        JSON.parse((await AsyncStorage.getItem('audiosilo.knownServers'))!) as {
          serverId: string;
          addresses?: unknown;
        }[];
      const byId = <T extends { id?: string; serverId?: string }>(rows: T[], id: string) =>
        rows.find((r) => (r.id ?? r.serverId) === id);

      it('two calls for two connections both land, in memory and in storage', async () => {
        await pairBoth();
        await Promise.all([
          useSession.getState().learnAddresses('srv-a.1', { home: HOME }),
          useSession.getState().learnAddresses('srv-b.1', { home: HOME_B }),
        ]);
        const conns = useSession.getState().connections;
        expect(byId(conns, 'srv-a.1')?.addresses).toEqual({ home: HOME });
        expect(byId(conns, 'srv-b.1')?.addresses).toEqual({ home: HOME_B });
        const stored = await persisted();
        expect(byId(stored, 'srv-a.1')?.addresses).toEqual({ home: HOME });
        expect(byId(stored, 'srv-b.1')?.addresses).toEqual({ home: HOME_B });
        const remembered = await known();
        expect(byId(remembered, 'srv-a')?.addresses).toEqual({ home: HOME });
        expect(byId(remembered, 'srv-b')?.addresses).toEqual({ home: HOME_B });
        reset();
        await useSession.getState().hydrate();
        expect(byId(useSession.getState().connections, 'srv-a.1')?.addresses).toEqual({
          home: HOME,
        });
        expect(byId(useSession.getState().connections, 'srv-b.1')?.addresses).toEqual({
          home: HOME_B,
        });
      });

      it('a connection removed while a call awaits storage is not brought back', async () => {
        await pairBoth();
        const learning = useSession.getState().learnAddresses('srv-a.1', { home: HOME });
        const removing = useSession.getState().removeConnection('srv-a.1');
        await Promise.all([learning, removing]);
        expect(useSession.getState().connections.map((c) => c.id)).toEqual(['srv-b.1']);
        expect((await persisted()).map((c) => c.id)).toEqual(['srv-b.1']);
        reset();
        await useSession.getState().hydrate();
        expect(useSession.getState().connections.map((c) => c.id)).toEqual(['srv-b.1']);
      });
    });
  });

  // Phase 8: a connection is one user on one server, `<server_id>.<user_id>`.
  describe('connection identity (server + user)', () => {
    const user = (id: number, name: string): User => ({ ...mkUser(name), id });
    const unsubs: (() => void)[] = [];
    afterEach(() => {
      while (unsubs.length) unsubs.pop()!();
    });

    it('two users on one server are two connections, each with its own token', async () => {
      const cleanup = jest.fn();
      unsubs.push(onConnectionRemoved(cleanup));
      const a = await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv', token: 'tA', user: user(3, 'sam') });
      const b = await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv', token: 'tB', user: user(5, 'kit') });
      expect([a, b]).toEqual(['srv.3', 'srv.5']);
      const s = useSession.getState();
      expect(s.connections.map((c) => [c.id, c.serverId, c.token])).toEqual([
        ['srv.3', 'srv', 'tA'],
        ['srv.5', 'srv', 'tB'],
      ]);
      expect(s.defaultConnectionId).toBe('srv.5');
      // Same URL, same server: the first user is NOT a stale identity.
      expect(cleanup).not.toHaveBeenCalled();
      expect(await SecureStore.getItemAsync('audiosilo.token.srv.3')).toBe('tA');
      expect(await SecureStore.getItemAsync('audiosilo.token.srv.5')).toBe('tB');
      reset();
      await useSession.getState().hydrate();
      expect(useSession.getState().connections.map((c) => c.id)).toEqual(['srv.3', 'srv.5']);
      // The remembered server is one row (server-level, no user).
      const known = JSON.parse((await AsyncStorage.getItem('audiosilo.knownServers'))!);
      expect(known.map((k: { serverId: string }) => k.serverId)).toEqual(['srv']);
    });

    it('a second user on a server starts from the addresses and name the device knew for it', async () => {
      await useSession.getState().setSession({
        serverUrl: 'https://a',
        serverId: 'srv',
        token: 'tA',
        user: user(3, 'sam'),
        name: 'Home library',
        addresses: { home: 'http://192.168.1.2:8080', away: 'https://a' },
      });
      await useSession.getState().setSession({
        serverUrl: 'https://a',
        serverId: 'srv',
        token: 'tB',
        user: user(5, 'kit'),
        addresses: { away: 'https://a' },
      });
      const kit = useSession.getState().connections.find((c) => c.id === 'srv.5')!;
      expect(kit.addresses).toEqual({ home: 'http://192.168.1.2:8080', away: 'https://a' });
      expect(kit.name).toBe('Home library');
    });

    it('the same user signing in again replaces their connection in place', async () => {
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv', token: 't1', user: user(3, 'sam') });
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://b', serverId: 'other', token: 'tO', user: user(1, 'o') });
      const id = await useSession.getState().setSession({
        serverUrl: 'https://a.example',
        serverId: 'srv',
        token: 't2',
        user: user(3, 'sam'),
      });
      expect(id).toBe('srv.3');
      const s = useSession.getState();
      expect(s.connections.map((c) => [c.id, c.serverUrl, c.token])).toEqual([
        ['srv.3', 'https://a.example', 't2'],
        ['other.1', 'https://b', 'tO'],
      ]);
      expect(s.defaultConnectionId).toBe('srv.3');
    });

    it('a legacy connection signed in to again KEEPS its id (its downloads and saves stay)', async () => {
      // Saved before Phase 8: the id is the bare server_id, no serverId field.
      await AsyncStorage.setItem(
        'audiosilo.connections',
        JSON.stringify([{ id: 'srv', serverUrl: 'https://a', name: 'A', user: user(3, 'sam') }]),
      );
      await SecureStore.setItemAsync('audiosilo.token.srv', 'old');
      await useSession.getState().hydrate();
      expect(useSession.getState().connections[0]).toMatchObject({ id: 'srv', serverId: 'srv' });
      const id = await useSession.getState().setSession({
        serverUrl: 'https://a',
        serverId: 'srv',
        token: 'new',
        user: user(3, 'sam'),
      });
      expect(id).toBe('srv');
      expect(useSession.getState().connections.map((c) => c.id)).toEqual(['srv']);
      expect(await SecureStore.getItemAsync('audiosilo.token.srv')).toBe('new');
      // Another user on that server is a new connection next to it, never a stale identity.
      const other = await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv', token: 'k', user: user(5, 'kit') });
      expect(other).toBe('srv.5');
      expect(useSession.getState().connections.map((c) => c.id)).toEqual(['srv', 'srv.5']);
    });

    it('a legacy connection saved without a user id is taken as the one signing in', async () => {
      await AsyncStorage.setItem(
        'audiosilo.connections',
        JSON.stringify([{ id: 'srv', serverUrl: 'https://a', name: 'A', user: {} }]),
      );
      await SecureStore.setItemAsync('audiosilo.token.srv', 'old');
      await useSession.getState().hydrate();
      const id = await useSession.getState().setSession({
        serverUrl: 'https://a',
        serverId: 'srv',
        token: 'new',
        user: user(3, 'sam'),
      });
      expect(id).toBe('srv');
      expect(useSession.getState().connections).toHaveLength(1);
    });

    it("a rebuilt server: re-pairing retires only the named identity, never another person's", async () => {
      const cleanup = jest.fn();
      const replaced = jest.fn();
      unsubs.push(onConnectionRemoved(cleanup), onConnectionReplaced(replaced));
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'old', token: 't1', user: user(3, 'sam') });
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'old', token: 't2', user: user(5, 'kit') });
      await useSession.getState().setSession({
        serverUrl: 'https://a',
        serverId: 'new',
        token: 't3',
        user: user(3, 'sam'),
        retire: ['old.3'],
      });
      const conns = useSession.getState().connections;
      expect(conns.map((c) => c.id)).toEqual(['old.5', 'new.3']);
      expect(cleanup.mock.calls.map(([id]) => id)).toEqual(['old.3']);
      expect(replaced).toHaveBeenCalledWith('old.3', 'new.3');
      expect(await SecureStore.getItemAsync('audiosilo.token.old.3')).toBeNull();
      // Kit's identity stays, token and all, flagged for Kit to sign in again.
      expect(conns[0].needsReconnect).toBe('server-reset');
      expect(await SecureStore.getItemAsync('audiosilo.token.old.5')).toBe('t2');
    });

    it('a rebuilt server: without `retire` nobody is dropped (the safe default)', async () => {
      const cleanup = jest.fn();
      unsubs.push(onConnectionRemoved(cleanup));
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'old', token: 't1', user: user(3, 'sam') });
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'new', token: 't3', user: user(3, 'sam') });
      expect(useSession.getState().connections.map((c) => [c.id, c.needsReconnect])).toEqual([
        ['old.3', 'server-reset'],
        ['new.3', undefined],
      ]);
      expect(cleanup).not.toHaveBeenCalled();
    });

    it('learnAddresses keeps the remembered server keyed by its server_id', async () => {
      await useSession
        .getState()
        .setSession({ serverUrl: 'https://a', serverId: 'srv', token: 't', user: user(3, 'sam') });
      await useSession.getState().learnAddresses('srv.3', { home: 'http://10.0.0.2' });
      const known = JSON.parse((await AsyncStorage.getItem('audiosilo.knownServers'))!);
      expect(known).toEqual([
        expect.objectContaining({ serverId: 'srv', addresses: { home: 'http://10.0.0.2' } }),
      ]);
    });

    it('hydrate fills serverId for a connection persisted without it (its legacy id)', async () => {
      await AsyncStorage.setItem(
        'audiosilo.connections',
        JSON.stringify([
          { id: 'srv', serverUrl: 'https://a', name: 'A', user: user(3, 'sam') },
          { id: 'two.4', serverUrl: 'https://b', name: 'B', user: user(4, 'b') },
        ]),
      );
      await SecureStore.setItemAsync('audiosilo.token.srv', 't');
      await SecureStore.setItemAsync('audiosilo.token.two.4', 't');
      await useSession.getState().hydrate();
      expect(useSession.getState().connections.map((c) => c.serverId)).toEqual(['srv', 'two']);
    });
  });
});

describe('setDefaultConnection (a profile switch)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    reset();
  });

  it('makes a signed-in connection the default, persisted, and ignores an unknown id', async () => {
    const s = useSession.getState();
    await s.setSession({ serverUrl: 'https://a', serverId: 'a', token: 't1', user: mkUser('a') });
    const b = await useSession
      .getState()
      .setSession({ serverUrl: 'https://b', serverId: 'b', token: 't2', user: mkUser('b') });
    const a = useSession.getState().connections[0].id;
    expect(useSession.getState().defaultConnectionId).toBe(b);
    await useSession.getState().setDefaultConnection(a);
    expect(useSession.getState().defaultConnectionId).toBe(a);
    expect(useSession.getState().user?.username).toBe('a');
    expect(JSON.parse((await AsyncStorage.getItem('audiosilo.activeConnection'))!)).toBe(a);
    await useSession.getState().setDefaultConnection('nope');
    expect(useSession.getState().defaultConnectionId).toBe(a);
  });
});

describe('setSession with makeDefault: false (a household member signed in here)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    reset();
  });

  const member = { ...mkUser('evie'), id: 12 };

  it('adds the connection and leaves the default where it was, persisted', async () => {
    const owner = await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', serverId: 'a', token: 't1', user: mkUser('adam') });
    const id = await useSession
      .getState()
      .setSession(
        { serverUrl: 'https://a', serverId: 'a', token: 't2', user: member },
        { makeDefault: false },
      );
    expect(id).toBe('a.12');
    expect(useSession.getState().connections.map((c) => c.id)).toEqual([owner, 'a.12']);
    expect(useSession.getState().defaultConnectionId).toBe(owner);
    expect(useSession.getState().user?.username).toBe('adam');
    expect(JSON.parse((await AsyncStorage.getItem('audiosilo.activeConnection'))!)).toBe(owner);
    // The default (true) still moves it, as before.
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://b', serverId: 'b', token: 't3', user: mkUser('b') });
    expect(useSession.getState().defaultConnectionId).toBe('b.1');
  });

  it('still makes it the default when there is none yet', async () => {
    const id = await useSession
      .getState()
      .setSession(
        { serverUrl: 'https://a', serverId: 'a', token: 't2', user: member },
        { makeDefault: false },
      );
    expect(useSession.getState().defaultConnectionId).toBe(id);
    expect(useSession.getState().status).toBe('authenticated');
    expect(JSON.parse((await AsyncStorage.getItem('audiosilo.activeConnection'))!)).toBe(id);
  });

  it('takes the default when the default it had is retired by this sign-in', async () => {
    const old = await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', serverId: 'old', token: 't1', user: member });
    const id = await useSession
      .getState()
      .setSession(
        { serverUrl: 'https://a', serverId: 'new', token: 't2', user: member, retire: [old] },
        { makeDefault: false },
      );
    expect(useSession.getState().connections.map((c) => c.id)).toEqual([id]);
    expect(useSession.getState().defaultConnectionId).toBe(id);
  });
});
