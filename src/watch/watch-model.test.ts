import type { Book, PairingPayload } from '@/api/types';

import {
  bookNeedsPair,
  buildBookMessage,
  buildPairMessage,
  NO_WATCH,
  parseWatchState,
  sendToWatchVisible,
  serverServesWatch,
  signedInHere,
  type WatchState,
  watchCardStatus,
  watchCardVisible,
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
  it('carries the fields the watch decodes, the addresses merged', () => {
    const at = Date.UTC(2026, 10, 5, 12, 0, 0);
    expect(buildPairMessage(payload, connection, "Ada's iPhone", at)).toEqual({
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
    expect(buildBookMessage(connection, 3, book)).toEqual({
      v: 1,
      type: 'book',
      server_id: 'srv',
      user_id: 7,
      library_id: 3,
      path: 'Author/Book',
      title: 'Book',
      author: 'Author',
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
