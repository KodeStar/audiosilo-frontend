import type { ApiClient } from '@/api/client';
import type { Book } from '@/api/types';
import { getDeviceName } from '@/lib/device';
import type { Connection } from '@/stores/session';

import { watchLink } from './link';
import {
  bookNeedsPair,
  buildBookMessage,
  buildPairMessage,
  WATCH_PAIR_TTL_SECONDS,
} from './watch-model';
import { notePairSent, refreshWatch, useWatchStore } from './watch-store';

/** The watch link refused a message (no ApiError: the server was never the problem). */
export class WatchSendError extends Error {}

async function deliver(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (e) {
    throw new WatchSendError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Sign the watch in to `connection`: a new single-use pairing token each time, so a send again
 * never reuses one that may have run out or been used on the way. The expiry the watch gets
 * counts from before the request, so it is never later than the server's own.
 */
export async function setUpWatch(api: Pick<ApiClient, 'pair'>, connection: Connection) {
  const asked = Date.now();
  const payload = await api.pair({ ttlSeconds: WATCH_PAIR_TTL_SECONDS });
  const expiresAt = asked + WATCH_PAIR_TTL_SECONDS * 1000;
  const message = buildPairMessage(payload, connection, getDeviceName(), expiresAt);
  await deliver(() => watchLink.sendPair(message));
  notePairSent(connection.id, expiresAt);
}

/**
 * Queue a book on the watch, bringing a `pair` first if it is not signed in to this connection
 * (the watch drops a book for an account it does not hold). Says whether it did: the listener
 * then has a step left on the watch.
 */
export async function sendBookToWatch(
  api: Pick<ApiClient, 'pair'>,
  connection: Connection,
  libraryId: number,
  book: Pick<Book, 'rel_path' | 'title' | 'author'>,
): Promise<{ paired: boolean }> {
  await refreshWatch();
  const { status, pairUntil } = useWatchStore.getState();
  const paired = bookNeedsPair(status.state, connection, pairUntil[connection.id], Date.now());
  if (paired) await setUpWatch(api, connection);
  await deliver(() => watchLink.sendBook(buildBookMessage(connection, libraryId, book)));
  return { paired };
}
