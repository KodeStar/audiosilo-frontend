import type { Href } from 'expo-router';

import type { PodcastEpisodeOrder } from '@/api/types';
import { resolveConnectionId } from '@/lib/connection-id';

/** Reconstruct a rel_path from an Expo Router catch-all param. */
export function segmentsToPath(seg?: string | string[]): string {
  if (!seg) return '';
  return (Array.isArray(seg) ? seg : [seg]).join('/');
}

/** The single connection id carried by a route's `?connection=` query param, normalized
 * to a string ('' when absent). One definition so the `(app)` scope layout and the
 * offline banner read the param the same way (Expo Router can hand back `string[]`). An old
 * id the identity migration moved (a widget or Live Activity link made before it, a web
 * history entry) reads as its new one (`resolveConnectionId`). */
export function connectionParam(connection?: string | string[]): string {
  const id = Array.isArray(connection) ? (connection[0] ?? '') : (connection ?? '');
  return id ? resolveConnectionId(id) : '';
}

/** Last path segment, for breadcrumb/title display. */
export function pathLeaf(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** A book's title as shown: its own, else its file or folder name. */
export function bookTitle(title: string | undefined, relPath: string): string {
  return title || pathLeaf(relPath);
}

/** Path one level up (the containing folder), or '' at the library root. */
export function parentPath(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/** The browse section's pages (the hrefs below): the Library root and folders, and the
 * detail pages a browse can push (a book, a series, an author or narrator, a collection). */
export const BROWSE_PATHS = [
  '/library',
  '/book',
  '/series',
  '/author',
  '/narrator',
  '/collection',
  '/podcast',
  '/find-shows',
] as const;

// Content routes are FLAT (`/book/[libraryId]`, `/library/[libraryId]`, `/account`); the
// connection they belong to and the library-relative path both ride as QUERY params
// (`?connection=<cid>&path=<rel>`), read back as the route scope by the `(app)` layout.
//
// Why not a `/s/[connectionId]/…` route segment (the shape the multi-server refactor first
// used)? `router.push` (React Navigation's `linkTo`) can't resolve a tap into a route
// nested under a dynamic layout segment - it lands on the scope group's first child
// (`account`). A direct URL load works (it uses `getStateFromPath`, which rebuilds the
// whole state) but an in-app push doesn't. Flat routes + a query param push correctly,
// and the `?path=` form mirrors the server's own path-identity model. Returned as the
// OBJECT form (route pattern + params) so Expo Router builds and encodes the URL.
export function libraryHref(connectionId: string, libraryId: number, relPath = ''): Href {
  return {
    pathname: '/library/[libraryId]',
    params: {
      libraryId: String(libraryId),
      connection: connectionId,
      ...(relPath ? { path: relPath } : {}),
    },
  };
}

/** The book screen's tabs, in display order (the rules are `book-tabs.ts`). Closed on
 * purpose: a module (`src/modules/registry.ts`) adds no tab until one needs it (Bridge
 * Phase 2d). */
export type BookTab =
  'chapters' | 'recaps' | 'characters' | 'bookmarks' | 'history' | 'notes' | 'series' | 'details';

/** A book page; `tab` opens it on that tab (`parseBookTab`) instead of the first. */
export function bookHref(
  connectionId: string,
  libraryId: number,
  relPath: string,
  tab?: BookTab,
): Href {
  return {
    pathname: '/book/[libraryId]',
    params: {
      libraryId: String(libraryId),
      connection: connectionId,
      path: relPath,
      ...(tab ? { tab } : {}),
    },
  };
}

/** A connection's per-server account screen (`/account?connection=<cid>`); the `(app)`
 * layout reads the query param as the scope so its account hooks resolve to that server. */
export function accountHref(connectionId: string): Href {
  return { pathname: '/account', params: { connection: connectionId } };
}

/** A place in a book to start or jump to: a whole-book position (seconds), or a file by
 * index (its durations may be unknown, so a position can't address it). Neither: the
 * saved place. */
export type BookPlace = { position?: number; track?: number };

/** The full-screen player modal for a book, at `place` when given (the route applies it
 * once: a chapter, a pin, a bookmark). The player is a root modal (outside any
 * scope), so it carries the connection as a param - under the SAME `connection` name the
 * content routes use, so while the modal is presented the still-mounted `(app)` scope
 * layout keeps resolving to this book's server (a different name flipped it to the
 * default connection and fired background fetches against the wrong server). */
export function playerHref(
  connectionId: string,
  libraryId: number,
  relPath: string,
  place: BookPlace = {},
): Href {
  return { pathname: '/player', params: playerParams(connectionId, libraryId, relPath, place) };
}

/** `playerHref`'s route params, for a link built outside Expo Router (the iOS widget's
 * deep link), so a renamed param can't leave that link behind. */
export function playerParams(
  connectionId: string,
  libraryId: number,
  relPath: string,
  place: BookPlace = {},
): Record<string, string> {
  return {
    connection: connectionId,
    libraryId: String(libraryId),
    path: relPath,
    // Whole seconds: the route param is a string the player parses back.
    ...(place.position !== undefined
      ? { position: String(Math.max(0, Math.round(place.position))) }
      : {}),
    ...(place.track !== undefined ? { track: String(place.track) } : {}),
  };
}

/** The end-credits (book-finished) modal for a book. A root modal like the player, so it
 * carries the connection under the SAME `connection` param name the content routes use.
 * `auto` marks an arrival from the book's natural end (already over) vs an early open, so
 * the screen picks the grace-countdown vs remaining-time regime; encoded as '1'/'0'
 * because route params are strings. */
export function finishedHref(
  connectionId: string,
  libraryId: number,
  relPath: string,
  auto = false,
): Href {
  return {
    pathname: '/finished',
    params: {
      connection: connectionId,
      libraryId: String(libraryId),
      path: relPath,
      auto: auto ? '1' : '0',
    },
  };
}

/** The ebook reader for a book (Bridge Phase 3b): a root modal like the player, carrying
 * the connection under the content routes' `connection` param. `relPath` is the BOOK's
 * path, never its epub's. The route is `/read`: a `/reader` route would be exported as
 * reader.html, which is the reader document itself (public/reader.html). */
export function readerHref(connectionId: string, libraryId: number, relPath: string): Href {
  return {
    pathname: '/read',
    params: { connection: connectionId, libraryId: String(libraryId), path: relPath },
  };
}

// --- Browse detail pages (player redesign Phase 2) ---------------------------------
// Flat routes in the shared `(home,library,search,offline,me)` group, like the book page:
// the connection and the library ride as query params (`connection`, `library`), so the
// tab that pushes one owns it and `<ContentScope>` reads the connection. Names are the
// exact field values the server groups by (`Book.author` / `narrator` / `series`), which
// are also the exact `author=` / `narrator=` / `series=` filters of GET /books.

/**
 * Which series a series page shows. `name` is a LOCAL series: a series name in the
 * library - a book's `series`, or one of its `series_list` (the `series=` books
 * filter and a `SeriesCount.name`). `work` is
 * a community-metadata work id (`BookMetaRailEntry.id`, `/meta/work?id=`): the page
 * shows that work's series rails, which is how a series the listener owns nothing of is
 * reached (a ghost on a rail, a "next in your series" for a book not in the library).
 * Give at least one; with both, `name` lists the owned books and `work` supplies the
 * community rail (reading orders, ghosts) around them.
 */
export type SeriesRef = { name: string; work?: string } | { name?: string; work: string };

/** `/series?connection=<cid>&library=<id>&name=<series>[&work=<meta work id>]`. */
export function seriesHref(connectionId: string, libraryId: number, ref: SeriesRef): Href {
  return {
    pathname: '/series',
    params: {
      connection: connectionId,
      library: String(libraryId),
      ...(ref.name ? { name: ref.name } : {}),
      ...(ref.work ? { work: ref.work } : {}),
    },
  };
}

/** `/author?connection=<cid>&library=<id>&name=<author>`: the books whose `Book.author`
 * is exactly `name` (a "Kramer & Reading" credit is one author, as the server lists it). */
export function authorHref(connectionId: string, libraryId: number, name: string): Href {
  return {
    pathname: '/author',
    params: { connection: connectionId, library: String(libraryId), name },
  };
}

/** `/podcast?connection=<cid>&library=<id>&show=<show path>[&order=newest|oldest]`: a
 * podcast show and its episodes (Bridge Phase 2d-1). The show is its folder path. */
export function podcastShowHref(
  connectionId: string,
  libraryId: number,
  show: string,
  order?: PodcastEpisodeOrder,
): Href {
  return {
    pathname: '/podcast',
    params: {
      connection: connectionId,
      library: String(libraryId),
      show,
      ...(order ? { order } : {}),
    },
  };
}

/** Find shows' sections (Bridge Phase 2d-2), in order: a directory search, a feed's
 * address, an OPML list. */
export const FIND_SHOWS_SECTIONS = ['search', 'address', 'import'] as const;
export type FindShowsSection = (typeof FIND_SHOWS_SECTIONS)[number];

/** `/find-shows?connection=<cid>&library=<id>[&section=search|address|import]`: adding
 * shows to a podcast library (Bridge Phase 2d-2), on `section` when given. */
export function findShowsHref(
  connectionId: string,
  libraryId: number,
  section?: FindShowsSection,
): Href {
  return {
    pathname: '/find-shows',
    params: {
      connection: connectionId,
      library: String(libraryId),
      ...(section ? { section } : {}),
    },
  };
}

/** `/narrator?connection=<cid>&library=<id>&name=<narrator>` (exact `Book.narrator`). */
export function narratorHref(connectionId: string, libraryId: number, name: string): Href {
  return {
    pathname: '/narrator',
    params: { connection: connectionId, library: String(libraryId), name },
  };
}

/** `/collection?connection=<cid>&id=<collection id>`: a collection is per server, not
 * per library (its items can span the server's libraries). */
export function collectionHref(connectionId: string, id: number): Href {
  return { pathname: '/collection', params: { connection: connectionId, id: String(id) } };
}

/** The Journal's tabs (`?tab=diary|bookmarks|notes`, on the You hub or `/journal`). */
export type JournalTab = 'diary' | 'bookmarks' | 'notes';

/** The You hub's own sections (`/you?section=`, the Me tab's root; absent = `stats`). A
 * phone offers all six; tablet and desktop offer the first three and reach Settings,
 * Household and Account from the top bar's gear and profile menu (an old link to them
 * still renders). */
export type CoreYouSection = 'stats' | 'year' | 'journal' | 'settings' | 'household' | 'account';

/** A You hub section: one of its own, or an active module's (`youSections` in
 * `src/modules/registry.ts`, Bridge Phase 2a). Only the hub's own rules take it; a link
 * (`youHref`, `openYou`) names one of its own (`CoreYouSection`). */
export type YouSection = CoreYouSection | (string & {});

/** The You hub's pathname: the Me tab's ROOT, opened with `openYou` / `openJournal`
 * (`src/lib/open.ts`), never pushed as a page on another tab. */
const YOU_PATHNAME = '/you';

/** The You hub on `section`, one of its own (Stats is the plain `/you`), with the Journal's
 * `tab` when the section is the Journal and the tab isn't the Diary. Closed on purpose, so
 * a misspelt section stays a type error: a module's key is no link target until one needs
 * it. */
export function youHref(section?: CoreYouSection, journalTab?: JournalTab): Href {
  if (!section || section === 'stats') return YOU_PATHNAME;
  const tab = section === 'journal' && journalTab && journalTab !== 'diary' ? journalTab : null;
  return { pathname: YOU_PATHNAME, params: tab ? { section, tab } : { section } };
}

/** What the full-screen Year in listening story (`/year`) shows. */
export type YearStoryParams = {
  /** A past year; absent for this year. */
  year?: number;
  /** A server other than the default. */
  connection?: string;
  /** The card to start on (0-based). */
  card?: number;
};

/**
 * The phone's full-screen Year in listening story, a root modal like the player: `/year`
 * with `?year=YYYY` (absent: this year), `?connection=` (absent: the default server) and
 * `?card=` (absent: the first). Open it with `router.push`; it never leads into the shell.
 */
export function yearHref(params: YearStoryParams = {}): Href {
  return {
    pathname: '/year',
    params: {
      ...(params.year !== undefined ? { year: String(params.year) } : {}),
      ...(params.connection ? { connection: params.connection } : {}),
      ...(params.card ? { card: String(params.card) } : {}),
    },
  };
}

/** The Settings panes (`/settings?section=`). `preferences` (the first pane, Playback) and
 * `accounts` (the signed-in servers) are the two the IA names; each pane can be linked to
 * directly too. Absent = `preferences`. `household` is no pane any more (Phase 8b-1): the
 * route sends an old link to the Household page (`householdHref`). Closed on purpose: a
 * module (`src/modules/registry.ts`) adds no pane until one needs it (Bridge Phase 2d). */
export type SettingsSection =
  | 'preferences'
  | 'playback'
  | 'sleep'
  | 'downloads'
  | 'appearance'
  | 'language'
  | 'household'
  | 'accounts'
  | 'support';

/** Settings, on `section` when given (the gear in the top bar; the palette). */
export function settingsHref(section?: SettingsSection): Href {
  return section && section !== 'preferences'
    ? { pathname: '/settings', params: { section } }
    : '/settings';
}

/** The Household page (`/household`, Phase 8b-1): the people on this device, the
 * caller's household members and house sharing. A page of the array group like Settings,
 * pushed on the current tab (`openHousehold`); the phone's You hub also has it as a
 * section. */
export function householdHref(): Href {
  return '/household';
}

/** A route's raw search params (Expo Router may hand back `string[]`). */
export type RawParams = Record<string, string | string[] | undefined>;

/** A search param's first value ('' when absent). Kept exactly as given (names are exact
 * filter values); only a blank one is treated as absent. */
export function firstParam(v: string | string[] | undefined): string {
  const s = (Array.isArray(v) ? v[0] : v) ?? '';
  return s.trim() ? s : '';
}

/** A positive integer id param, or null. */
export function idParam(v: string | string[] | undefined): number | null {
  const s = firstParam(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

/** The show page's params, or null when the link can't name a show (no library or no
 * `show`). `order` is null when the link names none (the show's default). */
export function parsePodcastParams(p: RawParams): {
  connectionId: string;
  libraryId: number;
  show: string;
  order: PodcastEpisodeOrder | null;
} | null {
  const libraryId = idParam(p.library);
  const show = firstParam(p.show);
  if (libraryId === null || !show) return null;
  const order = firstParam(p.order);
  return {
    connectionId: connectionParam(p.connection),
    libraryId,
    show,
    order: order === 'newest' || order === 'oldest' ? order : null,
  };
}

/** Find shows' params, or null without a library. `section` is null when the link names
 * none, or one this build does not know. */
export function parseFindShowsParams(p: RawParams): {
  connectionId: string;
  libraryId: number;
  section: FindShowsSection | null;
} | null {
  const libraryId = idParam(p.library);
  if (libraryId === null) return null;
  const section = firstParam(p.section);
  return {
    connectionId: connectionParam(p.connection),
    libraryId,
    section: (FIND_SHOWS_SECTIONS as readonly unknown[]).includes(section)
      ? (section as FindShowsSection)
      : null,
  };
}

/** The series page's params, or null when the link can't name a series (no library, or
 * neither a `name` nor a `work`). */
export function parseSeriesParams(
  p: RawParams,
): { connectionId: string; libraryId: number; name?: string; work?: string } | null {
  const libraryId = idParam(p.library);
  const name = firstParam(p.name);
  const work = firstParam(p.work);
  if (libraryId === null || (!name && !work)) return null;
  return {
    connectionId: connectionParam(p.connection),
    libraryId,
    ...(name ? { name } : {}),
    ...(work ? { work } : {}),
  };
}

/** An author or narrator page's params, or null without a library and a name. */
export function parsePersonParams(
  p: RawParams,
): { connectionId: string; libraryId: number; name: string } | null {
  const libraryId = idParam(p.library);
  const name = firstParam(p.name);
  if (libraryId === null || !name) return null;
  return { connectionId: connectionParam(p.connection), libraryId, name };
}

/** The book a connect link ends on (`parseConnectBook`). */
export type ConnectBook = { libraryId: number; path: string };

/** The book a connect link ends on (`/connect?book=<library_id>&path=<rel_path>`, the admin
 * console's "Listen in player"), or null when it names none (no positive library id, or no
 * path). Only these leave the flow, rebuilt into `bookHref`: never a URL the link carried. */
export function parseConnectBook(p: RawParams): ConnectBook | null {
  const libraryId = idParam(p.book);
  const path = firstParam(p.path);
  if (libraryId === null || !path) return null;
  return { libraryId, path };
}

/** The collection page's params, or null without a valid id. */
export function parseCollectionParams(p: RawParams): { connectionId: string; id: number } | null {
  const id = idParam(p.id);
  if (id === null) return null;
  return { connectionId: connectionParam(p.connection), id };
}
