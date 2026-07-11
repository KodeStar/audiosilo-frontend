import type {
  ApiKey,
  ApiKeyCreated,
  AuthSession,
  Book,
  BookMeta,
  Bookmark,
  ChaptersResponse,
  DemoSession,
  Favourite,
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

/**
 * Thrown when a request exceeds its timeout. Distinct from the `AbortError` a
 * caller-supplied signal raises on cancellation, so the reachability layer can
 * treat a timeout as "server unreachable" while still ignoring deliberate cancels.
 */
export class TimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
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
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly onAuthError?: () => void;

  /**
   * `onAuthError` is invoked once whenever a request produces an HTTP **401** - a
   * "dead token" signal: the server *answered* and rejected our credential itself. It
   * is the single choke point for dead-token detection: because EVERY request (queries,
   * mutations, the framework-free progress-sync save loop) funnels through `request`,
   * wiring the callback where a connection's client is built (`provider.tsx`,
   * `connection-clients.resolveClient`) gives every request path detection for free.
   * This class deliberately does NOT import the session store (that would be a cycle,
   * and would couple transport to state); the caller injects a callback that marks its
   * own connection. Onboarding flows build bare clients WITHOUT the callback, so a
   * wrong-password 401 on `/auth/login` never false-flags a reconnect.
   *
   * **Why 401 only.** On audiosilo-server a genuinely dead/invalid/revoked token ALWAYS
   * yields 401 (`middleware.go` "missing bearer token" / "invalid or expired token"),
   * while **403 means "valid token, but forbidden"** - a share/scope denial
   * (`handlers_library.go` "no access to this library"/"no access to this path", a
   * routine event when a scoped user browses outside their share), "admin only", or an
   * api-key/demo restriction. The token is perfectly good in every 403 case; treating
   * one as dead would spuriously tell a correctly-logged-in shared user to reconnect
   * just for hitting a forbidden path - the exact false-positive this feature exists to
   * prevent. And because this class only throws `ApiError` for a real HTTP response (a
   * network/offline failure surfaces as `TimeoutError` or a raw fetch rejection, with
   * no status), a 401 `ApiError` inherently proves "server responded, token refused" -
   * cleanly distinct from offline (the reachability layer relies on the same invariant).
   */
  constructor(
    baseUrl: string,
    token: string | null = null,
    timeoutMs = 15000,
    onAuthError?: () => void,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.onAuthError = onAuthError;
  }

  /** Absolute URL for an API path (e.g. `/server`). */
  apiUrl(path: string, query?: Query): string {
    return `${this.baseUrl}/api/v1${path}${toQueryString(query)}`;
  }

  /** Authorization header for use by the playback/image layers (expo-image,
   * the native player module) which need to attach the token to their own requests. */
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

    // Abort after timeoutMs so a frozen/unreachable server can't hang the caller
    // (and the 15s save loop) indefinitely; still honour a caller-supplied signal.
    // A timeout surfaces as a TimeoutError rather than the AbortError a caller
    // cancel raises, so reachability counts it as unreachable instead of ignoring
    // it as a cancellation.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onCallerAbort);
    }

    try {
      const res = await fetch(this.apiUrl(path, opts.query), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      if (res.status === 204) return undefined as T;
      const text = await res.text();
      // statusText is '' (not null) under HTTP/2, so use || to reach the fallback.
      const fallbackMsg = res.statusText || 'Request failed';
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        // A non-JSON body (e.g. an HTML 502/503 from a reverse proxy) must not surface
        // as a SyntaxError - callers branch on ApiError/its status (isUnrecoverable,
        // sign-in, reachability), so preserve the HTTP status instead.
        throw new ApiError(res.status, fallbackMsg);
      }
      if (!res.ok) {
        const msg = (data as { error?: string } | undefined)?.error;
        throw new ApiError(res.status, msg || fallbackMsg);
      }
      return data as T;
    } catch (e) {
      // Our timeout fired (not a caller cancel, and not a real server answer in
      // the same tick): report it as a timeout so it's classified as unreachable.
      if (timedOut && !(e instanceof ApiError)) throw new TimeoutError(this.timeoutMs);
      // A 401 ApiError means the server answered and rejected our token - fire the
      // dead-token callback (both ApiError throw sites above land here). 403 is a scope
      // denial (valid token, forbidden) and a network/timeout failure has no status, so
      // neither is a dead token - the full rationale is on the constructor doc above.
      if (e instanceof ApiError && e.status === 401) this.onAuthError?.();
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }
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
  /** Mint a throwaway demo account (when the server runs in demo mode). Returns a
   * ready-to-use session plus a pairing payload so the same user can be opened on
   * a phone via the QR. */
  demoSession(deviceName: string) {
    return this.request<DemoSession>('POST', '/demo/session', {
      body: { device_name: deviceName },
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

  // --- Self-service password (authed) --------------------------------------
  // Set/change your own password so a signed-out user can get back in on any
  // device without an admin. Changing an existing password requires the current
  // one (pass currentPassword); setting a first password does not. The password
  // can't be empty (clearing is admin-only). The connect screen's code field still
  // redeems an admin invite code (redeemCode → exchange) as the other way in.
  setPassword(password: string, currentPassword?: string) {
    return this.request<void>('POST', '/auth/password', {
      body: currentPassword ? { password, current_password: currentPassword } : { password },
    });
  }

  // --- API keys (authed) ---------------------------------------------------
  // User-minted, named keys for headless integrations (dashboards, cron). Each key
  // acts as its owner; no scopes and no expiry in v1 - revoke is the lifecycle.
  // Gated by the server's `api_keys` capability (hide the UI when absent) and
  // refused for demo accounts.
  /** Mint a named API key. The plaintext `token` is returned exactly once - the
   * server never reveals it again. */
  createApiKey(label: string) {
    return this.request<ApiKeyCreated>('POST', '/auth/tokens', { body: { label } });
  }
  /** The caller's non-revoked API keys (metadata only), newest first. */
  async listApiKeys() {
    const r = await this.request<{ api_keys: ApiKey[] | null }>('GET', '/auth/tokens');
    return r.api_keys ?? [];
  }
  /** Revoke a key by id. Success is any 2xx and may carry an empty body (204);
   * `request` returns undefined for both a 204 and an empty 200 without parsing. */
  revokeApiKey(id: number) {
    return this.request<void>('DELETE', `/auth/tokens/${id}`);
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
  async search(q: string, limit?: number, signal?: AbortSignal) {
    const r = await this.request<{ books: Book[] }>('GET', '/search', {
      query: { q, limit },
      signal,
    });
    return r.books ?? [];
  }
  /** Most recently added books across every accessible library (server merges and
   * sorts by added date), so the client needn't fan out per library. */
  async recentBooks(limit?: number, signal?: AbortSignal) {
    const r = await this.request<{ books: Book[] }>('GET', '/books/recent', {
      query: { limit },
      signal,
    });
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
  /** Enriched metadata for a book (description, series rail, meta links) resolved
   * server-side from its asin/isbn against the community metadata service. Only call
   * this when the server advertises the `metadata` capability. Returns
   * `{ matched: false }` when the book has no ids or no upstream match; throws an
   * `ApiError` (502) when the meta service is unreachable, so the caller can render
   * nothing rather than block the page. */
  bookMeta(libraryId: number, path: string, signal?: AbortSignal) {
    return this.request<BookMeta>('GET', `/libraries/${libraryId}/meta`, {
      query: { path },
      signal,
    });
  }

  // --- Media URLs ----------------------------------------------------------
  // The token rides in the media URL on every platform (the server accepts
  // `?token=` for media GETs). Web requires this - browsers can't set an
  // Authorization header on <img>/<audio>. Native uses the same mechanism for a
  // single uniform path, so cover/stream auth never depends on whether a given
  // library (expo-image, the native player module) forwards custom request
  // headers. Native still also passes headers via the track/source, so this is
  // belt-and-braces (and lets lock-screen artwork load without extra wiring).
  private mediaTokenQuery(): Query {
    return this.token ? { token: this.token } : {};
  }
  coverUrl(libraryId: number, path: string) {
    return this.apiUrl(`/libraries/${libraryId}/cover`, { path, ...this.mediaTokenQuery() });
  }
  /** Build a stream URL. `transcode` requests an on-the-fly MP3 re-encode for
   * codecs the client can't decode natively (only useful when the server's
   * `transcode` capability is on and the book's `direct_playable` is false);
   * `t` starts that transcode mid-file (transcoded output isn't byte-seekable, so
   * a seek re-requests with a new `t`). */
  streamUrl(
    libraryId: number,
    path: string,
    download = false,
    opts?: { transcode?: boolean; t?: number },
  ) {
    return this.apiUrl(`/libraries/${libraryId}/stream`, {
      path,
      download: download ? 1 : undefined,
      transcode: opts?.transcode ? 1 : undefined,
      t: opts?.t && opts.t > 0 ? opts.t : undefined,
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
    const r = await this.request<{ progress: Progress }>(
      'PUT',
      `/libraries/${libraryId}/progress`,
      {
        query: { path },
        body: input,
      },
    );
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

  // --- Favourites ----------------------------------------------------------
  // A single cross-library list feeds the per-row hearts, the Favourites shelf,
  // and the home section. A server without the endpoint (older build) yields []
  // so the UI degrades gracefully rather than erroring.
  async favourites(signal?: AbortSignal) {
    try {
      const r = await this.request<{ favourites: Favourite[] | null }>('GET', '/me/favourites', {
        signal,
      });
      return r.favourites ?? [];
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
  }
  addFavourite(libraryId: number, path: string) {
    return this.request<void>('POST', `/libraries/${libraryId}/favourites`, { query: { path } });
  }
  removeFavourite(libraryId: number, path: string) {
    return this.request<void>('DELETE', `/libraries/${libraryId}/favourites`, { query: { path } });
  }

  async history(libraryId: number, path: string) {
    const r = await this.request<{ history: History[] | null }>(
      'GET',
      `/libraries/${libraryId}/history`,
      { query: { path } },
    );
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
