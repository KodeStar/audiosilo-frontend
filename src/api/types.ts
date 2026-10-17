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
  /** Whether `/libraries/{id}/series/books?name=...` answers the first page of several
   * series' books in one request ({@link SeriesBooks}). Comes with `series_memberships`.
   * Absent on older servers - treat missing as false and ask `/libraries/{id}/books`
   * once per series. */
  series_books?: boolean;
  /** Whether the server resolves what to play after a book (`/libraries/{id}/next`,
   * {@link NextBook}). Absent on older servers - treat missing as false and keep the
   * client-side folder-sibling fallback. */
  next_book?: boolean;
  /** Whether `/libraries/{id}/meta` honours `include=previous` and `spoilers=hide`.
   * Tracks `metadata` (off when enrichment is off). Absent on older servers - treat
   * missing as false: such a server ignores both params and sends the full envelope. */
  meta_bundle?: boolean;
  /** Whether the server serves community covers itself
   * (`/libraries/{id}/meta/cover`, `client.communityCoverUrl`): a JPEG
   * thumbnail of a `cover_url` the book's `/meta` envelope hands out. Tracks
   * `metadata`. Absent on older servers - treat missing as false: the web player
   * can't load a cover from its own host (its CSP takes images only from the
   * server), so it shows the placeholder; native loads the `cover_url` directly. */
  meta_covers?: boolean;
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
  /** Whether the server keeps "Listening in the house" (player redesign Phase 8): the
   * caller's opt-in (`/me/household`, {@link HouseholdSettings}) and what the other
   * people on the server who share are listening to (`/household/listening`,
   * {@link HouseListening}). Absent on older servers: treat missing as false, hide the
   * toggle and the Home row, and never call the routes. */
  household?: boolean;
  /** Whether the server mints cast tokens (`POST /cast/token`, {@link CastToken}) and
   * accepts one as the `?token=` of a book's cover and stream, so a Chromecast receiver
   * never gets the session token (player redesign Phase 8). Absent on older servers:
   * treat missing as false and show no Cast button. */
  cast?: boolean;
  /** Whether the caller can add household members (player redesign Phase 8b-1): accounts
   * they own and manage (`/me/household/members/**`, {@link HouseholdMembers}), the
   * `managed_by` and `member_kind` of a {@link User}, `member_sign_ins` on
   * {@link MyDevice} and `?also_members=1` on `DELETE /me/devices/{id}`. Absent on older
   * servers: treat missing as false, never call the routes and never send
   * `also_members`. */
  household_members?: boolean;
  /** Whether an AudioSilo Bridge is paired and online (its heartbeat is under two minutes
   * old); what it can do is {@link ServerInfo.bridge}'s `features`. Absent on older servers
   * and false while the Bridge is offline: treat missing as false and show no Bridge
   * action (the admin console covers it). */
  bridge?: boolean;
};

/** A server's two addresses (capability `addresses`). Either may be absent. `home` is
 * the address on the household network (fast, often plain http, only reachable at
 * home); `away` is the configured public address that works from anywhere. The player
 * switches between them by itself (`src/api/address-route.ts`). */
export type ServerAddresses = { home?: string; away?: string };

export type ServerInfo = {
  name: string;
  /** Stable per-install identity minted once by the server. The client's connection id
   * is it plus the user's id (`<server_id>.<user_id>`, `connectionIdOf`), so a connection
   * keeps its identity across URL changes and remove/re-add, and two people on one server
   * are two connections. Compare servers with `serverIdOf`, never a connection id. */
  server_id: string;
  version: string;
  api: string;
  capabilities: Capabilities;
  auth: { methods: string[] };
  /** Present when the server runs in public demo mode (instant throwaway accounts). */
  demo?: { enabled: boolean };
  /** The online Bridge's version and the job families it offers (`sidecars`: generating
   * characters and recaps, `sidecars.generate`). Present only while
   * `capabilities.bridge` is true; absent on older servers. */
  bridge?: ServerBridge;
};

/** The Bridge block of GET /server (see {@link ServerInfo.bridge}). */
export type ServerBridge = { version: string; features: string[] };

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
  /** The person who manages this account when it is a household member (capability
   * `household_members`); `null` for an ordinary account, absent on older servers. */
  managed_by?: UserRef | null;
  /** A household member's kind (capability `household_members`); `null` for an ordinary
   * account, absent on older servers. A kid's account has no password or API keys and
   * can't pair a device itself: their owner signs them in. */
  member_kind?: MemberKind | null;
  /** A household member's name as their owner gave it (capability `household_members`):
   * a new profile for this account is named after it. Absent for an ordinary account and
   * on older servers (the username stands in). */
  display_name?: string;
};

/** Response of /auth/exchange and /auth/login. The token is the session secret;
 * `server_id` is the paired server's stable identity (with `user.id`, the connection id:
 * `connectionIdOf`). */
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
   * `home=` and `away=` params, and the server's `server_id` as `sid=` (newer servers;
   * `parsePairingScan` reads all three). */
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
  /** The end of a range position (an omnibus of 1-3), as on a `Book`. */
  series_index_end?: number;
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

/** Where a book's chapters come from when they are not the files' own (see
 * Book.chapters_source): a community recording's list, or a Bridge's detection. */
export type ChaptersSource = 'community' | 'generated';

export type Book = {
  id: number;
  library_id: number;
  rel_path: string;
  is_folder: boolean;
  title: string;
  author: string;
  series: string;
  /** Its position in `series` (0 = none); the START when that position is a range. */
  series_index: number;
  /** The END of its position in `series` when that is a range (an omnibus of books 1-3:
   * `series_index` 1, `series_index_end` 3); absent for a single position, and from
   * older servers. */
  series_index_end?: number;
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
  /** The book's subtitle (an Audiobookshelf metadata.json, a community match or an
   * admin edit; never an audio tag). Sent on every book response; absent when unknown
   * or on an older server. */
  subtitle?: string;
  /** The publisher, from the same sources as `subtitle`. */
  publisher?: string;
  /** The language as the sources give it (a code like "en", or a name), from the same
   * sources as `subtitle`. */
  language?: string;
  /** Whether the recording is abridged, from the same sources as `subtitle` (a
   * metadata.json or a match only ever says true): absent is UNKNOWN (never read as
   * unabridged), as on an older server. */
  abridged?: boolean;
  /** The book's genres (the files' genre tag, a metadata.json or an admin edit; no
   * community genres yet), each trimmed with its inner spacing collapsed and once by
   * `labelKey` (src/lib/labels.ts). Sent on list and search pages too (the Library's
   * filters read them on the device); absent when there are none or on an older server. */
  genres?: string[];
  /** Freeform tags (a metadata.json or an admin edit; no audio tag carries them), as
   * `genres`. */
  tags?: string[];
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
   * the metadata service) fitted onto its audio, rather than the files' own;
   * `"generated"` when a Bridge on this server found them in the narration of a book
   * with no chapters of its own (Bridge Phase 1d). Only GET /libraries/{id}/item sends
   * it; absent means the files' own chapters, and on older servers. */
  chapters_source?: ChaptersSource;
  /** True when the book's `.audiosilo/` folder holds characters, recaps or a description a
   * Bridge generated on this server (Bridge Phases 1a and 1c; list, search, item, recent
   * and the next book's `book` send it). Absent otherwise, and on older servers. */
  generated?: boolean;
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

/** One series of GET /libraries/{id}/series/books (capability `series_books`): exactly
 * the page `GET /libraries/{id}/books?series=<name>&memberships=1&limit=N` would return
 * (default sort; `books` is `[]` for none), so `next_cursor` (absent once exhausted)
 * continues on that `/books` query. */
export type SeriesBooksEntry = BookPage & { name: string };

/** Response of GET /libraries/{id}/series/books: one entry per distinct requested name,
 * in request order. */
export type SeriesBooks = { series: SeriesBooksEntry[] };

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

/** One series a book is in, with its position there (0 = none). A range (books 1-3)
 * is `position` 1 with `position_end` 3; `position_end` is absent for a single
 * position, and from older servers. */
export type SeriesMembership = { name: string; position: number; position_end?: number };

/** One distinct series in a library (GET /libraries/{id}/series, capability
 * `browse_people`): its book count, total `duration` (seconds), and the
 * `series_index` values the library holds (`positions`), so a UI can show gaps. A book
 * at a range holds every whole position in it (an omnibus 1-3 gives 1, 2 and 3), so
 * `positions` can outnumber `books`. */
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
 *   the same library (after a range, past its END); no `next` means the end of that
 *   numbered local series.
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
   * book's audio, `"generated"` when a Bridge on this server found them in the
   * narration (see Book.chapters_source); absent means the files' own chapters, and on
   * older servers. The chapters themselves have the same shape either way. */
  chapters_source?: ChaptersSource;
};

// --- Enriched metadata (community meta service, via /libraries/{id}/meta) -----
// The server resolves a book's asin/isbn against the community metadata API,
// composes the envelope below, and caches it. Capability-gated (`metadata`), so a
// client only ever asks a server that advertises it. `matched:false` without a `work`
// (no ids or no upstream match, and nothing generated on the server) and any transport
// failure both render nothing (progressive enhancement). Hand-mirrored from the
// server's `internal/api` meta handler.

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
  /** Which of `characters`, `recaps` and the description (`generated_description`) came
   * from files the Bridge generated on this server (the book's `.audiosilo/` folder) rather
   * than the community: community content wins per dimension, so a dimension is generated
   * only where the community has none. Omitted when nothing did (and on older servers).
   * Generated content carries no `attribution` of its own. */
  generated?: BookMetaGenerated;
  /** A description the Bridge wrote on this server in its own words (the book's
   * `.audiosilo/description.json`; Bridge Phase 1c), spoiler-free by contract. Only sent
   * when the community work has no `community_description`, and never CC BY-SA: it
   * carries no `attribution`. `generated.description` says it is there. Absent on older
   * servers. */
  generated_description?: BookMetaGeneratedDescription;
};

/** What of a work came from this server's own generated files (see
 * {@link BookMetaWork.generated}). `generated_at` is RFC 3339. `description` is Bridge
 * Phase 1c's (absent on a 1a/1b server). */
export type BookMetaGenerated = {
  characters?: boolean;
  recaps?: boolean;
  description?: boolean;
  generated_at?: string;
};

/** A description generated on this server (see {@link BookMetaWork.generated_description}). */
export type BookMetaGeneratedDescription = { text: string };

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
  /** Its position on the rail as text ("3", "2.5"); "1-3" is a range (an omnibus
   * holding books 1 to 3). Read it with `@/lib/series-position`. */
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
 * `matched:false` when the book has no asin/isbn or the service found no match. An
 * unmatched book whose characters, recaps or description were generated on this server
 * (Bridge Phases 1a and 1c) carries them in `work` (`id` empty, `title` the book's own,
 * `authors` empty, `language` empty, and its `generated`). Older servers never send it. */
export type BookMeta =
  | { matched: false; work?: BookMetaWork }
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
  /** The end of a range position (an omnibus of 1-3), as on a `Book`. */
  series_index_end?: number;
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

/** Response of GET and PUT /me/household (capability `household`): whether the caller
 * shares what they are listening to with the other people on the server. Off by default.
 * PUT takes the same shape (the field is required). A demo account's PUT is a 403. */
export type HouseholdSettings = { share_listening: boolean };

/** A housemate's state, from the age of their newest progress save: `playing` within a
 * minute, `paused` within ten minutes, `recent` within the last 24 hours. */
export type HouseListeningState = 'playing' | 'paused' | 'recent';

/** One other person on the server who shares, on their newest book (capability
 * `household`). Never carries a device, an address, an app or a token. */
export type HouseListeningRow = {
  user_id: number;
  username: string;
  library_id: number;
  path: string;
  /** The index's title, else the path's last segment (never empty). */
  title: string;
  author: string | null;
  state: HouseListeningState;
  /** Seconds into the whole book. */
  position: number;
  /** Whole-book seconds; null when unknown. */
  duration: number | null;
  /** The chapter at `position` as the server tidies it; null for a single-chapter book,
   * and for a chapter whose title names nothing ("Track 01"), where `chapter_index`
   * still says which (show "Chapter N"). */
  chapter: string | null;
  /** 0-based; null for a single-chapter or unindexed book. */
  chapter_index: number | null;
  /** The newest save, fixed-width UTC milliseconds (`2026-10-09T19:59:30.000Z`). */
  updated_at: string;
};

/** Response of GET /household/listening (capability `household`). Reciprocal:
 * `listening` is `[]` unless the caller shares (`sharing`). Otherwise one row per other
 * enabled, non-demo person who shares and listened in the last 24 hours, on a book the
 * caller may see, newest first. */
export type HouseListening = { sharing: boolean; listening: HouseListeningRow[] };

/** Response of POST /cast/token (capability `cast`): a short-lived (24 h) credential for
 * ONE book, accepted only as the `?token=` of that book's cover and stream URLs (never as
 * a header, never on another route or book). `expires_at` is fixed-width UTC
 * milliseconds. */
export type CastToken = { token: string; expires_at: string };

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
  /** The caller's household members signed in on this device (made here, still live):
   * `DELETE /me/devices/{id}?also_members=1` signs them out with it. Capability
   * `household_members`; absent on older servers and on a member's own device rows. */
  member_sign_ins?: { id: number; name: string }[];
};

/** Response of DELETE /me/devices/{id}: `current` is true when the caller signed out
 * the very token it used, which is dead from then on (sign out locally). */
export type MyDeviceRevoked = {
  current: boolean;
  /** How many of the caller's household members' sign-ins made on that device were
   * signed out with it (`?also_members=1`; 0 without it). Capability
   * `household_members`; absent on older servers. */
  members_signed_out?: number;
};

// --- Household members (capability `household_members`, player redesign Phase 8b-1) ---
// Accounts the caller owns and manages: a kid (no password or API keys; the owner signs
// them in) or a grown-up. A member's access is everything the owner can listen to
// (`all`) or only the owner's collections shared with them (`collections`).

/** A household member's kind. */
export type MemberKind = 'kid' | 'grownup';

/** What a household member can listen to: everything their owner can (`all`), or only
 * the owner's collections shared with them (`collections`). */
export type MemberAccess = 'all' | 'collections';

/** One of the owner's collections shared with a member, with its item count. */
export type HouseholdMemberCollection = { id: number; name: string; items: number };

/** One of the caller's household members (GET /me/household/members, and the answers of
 * POST and PATCH). Timestamps are fixed-width UTC milliseconds. */
export type HouseholdMember = {
  id: number;
  /** The name the owner gave them (the username when none). */
  name: string;
  username: string;
  kind: MemberKind;
  access: MemberAccess;
  created_at: string;
  /** The owner's collections shared with them: present (possibly `[]`) for
   * `access: 'collections'`, absent for `all`. */
  collections?: HouseholdMemberCollection[];
  /** How many devices they are signed in on (sessions plus API keys). */
  devices: number;
  /** Null when they have never listened. */
  last_listened_at: string | null;
};

/** Why the caller can't add household members: the server's switch is off
 * (`feature_off`), the admin turned it off for this person (`not_allowed`), the caller is
 * a member themselves (`member`) or a demo account (`demo`). Being at the cap is not a
 * reason: compare `members.length` with `max`. */
export type HouseholdMembersReason = 'feature_off' | 'not_allowed' | 'member' | 'demo';

/** Response of GET /me/household/members (capability `household_members`). `allowed`
 * gates adding only: an owner can always rename, sign out and delete the members they
 * have. `max` is the most members one person may have. Members sorted oldest first. */
export type HouseholdMembers = {
  allowed: boolean;
  /** Present when `allowed` is false. */
  reason?: HouseholdMembersReason;
  max: number;
  members: HouseholdMember[];
};

/** Body of POST /me/household/members. `name` is 1-40 characters after trimming (the
 * server derives the username). `sign_in_here` also signs the member in on the caller's
 * device (the answer's `session`). `collection_ids` is the full set of the caller's own
 * collections to share with them (sent for `access: 'collections'`). */
export type AddMemberBody = {
  name: string;
  kind: MemberKind;
  access: MemberAccess;
  sign_in_here?: boolean;
  collection_ids?: number[];
};

/** Response of POST /me/household/members (201): the new member, and their session on
 * this device when the body asked for `sign_in_here`. */
export type AddMemberResult = { member: HouseholdMember; session?: AuthSession };

/** Body of PATCH /me/household/members/{id}: absent fields are left as they are (at least
 * one is required). `kind: 'kid'` removes the member's password and API keys.
 * `collection_ids` replaces the set of the caller's collections shared with them. */
export type UpdateMemberBody = {
  name?: string;
  kind?: MemberKind;
  access?: MemberAccess;
  collection_ids?: number[];
};

// --- AudioSilo Bridge (capability `bridge`, admin only) ------------------------------
// The server queues jobs; the paired Bridge claims and runs them and reports back. The
// player is an admin's window onto one kind, `sidecars.generate` (characters and recaps
// for a book), through the admin routes `/admin/bridge/**` (a non-admin gets a 403).
// Hand-mirrored from the server's `internal/bridge` (Job) and `internal/api`.

/** Where a Bridge job stands. `queued`, `claimed`, `running` and `needs_attention`
 * (parked: a person has to look at it in the Bridge, or it resumes by itself at
 * `progress.park.retry_at`) are open; the other three are final. */
export type BridgeJobState =
  'queued' | 'claimed' | 'running' | 'needs_attention' | 'done' | 'failed' | 'cancelled';

/** One Bridge job (GET/POST /admin/bridge/jobs, GET /admin/bridge/jobs/{id}, the
 * estimate's `open_job`). `params`, `progress` and `result` are the kind's own objects
 * (for `sidecars.generate`: {@link SidecarsGenerateParams},
 * {@link SidecarsGenerateProgress}, {@link SidecarsGenerateResult}); `null` until set.
 * Timestamps are RFC 3339 UTC. */
export type BridgeJob = {
  id: number;
  kind: string;
  /** Null for a job about no library. */
  library_id: number | null;
  /** The book's own path (`rel_path`: the admin routes take exactly that, and a part path
   * is a 404); null for a job about a whole library or none. */
  path: string | null;
  params: SidecarsGenerateParams | Record<string, unknown> | null;
  state: BridgeJobState | (string & {});
  progress: SidecarsGenerateProgress | null;
  result: SidecarsGenerateResult | Record<string, unknown> | null;
  /** Empty unless the job failed, or is parked (the park message). */
  error: string;
  /** The admin who queued it; null once that account is deleted. */
  requested_by: UserRef | null;
  priority: number;
  attempts: number;
  lease_until: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  finished_at: string | null;
};

/** Response of GET /admin/bridge/jobs: newest first, `next_before` for the next page. */
export type BridgeJobList = { jobs: BridgeJob[]; next_before?: number };

/** Body of POST /admin/bridge/jobs. */
export type BridgeJobRequest = {
  kind: string;
  library_id: number;
  path: string;
  params?: SidecarsGenerateParams;
};

/** `sidecars.generate`'s params (the server refuses unknown fields). `source` defaults to
 * `auto` (the ebook when an `.epub` sits in the book's folder, else the audio);
 * `contribute` to `local` (the results stay on this server; `issue` also offers them to
 * the community, which the player never asks for); `work_id` names the community work
 * when known (at most 200 bytes). */
export type SidecarsGenerateParams = {
  source?: 'auto' | 'audio' | 'ebook';
  contribute?: 'local' | 'issue';
  work_id?: string;
};

/** Why a parked job stopped, while it is parked (`needs_attention`). `code` is the
 * engine's park code (`agent_unavailable`, `budget_exceeded`, `book_not_writable`...),
 * `hint` the Bridge's English (for the console; the player says the code in its own
 * words), `retry_at` when an availability park resumes by itself. */
export type BridgeJobPark = { code: string; hint?: string; retry_at?: string };

/** `sidecars.generate`'s progress (the Bridge's PATCH; stored opaquely, so every field
 * is optional here). `step` is always set by the Bridge: an engine stage name or
 * `waiting` / `writing` / `rescanning`; `stage` the engine state when known. */
export type SidecarsGenerateProgress = {
  step?: string;
  message?: string;
  done?: number;
  total?: number;
  stage?: string;
  /** The engine's whole-book estimate of the time left. */
  eta_seconds?: number;
  /** Agent spend so far. */
  cost_usd?: number;
  source?: 'audio' | 'ebook';
  park?: BridgeJobPark;
};

/** `sidecars.generate`'s result on `done`. */
export type SidecarsGenerateResult = {
  library_id: number;
  path: string;
  source: 'audio' | 'ebook';
  /** The file names written into the book's `.audiosilo/`. */
  files: string[];
  characters: number;
  recaps: number;
  cost_usd?: number;
  work_id?: string;
  /** Only with `contribute: issue`: where each dimension was offered. */
  contributed?: { characters?: string; recaps?: string };
  /** Whether the run also wrote the book's `description.json` (Bridge Phase 1c). Absent
   * from an older Bridge. */
  description?: boolean;
  /** Why no description was written, in a few plain words; only when `description` is
   * false. */
  description_error?: string;
};

/** An earlier book of the same series, in the same library, with no recaps yet (the
 * estimate's `earlier`, in reading order), with what generating it is expected to take
 * (costed from its audio), so the confirmation can quote the whole run it queues. */
export type BridgeEstimateBook = {
  library_id: number;
  path: string;
  title: string;
  series_index: string;
  /** Transcription time; 0 when not known (no figures, or the audio's length unknown). */
  asr_hours: number;
  /** The expected agent cost; null when there is no estimate. */
  agent_cost_usd: number | null;
};

/** What a book already has, per source (the estimate's `has`). `description` (Bridge
 * Phase 1c): the community's `community_description`, or one generated here; absent on
 * older servers. */
export type BridgeContentFlags = { characters: boolean; recaps: boolean; description?: boolean };

/** Response of GET /admin/bridge/estimate (the confirmation before generating). */
export type BridgeEstimate = {
  kind: string;
  library_id: number;
  path: string;
  /** What the run reads: the ebook when an `.epub` sits directly in the book's folder. */
  source: 'audio' | 'ebook';
  /** The ebook's path, for an ebook run. */
  ebook?: string;
  duration_seconds: number;
  /** Transcription time: 0 for an ebook, and for audio when it is not known (the Bridge
   * sent no figures, or the audio's length is unknown). */
  asr_hours: number;
  /** The expected agent cost; null while the Bridge has no history to go on. */
  agent_cost_usd: number | null;
  /** The agent runs on a subscription login, so the cost is notional. */
  subscription: boolean;
  /** The agent container answers and has a credential. */
  agent_ready: boolean;
  /** The Bridge can offer the results to the community (a job may ask for `contribute:
   * issue`); the player never does. Absent on older servers. */
  can_contribute?: boolean;
  /** The Bridge has sent its figures: without them `agent_ready`, `subscription` and the
   * costs are only defaults, so a false `agent_ready` means "not known", not "not ready".
   * Absent on servers before it (read as not known). */
  figures?: boolean;
  /** The library is mapped on the Bridge and writable there. */
  writable: boolean;
  /** The Bridge is online and runs `sidecars.describe` (a description from the notes it
   * kept, Bridge Phase 1c); the player queues none. Absent on older servers. */
  can_describe?: boolean;
  /** `community_unknown`: the community couldn't be asked just now, so `community` is no
   * answer (never "none"); omitted otherwise. */
  has: { community: BridgeContentFlags; local: BridgeContentFlags; community_unknown?: boolean };
  /** At most 10, reading order. */
  earlier: BridgeEstimateBook[];
  /** The open `sidecars.generate` job for this book, if there is one. */
  open_job?: BridgeJob;
};
