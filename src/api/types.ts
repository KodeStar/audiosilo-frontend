/**
 * TypeScript mirrors of the audiosilo-server JSON API shapes
 * (github.com/kodestar/audiosilo-server). Content is addressed by
 * (library_id, path) — never a database id.
 */

export type Capabilities = {
  admin_ui: boolean;
  transcode: boolean;
  upload: boolean;
  websocket: boolean;
};

export type ServerInfo = {
  name: string;
  version: string;
  api: string;
  capabilities: Capabilities;
  auth: { methods: string[] };
};

export type Role = 'admin' | 'user';

export type User = {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
};

/** Response of /auth/exchange and /auth/login. The token is the session secret. */
export type AuthSession = {
  token: string;
  user: User;
};

/** Response of /auth/redeem and /auth/pair. */
export type PairingPayload = {
  server_name: string;
  base_url: string;
  pairing_token: string;
  /** audiosilo://pair?url=<base>&token=<pairing_token> — encoded in the QR. */
  uri: string;
  qr_png_data_uri: string;
  links: { web: string; admin: string; ios?: string; android?: string };
};

export type LibraryLayout = 'flat' | 'chapters_in_folder' | 'books_in_folder';
export type LibraryView = 'filesystem' | 'computed' | 'hybrid';

export type Library = {
  id: number;
  name: string;
  root: string;
  layout: LibraryLayout;
  default_view: LibraryView;
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
  /** RFC3339; when the book was added (filesystem birth time, from the scanner). */
  added_at?: string;
  files?: BookFile[];
  chapters?: Chapter[];
};

export type ChaptersResponse = {
  library_id: number;
  path: string;
  duration: number;
  is_folder: boolean;
  files: BookFile[];
  chapters: Chapter[];
};

export type BooksSort = 'author' | 'title' | 'recent';

export type BooksPage = {
  books: Book[];
  next_cursor?: string;
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
