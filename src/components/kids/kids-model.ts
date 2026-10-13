import type { Book, Collection, CollectionDetail, Library, Progress, User } from '@/api/types';
import { type GridSpec, gridMetrics } from '@/components/library/cover-layout';
import { visibleDownloads } from '@/downloads/downloads-view';
import type { DownloadEntry } from '@/downloads/types';
import type { LayoutClass } from '@/lib/layout';
import { isInProgress } from '@/lib/progress-view';
import { type DevicePeople, managerName } from '@/lib/account';
import type { KidsSettings, Profile } from '@/stores/profiles';

/**
 * Kids mode's rules (Phase 8), pure and framework-free: which connection and library the
 * screen shows, the order of its stories and their grid, the downloaded stories it falls
 * back to offline, and which routes a kids profile may be on.
 */

/** Kids mode's route (a root route, outside the tabs). */
export const KIDS_PATH = '/kids';

/**
 * Where a kids profile may be. Kids mode itself, "Who's listening?" (leaving kids mode
 * goes through it, and the PIN rules apply there), and the connect flow, which keeps kids
 * mode out itself (8b-1, D1: `connect/_layout.tsx` runs none of it for a kids profile
 * without a grown-up's pass). Everything else (the tabs, search, settings, downloads, the
 * full player, the end credits, the year story) sends a kids profile back to `/kids`.
 */
const KIDS_ALLOWED = [KIDS_PATH, '/profiles', '/connect'];

/** Whether `pathname` is `base` or a route under it. */
const under = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

/** Whether a kids profile may stay on `pathname` (expo-router's, without the web base). */
export function kidsAllowsPath(pathname: string): boolean {
  return KIDS_ALLOWED.some((p) => under(pathname, p));
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

/** Who manages the account kids mode shows for `profile` (its kids connection's
 * `managerName`, Phase 8b-1): by the name this device knows them by (`people`); null for an
 * ordinary account. `people.connections` are the session's: the profile's are taken in
 * their order, as kids mode picks its own. */
export function kidsManager(
  profile: Pick<Profile, 'connectionIds' | 'kids'>,
  people: DevicePeople,
): string | null {
  const own = people.connections.filter((c) => profile.connectionIds.includes(c.id));
  const id = kidsConnectionId(
    own.map((c) => c.id),
    profile.kids,
  );
  const conn = own.find((c) => c.id === id);
  return conn ? managerName(conn.user, { connection: conn, people }) : null;
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

/** The progress rows of stories partway through, most recently played first: the order
 * kids mode shows them in, first (`kidsContinuePaths`, `kidsOrder`). */
function inProgressNewestFirst(progress: readonly Progress[]): Progress[] {
  return progress.filter(isInProgress).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * The stories the child is partway through in `libraryId`, most recently played first, by
 * path (a book with two rows is listed once): kids mode shows them first (`kidsShelf`).
 */
export function kidsContinuePaths(progress: readonly Progress[], libraryId: number): string[] {
  return [
    ...new Set(
      inProgressNewestFirst(progress)
        .filter((p) => p.library_id === libraryId)
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

/** One run of kids mode's stories: a collection's, titled with its name (shown when the
 * shelf has several). */
export type KidsSection = { key: string; title: string; books: Book[] };

/**
 * The collections kids mode shows for a household member (Phase 8b-1): those the account's
 * owner (`user.managed_by`) shares with it, in the order GET /me/collections lists them
 * (the owner's). Empty for an account nobody manages (an ordinary one, a Phase 8 kid the
 * admin limited, an older server): kids mode then shows one library (`kidsLibrary`).
 * Switching a member to "Everything I can listen to" stops the owner's shares to them
 * (the member card sends `collection_ids: []`), so their shelf is the one library; a
 * collection the owner shares with them later (ordinary sharing) shows here again.
 */
export function kidsCollections(
  collections: readonly Collection[],
  user: Pick<User, 'managed_by'> | undefined,
): Collection[] {
  const owner = user?.managed_by?.id;
  if (owner === undefined) return [];
  return collections.filter((c) => !c.owned && c.owner.id === owner);
}

/** Where kids mode's shelf comes from (8b-1, D6): the collections the account's owner
 * shares (`kidsCollections`), one library (`kidsLibrary`), or not known yet. */
export type KidsShelfMode = 'collections' | 'library' | 'unknown';

/**
 * Kids mode's shelf for an account (`user`), on a server that keeps collections or not
 * (`hasCollections`, undefined while not known) with its GET /me/collections answer
 * (`collections`, undefined while unread): the owner's shared collections when there are
 * any, else one library. An account nobody manages, or a server without collections, is
 * always the one library; a household member's shelf is unknown until both answers are in.
 */
export function kidsShelfMode(
  user: Pick<User, 'managed_by'> | undefined,
  hasCollections: boolean | undefined,
  collections: readonly Collection[] | undefined,
): KidsShelfMode {
  if (!user?.managed_by || hasCollections === false) return 'library';
  if (hasCollections === undefined || collections === undefined) return 'unknown';
  return kidsCollections(collections, user).length > 0 ? 'collections' : 'library';
}

/** A book's place in kids mode's lists, across libraries (a collection can hold books of
 * several). */
const storyKey = (libraryId: number, path: string) => `${libraryId}:${path}`;

/** `books` once each (a book listed twice keeps its first place). */
function uniqueStories(books: readonly Book[]): Book[] {
  const seen = new Set<string>();
  return books.filter((b) => {
    const key = storyKey(b.library_id, b.rel_path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * `books` in the order kids mode shows them: the ones the child is partway through first
 * (most recently played first, as `kidsContinuePaths`), then the rest in their own order;
 * a book listed twice is shown once.
 */
export function kidsOrder(books: readonly Book[], progress: readonly Progress[]): Book[] {
  const rank = new Map<string, number>();
  for (const p of inProgressNewestFirst(progress)) {
    const key = storyKey(p.library_id, p.path);
    if (!rank.has(key)) rank.set(key, rank.size);
  }
  const unique = uniqueStories(books);
  const rankOf = (b: Book) => rank.get(storyKey(b.library_id, b.rel_path));
  const started = unique
    .filter((b) => rankOf(b) !== undefined)
    .sort((a, b) => rankOf(a)! - rankOf(b)!);
  return [...started, ...unique.filter((b) => rankOf(b) === undefined)];
}

/**
 * Kids mode's shelf from the owner's shared collections (`kidsCollections`, with each
 * one's GET /me/collections/{id} answer in `details`, undefined while unread): the indexed
 * books of each, stories in progress first (`kidsOrder`), titled with the collection's
 * name. A collection with no stories is left out. Empty when no collection has a story
 * yet.
 */
export function kidsCollectionSections(
  collections: readonly Collection[],
  details: readonly (CollectionDetail | undefined)[],
  progress: readonly Progress[],
): KidsSection[] {
  return collections.flatMap((c, i): KidsSection[] => {
    const books = (details[i]?.items ?? []).flatMap((item) => (item.book ? [item.book] : []));
    return books.length > 0
      ? [{ key: `collection-${c.id}`, title: c.name, books: kidsOrder(books, progress) }]
      : [];
  });
}

/** Every story of `sections`, once each, in order (the whole shelf: the grid's `books`,
 * the car's). */
export function kidsSectionBooks(sections: readonly KidsSection[]): Book[] {
  return uniqueStories(sections.flatMap((s) => s.books));
}

/**
 * The library kids mode's offline stories come from (`kidsDownloads`), on a shelf of
 * `mode`. A one-library shelf: the library the screen shows when it is known, else, while
 * GET /libraries can't be read (offline), the profile's pick when it is on this
 * connection, else null (every story downloaded on the connection); without it, offline,
 * the grown-ups' downloads of another library on the same account would show in kids
 * mode. A household member's shelf of collections, or one not known yet, is null: the
 * collections can span libraries, and the server already limits what the account sees.
 */
export function kidsOfflineScope(
  mode: KidsShelfMode,
  library: Pick<Library, 'id'> | null,
  connectionId: string,
  kids: Pick<KidsSettings, 'library'> | undefined,
): number | null {
  if (mode !== 'library') return null;
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
