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
  /** Whether books can be in several series: `series_list` on a {@link Book} in more
   * than one, and `memberships=1` on `/libraries/{id}/books?series=` and
   * `/libraries/{id}/series` to match and count a book in every series it is in.
   * Absent on older servers - treat missing as false (main series only). */
  series_memberships?: boolean;
  /** Whether the server resolves what to play after a book (`/libraries/{id}/next`,
   * {@link NextBook}). Absent on older servers - treat missing as false and keep the
   * client-side folder-sibling fallback. */
  next_book?: boolean;
  /** Whether `/libraries/{id}/meta` honours `include=previous` and `spoilers=hide`.
   * Tracks `metadata` (off when enrichment is off). Absent on older servers - treat
   * missing as false: such a server ignores both params and sends the full envelope. */
  meta_bundle?: boolean;
  // The user-state flags below (player redesign Phase 1b) are all absent on older
  // servers: treat missing as false and never call the routes they gate.
  /** Whether the server keeps an Up next queue per user (`/me/queue`, every method;
   * {@link QueueEntry}). */
  queue?: boolean;
  /** Whether the server keeps personal collections, shareable read-only with named
   * users (`/me/collections/**` and `/me/share-targets`; {@link Collection}). */
  collections?: boolean;
  /** Whether the server keeps a 1-5 rating with a note per book
   * (`/libraries/{id}/rating` and `/me/ratings`; {@link Rating}). */
  ratings?: boolean;
  /** Whether the caller can edit their own progress (`PATCH /libraries/{id}/progress`,
   * {@link ProgressEdit}: mark unfinished, set the started/finished dates) and progress
   * responses carry `started_at`/`finished_at`. */
  progress_edit?: boolean;
  /** Whether the server reports the caller's own listening: `/me/stats`
   * ({@link UserStats}), `/me/listening` ({@link MyListening}) and `/me/goal`
   * ({@link ListeningGoalStatus}). */
  user_stats?: boolean;
  /** Whether the caller can list and sign out their own devices (`/me/devices`,
   * {@link MyDevice}). */
  my_devices?: boolean;
  /** Whether the server keeps bookmark labels ({@link BookmarkLabel}), takes edits to
   * bookmarks and notes (`PATCH /bookmarks/{id}`, `PATCH /notes/{id}`), and lists the
   * caller's bookmarks and notes across books (`/me/bookmarks`, `/me/notes`) with
   * `/me/history` paged on a cursor (player redesign Phase 4). Absent on older servers:
   * treat missing as false, never send a `label` (such a server rejects the unknown field
   * with a 400) and never call the routes it gates. */
  annotations?: boolean;
  /** Whether the server tells the player its home and away addresses
   * ({@link ServerAddresses}): on the pairing payload and its links, the exchange and
   * login answers, and `GET /addresses` (player redesign Phase 5). Absent on older
   * servers: treat missing as false and never call `/addresses`; the player then keeps
   * the one address it was paired with. */
  addresses?: boolean;
};

/** A server's two addresses (capability `addresses`). Either may be absent. `home` is
 * the address on the household network (fast, often plain http, only reachable at
 * home); `away` is the configured public address that works from anywhere. The player
 * switches between them by itself (`src/api/address-route.ts`). */
export type ServerAddresses = { home?: string; away?: string };

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
  /** The server's home and away addresses (capability `addresses`; omitted when it
   * has neither, and by older servers). */
  addresses?: ServerAddresses;
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
  /** The server's home and away addresses (capability `addresses`; omitted when it has
   * neither, and by older servers). The `uri` and `web_url` links carry them too, as
   * `home=` and `away=` params (`parsePairingScan`). */
  addresses?: ServerAddresses;
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
  /** Every series the book is in, its main one (`series`) first, with its position in
   * each (0 = none) - present only for a book in more than one series (capability
   * `series_memberships`; absent from older servers and downloads saved from one). */
  series_list?: SeriesMembership[];
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
  /** `"community"` when the book's chapters are a community recording's list (from
   * the metadata service) fitted onto its audio, rather than the files' own. Only
   * GET /libraries/{id}/item sends it; absent means the files' own chapters, and on
   * older servers. */
  chapters_source?: 'community';
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
 * `duration` (seconds). `name` is one person: a "Kramer & Reading" credit counts
 * for each of them, and the `author=`/`narrator=` books filter finds a book by
 * its whole credit or any one of its people (an older server lists and matches
 * whole credits only). */
export type PersonCount = { name: string; books: number; duration: number };

/** GET /libraries/{id}/authors or /narrators (capability `browse_people`),
 * normalized by the client: `people` is the `authors`/`narrators` array (sorted
 * case-insensitively by the server), `unknown` the number of books whose credit
 * names nobody (blank, only spaces or only joiners). `unknown` is a count only: an empty filter value is no
 * filter on GET /libraries/{id}/books, so those books cannot be listed. Counts cover
 * only books inside the caller's share scope. */
export type PeopleList = { people: PersonCount[]; unknown: number };

/** One series a book is in, with its position there (0 = none). */
export type SeriesMembership = { name: string; position: number };

/** One distinct series in a library (GET /libraries/{id}/series, capability
 * `browse_people`): its book count, total `duration` (seconds), and the
 * `series_index` values the library holds (`positions`), so a UI can show gaps. */
export type SeriesCount = {
  name: string;
  author: string;
  books: number;
  duration: number;
  positions: number[];
  /** How many of `books` are in it beyond their main series (`memberships=1`,
   * capability `series_memberships`); 0 without memberships, absent on older servers. */
  extra_books?: number;
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
  /** `"community"` when `chapters` are a community recording's list fitted onto the
   * book's audio (see Book.chapters_source); absent means the files' own chapters,
   * and on older servers. The chapters themselves have the same shape either way. */
  chapters_source?: 'community';
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
  /** RFC3339 UTC: when the caller started the book. Sent by a server with
   * `progress_edit`; absent when unknown and on older servers. */
  started_at?: string;
  /** RFC3339 UTC: when the caller finished the book. Sent by a server with
   * `progress_edit`; absent when not finished (or unknown) and on older servers. */
  finished_at?: string;
};

/** Body of PATCH /libraries/{id}/progress (capability `progress_edit`): the caller's
 * own edit, stamped with server time and a newer version (it beats older device saves;
 * a device with the book loaded overrides it on its next save). Every field is
 * optional: absent leaves it as it is.
 * - `finished: true` on a book not yet finished moves the position to the end and
 *   sets `finished_at` to now unless one is given; on a book already finished it
 *   changes neither.
 * - `finished: false` (mark unfinished) keeps the position unless one is given and
 *   clears `finished_at`. A book finished at its end is stored at (or within a few
 *   seconds of) its duration, and the player resumes an unfinished book at its saved
 *   position, so it would finish again at once: send a `position` (say 0) with
 *   `finished: false` for such a book.
 * - Dates are RFC3339 or `YYYY-MM-DD` (server time; a day-only finish is the end of
 *   that day, or now if sooner); `null` clears one. A date in the future, a finish
 *   before the start, or a finish on a book that isn't (becoming) finished is a 400.
 *   An edit that creates the progress (none yet) starts the book now, so a past
 *   `finished_at` there needs a `started_at` at or before it (or `null`).
 * It is not playback, so it records no listening session. */
export type ProgressEdit = {
  finished?: boolean;
  position?: number;
  started_at?: string | null;
  finished_at?: string | null;
};

/** Fields a client sends on PUT progress (server fills library_id/path/version). The
 * server ignores any dates here: a save stamps `started_at`/`finished_at` itself. */
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
  /** A machine key, never display text: `''` when none, else `^[a-z][a-z0-9_]{0,31}$`.
   * The player's own keys are {@link BookmarkLabel}; a newer client may store others, so
   * check with `isBookmarkLabel` (`src/api/bookmark-labels.ts`) before naming one.
   * Sent by a server with `annotations` (always, `''` included); absent on older
   * servers. */
  label?: string;
  created_at: string;
};

/** The bookmark labels this player knows: the five a listener picks, and `fell_asleep`,
 * the sleep timer's automatic bookmark. The server checks only a label's shape (see
 * {@link Bookmark.label}), never this list. Ordered lists and a type guard live in
 * `src/api/bookmark-labels.ts`. */
export type BookmarkLabel =
  'quote' | 'favourite' | 'relisten' | 'funny' | 'question' | 'fell_asleep';

/** Body of PATCH /bookmarks/{id} (capability `annotations`, owner only): absent fields
 * are left as they are, at least one is required. `label: ''` clears the label; `note`
 * is at most 2000 characters. */
export type BookmarkPatch = { note?: string; label?: BookmarkLabel | '' };

export type Note = {
  id: number;
  library_id: number;
  path: string;
  position: number;
  body: string;
  created_at: string;
  updated_at: string;
};

/** Body of PATCH /notes/{id} (capability `annotations`, owner only): absent fields are
 * left as they are, at least one is required. `body` is at most 10000 characters;
 * `position` (seconds on the whole-book timeline) is finite and >= 0. The edit moves
 * `updated_at`. */
export type NotePatch = { body?: string; position?: number };

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

// --- Across books (player redesign Phase 4, capability `annotations`) -----------
// The caller's own rows over every book they can still open, newest first, one keyset
// page at a time. A row whose path is outside the caller's CURRENT access is left out
// (kept on the server). `book` is the list shape (no description), present when the
// path is indexed.

/** One page of an across-books list, as the client normalizes it: the rows (`items`,
 * the wire's `bookmarks`/`notes`/`history` array) and the cursor to the next page,
 * absent on the last one. An older server never sends `next_cursor`, so its answer is
 * exactly one page. Pass `next_cursor` back as {@link PageQuery.cursor}. */
export type Page<T> = { items: T[]; next_cursor?: string };

/** Paging of the across-books lists. `limit` is 1-500 (the server's default 100, a
 * larger value is clamped); `cursor` is a previous page's opaque `next_cursor` (a
 * malformed one is a 400). */
export type PageQuery = { limit?: number; cursor?: string };

/** One of the caller's bookmarks across books (GET /me/bookmarks): newest made first. */
export type MyBookmark = Bookmark & { book?: Book };

/** One of the caller's notes across books (GET /me/notes): newest made first. */
export type MyNote = Note & { book?: Book };

/** One of the caller's listening spans across books (GET /me/history, every server):
 * newest ended first. `book` is sent by a server with `annotations` only. */
export type HistoryEntry = History & { book?: Book };

// --- User state & personal stats (player redesign Phase 1b) --------------------
// Each route is gated on its own capability flag (see Capabilities). Stored rows are
// path-keyed and survive re-indexing; a list read leaves out a row whose path is
// outside the caller's CURRENT access (kept on the server, not returned, not counted),
// but a whole-list replace (PUT) deletes such rows like any other row it doesn't list.

/** A user on the same server, as the collection share list names them. */
export type UserRef = { id: number; username: string };

/** One book on a stored list (Up next, a collection): its address, when it was
 * added (RFC3339), and the book in the list shape (no description) when the path is
 * indexed. */
export type BookListEntry = BookRef & {
  added_at: string;
  book?: Book;
};

/** One entry of the caller's Up next queue (capability `queue`), in queue order. */
export type QueueEntry = BookListEntry;

/** One item of a collection (capability `collections`), in collection order. */
export type CollectionItem = BookListEntry;

/** A personal collection (capability `collections`): owned by the caller or shared
 * with them read-only. */
export type Collection = {
  id: number;
  name: string;
  description: string;
  owner: UserRef;
  /** Whether the caller owns it. Only the owner can change it; a viewer can only
   * leave (DELETE). */
  owned: boolean;
  /** Who it is shared with: sent to the owner only (`[]` when unshared), absent for a
   * viewer. */
  shared_with?: UserRef[];
  /** Items the CALLER can see (their own current access), not the owner's total. */
  item_count: number;
  /** The first (up to 4) visible indexed items, for a cover mosaic. */
  preview: Book[];
  created_at: string;
  /** Moves on a rename, a description change and any items change. */
  updated_at: string;
};

/** Response of GET /me/collections/{id} (and of the items writes): the collection and
 * its items in order, filtered by the caller's current access. */
export type CollectionDetail = { collection: Collection; items: CollectionItem[] };

/** Body of POST /me/collections. `name` is 1-100 characters after trimming;
 * `description` at most 1000. */
export type CollectionInput = { name: string; description?: string };

/** Body of PATCH /me/collections/{id}: absent fields are left as they are. */
export type CollectionPatch = { name?: string; description?: string };

/** A user the caller can share a collection with (GET /me/share-targets): enabled,
 * non-demo, not the caller. */
export type ShareTarget = UserRef;

/** A rating value: a whole number of stars. */
export type RatingValue = 1 | 2 | 3 | 4 | 5;

/** The caller's rating of a book (capability `ratings`), stored on the book's own
 * path (rating a part/disc path rates its book). `note` is trimmed, at most 500
 * characters, `''` when none. */
export type Rating = BookRef & {
  rating: RatingValue;
  note: string;
  created_at: string;
  updated_at: string;
};

/** One row of GET /me/ratings: the rating plus the book in the list shape when the
 * path is indexed. */
export type RatedBook = Rating & { book?: Book };

/** The `range` of the personal stats routes: the last 7/30/90 days, the last year
 * (`1y`), this calendar year (`year`, answered as its `YYYY`), or a calendar year
 * (`YYYY`, 2000 or later). The server reads an absent range as `30d`; anything else
 * is a 400. Days, hours and weekdays are in server time. */
export type StatsRange = '7d' | '30d' | '90d' | '1y' | 'year' | `${number}`;

/** The period a stats response covers. `range` is the label asked for (`year` comes
 * back as its `YYYY`); `from`/`to` are RFC3339 UTC; `timezone` is the server's zone
 * abbreviation at `to` and `utc_offset` its offset from UTC in minutes. */
export type StatsPeriod = {
  range: string;
  from: string;
  to: string;
  timezone: string;
  utc_offset: number;
};

/** The caller's totals for a period: `listened` in seconds (wall clock), `sessions`
 * that started in it, distinct `books` listened to, and books `finished` in it. */
export type StatsTotals = {
  listened: number;
  sessions: number;
  books: number;
  finished: number;
};

/** One day's listening in seconds; `date` is `YYYY-MM-DD` in server time. */
export type ListeningDay = { date: string; listened: number };

/** A book by the caller's listening time in the period. */
export type StatsTopBook = BookRef & {
  title: string;
  author: string;
  listened: number;
};

/** An author, narrator or series (the whole field value) by the caller's listening
 * time, with how many of its books they listened to. */
export type StatsTopName = { name: string; listened: number; books: number };

/** A book the caller finished in the period; `finished_at` is RFC3339. */
export type StatsFinishedBook = BookRef & {
  title: string;
  author: string;
  finished_at: string;
};

/** Listening by how it played: direct or through the transcoder, per codec (`''` =
 * unknown). */
export type StatsPlayback = {
  transcoded: boolean;
  codec: string;
  listened: number;
  sessions: number;
};

/** The app a token last identified as (the `X-AudioSilo-Client` header). */
export type ClientInfo = { app: string; version: string; platform: string };

/** An app version the caller listened with, and on how many of their devices. */
export type StatsClient = ClientInfo & { devices: number };

/** Response of GET /me/stats (capability `user_stats`): the caller's own listening,
 * never anyone else's. Totals, `days` and `hour_weekday` count all of the caller's
 * time; the top lists and `finished_books` only cover books inside the caller's
 * current access (a revoked share's books never echo back). */
export type UserStats = StatsPeriod & {
  totals: StatsTotals;
  /** The same length of time just before `from`, for deltas. */
  previous: StatsTotals;
  /** Seconds of `totals.listened` that are estimates (listening from before the server
   * recorded sessions); in the totals and top lists, never in `days`/`hour_weekday`. */
  estimated: number;
  /** Every day of the period, oldest first, zeros included. */
  days: ListeningDay[];
  /** Listened seconds as [weekday][hour]: 7 rows (0 = Monday) of 24 hours, server
   * time, from raw sessions only. */
  hour_weekday: number[][];
  /** At most 10 each. */
  top_books: StatsTopBook[];
  top_authors: StatsTopName[];
  top_narrators: StatsTopName[];
  top_series: StatsTopName[];
  /** Newest first, at most 100. */
  finished_books: StatsFinishedBook[];
  playback: StatsPlayback[];
  clients: StatsClient[];
};

/** Response of GET /me/listening (capability `user_stats`): the caller's listening
 * day by day and nothing else. Streaks are the client's to compute from `days`. */
export type MyListening = StatsPeriod & { days: ListeningDay[] };

/** The caller's yearly goal: books finished per calendar year (1-1000). */
export type ListeningGoal = { books_per_year: number; updated_at: string };

/** Response of GET and PUT /me/goal (capability `user_stats`): the goal (`null` when
 * unset), the current calendar `year` (`YYYY`, server time) and the books the caller
 * has `finished` in it. */
export type ListeningGoalStatus = { goal: ListeningGoal | null; year: string; finished: number };

/** One of the caller's own signed-in devices (capability `my_devices`): a session (a
 * paired phone, a browser) or an API key. */
export type MyDevice = {
  id: number;
  kind: 'session' | 'api';
  /** The device name sent at sign-in (an API key's label). */
  name: string;
  /** Null until the token makes a request naming its app. */
  client: ClientInfo | null;
  created_at: string;
  last_seen: string | null;
  /** The address of the token's newest request (`''` before any). */
  last_ip: string;
  /** Whether this is the token making the request (this device). */
  current: boolean;
};

/** Response of DELETE /me/devices/{id}: `current` is true when the caller signed out
 * the very token it used, which is dead from then on (sign out locally). */
export type MyDeviceRevoked = { current: boolean };
