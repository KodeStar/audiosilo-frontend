import type { ApiClient } from '@/api/client';
import { getDeviceName } from '@/lib/device';
import type { Connection } from '@/stores/session';

import { watchLink } from './link';
import { noteHandedOver, noteRemoving, noteSending, restoreRow } from './watch-ledger';
import {
  bookNeedsPair,
  buildBookMessage,
  buildPairMessage,
  buildRemoveMessage,
  signedInHere,
  watchAccountOf,
  WATCH_PAIR_TTL_SECONDS,
  type WatchableBook,
} from './watch-model';
import { notePairSent, refreshWatch, useWatchStore } from './watch-store';

/** The watch link refused a message (no ApiError: the server was never the problem). */
export class WatchSendError extends Error {}

const refused = (cause: unknown): never => {
  throw new WatchSendError('The watch link refused the message', { cause });
};

async function mintAndSendPair(api: Pick<ApiClient, 'pair'>, connection: Connection) {
  const asked = Date.now();
  const payload = await api.pair({ ttlSeconds: WATCH_PAIR_TTL_SECONDS });
  const expiresAt = asked + WATCH_PAIR_TTL_SECONDS * 1000;
  const message = buildPairMessage(payload, connection, getDeviceName(), expiresAt);
  await watchLink.sendPair(message).catch(refused);
  notePairSent(connection.id, expiresAt);
}

/** The pair being minted and sent, by connection id (up to 10 s with a watch slow to reply). */
const inFlight = new Map<string, Promise<void>>();

/**
 * Sign the watch in to `connection`: a new single-use pairing token each time, so a send again
 * never reuses one that may have run out or been used on the way. The expiry the watch gets
 * counts from before the request, but the server truncates its own to whole seconds, so this one
 * can run under a second later: only a hint, since the watch's exchange is what decides. A second
 * call while one is on its way joins it: two tokens would sign the watch in twice, leaving a
 * session behind.
 */
export function setUpWatch(api: Pick<ApiClient, 'pair'>, connection: Connection): Promise<void> {
  const running = inFlight.get(connection.id);
  if (running) return running;
  const sending = mintAndSendPair(api, connection).finally(() => inFlight.delete(connection.id));
  inFlight.set(connection.id, sending);
  return sending;
}

/** What is under way per book: its sends and Removes go one at a time, in the order asked. A send
 * can wait 10 s for its pair, and a Remove tapped meanwhile would reach the watch ahead of the `book`
 * it is about: the book would come all the same, under a row saying "removing". */
const underWay = new Map<string, Promise<unknown>>();

function inTurn<T>(
  connection: Connection,
  libraryId: number,
  path: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = `${watchAccountOf(connection)}:${libraryId}:${path}`;
  const ahead = underWay.get(key);
  // Nothing ahead: at once, so a row appears the moment Send is tapped.
  const run = ahead ? ahead.then(work, work) : work();
  underWay.set(key, run);
  const done = () => {
    if (underWay.get(key) === run) underWay.delete(key);
  };
  void run.then(done, done);
  return run;
}

async function sendBook(
  api: Pick<ApiClient, 'pair'>,
  connection: Connection,
  libraryId: number,
  book: WatchableBook,
): Promise<{ signInLeft: boolean }> {
  // The row appears now, whatever the sign-in ahead of it takes. Up to 5 s go by when the session
  // has yet to answer, so with no watch named yet the row waits for that.
  const account = watchAccountOf(connection);
  const row = {
    library_id: libraryId,
    path: book.rel_path,
    title: book.title,
    author: book.author,
  };
  let watchId = useWatchStore.getState().status.watchId;
  let before = watchId ? noteSending(watchId, account, row, Date.now()) : undefined;
  try {
    await refreshWatch();
    const { status, pairUntil } = useWatchStore.getState();
    // Named for the first time, or another watch now: the row goes where the book goes.
    if (status.watchId !== watchId) {
      if (watchId) restoreRow(watchId, account, row, before);
      watchId = status.watchId;
      before = watchId ? noteSending(watchId, account, row, Date.now()) : undefined;
    }
    if (bookNeedsPair(status.state, connection, pairUntil[connection.id], Date.now())) {
      await setUpWatch(api, connection);
    }
    await watchLink.sendBook(buildBookMessage(connection, libraryId, book)).catch(refused);
    // Read first: with the transfer in the answer, the row can't read as delivered in between.
    await refreshWatch();
    if (watchId) noteHandedOver(watchId, account, row);
    return { signInLeft: !signedInHere(status.state, connection) };
  } catch (e) {
    if (watchId) restoreRow(watchId, account, row, before);
    throw e;
  }
}

/**
 * Queue a book on the watch, bringing a `pair` first if it is not signed in to this connection
 * (the watch only holds a book for an account it is not signed in to, until it is). `signInLeft`:
 * the watch has not said it is signed in here, so the listener has a step left on it, whether this
 * book brought the pair or follows one already on its way.
 */
export function sendBookToWatch(
  api: Pick<ApiClient, 'pair'>,
  connection: Connection,
  libraryId: number,
  book: WatchableBook,
): Promise<{ signInLeft: boolean }> {
  return inTurn(connection, libraryId, book.rel_path, () =>
    sendBook(api, connection, libraryId, book),
  );
}

/**
 * Ask the watch to take a book off. It answers only by no longer listing it (or, on another
 * account, by naming that one), so the row says "removing" until then, here and after a restart.
 * A send again after this comes behind it, in order, and stands. Asked again from a delivered row,
 * it sends the same message and starts the row's hold limit over: the first may have died with the
 * watch app. If it did not, the repeat finds the book gone and does nothing, unless the book is back
 * on the watch by then (its own Download button): the message can't tell, so that copy goes too.
 */
export function removeFromWatch(
  connection: Connection,
  book: { library_id: number; path: string; title: string },
): Promise<void> {
  return inTurn(connection, book.library_id, book.path, async () => {
    const message = buildRemoveMessage(connection, book.library_id, book.path);
    await watchLink.sendRemove(message).catch(refused);
    const { watchId } = useWatchStore.getState().status;
    if (watchId) {
      noteRemoving(watchId, watchAccountOf(connection), book, Date.now());
    }
    await refreshWatch();
  });
}
