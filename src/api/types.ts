/**
 * TypeScript mirrors of the audiosilo-server JSON API shapes
 * (github.com/kodestar/audiosilo-server). Content is addressed by
 * (library_id, path) - never a database id.
 */

export type Capabilities = {
  admin_ui: boolean;
  web_player: boolean;
  transcode: boolean;
  upload: boolean;
  websocket: boolean;
  /** Whether the server supports user-minted, named API keys (`/auth/tokens`).
   * Absent on older servers - treat missing as false and hide the management UI. */
  api_keys?: boolean;
  /** Whether the server enriches books from the community metadata service
   * (`/libraries/{id}/meta`). Absent on older servers - treat missing as false and
   * skip the enriched-metadata section entirely (progressive enhancement). */
  metadata?: boolean;
  /** Whether the server can export a library's book list for meta.audiosilo.app
   * (`/admin/libraries/{id}/export`, admin console only). Absent on older servers -
   * treat missing as false. The player does not consume it; the type mirrors the
   * wire so the contract stays complete. */
  export?: boolean;
  /** Whether GET cover accepts `?size=160|320|640` (a cached JPEG thumbnail; see
   * {@link CoverSize}). Absent on older servers - treat missing as false and request
   * the full art (an older server ignores `size` and sends it anyway). */
  cover_sizes?: boolean;
  /** Whether the browse lists exist: `/libraries/{id}/authors|narrators|series` and
   * the `narrator=` filter on `/libraries/{id}/books`. Absent on older servers -
   * treat missing as false and never request them. */
  browse_people?: boolean;
  /** Whether the server resolves what to play after a book (`/libraries/{id}/next`,
   * {@link NextBook}). Absent on older servers - treat missing as false and keep the
   * client-side folder-sibling fallback. */
  next_book?: boolean;
  /** Whether `/libraries/{id}/meta` honours `include=previous` and `spoilers=hide`.
   * Tracks `metadata` (off when enrichment is off). Absent on older servers - treat
   * missing as false: such a server ignores both params and sends the full envelope. */
  meta_bundle?: boolean;
};

export type ServerInfo = {
  name: string;
  /** Stable per-install identity minted once by the server. The client uses it as a
   * connection's id and keys all per-server state on it, so a server keeps its
   * identity across URL changes and remove/re-add. */
  server_id: string;
  version: string;
  api: string;
  capabilities: Capabilities;
  auth: { methods: string[] };
  /** Present when the server runs in public demo mode (instant throwaway accounts). */
  demo?: { enabled: boolean };
};

export type Role = 'admin' | 'user';

export type User = {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  /** Whether the account can sign in with a username + password. False for
   * password-less accounts onboarded purely via auth-code pairing. */
  has_password: boolean;
  /** @deprecated Legacy field - this client no longer mints or displays recovery
   * codes, so don't build new features on it. It IS still read in one place:
   * `needsPasswordWarning` (src/lib/account.ts) uses it to suppress the sign-out
   * warning for a user who still holds a working recovery code (a durable way back
   * in). Do not remove it from this wire type. */
  has_recovery: boolean;
  /** Throwaway demo account. The server refuses self-service password for these,
   * so the UI hides that affordance when set. */
  is_demo?: boolean;
};

/** Response of /auth/exchange and /auth/login. The token is the session secret;
 * `server_id` is the paired server's stable identity (adopted as the connection id). */
export type AuthSession = {
  token: string;
  server_id: string;
  user: User;
};

/** Response of /demo/session: a session for this client plus a pairing payload
 * (QR) so the same throwaway demo user can be opened on another device. */
export type DemoSession = AuthSession & {
  pairing: PairingPayload;
};

/** Response of /auth/redeem and /auth/pair. A token redeemed from an invite is
 * as redeemable as the invite (its uses/expiry govern how many devices can
 * exchange it); /auth/pair and demo tokens are single-use. */
export type PairingPayload = {
  server_name: string;
  base_url: string;
  pairing_token: string;
  /** audiosilo://connect?server=<base>&token=<pairing_token> - custom-scheme "Open in app" link. */
  uri: string;
  /** https://<base>/web/connect?token=<pairing_token> - encoded in the QR. */
  web_url: string;
  qr_png_data_uri: string;
  links: { web: string; admin: string; ios?: string; android?: string };
  /** Parent invite's expiry, when redeemed from one (advisory). */
  code_expires_at?: string;
  /** Devices the parent invite can still pair; absent = unlimited or not invite-derived (advisory). */
  uses_remaining?: number;
};

/** A user-minted, named API key for headless integrations (dashboards, cron). The
 * key acts as its owner; there are no scopes in v1 and keys don't expire - revoke
 * is the lifecycle. Only metadata is ever listed; the plaintext secret is returned
 * exactly once, at creation ({@link ApiKeyCreated}). */
export type ApiKey = {
  id: number;
  label: string;
  /** RFC3339 creation timestamp. */
  created_at: string;
  /** RFC3339 timestamp of the key's last use, or null if never used. */
  last_seen: string | null;
};

/** Response of POST /auth/tokens: the plaintext secret (shown to the user once and
 * never again) plus the new key's metadata. */
export type ApiKeyCreated = {
  token: string;
  api_key: ApiKey;
};

export type LibraryView = 'filesystem' | 'computed' | 'hybrid';

export type Library = {
  id: number;
  name: string;
  root: string;
  default_view: LibraryView;
  /** Display order (lower first). Also the tiebreaker when the same book exists in
   * more than one library - the earlier library's copy wins de-duplication. */
  sort_order: number;
};

/** One entry in the filesystem (hybrid) browse view. */
export type FsEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  is_audio: boolean;
  size: number;
  mod_time: number;
  // Hybrid annotations present when the entry is an indexed book.
  is_book?: boolean;
  title?: string;
  author?: string;
  series?: string;
  series_index?: number;
  duration?: number;
  /** Per-folder detection override ("book" | "collection"); empty when auto-detected.
   * An admin-console concern - the player browses read-only - but mirrored for completeness. */
  override?: string;
  /** A folder whose audio is only in disc folders (CD1, Disc 2) directly in it, each
   * still indexed as its own book (false once joined), so the console can offer to
   * join them. Sent to admins only; the player never acts on it, mirrored for
   * completeness like `override`. */
  split_discs?: boolean;
};

export type Listing = {
  path: string;
  entries: FsEntry[];
  total: number;
  offset: number;
  next_offset?: number;
};

export type BookFile = {
  rel_path: string;
  seq: number;
  duration: number;
  format: string;
  size: number;
};

/** Normalized playable unit. `file_path` is the audio file to stream; `start`/
 * `end` are offsets within that file; `book_offset` places it on the whole-book
 * timeline (used for progress). */
export type Chapter = {
  index: number;
  title: string;
  file_index: number;
  file_path: string;
  start: number;
  end: number;
  book_offset: number;
};

export type Book = {
  id: number;
  library_id: number;
  rel_path: string;
  is_folder: boolean;
  title: string;
  author: string;
  series: string;
  series_index: number;
  narrator: string;
  duration: number;
  asin?: string;
  isbn?: string;
  format: string;
  size: number;
  /** Audio codec (ffprobe codec_name, e.g. "aac"/"mp3"/"ac3"); empty if unprobed. */
  codec?: string;
  /** Whether the codec plays natively in browsers. When false, a web client should
   * request the transcoded stream (?transcode=1) instead of streaming directly. */
  direct_playable?: boolean;
  /** RFC3339; when the book was added (filesystem birth time, from the scanner). */
  added_at?: string;
  files?: BookFile[];
  chapters?: Chapter[];
  /** Groups copies of the same logical book (across libraries, and later servers)
   * so a client can collapse duplicates. A display-grouping HINT, not an identity -
   * never key durable state on it. Present on de-duplicated lists (search/recent). */
  dedup_key?: string;
  /** Whether the book has more than one audio file (a multipart book). Used to rank
   * copies when de-duplicating across servers (single file beats multipart). */
  multi_file?: boolean;
  /** The same book's other (non-winning) copies, so the UI can show "also on X"
   * and let the user switch. Present on de-duplicated lists. */
  other_locations?: BookLocation[];
  /** Publication date, "YYYY", "YYYY-MM" or "YYYY-MM-DD" (the admin-edited or
   * community value). Sent on every book response; absent when unknown or on an
   * older server. */
  published?: string;
  /** The admin-edited/community description. Only GET /libraries/{id}/item sends
   * it - list, search, recent and next responses leave it out to keep pages small.
   * Not the CC BY-SA `community_description` on {@link BookMetaWork}. Absent on
   * older servers. */
  description?: string;
  /** Colours taken from the cover art, for theming the book's screens. Absent
   * until the server first makes a thumbnail of this art, and on older servers. */
  cover_color?: CoverColor;
  /** Opaque token for the cover art, the cache buster for `coverUrl(..., { version })`.
   * It changes when a custom cover is set or removed, but it is not a pure content
   * hash: it starts from index data and moves to the art's own version the first time
   * the server makes a thumbnail of it (so a cover first seen before then is fetched
   * once more), a re-index moves it back until the next thumbnail, and a sidecar
   * image overwritten in place keeps its token until a thumbnail reads the new art.
   * Absent on older servers. */
  cover_version?: string;
};

/** Colours derived from a book's cover art, all lowercase "#rrggbb". `bg` is the
 * dominant colour. `accent` is its vibrant colour, adjusted to reach a WCAG contrast
 * of at least 4.5:1 against `bg`, and `on_accent` (`#ffffff` or `#000000`) is the
 * text colour to put on it. `accent`/`on_accent` are omitted together when the art
 * has no usable vibrant colour - fall back to the brand accent. Derived and
 * rebuildable on the server, never user state. */
export type CoverColor = { bg: string; accent?: string; on_accent?: string };

/** Thumbnail sizes GET cover accepts as `?size=` (capability `cover_sizes`): the art
 * scaled to fit within size x size, so its LONGER side is at most `size` pixels (a
 * 2:3 portrait cover at 320 comes back 213x320). Never scaled up: smaller art comes
 * back at its own size. Any other value is a 400. */
export type CoverSize = 160 | 320 | 640;

/** A content address, (library_id, path): a book the caller can open. */
export type BookRef = { library_id: number; path: string };

/** Sort orders of GET /libraries/{id}/books (the server's default is `author`). */
export type BookSort = 'author' | 'title' | 'recent';

/** Response of GET /libraries/{id}/books: one keyset page. `next_cursor` is absent
 * once the list is exhausted. */
export type BookPage = { books: Book[]; next_cursor?: string };

/** One distinct author or narrator in a library, with their book count and total
 * `duration` (seconds). `name` is the whole field value: a "Kramer & Reading"
 * credit is one entry, matching the exact `author=`/`narrator=` books filter. */
export type PersonCount = { name: string; books: number; duration: number };

/** GET /libraries/{id}/authors or /narrators (capability `browse_people`),
 * normalized by the client: `people` is the `authors`/`narrators` array (sorted
 * case-insensitively by the server), `unknown` the number of books with the field
 * blank (or only spaces). `unknown` is a count only: an empty filter value is no
 * filter on GET /libraries/{id}/books, so those books cannot be listed. Counts cover
 * only books inside the caller's share scope. */
export type PeopleList = { people: PersonCount[]; unknown: number };

/** One distinct series in a library (GET /libraries/{id}/series, capability
 * `browse_people`): its book count, total `duration` (seconds), and the
 * `series_index` values the library holds (`positions`), so a UI can show gaps. */
export type SeriesCount = {
  name: string;
  author: string;
  books: number;
  duration: number;
  positions: number[];
};

/** Response of GET /libraries/{id}/next (capability `next_book`): what to play
 * after a book. `source` names the step that produced `next` (or that decided
 * nothing follows):
 * - `community`: the book's community series rail placed its next work on one of
 *   the caller's books, in ANY of their libraries, so `next.library_id` can differ
 *   from the library asked. `next`, `book` and `work` (with `local`) are all set.
 * - `series`: the next higher `series_index` of the same, exactly named, series in
 *   the same library; no `next` means the end of that numbered local series.
 * - `folder`: the next item in the book's parent folder (`book` only when indexed).
 * - `none`: nothing found.
 * The community rail answers only when it places its next work: failing to place it
 * (untagged books, a series named unlike the rail) does not prove it is not owned,
 * and a rail that ends at the current work can lag the library, so the local steps
 * then answer. With any of them, a `work` WITHOUT `local` is the community's next
 * work that this server couldn't place (e.g. "Next in the series: <title> (not on
 * this server)" beside the local answer); no `work` means the rail named nothing. */
export type NextBook = {
  source: 'community' | 'series' | 'folder' | 'none';
  /** What to play next: a book the caller can open. Open it by its own
   * `library_id`, which for `community` need not be the library asked. */
  next?: BookRef;
  /** The next book's indexed metadata in the list shape (no files, chapters or
   * description). */
  book?: Book;
  /** The community rail's next work: with `local` when `source` is `community`,
   * without it beside a `series`/`folder`/`none` answer when it couldn't be placed. */
  work?: BookMetaSeriesWork;
};

/** One copy of a book in a particular library - the non-winning copies behind a
 * de-duplicated search/recent result. */
export type BookLocation = {
  library_id: number;
  library_name: string;
  path: string;
  format?: string;
  size?: number;
  multi_file?: boolean;
};

export type ChaptersResponse = {
  library_id: number;
  path: string;
  duration: number;
  is_folder: boolean;
  files: BookFile[];
  chapters: Chapter[];
  /** Audio codec (ffprobe codec_name); empty if unprobed. */
  codec?: string;
  /** Whether the codec plays natively in browsers (see Book.direct_playable). */
  direct_playable?: boolean;
};

// --- Enriched metadata (community meta service, via /libraries/{id}/meta) -----
// The server resolves a book's asin/isbn against the community metadata API,
// composes the envelope below, and caches it. Capability-gated (`metadata`), so a
// client only ever asks a server that advertises it. `matched:false` (no ids or no
// upstream match) and any transport failure both render nothing (progressive
// enhancement). Hand-mirrored from the server's `internal/api` meta handler.

/** A person referenced by the metadata service (author or narrator). */
export type MetaPersonRef = { id: string; name: string };

/** A spoiler position on the work's own (edition-independent) timeline. `chapter`
 * is the logical book chapter; 0 means front matter / prior-book knowledge. */
export type BookMetaPosition = { chapter: number };

/** A community-authored, spoiler-tagged character entry (the CC BY-SA layer).
 * `reveal` is where the character is first disclosed in the work. */
export type BookMetaCharacter = {
  id: string;
  name: string;
  aliases?: string[];
  role?: 'protagonist' | 'antagonist' | 'supporting' | 'minor';
  reveal: BookMetaPosition;
  description?: string;
};

/** A position-keyed "story so far" recap; `through` is the position it is safe to
 * show at (the listener has finished that chapter). */
export type BookMetaRecap = {
  through: BookMetaPosition;
  scope?: 'book' | 'series';
  text: string;
};

/**
 * A whole-work summary pair, used to catch up on a book you have not read.
 * Omitted entirely when absent; when present at least one field is non-empty.
 *
 * `in_short` is the whole book in one short paragraph, ENDING INCLUDED - so for a
 * book the listener is still in, it is shown only behind a deliberate tap (or
 * inline once they have finished it).
 * `ending` is a FULL SPOILER for the work by construction - only ever render it
 * behind a deliberate extra tap, and never offer it for an unfinished current
 * book.
 */
export type BookMetaRecapSummary = { in_short?: string; ending?: string };

/** The abstract work (edition-independent): what the book is. */
export type BookMetaWork = {
  id: string;
  title: string;
  subtitle?: string;
  authors: MetaPersonRef[];
  language: string;
  first_published?: string;
  description?: string;
  /** Community expressive layer (CC BY-SA); absent on most works. */
  characters?: BookMetaCharacter[];
  recaps?: BookMetaRecap[];
  /** Whole-work catch-up summary. Both fields reveal the ending - gate them. */
  recap_summary?: BookMetaRecapSummary;
  /** The community-written description (CC BY-SA), separate from `description`.
   * Absent on most works and on older servers. */
  community_description?: BookMetaCommunityDescription;
  /** The CC BY-SA credit for this work's community content. Present iff the work
   * carries any (`characters`, `recaps`, `recap_summary` or
   * `community_description`); the UI must show it beside that content. The server
   * writes the legal text - render it, never compose it. Absent on older servers. */
  attribution?: BookMetaAttribution;
};

/** A community-written work description (CC BY-SA). `license` names the licence
 * when the entry states one. */
export type BookMetaCommunityDescription = { text: string; license?: string };

/** The licence credit for a work's community (CC BY-SA) content, written by the
 * server. `source_url` is the work's page on the metadata site (the same as the
 * envelope's `web_url`). */
export type BookMetaAttribution = {
  credit: string;
  license: string;
  license_url: string;
  source_url: string;
};

/** The specific narration/production matched to this book. Narrator and runtime
 * are intentionally shown elsewhere on the book screen, so the UI skips them here. */
export type BookMetaRecording = {
  id: string;
  narrators: MetaPersonRef[];
  abridged?: boolean;
  runtime_min?: number;
  release_date?: string;
  publisher?: string;
  cover_url?: string;
  /** Number of chapters in this recording. Absent when unknown and on older
   * servers. */
  chapter_count?: number;
};

/** One work in a series rail. Carries its own `web_url` so the client never
 * constructs meta URLs itself. */
export type BookMetaSeriesWork = {
  id: string;
  title: string;
  position: string;
  authors: MetaPersonRef[];
  cover_url?: string;
  web_url: string;
  /** A book the CALLER can open that is this work (resolved per request against
   * their libraries and share scope, so it can be in another library than the
   * envelope's). Absent when none could be placed, which needs the book's series to be
   * named like the rail (or the book to be the one the envelope is for), and on older
   * servers. */
  local?: BookRef;
};

/** Which reading order a series records (metaserve's `ordering` enum). Typed
 * loosely at the edges: an unknown upstream value falls back to the series name. */
export type BookMetaSeriesOrderingKind = 'publication' | 'chronological' | 'recommended';

/** Another reading order of the same ordering FAMILY (a primary series plus the
 * variants naming it), carried on the rail as an additive alternate view. */
export type BookMetaSeriesOrdering = {
  id: string;
  name: string;
  ordering?: BookMetaSeriesOrderingKind;
  /** Set when this view is itself a variant (names the family's primary). */
  ordering_of?: string;
  /** This work's position in this ordering - EMPTY/absent when the work is not in it. */
  position?: string;
  works: BookMetaSeriesWork[];
};

/** A series the work belongs to, with the full ordered rail (including the current
 * work - the UI filters it out by id). The top-level `works`/`position` are the
 * family's MAIN view (the primary order, or the variant for a work only a variant
 * places); `orderings` holds the family's other views. The three ordering fields are
 * additive - an older server omits them and every series is its own family. */
export type BookMetaSeries = {
  id: string;
  name: string;
  /** This work's position within the series. */
  position: string;
  works: BookMetaSeriesWork[];
  /** The main view's reading order, when the series states one. */
  ordering?: BookMetaSeriesOrderingKind;
  /** Set when the main view is itself a variant: the family's primary series id. */
  ordering_of?: string;
  /** The family's alternate views, in family order (primary first, then variants). */
  orderings?: BookMetaSeriesOrdering[];
};

/** Response of GET /libraries/{id}/meta. A discriminated union on `matched`:
 * `matched:false` when the book has no asin/isbn or the service found no match. */
export type BookMeta =
  | { matched: false }
  | {
      matched: true;
      work: BookMetaWork;
      recording?: BookMetaRecording;
      series?: BookMetaSeries[];
      web_url: string;
      /** The works before this one in its series, nearest first (at most 5). Only
       * sent when asked for with `include=previous` (capability `meta_bundle`);
       * absent when there are none and on older servers. Read from each rail's MAIN
       * view only (numbered positions, never an alternate reading order), so it is
       * not the reader's picked order that the book screen's own previous books
       * follow; a work that fails to load is left out. With `spoilers=hide` each
       * one's `recap_summary.ending` is left out. */
      previous?: BookMetaWork[];
    };

export type Progress = {
  library_id: number;
  path: string;
  position: number;
  duration: number;
  finished: boolean;
  playback_speed: number;
  version: number;
  device_id: string;
  updated_at: string;
};

/** Fields a client sends on PUT progress (server fills library_id/path/version). */
export type ProgressInput = {
  position: number;
  duration: number;
  finished?: boolean;
  playback_speed?: number;
  version?: number;
  device_id?: string;
  updated_at?: string;
};

export type Bookmark = {
  id: number;
  library_id: number;
  path: string;
  position: number;
  note: string;
  created_at: string;
};

export type Note = {
  id: number;
  library_id: number;
  path: string;
  position: number;
  body: string;
  created_at: string;
  updated_at: string;
};

/** A user-hearted item, addressed by (library_id, path). May be a navigation
 * folder, a book folder, or a single-file book. `is_book` reports whether the
 * server matched an indexed book at the path (so the client knows whether to open
 * the book screen or drill into the folder); the title/author/… fields are only
 * populated for books. */
export type Favourite = {
  library_id: number;
  path: string;
  is_book: boolean;
  title: string;
  author: string;
  series: string;
  series_index: number;
  duration: number;
  created_at: string;
};

/** A recorded listening span (positions over a time range). */
export type History = {
  id: number;
  library_id: number;
  path: string;
  from_pos: number;
  to_pos: number;
  started_at: string;
  ended_at: string;
};
