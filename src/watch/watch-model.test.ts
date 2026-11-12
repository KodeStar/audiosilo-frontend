import type { Book, PairingPayload } from '@/api/types';
import en from '@/i18n/locales/en.json';

import {
  bookNeedsPair,
  buildBookMessage,
  buildPairMessage,
  buildRemoveMessage,
  NO_WATCH,
  parseTransfers,
  parseWatchState,
  sendToWatchVisible,
  serverServesWatch,
  signedInHere,
  watchAccountOf,
  type WatchState,
  watchCardStatus,
  watchCardVisible,
  watchKindOf,
  watchSectionVisible,
  watchWording,
} from './watch-model';

const connection = {
  id: 'srv.7',
  serverId: 'srv',
  serverUrl: 'https://paired.example',
  name: 'Hearthside',
  user: { id: 7, username: 'ada' },
  addresses: { home: 'http://192.168.1.5:8080' },
};
const payload: Pick<PairingPayload, 'server_name' | 'base_url' | 'pairing_token' | 'addresses'> = {
  server_name: 'Hearthside',
  base_url: 'https://books.example',
  pairing_token: 'tok',
  addresses: { away: 'https://away.example' },
};
const signedIn: WatchState = {
  signed_in: true,
  server_id: 'srv',
  user_id: 7,
  books: [],
  unsent_events: 0,
  couldnt_sync: 0,
};
const account = { id: 7 };

describe('buildPairMessage', () => {
  it('carries the collision-only display label without changing watch account identity', () => {
    const other = {
      ...connection,
      id: 'other.7',
      serverId: 'other',
      serverUrl: 'https://other.example',
    };
    const message = buildPairMessage(payload, connection, 'iPhone', 0, [connection, other]);
    expect(message.server_name).toBe('Hearthside (paired.example)');
    expect(message.server_id).toBe('srv');
    expect(message.user_id).toBe(7);
    expect(message.server_url).toBe('https://paired.example');
    const sameServer = { ...connection, id: 'srv.8', user: { id: 8, username: 'sam' } };
    expect(
      buildPairMessage(payload, connection, 'iPhone', 0, [connection, sameServer]).server_name,
    ).toBe('Hearthside');
  });

  it('carries the fields the watch decodes, the addresses merged', () => {
    const at = Date.UTC(2026, 10, 5, 12, 0, 0);
    expect(
      buildPairMessage(payload, connection, "Ada's iPhone", at, [connection], at - 1000),
    ).toEqual({
      v: 1,
      type: 'pair',
      server_id: 'srv',
      server_name: 'Hearthside',
      user_id: 7,
      user_name: 'ada',
      base_url: 'https://books.example',
      server_url: 'https://paired.example',
      addresses: { home: 'http://192.168.1.5:8080', away: 'https://away.example' },
      pairing_token: 'tok',
      expires_at: '2026-11-05T12:00:00.000Z',
      phone_name: "Ada's iPhone",
      sent_at: '2026-11-05T11:59:59.000Z',
    });
  });

  it('sends no nulls or undefined values with no address to tell', () => {
    const message = buildPairMessage(
      { ...payload, addresses: undefined, server_name: '' },
      { ...connection, addresses: undefined },
      'iPhone',
      0,
    );
    expect(message.addresses).toEqual({});
    expect(message.server_name).toBe('Hearthside');
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });

  it('names the server of a legacy connection by its id', () => {
    const legacy = { ...connection, id: 'srv', serverId: undefined };
    expect(buildPairMessage(payload, legacy, 'iPhone', 0).server_id).toBe('srv');
  });
});

describe('buildBookMessage', () => {
  const book: Pick<Book, 'rel_path' | 'title' | 'author'> = {
    rel_path: 'Author/Book',
    title: 'Book',
    author: 'Author',
  };

  it('names the book by library and path, for this account', () => {
    expect(buildBookMessage(connection, 3, book, Date.UTC(2026, 10, 12, 10))).toEqual({
      v: 1,
      type: 'book',
      server_id: 'srv',
      user_id: 7,
      library_id: 3,
      path: 'Author/Book',
      title: 'Book',
      author: 'Author',
      sent_at: '2026-11-12T10:00:00.000Z',
    });
  });

  it('leaves out an author it does not have (property lists take no nulls)', () => {
    expect(buildBookMessage(connection, 3, { ...book, author: '' })).not.toHaveProperty('author');
  });
});

describe('parseWatchState', () => {
  const wire = {
    v: 1,
    type: 'watch-state',
    signed_in: true,
    server_id: 'srv',
    user_id: 7,
    app_version: '2.6.0',
    books: [
      { library_id: 1, path: 'A/B', title: 'B', state: 'ready', bytes: 1024 },
      { library_id: 1, path: 'A/C', title: 'C', state: 'downloading' },
    ],
    unsent_events: 3,
    couldnt_sync: 1,
    last_sync_at: '2026-11-05T10:00:00.000Z',
  };

  it('reads what the watch encodes', () => {
    expect(parseWatchState(wire)).toEqual({
      signed_in: true,
      server_id: 'srv',
      user_id: 7,
      books: [
        { library_id: 1, path: 'A/B', title: 'B', state: 'ready', bytes: 1024 },
        { library_id: 1, path: 'A/C', title: 'C', state: 'downloading' },
      ],
      unsent_events: 3,
      couldnt_sync: 1,
      last_sync_at: '2026-11-05T10:00:00.000Z',
    });
  });

  it('reads a signed-out watch, which omits the optional fields', () => {
    const state = parseWatchState({
      v: 1,
      type: 'watch-state',
      signed_in: false,
      app_version: '2.6.0',
      books: [],
      unsent_events: 0,
      couldnt_sync: 0,
    });
    expect(state?.signed_in).toBe(false);
    expect(state?.server_id).toBeUndefined();
  });

  it('ignores a newer version, another type and anything not a message', () => {
    expect(parseWatchState({ ...wire, v: 2 })).toBeNull();
    expect(parseWatchState({ ...wire, type: 'other' })).toBeNull();
    expect(parseWatchState(null)).toBeNull();
    expect(parseWatchState(undefined)).toBeNull();
    expect(parseWatchState('watch-state')).toBeNull();
  });

  it('keeps going past a bad book or a state it does not know', () => {
    const state = parseWatchState({
      ...wire,
      books: [{ path: 'no library' }, 'nonsense', { library_id: 1, path: 'A/B', state: 'paused' }],
    });
    expect(state?.books).toEqual([{ library_id: 1, path: 'A/B', title: 'A/B', state: 'queued' }]);
  });
});

describe('signedInHere', () => {
  it('is this very server and user', () => {
    expect(signedInHere(signedIn, connection)).toBe(true);
    expect(signedInHere({ ...signedIn, server_id: 'other' }, connection)).toBe(false);
    expect(signedInHere({ ...signedIn, user_id: 8 }, connection)).toBe(false);
    expect(signedInHere({ ...signedIn, signed_in: false }, connection)).toBe(false);
    expect(signedInHere(null, connection)).toBe(false);
  });
});

describe('bookNeedsPair', () => {
  const now = 1_000_000;

  it('needs none once the watch is signed in here', () => {
    expect(bookNeedsPair(signedIn, connection, undefined, now)).toBe(false);
  });

  it('needs one when the watch is signed in elsewhere or has said nothing', () => {
    expect(bookNeedsPair(null, connection, undefined, now)).toBe(true);
    expect(bookNeedsPair({ ...signedIn, user_id: 8 }, connection, undefined, now)).toBe(true);
  });

  it('follows a pair on its way with time left, not one about to run out', () => {
    expect(bookNeedsPair(null, connection, now + 5 * 60_000, now)).toBe(false);
    expect(bookNeedsPair(null, connection, now + 60_000, now)).toBe(true);
    expect(bookNeedsPair(null, connection, now - 1, now)).toBe(true);
  });
});

describe('visibility', () => {
  const paired = { ...NO_WATCH, paired: true };
  const installed = { ...paired, installed: true };

  it('shows the card for a paired watch, app installed or not', () => {
    expect(watchCardVisible(paired, account)).toBe(true);
    expect(watchCardVisible(installed, account)).toBe(true);
  });

  it('hides the card with no paired watch (web, Android, no watch at all)', () => {
    expect(watchCardVisible(NO_WATCH, account)).toBe(false);
  });

  it('hides the card from a kid and from a demo account', () => {
    expect(watchCardVisible(installed, { id: 7, member_kind: 'kid' })).toBe(false);
    expect(watchCardVisible(installed, { id: 7, is_demo: true })).toBe(false);
    expect(watchCardVisible(installed, { id: 7, member_kind: 'grownup' })).toBe(true);
    expect(watchCardVisible(installed, { id: 0 })).toBe(false);
  });

  it('offers Send to watch only with the app installed and the rendition advertised', () => {
    expect(sendToWatchVisible(installed, account, ['watch'])).toBe(true);
    expect(sendToWatchVisible(paired, account, ['watch'])).toBe(false);
    expect(sendToWatchVisible(NO_WATCH, account, ['watch'])).toBe(false);
    expect(sendToWatchVisible(installed, account, [])).toBe(false);
    expect(sendToWatchVisible(installed, account, undefined)).toBe(false);
  });

  it('does not offer Send to watch to a kid or a demo account', () => {
    expect(sendToWatchVisible(installed, { id: 7, member_kind: 'kid' }, ['watch'])).toBe(false);
    expect(sendToWatchVisible(installed, { id: 7, is_demo: true }, ['watch'])).toBe(false);
  });

  it('reads the rendition kinds', () => {
    expect(serverServesWatch(['watch'])).toBe(true);
    expect(serverServesWatch(['other'])).toBe(false);
    expect(serverServesWatch(undefined)).toBe(false);
  });
});

describe('watchCardStatus', () => {
  const installed = { paired: true, installed: true, state: null };
  const now = 1_000_000;

  it('asks to install first', () => {
    expect(watchCardStatus({ ...installed, installed: false }, connection, now + 1, now)).toBe(
      'install',
    );
  });

  it('offers set up with nothing sent', () => {
    expect(watchCardStatus(installed, connection, undefined, now)).toBe('setup');
    expect(
      watchCardStatus(
        { ...installed, state: { ...signedIn, signed_in: false, server_id: undefined } },
        connection,
        undefined,
        now,
      ),
    ).toBe('setup');
  });

  it('says a pair is on its way, then that it ran out in transit', () => {
    expect(watchCardStatus(installed, connection, now + 1, now)).toBe('sent');
    expect(watchCardStatus(installed, connection, now, now)).toBe('expired');
  });

  it('says signed in once the watch does, whatever was sent', () => {
    const here = { ...installed, state: signedIn };
    expect(watchCardStatus(here, connection, undefined, now)).toBe('signed-in');
    expect(watchCardStatus(here, connection, now - 1, now)).toBe('signed-in');
  });

  it('names another account as such', () => {
    const elsewhere = { ...installed, state: { ...signedIn, user_id: 8 } };
    expect(watchCardStatus(elsewhere, connection, undefined, now)).toBe('other-account');
  });
});

describe('the remove message', () => {
  it('names the account and the book by path, and nothing else', () => {
    expect(buildRemoveMessage(connection, 3, 'A/B', Date.UTC(2026, 10, 12, 10))).toEqual({
      v: 1,
      type: 'remove',
      server_id: 'srv',
      user_id: 7,
      library_id: 3,
      path: 'A/B',
      sent_at: '2026-11-12T10:00:00.000Z',
    });
  });
});

describe('sent_at', () => {
  // Wear OS: each send is a new Data Layer item (an identical one sends nothing), the watch orders a
  // remove against a later download by it, and its receipt echoes it. The Apple Watch ignores it.
  it('stamps every message with when it was sent, by default now', () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 12, 9, 30) });
    try {
      const book = { rel_path: 'A/B', title: 'B', author: '' };
      expect(buildPairMessage(payload, connection, 'Pixel', 0).sent_at).toBe(
        '2026-11-12T09:30:00.000Z',
      );
      expect(buildBookMessage(connection, 3, book).sent_at).toBe('2026-11-12T09:30:00.000Z');
      expect(buildRemoveMessage(connection, 3, 'A/B').sent_at).toBe('2026-11-12T09:30:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('makes a send again a different message', () => {
    const book = { rel_path: 'A/B', title: 'B', author: '' };
    expect(buildBookMessage(connection, 3, book, 1000)).not.toEqual(
      buildBookMessage(connection, 3, book, 2000),
    );
  });
});

describe('watch kind and wording', () => {
  it('pairs an Android phone with a Wear OS watch, anything else with an Apple Watch', () => {
    expect(watchKindOf('android')).toBe('wear');
    expect(watchKindOf('ios')).toBe('apple');
    expect(watchKindOf('web')).toBe('apple');
  });

  it('never names the Apple Watch on a Wear OS phone', () => {
    expect(watchWording('wear', 'account.watch.title')).toBe('account.watch.titleWear');
    expect(watchWording('wear', 'account.watch.setUp')).toBe('account.watch.setUpWear');
    expect(watchWording('wear', 'downloads.watch.title')).toBe('downloads.watch.titleWear');
    expect(en.account.watch.titleWear).not.toMatch(/Apple/);
    expect(en.account.watch.setUpWear).not.toMatch(/Apple/);
    expect(en.downloads.watch.titleWear).not.toMatch(/Apple/);
  });

  it('never asks a Wear OS watch to be opened: its listener takes what is sent', () => {
    for (const key of [
      'account.watch.sent',
      'library.bookActions.sentToWatchPair',
      'downloads.watch.phase.delivered',
      'downloads.watch.phase.removing',
    ] as const) {
      const wear = watchWording('wear', key);
      expect(wear).toBe(`${key}Wear`);
      const text = wear.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], en);
      expect(text).not.toMatch(/open/i);
    }
  });

  it('keeps the Apple Watch texts, and every other text, as they are', () => {
    expect(watchWording('apple', 'account.watch.title')).toBe('account.watch.title');
    expect(watchWording('apple', 'account.watch.sent')).toBe('account.watch.sent');
    expect(watchWording('wear', 'account.watch.sendAgain')).toBe('account.watch.sendAgain');
    expect(watchWording('wear', 'downloads.watch.phase.undelivered')).toBe(
      'downloads.watch.phase.undelivered',
    );
  });
});

describe('parseTransfers', () => {
  const book = { type: 'book', server_id: 'srv', user_id: 7, library_id: 3, path: 'A/B' };

  it('reads what is undelivered, and what failed', () => {
    expect(parseTransfers([book, { ...book, type: 'remove', failed: true }])).toEqual([
      { type: 'book', account: 'srv.7', library_id: 3, path: 'A/B', failed: false },
      { type: 'remove', account: 'srv.7', library_id: 3, path: 'A/B', failed: true },
    ]);
  });

  it('leaves out what it cannot read, and takes anything for none', () => {
    expect(parseTransfers(null)).toEqual([]);
    expect(parseTransfers('x')).toEqual([]);
    expect(
      parseTransfers([
        { ...book, type: 'pair' },
        { ...book, user_id: undefined },
        { ...book, path: 3 },
        7,
      ]),
    ).toEqual([]);
  });
});

describe('watchSectionVisible', () => {
  const account = { id: 7 };
  const installed = { paired: true, installed: true };

  it('needs a paired watch with the app on it', () => {
    expect(watchSectionVisible(installed, account)).toBe(true);
    expect(watchSectionVisible({ paired: true, installed: false }, account)).toBe(false);
    expect(watchSectionVisible(NO_WATCH, account)).toBe(false);
  });

  it('is not for a kid, a demo or an account with no user id yet', () => {
    expect(watchSectionVisible(installed, { id: 7, member_kind: 'kid' })).toBe(false);
    expect(watchSectionVisible(installed, { id: 7, is_demo: true })).toBe(false);
    expect(watchSectionVisible(installed, { id: 0 })).toBe(false);
  });
});

describe('watchAccountOf', () => {
  it('is the same id for either form of a connection id', () => {
    expect(watchAccountOf({ id: 'srv.7', user: { id: 7, username: 'a' } })).toBe('srv.7');
    expect(watchAccountOf({ id: 'srv', user: { id: 7, username: 'a' } })).toBe('srv.7');
  });
});
