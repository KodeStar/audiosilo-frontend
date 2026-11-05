import type { Book, PairingPayload, ServerAddresses, User } from '@/api/types';
import { isKidAccount } from '@/lib/account';
import { connectionIdOf, serverIdOf, usableUserId } from '@/lib/connection-id';
import { mergeAddresses } from '@/lib/server-address';
import { isRecord } from '@/lib/storage-keys';

/**
 * The phone's side of the phone-watch message contract and the rules around it, pure. The
 * watch's side is targets/watch/Core/PhoneMessages.swift: a field changed here changes there,
 * with tests on both. Every message carries `v: 1`; a newer one is ignored.
 */
const WATCH_MESSAGE_VERSION = 1;

/** The pairing token's life when it is minted for a watch: the most the server gives, since a
 * `transferUserInfo` waits until the watch is in reach. */
export const WATCH_PAIR_TTL_SECONDS = 600;

/** A book sent while a pair is on its way needs no second one, unless that one has less than
 * this left (it would run out before the watch has signed in). */
const PAIR_REUSE_MARGIN_MS = 60_000;

/** The server's rendition kind for a watch (`ServerInfo.renditions`). */
const WATCH_RENDITION = 'watch';

type PairMessage = {
  v: typeof WATCH_MESSAGE_VERSION;
  type: 'pair';
  server_id: string;
  server_name: string;
  user_id: number;
  user_name: string;
  base_url: string;
  server_url: string;
  addresses: ServerAddresses;
  pairing_token: string;
  /** RFC 3339. Past it the watch tries nothing and asks to send again. */
  expires_at: string;
  phone_name: string;
};

type BookMessage = {
  v: typeof WATCH_MESSAGE_VERSION;
  type: 'book';
  server_id: string;
  user_id: number;
  library_id: number;
  path: string;
  title: string;
  author?: string;
};

type RemoveMessage = {
  v: typeof WATCH_MESSAGE_VERSION;
  type: 'remove';
  server_id: string;
  user_id: number;
  library_id: number;
  path: string;
};

const WATCH_BOOK_STATES = ['queued', 'preparing', 'downloading', 'ready', 'failed'] as const;
type WatchBookState = (typeof WATCH_BOOK_STATES)[number];

export type WatchBook = {
  library_id: number;
  path: string;
  title: string;
  state: WatchBookState;
  bytes?: number;
};

/** `watch-state`: what the watch last said about itself. */
export type WatchState = {
  signed_in: boolean;
  server_id?: string;
  user_id?: number;
  books: WatchBook[];
  unsent_events: number;
  couldnt_sync: number;
  last_sync_at?: string;
};

/** A `book` or `remove` the session still holds, or (`failed`) could not deliver. */
export type WatchTransfer = {
  type: 'book' | 'remove';
  /** `<server_id>.<user_id>`, the account it names. */
  account: string;
  library_id: number;
  path: string;
  failed: boolean;
};

/** What the phone knows of its watch. With no watch link (web, Android) never `paired`.
 * `watchId` names this very watch, null where there is no app on it to name. */
export type WatchStatus = {
  paired: boolean;
  installed: boolean;
  state: WatchState | null;
  watchId: string | null;
  transfers: WatchTransfer[];
};

export const NO_WATCH: WatchStatus = {
  paired: false,
  installed: false,
  state: null,
  watchId: null,
  transfers: [],
};

/** The platform's way to the watch (`link.ts`, `link.ios.ts`; W4 adds Wear OS behind it). */
export type WatchLink = {
  supported: boolean;
  read: () => Promise<WatchStatus>;
  /** Told of every change, for as long as the app runs. */
  subscribe: (listener: (status: WatchStatus) => void) => void;
  /** Answers once the pair is ahead of anything sent after it. */
  sendPair: (message: PairMessage) => Promise<void>;
  sendBook: (message: BookMessage) => Promise<void>;
  sendRemove: (message: RemoveMessage) => Promise<void>;
};

/** Where there is no way to a watch. */
export const NO_WATCH_LINK: WatchLink = {
  supported: false,
  read: async () => NO_WATCH,
  subscribe: () => {},
  sendPair: async () => {},
  sendBook: async () => {},
  sendRemove: async () => {},
};

type WatchConnection = {
  id: string;
  serverId?: string;
  serverUrl: string;
  name: string;
  user: Pick<User, 'id' | 'username'>;
  addresses?: ServerAddresses;
};
type WatchAccount = Pick<WatchConnection, 'id' | 'serverId' | 'user'>;
type WatchUser = Pick<User, 'id' | 'is_demo' | 'member_kind'>;
export type WatchableBook = Pick<Book, 'rel_path' | 'title' | 'author'>;

/** The `pair` message for `connection`, from a token just minted (`POST /auth/pair`).
 * `expiresAt` is epoch ms. */
export function buildPairMessage(
  payload: Pick<PairingPayload, 'server_name' | 'base_url' | 'pairing_token' | 'addresses'>,
  connection: WatchConnection,
  phoneName: string,
  expiresAt: number,
): PairMessage {
  return {
    v: WATCH_MESSAGE_VERSION,
    type: 'pair',
    server_id: serverIdOf(connection),
    server_name: payload.server_name || connection.name,
    user_id: connection.user.id,
    user_name: connection.user.username,
    base_url: payload.base_url,
    server_url: connection.serverUrl,
    addresses: mergeAddresses(connection.addresses, payload.addresses) ?? {},
    pairing_token: payload.pairing_token,
    expires_at: new Date(expiresAt).toISOString(),
    phone_name: phoneName,
  };
}

/** The `book` message for one of `connection`'s books. No nulls or undefined values:
 * WatchConnectivity takes property lists only. */
export function buildBookMessage(
  connection: WatchAccount,
  libraryId: number,
  book: WatchableBook,
): BookMessage {
  return {
    v: WATCH_MESSAGE_VERSION,
    type: 'book',
    server_id: serverIdOf(connection),
    user_id: connection.user.id,
    library_id: libraryId,
    path: book.rel_path,
    title: book.title,
    ...(book.author ? { author: book.author } : {}),
  };
}

/** The `remove` message for one of `connection`'s books (phone to watch only). */
export function buildRemoveMessage(
  connection: WatchAccount,
  libraryId: number,
  path: string,
): RemoveMessage {
  return {
    v: WATCH_MESSAGE_VERSION,
    type: 'remove',
    server_id: serverIdOf(connection),
    user_id: connection.user.id,
    library_id: libraryId,
    path,
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const count = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0);

/** A received `watch-state`; null for anything else or a newer version. A state a newer watch
 * app names reads as `queued`, a book without its ids is left out. */
export function parseWatchState(raw: unknown): WatchState | null {
  if (!isRecord(raw) || raw.v !== WATCH_MESSAGE_VERSION || raw.type !== 'watch-state') return null;
  const books: WatchBook[] = [];
  for (const b of Array.isArray(raw.books) ? raw.books : []) {
    if (!isRecord(b) || typeof b.library_id !== 'number' || typeof b.path !== 'string') continue;
    books.push({
      library_id: b.library_id,
      path: b.path,
      title: str(b.title) ?? b.path,
      state: (WATCH_BOOK_STATES as readonly unknown[]).includes(b.state)
        ? (b.state as WatchBookState)
        : 'queued',
      bytes: num(b.bytes),
    });
  }
  return {
    signed_in: raw.signed_in === true,
    server_id: str(raw.server_id),
    user_id: num(raw.user_id),
    books,
    unsent_events: count(raw.unsent_events),
    couldnt_sync: count(raw.couldnt_sync),
    last_sync_at: str(raw.last_sync_at),
  };
}

/** The snapshot's `outstanding`; an entry that doesn't name a book of an account is left out. */
export function parseTransfers(raw: unknown): WatchTransfer[] {
  const out: WatchTransfer[] = [];
  for (const t of Array.isArray(raw) ? raw : []) {
    if (
      !isRecord(t) ||
      (t.type !== 'book' && t.type !== 'remove') ||
      typeof t.server_id !== 'string' ||
      typeof t.user_id !== 'number' ||
      typeof t.library_id !== 'number' ||
      typeof t.path !== 'string'
    ) {
      continue;
    }
    out.push({
      type: t.type,
      account: connectionIdOf(t.server_id, t.user_id),
      library_id: t.library_id,
      path: t.path,
      failed: t.failed === true,
    });
  }
  return out;
}

/** The account a connection is on the watch (`<server_id>.<user_id>`), the id a ledger row and a
 * transfer go by whichever form the connection's own id is in. */
export function watchAccountOf(connection: WatchAccount): string {
  return connectionIdOf(serverIdOf(connection), connection.user.id);
}

/** Whether the watch says it is signed in to this very connection (`<server_id>.<user_id>`). */
export function signedInHere(state: WatchState | null, connection: WatchAccount): boolean {
  return (
    !!state?.signed_in &&
    state.server_id === serverIdOf(connection) &&
    state.user_id === connection.user.id
  );
}

/** Whether a book for this connection has to bring a `pair`: the watch is not signed in to it
 * (as far as it last said) and none on its way has time left. `pairUntil`: when the last one
 * sent runs out, epoch ms. */
export function bookNeedsPair(
  state: WatchState | null,
  connection: WatchAccount,
  pairUntil: number | undefined,
  now: number,
): boolean {
  if (signedInHere(state, connection)) return false;
  return pairUntil === undefined || pairUntil - now <= PAIR_REUSE_MARGIN_MS;
}

/** Whether this account can sign a watch in: a kid's can't pair (403 `kid_account`), nor can a
 * demo's. A connection saved without a numeric user id can't be named to the watch until the
 * account page has read `/me`. */
function accountCanUseWatch(user: WatchUser) {
  return usableUserId(user) !== null && !user.is_demo && !isKidAccount(user);
}

/** The account page's Apple Watch card: a paired watch and an account that can use one. */
export function watchCardVisible(status: Pick<WatchStatus, 'paired'>, user: WatchUser): boolean {
  return status.paired && accountCanUseWatch(user);
}

/** The Downloads page's section: a paired watch with the app on it and an account that can use
 * one. */
export function watchSectionVisible(
  status: Pick<WatchStatus, 'paired' | 'installed'>,
  user: WatchUser,
): boolean {
  return status.paired && status.installed && accountCanUseWatch(user);
}

/** Whether the server can make what a watch plays (`renditions` holds `watch`). */
export function serverServesWatch(renditions: readonly string[] | undefined): boolean {
  return !!renditions?.includes(WATCH_RENDITION);
}

/** The book action Send to watch: a paired watch with the app installed, a server that serves
 * it (`renditions`, unknown while `/server` is) and an account that can use one. */
export function sendToWatchVisible(
  status: Pick<WatchStatus, 'paired' | 'installed'>,
  user: WatchUser,
  renditions: readonly string[] | undefined,
): boolean {
  return watchSectionVisible(status, user) && serverServesWatch(renditions);
}

export type WatchCardStatus =
  /** The watch has no AudioSilo yet. */
  | 'install'
  /** Nothing sent, and the watch is signed in to nothing. */
  | 'setup'
  /** A pair is on its way. */
  | 'sent'
  /** The pair sent ran out with the watch still not signed in here. */
  | 'expired'
  | 'signed-in'
  /** The watch is signed in to another account (a pair would replace it). */
  | 'other-account';

/** What the card says. `pairUntil`: when the pair last sent for this connection runs out. */
export function watchCardStatus(
  status: Pick<WatchStatus, 'installed' | 'state'>,
  connection: WatchAccount,
  pairUntil: number | undefined,
  now: number,
): WatchCardStatus {
  if (!status.installed) return 'install';
  if (signedInHere(status.state, connection)) return 'signed-in';
  if (pairUntil !== undefined) return now < pairUntil ? 'sent' : 'expired';
  return status.state?.signed_in ? 'other-account' : 'setup';
}
