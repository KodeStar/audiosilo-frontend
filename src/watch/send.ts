import type { ApiClient } from '@/api/client';
import { getDeviceName } from '@/lib/device';
import type { Connection } from '@/stores/session';

import { watchLink } from './link';
import {
  bookNeedsPair,
  buildBookMessage,
  buildPairMessage,
  signedInHere,
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

/**
 * Queue a book on the watch, bringing a `pair` first if it is not signed in to this connection
 * (the watch only holds a book for an account it is not signed in to, until it is). `signInLeft`:
 * the watch has not said it is signed in here, so the listener has a step left on it, whether this
 * book brought the pair or follows one already on its way.
 */
export async function sendBookToWatch(
  api: Pick<ApiClient, 'pair'>,
  connection: Connection,
  libraryId: number,
  book: WatchableBook,
): Promise<{ signInLeft: boolean }> {
  await refreshWatch();
  const { status, pairUntil } = useWatchStore.getState();
  if (bookNeedsPair(status.state, connection, pairUntil[connection.id], Date.now())) {
    await setUpWatch(api, connection);
  }
  await watchLink.sendBook(buildBookMessage(connection, libraryId, book)).catch(refused);
  return { signInLeft: !signedInHere(status.state, connection) };
}
