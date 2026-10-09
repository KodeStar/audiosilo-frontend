import AsyncStorage from '@react-native-async-storage/async-storage';

import { contentKey } from '@/lib/content-key';

import {
  CONNECTION_ALIASES_KEY,
  connectionAliases,
  connectionIdOf,
  isLegacyConnectionId,
  loadConnectionAliases,
  parseAliases,
  parseConnectionId,
  resolveConnectionId,
  serverIdOf,
  setConnectionAliases,
  usableUserId,
} from './connection-id';

afterEach(() => setConnectionAliases({}));

describe('connectionIdOf', () => {
  it('joins the server and the user with a dot', () => {
    expect(connectionIdOf('Xy_9-abc', 3)).toBe('Xy_9-abc.3');
  });

  it('stays inside the secure-store key alphabet, and a contentKey still splits on its first colon', () => {
    const id = connectionIdOf('Ab-_09xyzQ', 42);
    expect(`audiosilo.token.${id}`).toMatch(/^[\w.-]+$/);
    const key = contentKey(id, 1, 'Author/Book: Part 1');
    expect(key.slice(0, key.indexOf(':'))).toBe(id);
  });

  it('gives the legacy form for a user id that cannot be part of one', () => {
    expect(connectionIdOf('srv', undefined)).toBe('srv');
    expect(connectionIdOf('srv', null)).toBe('srv');
    expect(connectionIdOf('srv', 0)).toBe('srv');
    expect(connectionIdOf('srv', -2)).toBe('srv');
    expect(connectionIdOf('srv', 1.5)).toBe('srv');
  });
});

describe('usableUserId', () => {
  it('is a positive safe integer, else null', () => {
    expect(usableUserId({ id: 7 })).toBe(7);
    expect(usableUserId({ id: '7' })).toBeNull();
    expect(usableUserId({})).toBeNull();
    expect(usableUserId(null)).toBeNull();
    expect(usableUserId({ id: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
  });
});

describe('parseConnectionId / isLegacyConnectionId', () => {
  it('reads the server and the user of a new id', () => {
    expect(parseConnectionId('srv.3')).toEqual({ serverId: 'srv', userId: 3 });
    expect(isLegacyConnectionId('srv.3')).toBe(false);
  });

  it('reads a legacy id as the server alone', () => {
    expect(parseConnectionId('Xy_9-abc')).toEqual({ serverId: 'Xy_9-abc' });
    expect(isLegacyConnectionId('Xy_9-abc')).toBe(true);
  });

  it('round-trips connectionIdOf', () => {
    expect(parseConnectionId(connectionIdOf('a-b_c', 12))).toEqual({
      serverId: 'a-b_c',
      userId: 12,
    });
  });

  it('treats anything without a numeric user part as legacy', () => {
    expect(isLegacyConnectionId('srv.')).toBe(true);
    expect(isLegacyConnectionId('srv.x')).toBe(true);
    expect(isLegacyConnectionId('srv.0')).toBe(true);
  });
});

describe('serverIdOf', () => {
  it('prefers the connection serverId', () => {
    expect(serverIdOf({ id: 'srv.3', serverId: 'srv' })).toBe('srv');
  });

  it('reads it from the id when absent: a legacy id IS the server_id', () => {
    expect(serverIdOf({ id: 'srv' })).toBe('srv');
    expect(serverIdOf({ id: 'srv.5' })).toBe('srv');
  });

  it('two users of one server have the same server', () => {
    const a = { id: connectionIdOf('srv', 3), serverId: 'srv' };
    const b = { id: connectionIdOf('srv', 5) };
    expect(a.id).not.toBe(b.id);
    expect(serverIdOf(a)).toBe(serverIdOf(b));
  });
});

describe('aliases', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('maps an old id to its new one, and anything else to itself', () => {
    setConnectionAliases({ srv: 'srv.3' });
    expect(resolveConnectionId('srv')).toBe('srv.3');
    expect(resolveConnectionId('srv.3')).toBe('srv.3');
    expect(resolveConnectionId('other')).toBe('other');
    expect(resolveConnectionId('')).toBe('');
  });

  it('never loops on a corrupt chain', () => {
    setConnectionAliases({ a: 'b', b: 'a' });
    expect(['a', 'b']).toContain(resolveConnectionId('a'));
  });

  it('ignores prototype names', () => {
    expect(resolveConnectionId('constructor')).toBe('constructor');
    expect(resolveConnectionId('__proto__')).toBe('__proto__');
  });

  it('parseAliases keeps only string pairs that differ', () => {
    expect(parseAliases({ a: 'a.1', b: 3, c: '', d: 'd', '': 'x' })).toEqual({ a: 'a.1' });
    expect(parseAliases(['a'])).toEqual({});
    expect(parseAliases(null)).toEqual({});
  });

  it('loads the stored document, keeping any set in this runtime', async () => {
    await AsyncStorage.setItem(CONNECTION_ALIASES_KEY, JSON.stringify({ old: 'old.2', x: 9 }));
    setConnectionAliases({ mine: 'mine.4' });
    await loadConnectionAliases();
    expect(connectionAliases()).toEqual({ old: 'old.2', mine: 'mine.4' });
    expect(resolveConnectionId('old')).toBe('old.2');
  });

  it('loads nothing from a missing or corrupt document (never rejects)', async () => {
    await AsyncStorage.setItem(CONNECTION_ALIASES_KEY, '{nope');
    await expect(loadConnectionAliases()).resolves.toBeUndefined();
    expect(connectionAliases()).toEqual({});
  });
});
