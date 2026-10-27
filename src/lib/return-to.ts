import type { Href } from 'expo-router';
import { Platform } from 'react-native';

import { BASE_URL } from '@/lib/base-url';
import { type ConnectBook, parseConnectBook } from '@/lib/paths';

/**
 * The book page a web address names (`<base>/book/<library_id>?path=<rel_path>`), or null.
 * Read from the URL itself, decoded once (`URLSearchParams`). Only these two values leave
 * it, rebuilt into `bookHref` at the end of the connect flow, never a URL.
 */
export function bookOfAddress(
  location: { pathname: string; search: string },
  base = BASE_URL,
): ConnectBook | null {
  const path =
    base && location.pathname.startsWith(base)
      ? location.pathname.slice(base.length)
      : location.pathname;
  const m = /^\/book\/([^/]+)\/?$/.exec(path);
  if (!m) return null;
  return parseConnectBook({
    book: m[1],
    path: new URLSearchParams(location.search).get('path') ?? '',
  });
}

/**
 * Where a signed-out visit goes: the connect flow, carrying the book the address named
 * (web: a book link opened signed out), so signing in ends on that book instead of "Your
 * library is ready." (frontend#129). The flow carries it as the `book` and `path` params a
 * console "Listen in player" link uses (`parseConnectBook`).
 */
export function signedOutHref(): Href {
  const book =
    Platform.OS === 'web' && typeof window !== 'undefined' ? bookOfAddress(window.location) : null;
  return book
    ? { pathname: '/connect', params: { book: String(book.libraryId), path: book.path } }
    : '/connect';
}
