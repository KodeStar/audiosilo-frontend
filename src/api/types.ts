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
};

/** A series the work belongs to, with the full ordered rail (including the current
 * work - the UI filters it out by id). */
export type BookMetaSeries = {
  id: string;
  name: string;
  /** This work's position within the series. */
  position: string;
  works: BookMetaSeriesWork[];
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
