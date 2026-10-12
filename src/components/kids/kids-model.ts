import type { Book, Library, Progress } from '@/api/types';
import { type GridSpec, gridMetrics } from '@/components/library/cover-layout';
import { visibleDownloads } from '@/downloads/downloads-view';
import type { DownloadEntry } from '@/downloads/types';
import type { LayoutClass } from '@/lib/layout';
import { isInProgress } from '@/lib/progress-view';
import type { KidsSettings } from '@/stores/profiles';

/**
 * Kids mode's rules (Phase 8), pure and framework-free: which connection and library the
 * screen shows, the order of its stories and their grid, the downloaded stories it falls
 * back to offline, and which routes a kids profile may be on.
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
 * The stories the child is partway through in `libraryId`, most recently played first, by
 * path (a book with two rows is listed once): kids mode shows them first (`kidsShelf`).
 */
export function kidsContinuePaths(progress: readonly Progress[], libraryId: number): string[] {
  return [
    ...new Set(
      progress
        .filter((p) => p.library_id === libraryId && isInProgress(p))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((p) => p.path),
    ),
  ];
}

/**
 * The stories in the order kids mode shows them: the ones the child is partway through
 * (`continuing`, in `kidsContinuePaths`' order; one no longer in the library is left out
 * by the caller), then every other book of the library listed so far, in the server's
 * order (finished ones too: children listen again).
 */
export function kidsShelf(continuing: readonly Book[], listed: readonly Book[]): Book[] {
  const first = new Set(continuing.map((b) => b.rel_path));
  return [...continuing, ...listed.filter((b) => !first.has(b.rel_path))];
}

/**
 * The library kids mode's offline stories come from (`kidsDownloads`): the library the
 * screen shows when it is known, else, while GET /libraries can't be read (offline), the
 * profile's pick when it is on this connection, else null (every story downloaded on the
 * connection). Without it, offline, the grown-ups' downloads of another library on the
 * same account would show in kids mode.
 */
export function kidsOfflineLibraryId(
  library: Pick<Library, 'id'> | null,
  connectionId: string,
  kids: Pick<KidsSettings, 'library'> | undefined,
): number | null {
  if (library) return library.id;
  const pick = kids?.library;
  return pick && pick.connectionId === connectionId ? pick.libraryId : null;
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

/** Kids mode's story grid: two columns on a phone, as many tiles of at least 180 as fit
 * wider (never fewer than two). */
const KIDS_GRID: GridSpec = {
  min: 180,
  minColumns: 2,
  phoneColumns: 2,
  columnGap: [16, 24],
  rowGap: [24, 32],
};

/** The story grid's columns, tile width and gaps for a content column `width` wide
 * (`gridMetrics`); 150 wide tiles until the column is measured. */
export function kidsGrid(width: number, layout: LayoutClass) {
  const metrics = gridMetrics(width, layout, KIDS_GRID);
  return width > 0 ? metrics : { ...metrics, tile: 150 };
}
