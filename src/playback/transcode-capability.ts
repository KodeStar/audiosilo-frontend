import { Platform } from 'react-native';

import type { ApiClient } from '@/api/client';
import { qk, serverInfoQuery } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Book, ChaptersResponse, ServerInfo } from '@/api/types';

import { isBrowserUndecodable, needsWebTranscode } from './transcode';

/** The `transcode` capability of a connection's server as the query cache holds it
 * (undefined when its `/server` has not been read). */
function cachedCanTranscode(connectionId: string): boolean | undefined {
  return queryClient.getQueryData<ServerInfo>(qk.server(connectionId))?.capabilities?.transcode;
}

/**
 * Could this book need the transcoder here at all? Synchronous and cheap, so a caller
 * can skip the capability lookup (and its await) for every ordinary book: false off
 * web and for any book the server didn't mark undecodable.
 */
export function mayNeedWebTranscode(book: Book, chapterData?: ChaptersResponse): boolean {
  return Platform.OS === 'web' && isBrowserUndecodable(book, chapterData);
}

/**
 * Whether the playing book should stream through its server's transcoder (see
 * `needsWebTranscode`), resolving the server's capability the way the rest of the app
 * reads it: the shared `/server` query (cached for minutes, so normally no request).
 * A failed read falls back to whatever the cache last held, and otherwise to "no" -
 * stream directly and let the error/retry path speak if the browser can't play it.
 */
export async function resolveWebTranscode(
  connectionId: string,
  api: ApiClient | null,
  book: Book,
  chapterData?: ChaptersResponse,
): Promise<boolean> {
  if (!api || !mayNeedWebTranscode(book, chapterData)) return false;
  let canTranscode: boolean | undefined;
  try {
    canTranscode = (await queryClient.fetchQuery(serverInfoQuery(connectionId, api))).capabilities
      .transcode;
  } catch {
    canTranscode = cachedCanTranscode(connectionId);
  }
  return needsWebTranscode(Platform.OS, book, chapterData, canTranscode);
}

/**
 * Synchronous form for the download path: a book that streams transcoded on web must
 * not be downloaded raw (its files would not play offline in this browser). Reads the
 * cached capability; unknown reads as "not transcoded" (download as before).
 */
export function webTranscodeFromCache(
  connectionId: string,
  book: Book,
  chapterData?: ChaptersResponse,
): boolean {
  if (!mayNeedWebTranscode(book, chapterData)) return false;
  return needsWebTranscode(Platform.OS, book, chapterData, cachedCanTranscode(connectionId));
}
