import type { PeopleList, Progress } from '@/api/types';

import {
  bookTotal,
  hostOf,
  isFirstConnection,
  joinList,
  knownToOffer,
  latestPlace,
  looksLikeHomeAddress,
  pairingAddresses,
  readyLine,
  reconnectAddress,
  repairPlan,
  revealOffset,
  scanParams,
} from './connect-model';

const HOME = 'http://192.168.1.20:8080';
const AWAY = 'https://books.example.com';

describe('pairingAddresses', () => {
  it('keeps the home address a link carried when the answer (read through away) has none', () => {
    expect(pairingAddresses({ home: HOME, away: AWAY }, { away: AWAY })).toEqual({
      home: HOME,
      away: AWAY,
    });
  });

  it("takes the answer's away address over the link's", () => {
    expect(pairingAddresses({ away: 'https://old.example.com' }, { away: AWAY })).toEqual({
      away: AWAY,
    });
  });

  it('keeps what the link said when the answer says nothing (an older server)', () => {
    expect(pairingAddresses({ home: HOME }, undefined)).toEqual({ home: HOME });
  });

  it('drops malformed values and is undefined when nothing is left', () => {
    expect(pairingAddresses({ home: 'ftp://nas', away: 42 }, {})).toBeUndefined();
    expect(pairingAddresses(undefined, undefined)).toBeUndefined();
  });
});

describe('repairPlan', () => {
  const conn = {
    id: 'srv-1',
    serverUrl: HOME,
    addresses: { home: HOME, away: AWAY },
  };

  it('keeps the paired address when the same server answers through its away address', () => {
    expect(
      repairPlan({ pending: AWAY, serverId: 'srv-1', connections: [conn], answer: { away: AWAY } }),
    ).toEqual({ serverUrl: HOME, addresses: { away: AWAY } });
  });

  it('stores a new address for the same server when it is not one of its own', () => {
    const moved = 'https://new.example.com';
    expect(repairPlan({ pending: moved, serverId: 'srv-1', connections: [conn] })).toEqual({
      serverUrl: moved,
      addresses: undefined,
    });
  });

  it('carries a reset server over to its new identity: old serverUrl and addresses', () => {
    expect(
      repairPlan({
        pending: AWAY,
        serverId: 'srv-2',
        connections: [conn],
        reconnectId: 'srv-1',
        answer: { away: AWAY },
      }),
    ).toEqual({ serverUrl: HOME, addresses: { home: HOME, away: AWAY } });
  });

  it('does not carry anything over without the reconnect it was started for', () => {
    expect(
      repairPlan({ pending: AWAY, serverId: 'srv-2', connections: [conn], answer: undefined }),
    ).toEqual({ serverUrl: AWAY, addresses: undefined });
  });

  it('a new server keeps the typed address', () => {
    expect(repairPlan({ pending: AWAY, serverId: 'x', connections: [] })).toEqual({
      serverUrl: AWAY,
      addresses: undefined,
    });
  });
});

it('isFirstConnection: only with no connection before', () => {
  expect(isFirstConnection([])).toBe(true);
  expect(isFirstConnection([{}])).toBe(false);
});

describe('reconnectAddress', () => {
  const entry = { serverId: 'srv-1', serverUrl: AWAY, name: 'Hearthside' };
  const at = (answers: Record<string, string>) => {
    const probe = jest.fn(async (url: string) => answers[url] ?? null);
    return probe;
  };

  it('uses the home address only when the server answers there as itself', async () => {
    const home = { ...entry, addresses: { home: HOME, away: AWAY } };
    await expect(reconnectAddress(home, at({ [HOME]: 'srv-1' }), false)).resolves.toBe(HOME);
    // Another box at the same private IP: away.
    await expect(reconnectAddress(home, at({ [HOME]: 'other' }), false)).resolves.toBe(AWAY);
    await expect(reconnectAddress(home, at({}), false)).resolves.toBe(AWAY);
  });

  it('falls back to the remembered address without an away one', async () => {
    const homeOnly = { ...entry, serverUrl: 'https://paired.example', addresses: { home: HOME } };
    await expect(reconnectAddress(homeOnly, at({}), false)).resolves.toBe('https://paired.example');
  });

  it('asks nothing on the web or without a home address', async () => {
    const probe = at({ [HOME]: 'srv-1' });
    const home = { ...entry, addresses: { home: HOME, away: AWAY } };
    await expect(reconnectAddress(home, probe, true)).resolves.toBe(AWAY);
    await expect(reconnectAddress(entry, probe, false)).resolves.toBe(AWAY);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('looksLikeHomeAddress', () => {
  it.each([
    ['192.168.1.20:8080', true],
    ['http://10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.31.255.1', true],
    ['172.32.0.1', false],
    ['169.254.10.1', true],
    ['100.64.0.1', false],
    ['8.8.8.8', false],
    ['http://[fd12:3456::1]:8080', true],
    ['http://[fe80::1]', true],
    ['http://[2001:db8::1]', false],
    ['nas.local', true],
    ['books.lan:8080', true],
    ['shelf.home.arpa', true],
    ['nas', true],
    ['localhost:8080', false],
    ['127.0.0.1', false],
    ['http://[::1]', false],
    ['books.example.com', false],
    ['', false],
  ])('%s -> %s', (url, home) => {
    expect(looksLikeHomeAddress(url)).toBe(home);
  });
});

it('hostOf: host and port without scheme or path', () => {
  expect(hostOf('https://books.example.com:8443/base')).toBe('books.example.com:8443');
  expect(hostOf(HOME)).toBe('192.168.1.20:8080');
});

it('knownToOffer: only servers this device is not signed in to', () => {
  const a = { serverId: 'a', serverUrl: 'https://a', name: 'A' };
  const b = { serverId: 'b', serverUrl: 'https://b', name: 'B' };
  expect(knownToOffer([a, b], ['a'])).toEqual([b]);
  expect(knownToOffer([a, b], [])).toEqual([a, b]);
});

describe('revealOffset', () => {
  it('leaves a visible field alone', () => {
    expect(revealOffset({ fieldTop: 100, fieldBottom: 148, scrollY: 0, viewport: 400 })).toBeNull();
  });

  it('scrolls a field under the keyboard up, keeping a margin below it', () => {
    expect(revealOffset({ fieldTop: 500, fieldBottom: 548, scrollY: 0, viewport: 400 })).toBe(172);
  });

  it('scrolls back to a field above the view', () => {
    expect(revealOffset({ fieldTop: 50, fieldBottom: 98, scrollY: 200, viewport: 400 })).toBe(26);
  });

  it('aligns the top of a field taller than the view', () => {
    expect(
      revealOffset({ fieldTop: 300, fieldBottom: 900, scrollY: 0, viewport: 200, margin: 10 }),
    ).toBe(290);
  });

  it('does nothing before the view has a size', () => {
    expect(revealOffset({ fieldTop: 500, fieldBottom: 548, scrollY: 0, viewport: 0 })).toBeNull();
  });
});

describe('bookTotal', () => {
  const list = (books: number[], unknown = 0): PeopleList => ({
    people: books.map((n, i) => ({ name: `p${i}`, books: n, duration: 0 })),
    unknown,
  });

  it('counts every book once: each author value plus the unknown ones', () => {
    expect(bookTotal([list([3, 2], 1), list([4])])).toBe(10);
  });

  it('is null until every list has loaded', () => {
    expect(bookTotal([list([3]), undefined])).toBeNull();
  });

  it('is 0 with no libraries', () => {
    expect(bookTotal([])).toBe(0);
  });
});

describe('latestPlace', () => {
  const p = (path: string, updated: string, extra: Partial<Progress> = {}): Progress => ({
    library_id: 1,
    path,
    position: 100,
    duration: 1000,
    finished: false,
    playback_speed: 1,
    version: 1,
    device_id: 'd',
    updated_at: updated,
    ...extra,
  });

  it('is the newest book started and not finished', () => {
    const rows = [
      p('a', '2026-01-01T00:00:00Z'),
      p('b', '2026-03-01T00:00:00Z', { finished: true }),
      p('c', '2026-02-01T00:00:00Z'),
      p('d', '2026-04-01T00:00:00Z', { position: 0 }),
    ];
    expect(latestPlace(rows)?.path).toBe('c');
  });

  it('is undefined with nothing in progress', () => {
    expect(latestPlace(undefined)).toBeUndefined();
    expect(latestPlace([p('a', 'x', { finished: true })])).toBeUndefined();
  });
});

it('joinList joins with commas and the locale joiner', () => {
  const and = (rest: string, last: string) => `${rest} and ${last}`;
  expect(joinList([], and)).toBe('');
  expect(joinList(['Fiction'], and)).toBe('Fiction');
  expect(joinList(['Fiction', 'Kids'], and)).toBe('Fiction and Kids');
  expect(joinList(['Fiction', 'Kids', 'Podcasts'], and)).toBe('Fiction, Kids and Podcasts');
});

describe('readyLine', () => {
  it('waits for the libraries and the count', () => {
    expect(readyLine({ libraries: undefined, books: 3 })).toBeNull();
    expect(readyLine({ libraries: ['A'], books: undefined })).toBeNull();
  });

  it('names a few libraries with the book count', () => {
    expect(readyLine({ libraries: ['A', 'B'], books: 12 })).toEqual({
      kind: 'booksIn',
      books: 12,
      names: ['A', 'B'],
    });
  });

  it('counts many libraries instead of naming them', () => {
    expect(readyLine({ libraries: ['A', 'B', 'C', 'D', 'E'], books: 9 })).toEqual({
      kind: 'booksAcross',
      books: 9,
      libraries: 5,
    });
  });

  it('names the libraries alone when the server cannot count books', () => {
    expect(readyLine({ libraries: ['A'], books: null })).toEqual({
      kind: 'librariesIn',
      libraries: 1,
      names: ['A'],
    });
    expect(readyLine({ libraries: ['A', 'B', 'C', 'D', 'E'], books: null })).toEqual({
      kind: 'librariesCount',
      libraries: 5,
    });
  });

  it('is empty with no library or no book', () => {
    expect(readyLine({ libraries: [], books: 0 })).toEqual({ kind: 'empty' });
    expect(readyLine({ libraries: ['A'], books: 0 })).toEqual({ kind: 'empty' });
  });
});

it('scanParams carries the addresses only when the code has them', () => {
  expect(scanParams({ base: AWAY, token: 't' })).toEqual({ server: AWAY, token: 't' });
  expect(scanParams({ base: AWAY, token: 't', addresses: { home: HOME, away: AWAY } })).toEqual({
    server: AWAY,
    token: 't',
    home: HOME,
    away: AWAY,
  });
});
