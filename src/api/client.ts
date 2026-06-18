import type {
  AuthSession,
  Book,
  Bookmark,
  BooksPage,
  BooksSort,
  ChaptersResponse,
  History,
  Library,
  Listing,
  Note,
  PairingPayload,
  Progress,
  ProgressInput,
  ServerInfo,
  User,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type QueryValue = string | number | boolean | undefined | null;
type Query = Record<string, QueryValue>;

function toQueryString(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Thin, fully-typed client over the audiosilo-server REST API. Holds the base
 * URL and (optional) session token; every content call is addressed by
 * (library_id, path). Throws `ApiError` on non-2xx with the server's `error`.
 */
export class ApiClient {
  readonly baseUrl: string;
  private token: string | null;

  constructor(baseUrl: string, token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  setToken(token: string | null) {
    this.token = token;
  }

  /** Absolute URL for an API path (e.g. `/server`). */
  apiUrl(path: string, query?: Query): string {
    return `${this.baseUrl}/api/v1${path}${toQueryString(query)}`;
  }

  /** Authorization header for use by the playback/image layers (expo-image,
   * track-player) which need to attach the token to their own requests. */
  authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...this.authHeaders() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(this.apiUrl(path, opts.query), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      throw new ApiError(res.status, data?.error ?? res.statusText ?? 'Request failed');
    }
    return data as T;
  }

  // --- Discovery & auth (public) -------------------------------------------
  serverInfo(signal?: AbortSignal) {
    return this.request<ServerInfo>('GET', '/server', { signal });
  }
  redeemCode(code: string) {
    return this.request<PairingPayload>('POST', '/auth/redeem', { body: { code } });
  }
  exchange(pairingToken: string, deviceName: string) {
    return this.request<AuthSession>('POST', '/auth/exchange', {
      body: { pairing_token: pairingToken, device_name: deviceName },
    });
  }
  login(username: string, password: string, deviceName: string) {
    return this.request<AuthSession>('POST', '/auth/login', {
      body: { username, password, device_name: deviceName },
    });
  }

  // --- Session (authed) ----------------------------------------------------
  me() {
    return this.request<User>('GET', '/me');
  }
  logout() {
    return this.request<void>('POST', '/auth/logout');
  }
  pair() {
    return this.request<PairingPayload>('POST', '/auth/pair');
  }

  // --- Libraries & browsing ------------------------------------------------
  async libraries() {
    const r = await this.request<{ libraries: Library[] }>('GET', '/libraries');
    return r.libraries ?? [];
  }
  browse(libraryId: number, path = '', offset?: number, limit?: number, signal?: AbortSignal) {
    return this.request<Listing>('GET', `/libraries/${libraryId}/fs`, {
      query: { path, offset, limit },
      signal,
    });
  }
  books(
    libraryId: number,
    opts: { sort?: BooksSort; author?: string; series?: string; cursor?: string; limit?: number } = {},
  ) {
    return this.request<BooksPage>('GET', `/libraries/${libraryId}/books`, { query: { ...opts } });
  }
  async search(q: string, limit?: number, signal?: AbortSignal) {
    const r = await this.request<{ books: Book[] }>('GET', '/search', { query: { q, limit }, signal });
    return r.books ?? [];
  }
  /** Most recently added books across every accessible library (server merges and
   * sorts by added date), so the client needn't fan out per library. */
  async recentBooks(limit?: number, signal?: AbortSignal) {
    const r = await this.request<{ books: Book[] }>('GET', '/books/recent', { query: { limit }, signal });
    return r.books ?? [];
  }
  item(libraryId: number, path: string, signal?: AbortSignal) {
    return this.request<Book>('GET', `/libraries/${libraryId}/item`, { query: { path }, signal });
  }
  chapters(libraryId: number, path: string, signal?: AbortSignal) {
    return this.request<ChaptersResponse>('GET', `/libraries/${libraryId}/chapters`, {
      query: { path },
      signal,
    });
  }

  // --- Media URLs ----------------------------------------------------------
  // The token rides in the media URL on every platform (the server accepts
  // `?token=` for media GETs). Web requires this — browsers can't set an
  // Authorization header on <img>/<audio>. Native uses the same mechanism for a
  // single uniform path, so cover/stream auth never depends on whether a given
  // library (expo-image, track-player) forwards custom request headers. (We did
  // not confirm whether track-player forwards them; native still also passes
  // headers via the track/source, so this is belt-and-braces.)
  private mediaTokenQuery(): Query {
    return this.token ? { token: this.token } : {};
  }
  coverUrl(libraryId: number, path: string) {
    return this.apiUrl(`/libraries/${libraryId}/cover`, { path, ...this.mediaTokenQuery() });
  }
  streamUrl(libraryId: number, path: string, download = false) {
    return this.apiUrl(`/libraries/${libraryId}/stream`, {
      path,
      download: download ? 1 : undefined,
      ...this.mediaTokenQuery(),
    });
  }

  // --- Listening state -----------------------------------------------------
  async allProgress() {
    const r = await this.request<{ progress: Progress[] | null }>('GET', '/me/progress');
    return r.progress ?? [];
  }
  async getProgress(libraryId: number, path: string, signal?: AbortSignal) {
    const r = await this.request<{ progress: Progress | null }>(
      'GET',
      `/libraries/${libraryId}/progress`,
      { query: { path }, signal },
    );
    return r.progress;
  }
  async saveProgress(libraryId: number, path: string, input: ProgressInput) {
    const r = await this.request<{ progress: Progress }>('PUT', `/libraries/${libraryId}/progress`, {
      query: { path },
      body: input,
    });
    return r.progress;
  }

  async bookmarks(libraryId: number, path: string) {
    const r = await this.request<{ bookmarks: Bookmark[] }>(
      'GET',
      `/libraries/${libraryId}/bookmarks`,
      { query: { path } },
    );
    return r.bookmarks ?? [];
  }
  addBookmark(libraryId: number, path: string, position: number, note = '') {
    return this.request<Bookmark>('POST', `/libraries/${libraryId}/bookmarks`, {
      query: { path },
      body: { position, note },
    });
  }
  deleteBookmark(id: number) {
    return this.request<void>('DELETE', `/bookmarks/${id}`);
  }

  async notes(libraryId: number, path: string) {
    const r = await this.request<{ notes: Note[] }>('GET', `/libraries/${libraryId}/notes`, {
      query: { path },
    });
    return r.notes ?? [];
  }
  addNote(libraryId: number, path: string, body: string, position = 0) {
    return this.request<Note>('POST', `/libraries/${libraryId}/notes`, {
      query: { path },
      body: { body, position },
    });
  }
  deleteNote(id: number) {
    return this.request<void>('DELETE', `/notes/${id}`);
  }

  async history(libraryId: number, path: string) {
    const r = await this.request<{ history: History[] | null }>(
      'GET',
      `/libraries/${libraryId}/history`,
      { query: { path } },
    );
    return r.history ?? [];
  }
  async allHistory() {
    const r = await this.request<{ history: History[] | null }>('GET', '/me/history');
    return r.history ?? [];
  }
  addHistory(
    libraryId: number,
    path: string,
    span: { from_pos: number; to_pos: number; started_at: string; ended_at: string },
  ) {
    return this.request<void>('POST', `/libraries/${libraryId}/history`, {
      query: { path },
      body: span,
    });
  }
}
