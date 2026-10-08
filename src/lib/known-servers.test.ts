import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  forget,
  knownAddresses,
  list,
  remember,
  rememberAddresses,
  type KnownServer,
} from './known-servers';

const KEY = 'audiosilo.knownServers';
const mk = (id: string, url = `https://${id}`, name = id): KnownServer => ({
  serverUrl: url,
  name,
  serverId: id,
});

describe('known-servers', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('starts empty', async () => {
    expect(await list()).toEqual([]);
  });

  it('remembers a server and persists it (round-trips through storage)', async () => {
    await remember(mk('srv-a'));
    expect(await list()).toEqual([mk('srv-a')]);
    // Persisted under the durable key, not just in memory.
    expect(await AsyncStorage.getItem(KEY)).not.toBeNull();
  });

  it('adds newest first', async () => {
    await remember(mk('srv-a'));
    await remember(mk('srv-b'));
    expect((await list()).map((e) => e.serverId)).toEqual(['srv-b', 'srv-a']);
  });

  it('upserts by serverId (no duplicate), refreshing url/name and moving to front', async () => {
    await remember(mk('srv-a'));
    await remember(mk('srv-b'));
    await remember(mk('srv-a', 'https://a.example', 'Server A'));
    const l = await list();
    expect(l.map((e) => e.serverId)).toEqual(['srv-a', 'srv-b']); // moved to front, still one
    expect(l[0]).toEqual({ serverUrl: 'https://a.example', name: 'Server A', serverId: 'srv-a' });
  });

  it('supersedes an entry at the same url when the server minted a new id (rebuilt server)', async () => {
    await remember(mk('old-id', 'https://same.example', 'Home'));
    await remember(mk('srv-b', 'https://b.example'));
    // Re-pair to the same address; the rebuilt server minted a fresh serverId.
    await remember(mk('new-id', 'https://same.example', 'Home'));
    const l = await list();
    expect(l.map((e) => e.serverId)).toEqual(['new-id', 'srv-b']); // single entry, dead id gone
    expect(l[0]).toEqual({ serverUrl: 'https://same.example', name: 'Home', serverId: 'new-id' });
  });

  it('leaves entries at distinct urls untouched', async () => {
    await remember(mk('srv-a', 'https://a.example'));
    await remember(mk('srv-b', 'https://b.example'));
    await remember(mk('srv-c', 'https://c.example'));
    expect((await list()).map((e) => e.serverId)).toEqual(['srv-c', 'srv-b', 'srv-a']);
  });

  it('ignores a blank serverId', async () => {
    await remember(mk('', 'https://x'));
    expect(await list()).toEqual([]);
  });

  it('forgets a server by id, leaving the others', async () => {
    await remember(mk('srv-a'));
    await remember(mk('srv-b'));
    await forget('srv-a');
    expect((await list()).map((e) => e.serverId)).toEqual(['srv-b']);
  });

  it('forgetting an unknown id is a no-op', async () => {
    await remember(mk('srv-a'));
    await forget('does-not-exist');
    expect((await list()).map((e) => e.serverId)).toEqual(['srv-a']);
  });

  it('never persists a token/secret (only url, name, id)', async () => {
    await remember(mk('srv-a'));
    const raw = (await AsyncStorage.getItem(KEY))!;
    expect(raw).not.toMatch(/token|secret/i);
    expect(Object.keys(JSON.parse(raw)[0]).sort()).toEqual(['name', 'serverId', 'serverUrl']);
  });

  describe('home and away addresses', () => {
    const HOME = 'http://192.168.1.20:8080';
    const AWAY = 'https://books.example.com';

    it('keeps them, and keeps the home address when a later sign-in only knew away', async () => {
      await remember({ ...mk('srv-a'), addresses: { home: HOME, away: AWAY } });
      await remember({ ...mk('srv-a'), addresses: { away: 'https://new.example.com' } });
      expect(await knownAddresses('srv-a')).toEqual({
        home: HOME,
        away: 'https://new.example.com',
      });
      // A sign-in that says nothing about them keeps them.
      await remember(mk('srv-a'));
      expect(await knownAddresses('srv-a')).toEqual({
        home: HOME,
        away: 'https://new.example.com',
      });
    });

    it('another server never inherits them', async () => {
      await remember({ ...mk('old-id', 'https://same.example'), addresses: { home: HOME } });
      await remember(mk('new-id', 'https://same.example'));
      expect(await knownAddresses('new-id')).toBeUndefined();
      expect(await knownAddresses('old-id')).toBeUndefined();
    });

    it('rememberAddresses replaces them in place, and ignores an unknown server', async () => {
      await remember(mk('srv-a'));
      await remember(mk('srv-b'));
      await rememberAddresses('srv-a', { away: AWAY });
      expect(await knownAddresses('srv-a')).toEqual({ away: AWAY });
      expect((await list()).map((e) => e.serverId)).toEqual(['srv-b', 'srv-a']);
      await rememberAddresses('srv-a', undefined);
      expect((await list()).find((e) => e.serverId === 'srv-a')).not.toHaveProperty('addresses');
      await rememberAddresses('nope', { away: AWAY });
      expect(await list()).toHaveLength(2);
    });
  });
});
