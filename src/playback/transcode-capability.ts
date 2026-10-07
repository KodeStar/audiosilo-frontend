import type { ApiClient } from '@/api/client';
import { cachedCapability, fetchCapabilities, useCapability } from '@/api/hooks';
import type { Book, ChaptersResponse } from '@/api/types';

import { mayNeedWebTranscode, needsWebTranscode } from './transcode';

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
    canTranscode = (await fetchCapabilities(connectionId, api)).transcode;
  } catch {
    canTranscode = cachedCapability(connectionId, 'transcode');
  }
  return needsWebTranscode(book, chapterData, canTranscode);
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
  return needsWebTranscode(book, chapterData, cachedCapability(connectionId, 'transcode'));
}

/** The UI's form (the book page's note, the download controls): whether this browser
 * plays `book` through its server's transcoder, as the server's `transcode` flag is
 * known now (false while it is not known, or without a book). */
export function useNeedsWebTranscode(
  book: Book | undefined,
  chapterData: ChaptersResponse | undefined,
  connectionId?: string,
): boolean {
  const canTranscode = useCapability('transcode', connectionId);
  return !!book && needsWebTranscode(book, chapterData, canTranscode);
}
