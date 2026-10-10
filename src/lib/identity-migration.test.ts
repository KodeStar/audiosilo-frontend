import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { pruneDrifts } from '@/playback/drift';
import { parseTimeSaved } from '@/playback/time-saved';
import { resolveLibrarySelection } from '@/stores/library-selection';
import { profileConnectionIds, resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import {
  connectionAliases,
  legacyIdOf,
  resolveConnectionId,
  setConnectionAliases,
} from './connection-id';
import {
  ID_DOCUMENTS,
  IDENTITY_PLAN_KEY,
  IDENTITY_VERSION_KEY,
  type IdentityMigrationDeps,
  initialProfiles,
  migrateConnectionIdentity,
  planMoves,
  rekey,
  UNKNOWN,
} from './identity-migration';
import { CAR_SNAPSHOT_WRITTEN_KEY, DRIFT_STORAGE_KEY, OFFLINE_SERVERS_KEY } from './storage-keys';

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const set = (key: string, value: Json) => AsyncStorage.setItem(key, JSON.stringify(value));
const get = async (key: string) => {
  const raw = await AsyncStorage.getItem(key);
  return raw == null ? undefined : (JSON.parse(raw) as unknown);
};
const token = (id: string) => SecureStore.getItemAsync(`audiosilo.token.${id}`);

// --- The install before the update ----------------------------------------------------------

const sam = { id: 3, username: 'sam', role: 'user' };
const kit = { id: 7, username: 'kit', role: 'user' };
const entry = (connectionId: string, libraryId: number, path: string) => ({
  connectionId,
  libraryId,
  path,
  title: path,
  status: 'downloaded',
  progress: 1,
  bytes: 10,
  totalBytes: 10,
  manifest: {
    book: { rel_path: path },
    chapters: null,
    // Recomputed from the entry at hydrate (`relocateEntry`), so never rewritten here.
    files: [{ relPath: `${path}/a.mp3`, localUri: 'file:///docs/downloads/old/x' }],
    coverUri: null,
    savedAt: '2026-10-01T00:00:00.000Z',
  },
});
const save = (connectionId: string, path: string) => ({
  connectionId,
  libraryId: 1,
  path,
  position: 100,
  duration: 1000,
  finished: false,
  playback_speed: 1,
  device_id: 'dev',
  updated_at: '2026-10-01T00:00:00.000Z',
});
const drift = { touchAt: 1, touchPosition: 2, stoppedAt: 3, recordedAt: Date.now() - 1000 };

/** Every scoped store, as a pre-Phase 8 install wrote it. `srvC` has no usable user id. */
async function seedLegacyInstall() {
  await set('audiosilo.connections', [
    { id: 'srvA', serverUrl: 'https://a', name: 'A', user: sam },
    {
      id: 'srvB',
      serverUrl: 'https://b',
      name: 'B',
      user: kit,
      addresses: { home: 'http://10.0.0.2' },
    },
    { id: 'srvC', serverUrl: 'https://c', name: 'C', user: {} },
  ]);
  await set('audiosilo.activeConnection', 'srvA');
  await SecureStore.setItemAsync('audiosilo.token.srvA', 'tokA');
  await SecureStore.setItemAsync('audiosilo.token.srvB', 'tokB');
  await SecureStore.setItemAsync('audiosilo.token.srvC', 'tokC');
  await set('audiosilo.downloads', {
    'srvA:1:Book/One': entry('srvA', 1, 'Book/One'),
    'srvC:2:Other': entry('srvC', 2, 'Other'),
  });
  await set('audiosilo.progressMirror', {
    'srvA:1:Book/One': save('srvA', 'Book/One'),
    'srvB:1:Two': save('srvB', 'Two'),
  });
  await set('audiosilo.progressQueue', [save('srvB', 'Two'), save('srvA', 'Book/One')]);
  await set(OFFLINE_SERVERS_KEY, {
    srvA: { info: { server_id: 'srvA' }, savedAt: 1 },
    srvB: { info: { server_id: 'srvB' }, savedAt: 2 },
  });
  await set('audiosilo.carBookmarks', [
    { connectionId: 'srvA', libraryId: 1, path: 'Book/One', position: 10 },
    { connectionId: 'srvB', libraryId: 1, path: 'Two', trackIndex: 1, positionInTrack: 5 },
  ]);
  await set('audiosilo.librarySelection', { selection: { connectionId: 'srvB', libraryId: 2 } });
  await set('audiosilo.timeSaved', {
    lifetime: 100,
    books: { 'srvA:1:Book/One': 40, 'srvC:2:Other': 5 },
  });
  await set(DRIFT_STORAGE_KEY, { 'srvB:1:Two': drift });
  await set(CAR_SNAPSHOT_WRITTEN_KEY, true);
  await set('audiosilo.storageVersion', 2);
}

/** What every store holds once the migration is done. */
async function expectMigrated() {
  expect(await get('audiosilo.connections')).toEqual([
    { id: 'srvA.3', serverId: 'srvA', serverUrl: 'https://a', name: 'A', user: sam },
    {
      id: 'srvB.7',
      serverId: 'srvB',
      serverUrl: 'https://b',
      name: 'B',
      user: kit,
      addresses: { home: 'http://10.0.0.2' },
    },
    // No usable user id: stays legacy (and keeps working), but says which server it is.
    { id: 'srvC', serverId: 'srvC', serverUrl: 'https://c', name: 'C', user: {} },
  ]);
  expect(await get('audiosilo.activeConnection')).toBe('srvA.3');
  expect(await get('audiosilo.downloads')).toEqual({
    'srvA.3:1:Book/One': entry('srvA.3', 1, 'Book/One'),
    'srvC:2:Other': entry('srvC', 2, 'Other'),
  });
  expect(await get('audiosilo.progressMirror')).toEqual({
    'srvA.3:1:Book/One': save('srvA.3', 'Book/One'),
    'srvB.7:1:Two': save('srvB.7', 'Two'),
  });
  expect(await get('audiosilo.progressQueue')).toEqual([
    save('srvB.7', 'Two'),
    save('srvA.3', 'Book/One'),
  ]);
  expect(await get(OFFLINE_SERVERS_KEY)).toEqual({
    'srvA.3': { info: { server_id: 'srvA' }, savedAt: 1 },
    'srvB.7': { info: { server_id: 'srvB' }, savedAt: 2 },
  });
  expect(await get('audiosilo.carBookmarks')).toEqual([
    { connectionId: 'srvA.3', libraryId: 1, path: 'Book/One', position: 10 },
    { connectionId: 'srvB.7', libraryId: 1, path: 'Two', trackIndex: 1, positionInTrack: 5 },
  ]);
  expect(await get('audiosilo.librarySelection')).toEqual({
    selection: { connectionId: 'srvB.7', libraryId: 2 },
  });
  expect(await get('audiosilo.timeSaved')).toEqual({
    lifetime: 100,
    books: { 'srvA.3:1:Book/One': 40, 'srvC:2:Other': 5 },
  });
  expect(await get(DRIFT_STORAGE_KEY)).toEqual({ 'srvB.7:1:Two': drift });
  expect(await get('audiosilo.connectionAliases')).toEqual({ srvA: 'srvA.3', srvB: 'srvB.7' });
  expect(await get('audiosilo.profiles')).toEqual({
    version: 1,
    profiles: [{ id: 'p1', name: 'sam', connectionIds: ['srvA.3', 'srvB.7', 'srvC'] }],
    activeProfileId: 'p1',
    askAtLaunch: false,
  });
  expect(await get(CAR_SNAPSHOT_WRITTEN_KEY)).toBeUndefined();
  expect(await get(IDENTITY_VERSION_KEY)).toBe(2);
  expect(await get(IDENTITY_PLAN_KEY)).toBeUndefined();
  // Tokens: under the new ids; the moved ones' old keys gone; the legacy one untouched.
  expect(await token('srvA.3')).toBe('tokA');
  expect(await token('srvB.7')).toBe('tokB');
  expect(await token('srvC')).toBe('tokC');
  expect(await token('srvA')).toBeNull();
  expect(await token('srvB')).toBeNull();
  // Files followed.
  expect(dirs).toEqual({ 'srvA.3': ['srvA-book'], 'srvB.7': ['srvB-book'], srvC: ['srvC-book'] });
}

/** Every document as it was seeded (a stopped run changed nothing the app reads). */
async function snapshotDocuments() {
  const keys = [...Object.values(ID_DOCUMENTS), CAR_SNAPSHOT_WRITTEN_KEY, IDENTITY_VERSION_KEY];
  return Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await get(k)])));
}

// --- Files (the engine's move, in memory) ----------------------------------------------------

let dirs: Record<string, string[]>;
let failMove: ((from: string, to: string) => boolean) | null;
const moveConnection = jest.fn(async (from: string, to: string) => {
  if (failMove?.(from, to)) throw new Error(`could not move ${from}`);
  if (!dirs[from]) return;
  dirs[to] = [...(dirs[to] ?? []), ...dirs[from]];
  delete dirs[from];
});

let profileIds = 0;
const deps = (over: Partial<IdentityMigrationDeps> = {}): IdentityMigrationDeps => ({
  moveConnection,
  loadedConnectionId: async () => null,
  newProfileId: () => `p${++profileIds}`,
  ...over,
});

// --- Secure store failure injection ----------------------------------------------------------

const secure = SecureStore as unknown as {
  getItemAsync: (k: string, o?: unknown) => Promise<string | null>;
  setItemAsync: (k: string, v: string, o?: unknown) => Promise<void>;
};
const realGet = secure.getItemAsync;
const realSet = secure.setItemAsync;
const LOCKED = new Error(
  "Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: User interaction is not allowed.",
);

// The setup's in-memory AsyncStorage batch calls (a spy on a jest.fn is that same fn, so a
// test swaps its implementation and puts this one back).
const storage = AsyncStorage as unknown as Record<'getMany' | 'setMany', jest.Mock>;
const realGetMany = storage.getMany.getMockImplementation()!;
const realSetMany = storage.setMany.getMockImplementation()! as (
  e: Record<string, string>,
) => Promise<void>;

const os = Platform.OS;
beforeEach(async () => {
  await AsyncStorage.clear();
  for (const id of ['srvA', 'srvB', 'srvC', 'srvA.3', 'srvB.7', 'x', 'x.1', 'y.2', 'y', 'srvA.9']) {
    await SecureStore.deleteItemAsync(`audiosilo.token.${id}`);
  }
  dirs = { srvA: ['srvA-book'], srvB: ['srvB-book'], srvC: ['srvC-book'] };
  failMove = null;
  moveConnection.mockClear();
  profileIds = 0;
  setConnectionAliases({});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  storage.getMany.mockImplementation(realGetMany);
  storage.setMany.mockImplementation(realSetMany);
  secure.getItemAsync = realGet;
  secure.setItemAsync = realSet;
  Platform.OS = os;
  jest.restoreAllMocks();
});

describe('migrateConnectionIdentity', () => {
  it('moves every store, every token and every file to the new ids', async () => {
    await seedLegacyInstall();
    const result = await migrateConnectionIdentity(deps());
    expect(result).toEqual({ status: 'migrated', moved: { srvA: 'srvA.3', srvB: 'srvB.7' } });
    await expectMigrated();
    // In memory for this launch's entry points, too.
    expect(connectionAliases()).toEqual({ srvA: 'srvA.3', srvB: 'srvB.7' });
    expect(resolveConnectionId('srvB')).toBe('srvB.7');
  });

  it('nobody is signed out: a hydrate afterwards finds every connection with its token', async () => {
    await seedLegacyInstall();
    await migrateConnectionIdentity(deps());
    useSession.setState({ status: 'loading', connections: [], defaultConnectionId: null });
    await useSession.getState().hydrate();
    const s = useSession.getState();
    expect(s.status).toBe('authenticated');
    expect(s.connections.map((c) => [c.id, c.serverId, c.token])).toEqual([
      ['srvA.3', 'srvA', 'tokA'],
      ['srvB.7', 'srvB', 'tokB'],
      ['srvC', 'srvC', 'tokC'],
    ]);
    expect(s.defaultConnectionId).toBe('srvA.3');
  });

  // The Pixel device pass (Phase 8, item 9): a demo connection first and the default, then
  // two fixture servers where the user is alex, id 2, on both. After the update the
  // Library and the car showed fixture B: not the migration's doing (this proves the
  // default and a stored pick survive it, the session and the profiles), but the
  // no-pick fallback taking whichever server answered first (`resolveLibrarySelection`).
  describe("the device pass's three connections", () => {
    const demoUser = { id: 57, username: 'demo-x', role: 'user' };
    const alex = { id: 2, username: 'alex', role: 'user' };
    const DEMO = 'jXVyhtNwYeFXefnS7tWlTw';
    const A = 'lrqIfd20UOAJuELBt2NnKQ';
    const B = 'mn3NYY0QM8xEl0ZnU-srAA';

    async function seed(pick: { connectionId: string; libraryId: number } | null) {
      await set('audiosilo.connections', [
        { id: DEMO, serverUrl: 'https://demo.audiosilo.app', name: 'Demo', user: demoUser },
        { id: B, serverUrl: 'http://127.0.0.1:8082', name: "Maya's Shelf", user: alex },
        { id: A, serverUrl: 'http://127.0.0.1:8081', name: 'Hearthside', user: alex },
      ]);
      await set('audiosilo.activeConnection', DEMO);
      for (const id of [DEMO, A, B]) await SecureStore.setItemAsync(`audiosilo.token.${id}`, id);
      if (pick) await set('audiosilo.librarySelection', { selection: pick });
      await set('audiosilo.storageVersion', 2);
    }

    async function hydrateAll() {
      useSession.setState({ status: 'loading', connections: [], defaultConnectionId: null });
      resetProfilesForTests();
      await useSession.getState().hydrate();
      await useProfiles.getState().hydrate();
    }

    afterEach(async () => {
      for (const id of [DEMO, A, B, `${DEMO}.57`, `${A}.2`, `${B}.2`]) {
        await SecureStore.deleteItemAsync(`audiosilo.token.${id}`);
      }
    });

    it('keeps the default connection, the order and a stored pick', async () => {
      await seed({ connectionId: DEMO, libraryId: 1 });
      await migrateConnectionIdentity(deps());
      await hydrateAll();
      const ids = [`${DEMO}.57`, `${B}.2`, `${A}.2`];
      expect(useSession.getState().connections.map((c) => c.id)).toEqual(ids);
      expect(useSession.getState().defaultConnectionId).toBe(`${DEMO}.57`);
      // One person (three servers): everything stays theirs, in the same order.
      expect(useProfiles.getState().profiles.map((p) => p.connectionIds)).toEqual([ids]);
      expect(profileConnectionIds()).toEqual(ids);
      const stored = { connectionId: `${DEMO}.57`, libraryId: 1 };
      expect(await get('audiosilo.librarySelection')).toEqual({ selection: stored });
      // The stored pick wins whatever answers first.
      const groups = ids.map((connectionId) => ({
        connectionId,
        connectionName: connectionId,
        libraryIds: [1],
        status: 'ready' as const,
      }));
      expect(
        resolveLibrarySelection(stored, groups, { connectionId: `${B}.2`, libraryId: 1 }),
      ).toEqual(stored);
    });

    it('with no stored pick, none is invented (the fallback is by order of arrival)', async () => {
      await seed(null);
      await migrateConnectionIdentity(deps());
      await hydrateAll();
      expect(useSession.getState().defaultConnectionId).toBe(`${DEMO}.57`);
      expect(await get('audiosilo.librarySelection')).toBeUndefined();
    });
  });

  it("the stores' own parsers read the rewritten documents", async () => {
    await seedLegacyInstall();
    await migrateConnectionIdentity(deps());
    expect(parseTimeSaved(await get('audiosilo.timeSaved')).books).toEqual({
      'srvA.3:1:Book/One': 40,
      'srvC:2:Other': 5,
    });
    expect(Object.keys(pruneDrifts(await get(DRIFT_STORAGE_KEY), Date.now()))).toEqual([
      'srvB.7:1:Two',
    ]);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await seedLegacyInstall();
    await migrateConnectionIdentity(deps());
    const after = await snapshotDocuments();
    moveConnection.mockClear();
    expect(await migrateConnectionIdentity(deps())).toEqual({ status: 'skipped' });
    expect(await snapshotDocuments()).toEqual(after);
    expect(moveConnection).not.toHaveBeenCalled();
  });

  it('with no connections: marks itself done and writes nothing else', async () => {
    expect(await migrateConnectionIdentity(deps())).toEqual({ status: 'skipped' });
    expect(await get(IDENTITY_VERSION_KEY)).toBe(2);
    expect(await get('audiosilo.profiles')).toBeUndefined();
    expect(await get('audiosilo.connectionAliases')).toBeUndefined();
  });

  it('a connection with no usable user id stays legacy and keeps its token', async () => {
    await set('audiosilo.connections', [
      { id: 'x', serverUrl: 'https://x', name: 'X', user: { username: 'old' } },
    ]);
    await SecureStore.setItemAsync('audiosilo.token.x', 'tx');
    const result = await migrateConnectionIdentity(deps());
    expect(result).toEqual({ status: 'migrated', moved: {} });
    expect(await get('audiosilo.connections')).toEqual([
      { id: 'x', serverId: 'x', serverUrl: 'https://x', name: 'X', user: { username: 'old' } },
    ]);
    expect(await token('x')).toBe('tx');
    expect(moveConnection).not.toHaveBeenCalled();
    expect(await get('audiosilo.profiles')).toMatchObject({
      profiles: [{ name: 'old', connectionIds: ['x'] }],
    });
    // Done: the next launch does not try again.
    expect(await migrateConnectionIdentity(deps())).toEqual({ status: 'skipped' });
  });

  it('a connection that never had a token moves without one (the session drops it anyway)', async () => {
    await set('audiosilo.connections', [{ id: 'x', serverUrl: 'https://x', name: 'X', user: sam }]);
    expect(await migrateConnectionIdentity(deps())).toMatchObject({ status: 'migrated' });
    expect(await get('audiosilo.connections')).toEqual([
      expect.objectContaining({ id: 'x.3', serverId: 'x' }),
    ]);
    expect(await token('x.3')).toBeNull();
  });

  it('keeps an existing profiles document, mapping its connection ids', async () => {
    await seedLegacyInstall();
    await set('audiosilo.profiles', {
      version: 1,
      profiles: [{ id: 'me', name: 'Me', connectionIds: ['srvA', 'srvA.3', 'srvC'] }],
      activeProfileId: 'me',
      askAtLaunch: true,
    });
    await migrateConnectionIdentity(deps());
    expect(await get('audiosilo.profiles')).toEqual({
      version: 1,
      profiles: [{ id: 'me', name: 'Me', connectionIds: ['srvA.3', 'srvC'] }],
      activeProfileId: 'me',
      askAtLaunch: true,
    });
  });

  it('loads the stored aliases with its first read, even with nothing to move', async () => {
    await set('audiosilo.connectionAliases', { old: 'old.2' });
    expect(await migrateConnectionIdentity(deps())).toEqual({ status: 'skipped' });
    expect(resolveConnectionId('old')).toBe('old.2');
    // A done run, too (the launch reads them nowhere else).
    setConnectionAliases({});
    expect(await migrateConnectionIdentity(deps())).toEqual({ status: 'skipped' });
    expect(resolveConnectionId('old')).toBe('old.2');
  });

  it('keeps aliases an earlier run recorded', async () => {
    await seedLegacyInstall();
    await set('audiosilo.connectionAliases', { gone: 'gone.1' });
    await migrateConnectionIdentity(deps());
    expect(await get('audiosilo.connectionAliases')).toEqual({
      gone: 'gone.1',
      srvA: 'srvA.3',
      srvB: 'srvB.7',
    });
  });

  describe('stops, changing nothing the app reads, and runs again next launch', () => {
    it('a locked keychain at the second token (a CarPlay launch with the phone locked)', async () => {
      Platform.OS = 'ios';
      await seedLegacyInstall();
      const before = await snapshotDocuments();
      secure.getItemAsync = (k: string, o?: unknown) =>
        k === 'audiosilo.token.srvB' ? Promise.reject(LOCKED) : realGet(k, o);

      expect(await migrateConnectionIdentity(deps())).toEqual({
        status: 'aborted',
        step: 'tokens',
        error: LOCKED,
      });
      // Unlocked, to look.
      secure.getItemAsync = realGet;
      expect(await snapshotDocuments()).toEqual(before);
      expect(await get(IDENTITY_PLAN_KEY)).toBeUndefined();
      expect(moveConnection).not.toHaveBeenCalled();
      expect(dirs.srvA).toEqual(['srvA-book']);
      expect(await token('srvA')).toBe('tokA'); // never deleted before the end
      expect(await token('srvB')).toBe('tokB');
      expect(connectionAliases()).toEqual({});

      // Next launch: it finishes.
      expect(await migrateConnectionIdentity(deps())).toMatchObject({ status: 'migrated' });
      await expectMigrated();
    });

    it('a token copy that does not read back', async () => {
      await seedLegacyInstall();
      const before = await snapshotDocuments();
      secure.setItemAsync = (k: string, v: string, o?: unknown) =>
        k === 'audiosilo.token.srvA.3' ? Promise.resolve() : realSet(k, v, o);
      expect(await migrateConnectionIdentity(deps())).toMatchObject({
        status: 'aborted',
        step: 'tokens',
      });
      expect(await snapshotDocuments()).toEqual(before);
      expect(await token('srvA')).toBe('tokA');
    });

    it('a file that cannot move: what moved goes back', async () => {
      await seedLegacyInstall();
      const before = await snapshotDocuments();
      failMove = (from) => from === 'srvB';
      expect(await migrateConnectionIdentity(deps())).toMatchObject({
        status: 'aborted',
        step: 'files',
      });
      expect(moveConnection.mock.calls).toEqual([
        ['srvA', 'srvA.3'],
        ['srvB', 'srvB.7'],
        ['srvA.3', 'srvA'], // moved back
      ]);
      expect(dirs).toEqual({ srvA: ['srvA-book'], srvB: ['srvB-book'], srvC: ['srvC-book'] });
      expect(await snapshotDocuments()).toEqual(before);
      // The tokens it copied stay (harmless); the old ones are all there.
      expect(await token('srvA')).toBe('tokA');
      expect(await token('srvB')).toBe('tokB');

      failMove = null;
      expect(await migrateConnectionIdentity(deps())).toMatchObject({ status: 'migrated' });
      await expectMigrated();
    });

    it('a document write that fails: documents restored, files moved back', async () => {
      await seedLegacyInstall();
      const before = await snapshotDocuments();
      let calls = 0;
      storage.setMany.mockImplementation(async (entries: Record<string, string>) => {
        calls++;
        if (calls > 1) return realSetMany(entries); // the restore
        // Half written, then the disk is full (iOS and the web write key by key).
        const pairs = Object.entries(entries);
        await realSetMany(Object.fromEntries(pairs.slice(0, Math.ceil(pairs.length / 2))));
        throw new Error('disk full');
      });
      expect(await migrateConnectionIdentity(deps())).toMatchObject({
        status: 'aborted',
        step: 'documents',
      });
      expect(await snapshotDocuments()).toEqual(before);
      expect(dirs).toEqual({ srvA: ['srvA-book'], srvB: ['srvB-book'], srvC: ['srvC-book'] });
      expect(await token('srvA')).toBe('tokA');
      // Put back: nothing new in memory either.
      expect(resolveConnectionId('srvA')).toBe('srvA');

      storage.setMany.mockImplementation(realSetMany);
      profileIds = 0;
      expect(await migrateConnectionIdentity(deps())).toMatchObject({ status: 'migrated' });
      await expectMigrated();
    });

    it('a document write that fails and cannot be put back: the moves are known in memory', async () => {
      await seedLegacyInstall();
      storage.setMany.mockImplementation(async (entries: Record<string, string>) => {
        const pairs = Object.entries(entries);
        await realSetMany(Object.fromEntries(pairs.slice(0, Math.ceil(pairs.length / 2))));
        throw new Error('disk full');
      });
      expect(await migrateConnectionIdentity(deps())).toMatchObject({
        status: 'aborted',
        step: 'documents',
      });
      // A document already naming a new id reaches its connection, and on the web its files
      // under the legacy id, until the stored plan finishes next launch.
      expect(resolveConnectionId('srvA')).toBe('srvA.3');
      expect(legacyIdOf('srvB.7')).toBe('srvB');
      storage.setMany.mockImplementation(realSetMany);
      profileIds = 0;
      expect(await migrateConnectionIdentity(deps())).toMatchObject({ status: 'migrated' });
      await expectMigrated();
    });

    it('the Android playback service holds a book of a connection being moved', async () => {
      await seedLegacyInstall();
      const before = await snapshotDocuments();
      expect(
        await migrateConnectionIdentity(deps({ loadedConnectionId: async () => 'srvB' })),
      ).toEqual({ status: 'aborted', step: 'busy' });
      expect(await snapshotDocuments()).toEqual(before);
      expect(moveConnection).not.toHaveBeenCalled();
      expect(await token('srvB.7')).toBeNull();
      // A book of a connection not being moved is no reason to wait.
      expect(
        await migrateConnectionIdentity(deps({ loadedConnectionId: async () => 'srvC' })),
      ).toMatchObject({ status: 'migrated' });
    });

    it('the playback service does not say which book it holds in time', async () => {
      await seedLegacyInstall();
      const before = await snapshotDocuments();
      expect(
        await migrateConnectionIdentity(deps({ loadedConnectionId: async () => UNKNOWN })),
      ).toEqual({ status: 'aborted', step: 'busy' });
      expect(await snapshotDocuments()).toEqual(before);
    });

    it('a storage read that fails', async () => {
      await seedLegacyInstall();
      storage.getMany.mockRejectedValueOnce(new Error('io'));
      expect(await migrateConnectionIdentity(deps())).toMatchObject({
        status: 'aborted',
        step: 'read',
      });
      expect(await get(IDENTITY_VERSION_KEY)).toBeUndefined();
    });
  });

  describe('a run cut short (the app killed) is finished by the next one', () => {
    /** setMany writes `keep` of its entries, then the process dies (never settles). */
    const dieDuringSetMany = (keep: (n: number) => number) => {
      storage.setMany.mockImplementation(async (entries: Record<string, string>) => {
        const pairs = Object.entries(entries);
        await realSetMany(Object.fromEntries(pairs.slice(0, keep(pairs.length))));
        return new Promise<void>(() => {});
      });
      return () => storage.setMany.mockImplementation(realSetMany);
    };

    it('between the documents and the mark', async () => {
      await seedLegacyInstall();
      const revive = dieDuringSetMany((n) => n);
      void migrateConnectionIdentity(deps());
      await new Promise((r) => setTimeout(r, 20));
      expect(await get(IDENTITY_VERSION_KEY)).toBeUndefined();
      expect(await get(IDENTITY_PLAN_KEY)).toEqual({ srvA: 'srvA.3', srvB: 'srvB.7' });
      revive();
      profileIds = 0;
      // The next launch: every document already names the new ids, the old tokens are still
      // there; it marks itself done and cleans up.
      expect(await migrateConnectionIdentity(deps())).toMatchObject({ status: 'migrated' });
      await expectMigrated();
    });

    it('part-way through writing the documents (the connections list already rewritten)', async () => {
      await seedLegacyInstall();
      const revive = dieDuringSetMany(() => 1); // only the first document landed
      void migrateConnectionIdentity(deps());
      await new Promise((r) => setTimeout(r, 20));
      // The connection list names the new ids, the rest the old ones.
      expect(await get('audiosilo.connections')).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'srvA.3' })]),
      );
      expect(await get('audiosilo.activeConnection')).toBe('srvA');
      revive();
      profileIds = 0;
      expect(await migrateConnectionIdentity(deps())).toMatchObject({ status: 'migrated' });
      await expectMigrated();
    });

    it('after the mark, before the clean-up', async () => {
      await seedLegacyInstall();
      await migrateConnectionIdentity(deps());
      // As if the old tokens' delete and the plan's removal never ran.
      await SecureStore.setItemAsync('audiosilo.token.srvA', 'tokA');
      await set(IDENTITY_PLAN_KEY, { srvA: 'srvA.3', srvB: 'srvB.7' });
      expect(await migrateConnectionIdentity(deps())).toEqual({ status: 'skipped' });
      expect(await token('srvA')).toBeNull();
      expect(await get(IDENTITY_PLAN_KEY)).toBeUndefined();
      expect(await token('srvA.3')).toBe('tokA');
    });
  });

  it('a legacy list written back after the mark (a web tab on the old code) is moved again, signed in', async () => {
    await seedLegacyInstall();
    await migrateConnectionIdentity(deps());
    // The old tab persists the list it holds: the legacy ids, without serverId.
    await set('audiosilo.connections', [
      { id: 'srvA', serverUrl: 'https://a', name: 'A', user: sam },
      { id: 'srvB', serverUrl: 'https://b', name: 'B', user: kit },
    ]);
    await set('audiosilo.activeConnection', 'srvB');
    expect(await migrateConnectionIdentity(deps())).toMatchObject({ status: 'migrated' });
    expect((await get('audiosilo.connections')) as { id: string }[]).toEqual([
      expect.objectContaining({ id: 'srvA.3' }),
      expect.objectContaining({ id: 'srvB.7' }),
    ]);
    expect(await get('audiosilo.activeConnection')).toBe('srvB.7');
    useSession.setState({ status: 'loading', connections: [], defaultConnectionId: null });
    await useSession.getState().hydrate();
    expect(useSession.getState().connections.map((c) => c.token)).toEqual(['tokA', 'tokB']);
  });
});

describe('planMoves', () => {
  it('moves legacy ids with a usable user id, keeps the rest, and never onto an id in use', () => {
    expect(
      planMoves(
        [
          { id: 'a', serverUrl: '', name: '', user: { ...sam } } as never,
          { id: 'b.4', serverUrl: '', name: '', user: { id: 4 } } as never,
          { id: 'c', serverUrl: '', name: '', user: {} } as never,
          { id: 'd', serverUrl: '', name: '', user: { id: 2 } } as never,
          { id: 'd.2', serverUrl: '', name: '', user: { id: 2 } } as never,
        ],
        { gone: 'gone.1' },
      ),
    ).toEqual({ gone: 'gone.1', a: 'a.3' });
  });
});

describe('initialProfiles', () => {
  it('one profile per person: a second user on a server gets their own, the default is active', () => {
    let n = 0;
    const doc = initialProfiles(
      [
        { id: 'x.1', serverId: 'x', serverUrl: '', name: '', user: { ...sam, id: 1 } },
        { id: 'y.2', serverId: 'y', serverUrl: '', name: '', user: { ...sam, id: 2 } },
        { id: 'x.9', serverId: 'x', serverUrl: '', name: '', user: { ...kit, id: 9 } },
      ] as never,
      'x.9',
      () => `p${++n}`,
    );
    expect(doc).toEqual({
      version: 1,
      profiles: [
        { id: 'p1', name: 'sam', connectionIds: ['x.1', 'y.2'] },
        { id: 'p2', name: 'kit', connectionIds: ['x.9'] },
      ],
      activeProfileId: 'p2',
      askAtLaunch: false,
    });
  });
});

describe('rekey', () => {
  it('maps only the connection part of a contentKey', () => {
    const plan = { a: 'a.1' };
    expect(rekey(plan, 'a:1:Some/Path:with:colons')).toBe('a.1:1:Some/Path:with:colons');
    expect(rekey(plan, 'ab:1:x')).toBe('ab:1:x');
    expect(rekey(plan, 'no-colon')).toBe('no-colon');
  });
});
