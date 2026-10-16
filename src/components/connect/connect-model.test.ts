import { ApiError, TimeoutError } from '@/api/client';
import type { PeopleList, Progress } from '@/api/types';
import { serverIdOf } from '@/lib/connection-id';
import type { PairingScan } from '@/lib/pairing';

import {
  httpFallback,
  bookTotal,
  isFirstConnection,
  knownToOffer,
  latestPlace,
  looksLikeHomeAddress,
  pairingFallback,
  readyLine,
  reconnectAddress,
  repairPlan,
  revealOffset,
  revealSpan,
  scanParams,
  selfSignedMayBeWhy,
  signedInAs,
  withFallback,
} from './connect-model';

const HOME = 'http://192.168.1.20:8080';
const AWAY = 'https://books.example.com';

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

  it("keeps a remembered server's paired address when signing in again through its home one", () => {
    const known = {
      serverId: 'srv-9',
      serverUrl: 'https://paired.example.com',
      name: 'Hearthside',
      addresses: { home: HOME },
    };
    expect(
      repairPlan({ pending: HOME, serverId: 'srv-9', connections: [], answer: undefined, known }),
    ).toEqual({ serverUrl: 'https://paired.example.com', addresses: undefined });
    // Another server answering, or an address that isn't the remembered server's: as typed.
    expect(repairPlan({ pending: HOME, serverId: 'other', connections: [], known })).toEqual({
      serverUrl: HOME,
      addresses: undefined,
    });
    expect(repairPlan({ pending: AWAY, serverId: 'srv-9', connections: [], known })).toEqual({
      serverUrl: AWAY,
      addresses: undefined,
    });
  });

  it('a new server keeps the typed address', () => {
    expect(repairPlan({ pending: AWAY, serverId: 'x', connections: [] })).toEqual({
      serverUrl: AWAY,
      addresses: undefined,
    });
  });

  describe('with connection ids that name the user (`<server_id>.<user_id>`)', () => {
    const sam = { ...conn, id: 'srv-1.3', serverId: 'srv-1', user: { id: 3 } };
    const kit = {
      id: 'srv-1.5',
      serverId: 'srv-1',
      serverUrl: 'https://kit.example',
      user: { id: 5 },
    };

    it('matches the connection to the server by its server_id, never its id', () => {
      expect(
        repairPlan({
          pending: AWAY,
          serverId: 'srv-1',
          connections: [sam],
          answer: { away: AWAY },
        }),
      ).toEqual({ serverUrl: HOME, addresses: { away: AWAY } });
      // The id alone (a fixture without serverId) is read the same way.
      const { serverId: _s, ...bare } = sam;
      expect(repairPlan({ pending: AWAY, serverId: 'srv-1', connections: [bare] })).toEqual({
        serverUrl: HOME,
        addresses: undefined,
      });
    });

    it("prefers the signing-in user's own connection on a server with several", () => {
      expect(
        repairPlan({
          pending: 'https://kit.example',
          serverId: 'srv-1',
          connections: [sam, kit],
          userId: 5,
        }),
      ).toEqual({ serverUrl: 'https://kit.example', addresses: undefined });
      // Another user signing in through one of the server's addresses: that server's.
      expect(
        repairPlan({ pending: AWAY, serverId: 'srv-1', connections: [sam, kit], userId: 9 }),
      ).toEqual({ serverUrl: HOME, addresses: undefined });
    });

    it('carries a reset server over from the reconnect it was started for', () => {
      expect(
        repairPlan({
          pending: AWAY,
          serverId: 'srv-2',
          connections: [sam],
          reconnectId: 'srv-1.3',
          answer: { away: AWAY },
          userId: 3,
        }),
      ).toEqual({ serverUrl: HOME, addresses: { home: HOME, away: AWAY } });
    });
  });
});

it('isFirstConnection: only with no connection before', () => {
  expect(isFirstConnection([])).toBe(true);
  expect(isFirstConnection([{}])).toBe(false);
});

describe('signedInAs', () => {
  const sam = { id: 'srv-1.2', serverId: 'srv-1', user: { id: 2 } };
  const chris = { id: 'srv-1.1', serverId: 'srv-1', user: { id: 1 } };
  const elsewhere = { id: 'srv-2.1', serverId: 'srv-2', user: { id: 1 } };

  it("is the user's own connection on that server", () => {
    expect(signedInAs([sam, elsewhere, chris], 'srv-1', 1)).toBe(chris);
    // A legacy id names the server too.
    const legacy = { id: 'srv-1', user: { id: 1 } };
    expect(signedInAs([legacy], 'srv-1', 1)).toBe(legacy);
  });

  it('is none for another user, another server, or a token the server refused', () => {
    expect(signedInAs([sam, elsewhere], 'srv-1', 1)).toBeUndefined();
    expect(signedInAs([chris], 'srv-2', 1)).toBeUndefined();
    expect(signedInAs([{ ...chris, needsReconnect: 'auth' }], 'srv-1', 1)).toBeUndefined();
    // Saved before user ids were kept: whose it is can't be told, so the link pairs.
    expect(signedInAs([{ id: 'srv-1', user: {} }], 'srv-1', 1)).toBeUndefined();
  });
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

describe('revealSpan', () => {
  it('runs from the focused field to the lowest notice under it', () => {
    // The Pixel: tapping the field again brought the keyboard up over the notice.
    expect(revealSpan({ top: 300, bottom: 350 }, [{ top: 370, bottom: 520 }])).toEqual({
      top: 300,
      bottom: 520,
    });
    expect(revealSpan({ top: 300, bottom: 350 }, [])).toEqual({ top: 300, bottom: 350 });
    expect(revealSpan(null, [{ top: 370, bottom: 520 }])).toEqual({ top: 370, bottom: 520 });
    expect(revealSpan(null, [])).toBeNull();
  });

  it('keeps the field in view first when the span is taller than the room', () => {
    const span = revealSpan({ top: 300, bottom: 350 }, [{ top: 370, bottom: 900 }])!;
    const to = revealOffset({
      fieldTop: span.top,
      fieldBottom: span.bottom,
      scrollY: 0,
      viewport: 400,
    });
    expect(to).toBe(300 - 24);
  });
});

describe('pairingFallback', () => {
  const BASE = 'https://192.168.1.205:8080';
  const SAME_HOST = 'http://192.168.1.205:8080';
  const SID = 'srv-home';
  const link = (home?: string, base = BASE, serverId = SID): PairingScan => ({
    base,
    token: 'tok',
    ...(home ? { addresses: { home } } : {}),
    ...(serverId ? { serverId } : {}),
  });
  const down = new TypeError('Network request failed');
  // Home answers as `answers` (null: no answer); records what was asked.
  const probeAs = (answers: string | null) => {
    const asked: string[] = [];
    const probe = async (url: string) => {
      asked.push(url);
      return answers;
    };
    return { asked, probe };
  };
  const fallback = (scan: PairingScan, error: unknown = down) =>
    pairingFallback(scan, error, probeAs(SID).probe);

  it("falls back to the link's plain-http home on the base's own host and port, as its server", async () => {
    const { asked, probe } = probeAs(SID);
    await expect(pairingFallback(link(SAME_HOST), down, probe)).resolves.toBe(SAME_HOST);
    expect(asked).toEqual([SAME_HOST]);
    await expect(fallback(link('http://NAS.local:8080', 'https://nas.local:8080'))).resolves.toBe(
      'http://NAS.local:8080',
    );
    await expect(fallback(link('http://[fd00::5]:8080', 'https://[fd00::5]:8080'))).resolves.toBe(
      'http://[fd00::5]:8080',
    );
  });

  it('never when home answers as another server, or not at all', async () => {
    const other = probeAs('srv-other');
    await expect(pairingFallback(link(SAME_HOST), down, other.probe)).resolves.toBeNull();
    expect(other.asked).toEqual([SAME_HOST]);
    await expect(pairingFallback(link(SAME_HOST), down, probeAs(null).probe)).resolves.toBeNull();
  });

  it("never without the server's id in the link (an older server), and then asks nothing", async () => {
    const { asked, probe } = probeAs(SID);
    await expect(pairingFallback(link(SAME_HOST, BASE, ''), down, probe)).resolves.toBeNull();
    expect(asked).toEqual([]);
  });

  it('never sends the token to a host or port the base did not name, and asks it nothing', async () => {
    const { asked, probe } = probeAs(SID);
    for (const scan of [
      link('http://192.168.1.99:8080'),
      link('http://192.168.1.205:8081'),
      link('http://evil.example:8080'),
      // No port named: https means 443 and http means 80, two different ports.
      link('http://nas.local', 'https://nas.local'),
    ]) {
      await expect(pairingFallback(scan, down, probe)).resolves.toBeNull();
    }
    expect(asked).toEqual([]);
  });

  it('only from an https base to a plain-http home', async () => {
    await expect(fallback(link('https://192.168.1.205:8080'))).resolves.toBeNull();
    await expect(fallback(link(SAME_HOST, SAME_HOST))).resolves.toBeNull();
  });

  it('not without a home address', async () => {
    await expect(fallback(link())).resolves.toBeNull();
    await expect(
      fallback({ ...link(), addresses: { away: 'https://books.example' } }),
    ).resolves.toBeNull();
  });

  it('not after a timeout: a host that never answered would only time out again', async () => {
    await expect(fallback(link(SAME_HOST), new TimeoutError(15000))).resolves.toBeNull();
  });
});

describe('withFallback', () => {
  const ask = (answers: Record<string, unknown>) => {
    const asked: string[] = [];
    const attempt = async (base: string) => {
      asked.push(base);
      const a = answers[base];
      if (a instanceof Error) throw a;
      return a;
    };
    return { asked, attempt };
  };
  const down = new TypeError('Network request failed');

  it('answers from the primary when it answers, without asking the fallback', async () => {
    const { asked, attempt } = ask({ a: 1 });
    await expect(withFallback('a', attempt, () => 'b')).resolves.toEqual({ answer: 1, base: 'a' });
    expect(asked).toEqual(['a']);
  });

  it('asks the fallback once when the primary could not connect', async () => {
    const { asked, attempt } = ask({ a: down, b: 2 });
    await expect(withFallback('a', attempt, () => 'b')).resolves.toEqual({ answer: 2, base: 'b' });
    expect(asked).toEqual(['a', 'b']);
  });

  it("never falls back after a server's own answer", async () => {
    const refused = new ApiError(401, 'expired');
    const { asked, attempt } = ask({ a: refused, b: 2 });
    await expect(withFallback('a', attempt, () => 'b')).rejects.toBe(refused);
    expect(asked).toEqual(['a']);
  });

  it("reports the fallback's server answer, else the primary's error", async () => {
    const boom = new ApiError(500, 'boom');
    await expect(withFallback('a', ask({ a: down, b: boom }).attempt, () => 'b')).rejects.toBe(
      boom,
    );
    await expect(
      withFallback('a', ask({ a: down, b: new TypeError('also down') }).attempt, () => 'b'),
    ).rejects.toBe(down);
    await expect(withFallback('a', ask({ a: down }).attempt, () => null)).rejects.toBe(down);
  });
});

describe('selfSignedMayBeWhy', () => {
  const down = new TypeError('Network request failed');

  it('for an https address on native that could not connect', () => {
    expect(selfSignedMayBeWhy('https://192.168.1.205:8080', down, false)).toBe(true);
    expect(selfSignedMayBeWhy('HTTPS://nas.local', down, false)).toBe(true);
  });

  it('never for plain http, the web, a timeout or a server that answered', () => {
    expect(selfSignedMayBeWhy('http://192.168.1.205:8080', down, false)).toBe(false);
    expect(selfSignedMayBeWhy('https://books.example', down, true)).toBe(false);
    expect(selfSignedMayBeWhy('https://books.example', new TimeoutError(15000), false)).toBe(false);
    expect(selfSignedMayBeWhy('https://books.example', new ApiError(500, 'boom'), false)).toBe(
      false,
    );
  });
});

describe('httpFallback', () => {
  it('offers plain http for an address typed without a scheme', () => {
    expect(httpFallback('mac-studio-3.local:18571')).toBe('http://mac-studio-3.local:18571');
    expect(httpFallback(' 192.168.1.20:8080/ ')).toBe('http://192.168.1.20:8080');
    expect(httpFallback('192.168.1.205:8080')).toBe('http://192.168.1.205:8080');
    expect(httpFallback('books.example.com/audiosilo')).toBe('http://books.example.com/audiosilo');
  });

  it('offers nothing when a scheme was typed, or for no address', () => {
    expect(httpFallback('https://mac-studio-3.local:18571')).toBeNull();
    expect(httpFallback('HTTP://books.example.com')).toBeNull();
    expect(httpFallback('')).toBeNull();
    expect(httpFallback('   ')).toBeNull();
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

it('knownToOffer: only servers this device is not signed in to', () => {
  const a = { serverId: 'a', serverUrl: 'https://a', name: 'A' };
  const b = { serverId: 'b', serverUrl: 'https://b', name: 'B' };
  expect(knownToOffer([a, b], ['a'])).toEqual([b]);
  expect(knownToOffer([a, b], [])).toEqual([a, b]);
});

it('knownToOffer: fed the signed-in servers (serverIdOf), not connection ids', () => {
  const a = { serverId: 'a', serverUrl: 'https://a', name: 'A' };
  const b = { serverId: 'b', serverUrl: 'https://b', name: 'B' };
  const connections = [{ id: 'a.3', serverId: 'a' }, { id: 'legacy' }];
  expect(knownToOffer([a, b], connections.map(serverIdOf))).toEqual([b]);
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

it("scanParams carries the addresses, the server's id, the user and the book only when the code has them", () => {
  expect(scanParams({ base: AWAY, token: 't' })).toEqual({ server: AWAY, token: 't' });
  expect(
    scanParams({
      base: AWAY,
      token: 't',
      addresses: { home: HOME, away: AWAY },
      serverId: 'srv-1',
      userId: 1,
      book: { libraryId: 2, path: 'A/B & C' },
    }),
  ).toEqual({
    server: AWAY,
    token: 't',
    home: HOME,
    away: AWAY,
    sid: 'srv-1',
    uid: '1',
    book: '2',
    path: 'A/B & C',
  });
});
