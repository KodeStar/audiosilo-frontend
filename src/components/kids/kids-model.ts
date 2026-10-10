import type { Book, Library, Progress } from '@/api/types';
import { visibleDownloads } from '@/downloads/downloads-view';
import type { DownloadEntry } from '@/downloads/types';
import { isInProgress } from '@/lib/progress-view';
import type { KidsSettings } from '@/stores/profiles';

/**
 * Kids mode's rules (Phase 8), pure and framework-free: which connection and library the
 * screen shows, the order of its stories, the downloaded stories it falls back to offline,
 * and which routes a kids profile may be on.
 */

/** Kids mode's route (a root route, outside the tabs). */
export const KIDS_PATH = '/kids';

/**
 * Where a kids profile may be. Kids mode itself; "Who's listening?" (leaving kids mode
 * goes through it, and the PIN rules apply there); and the connect flow, which "Add
 * someone" on that screen opens before anyone has switched away. Everything else (the
 * tabs, search, settings, downloads, the full player, the end credits, the year story)
 * sends a kids profile back to `/kids`.
 */
const KIDS_ALLOWED = [KIDS_PATH, '/profiles', '/connect'];

/** Whether a kids profile may stay on `pathname` (expo-router's, without the web base). */
export function kidsAllowsPath(pathname: string): boolean {
  return KIDS_ALLOWED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * The connection kids mode shows: the profile's picked library's, while the profile still
 * holds that connection, else the profile's first (`connectionIds` in session order), else
 * none (a profile with no connections is deleted, so only for a moment).
 */
export function kidsConnectionId(
  connectionIds: readonly string[],
  kids: Pick<KidsSettings, 'library'> | undefined,
): string | null {
  const picked = kids?.library?.connectionId;
  if (picked && connectionIds.includes(picked)) return picked;
  return connectionIds[0] ?? null;
}

/**
 * The library kids mode shows on `connectionId`, from its GET /libraries answer (the
 * server's scopes: the kid's account sees only what the admin allowed): the profile's
 * pick when it is on this connection and still listed, else the first library listed,
 * else null (the account sees none).
 */
export function kidsLibrary(
  libraries: readonly Library[],
  connectionId: string,
  kids: Pick<KidsSettings, 'library'> | undefined,
): Library | null {
  const pick = kids?.library;
  if (pick && pick.connectionId === connectionId) {
    const found = libraries.find((l) => l.id === pick.libraryId);
    if (found) return found;
  }
  return libraries[0] ?? null;
}

/**
 * The stories in the order kids mode shows them: the ones the child is partway through,
 * most recently played first, then every other book of the library in the server's order
 * (finished ones too: children listen again). A progress row for a book that is no longer
 * in the list is left out.
 */
export function kidsShelf(
  books: readonly Book[],
  progress: readonly Progress[],
  libraryId: number,
): Book[] {
  const byPath = new Map(books.map((b) => [b.rel_path, b]));
  // A Set of paths, most recent first: a book with two rows is listed once.
  const first = new Set(
    progress
      .filter((p) => p.library_id === libraryId && isInProgress(p) && byPath.has(p.path))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((p) => p.path),
  );
  return [
    ...[...first].map((path) => byPath.get(path) as Book),
    ...books.filter((b) => !first.has(b.rel_path)),
  ];
}

/**
 * The stories on this device for kids mode when its server can't be reached: the
 * finished downloads of `connectionId`, in `libraryId` when it is known, most recently
 * saved first.
 */
export function kidsDownloads(
  entries: Readonly<Record<string, DownloadEntry>>,
  connectionId: string,
  libraryId: number | null,
): Book[] {
  return visibleDownloads(entries, [connectionId])
    .ready.filter((e) => libraryId === null || e.libraryId === libraryId)
    .map((e) => e.manifest.book);
}

/** How many columns of story tiles fit in `width` (at least 2; tiles at least `min` wide
 * with `gap` between them). */
export function kidsColumns(width: number, min: number, gap: number): number {
  if (width <= 0) return 2;
  return Math.max(2, Math.floor((width + gap) / (min + gap)));
}
