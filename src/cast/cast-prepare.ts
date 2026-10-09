import { ApiClient } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import { fetchCapabilities } from '@/api/hooks';
import type { Capabilities } from '@/api/types';
import { bookSourceOf } from '@/playback/book-source';
import type { BookRef, PlaybackTrack } from '@/playback/types';

import {
  buildCastItems,
  castBlockReason,
  castNeedsTranscode,
  type CastBlockReason,
} from './cast-media';
import { castTokens } from './cast-token';
import type { CastItem } from './types';

/** A book that can't be cast, and why (the session glue explains it and hands the book
 * back to this device). */
export class CastBlockedError extends Error {
  constructor(readonly reason: CastBlockReason) {
    super(`This book can't be cast (${reason})`);
    this.name = 'CastBlockedError';
  }
}

/** What the cast engine needs to load a book on the receiver. */
export type PreparedCast = { items: CastItem[] };

/** Turns a book's tracks into the receiver's queue (see `prepareCast`). Injected into the
 * cast engine so its tests need no server. */
export type PrepareCast = (tracks: PlaybackTrack[], book: BookRef) => Promise<PreparedCast>;

/**
 * The receiver's queue for a book, built from the same tracks the store loads: the book's
 * server (its connection's address in use now, `effectiveUrl`, home when picked) must have
 * `cast` and be reachable from another device, the book's codec must be one the receiver
 * plays or the server must transcode it, and the URLs carry a cast token for this book
 * (never the session token). A downloaded book casts from its server too: the receiver
 * can't read this device's files. Rejects with `CastBlockedError` when the book can't be
 * cast, and with the server's error when the token can't be minted.
 */
export const prepareCast: PrepareCast = async (tracks, book) => {
  const client = resolveClient(book.connectionId);
  if (!client) throw new CastBlockedError('no-connection');
  let caps: Capabilities | undefined;
  try {
    caps = await fetchCapabilities(book.connectionId, client);
  } catch {
    caps = undefined;
  }
  // The book's codec: the downloaded copy's item, else the server's (through the cache).
  const source = await bookSourceOf(book).catch(() => null);
  const reason = castBlockReason({
    // An unknown flag can't be trusted to mint a token: treat it as missing.
    canCast: caps?.cast === true,
    canTranscode: caps?.transcode,
    baseUrl: client.baseUrl,
    book: source?.book,
    chapters: source?.chapters,
  });
  if (reason) throw new CastBlockedError(reason);
  const transcode =
    !!source && caps?.transcode === true && castNeedsTranscode(source.book, source.chapters);
  const token = await castTokens.get(client, book.connectionId, book.libraryId, book.path);
  // The existing URL builders, on the same address, with the cast token in place of the
  // session token.
  const castClient = new ApiClient(client.baseUrl, token);
  return { items: buildCastItems(tracks, book, castClient, transcode) };
};
