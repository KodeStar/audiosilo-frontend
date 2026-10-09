import { Platform } from 'react-native';

import { webOrigin } from '@/lib/base-url';
import { createBatchLoader } from '@/lib/batch-loader';
import { CLIENT_HEADER, clientIdentity, shouldIdentify } from '@/lib/client-id';
import { cleanAddresses } from '@/lib/pairing';
import { APP_VERSION } from '@/lib/version';

import type {
  ApiKey,
  ApiKeyCreated,
  AuthSession,
  Book,
  BookMeta,
  BookMetaWork,
  Bookmark,
  BookmarkLabel,
  BookmarkPatch,
  BookPage,
  BookRef,
  BookSort,
  ChaptersResponse,
  Collection,
  CollectionDetail,
  CollectionInput,
  CollectionPatch,
  CoverSize,
  DemoSession,
  Favourite,
  History,
  HistoryEntry,
  Library,
  ListeningGoalStatus,
  Listing,
  MyDevice,
  MyDeviceRevoked,
  MyBookmark,
  MyListening,
  MyNote,
  NextBook,
  Note,
  NotePatch,
  Page,
  PageQuery,
  PairingPayload,
  PeopleList,
  PersonCount,
  Progress,
  ProgressEdit,
  ProgressInput,
  QueueEntry,
  RatedBook,
  Rating,
  RatingValue,
  SeriesBooks,
  SeriesBooksEntry,
  SeriesCount,
  ServerAddresses,
  ServerInfo,
  ShareTarget,
  StatsRange,
  User,
  UserStats,
} from './types';

/** An answer with its `addresses` checked (`cleanAddresses`: normalised, a malformed
 * one dropped). The client is where addresses arrive from the wire, so this is the one
 * place they are cleaned; everything after it trusts them. */
function withCleanAddresses<T extends { addresses?: ServerAddresses }>(answer: T): T {
  return { ...answer, addresses: cleanAddresses(answer.addresses) };
}

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
/** A list value is sent as the key repeated once per item (`name=A&name=B`). */
type Query = Record<string, QueryValue | readonly QueryValue[]>;

/** Options of `bookMeta` (capability `meta_bundle`; an older server ignores both). */
export type BookMetaOptions = { includePrevious?: boolean; hideSpoilers?: boolean };

/** Exact-match filters and sort of GET /libraries/{id}/books (`listBooks`). An empty
 * value is no filter. */
export type BookListQuery = {
  author?: string;
  series?: string;
  narrator?: string;
  sort?: BookSort;
  /** With `series`: every book in it, those in it beyond their main series too
   * (capability `series_memberships`; an older server matches main series only). */
  memberships?: boolean;
};

/** The timeout of a request that waits on the community metadata service. The server
 * can spend its whole metadata budget (15 s, meta's composeTimeout) before it answers
 * from local data or does more upstream work, so this is the server's own request
 * budget instead (30 s, api requestTimeout), by which it always answers (a 503 at
 * worst). */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** How long `seriesBooksPage` collects series names before it asks: every card
 * rendered in one commit (their queries start in the same task) lands in one request,
 * and a few ms is not felt. */
const SERIES_BATCH_WINDOW_MS = 10;

/** The most distinct names one GET /libraries/{id}/series/books takes (400 beyond). */
export const SERIES_BOOKS_MAX_NAMES = 50;

/** Whether a `listBooks` query is exactly what `seriesBooks` answers: a `series` (with
 * `memberships` or not) and nothing else, so default sort and no other filter. Checks
 * for keys beyond those two rather than for the ones known today, so a filter added to
 * {@link BookListQuery} later is never answered by the batch by mistake. */
export function isPlainSeriesQuery(q: BookListQuery): boolean {
  return (
    !!q.series &&
    Object.entries(q).every(
      ([k, v]) => k === 'series' || k === 'memberships' || v === undefined || v === '',
    )
  );
}

/** Just the `{library_id, path}` of each entry: the server decodes list bodies
 * strictly, so a cached `QueueEntry`/`CollectionItem` (with `added_at`, `book`)
 * passed as a ref would otherwise be a 400. */
function bareRefs(items: readonly BookRef[]): BookRef[] {
  return items.map(({ library_id, path }) => ({ library_id, path }));
}

function toQueryString(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== undefined && v !== null) params.append(key, String(v));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Thin, fully-typed client over the audiosilo-server REST API. Holds the base
 * URL and (optional) session token; every content call is addressed by
 * (library_id, path). Throws `ApiError` on non-2xx with the server's `error`.
 * Every request also sends `X-AudioSilo-Client: AudioSilo/<version> (<platform>)` so
 * the server can tell which app owns a session - on web only when same-origin with
 * the page (see `shouldIdentify` in `src/lib/client-id.ts` for the CORS reason).
 */
export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string | null;
  /** Identity header for `request()`; empty when this client must not send it. */
  private readonly clientHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly onAuthError?: () => void;
  /** The batch loader behind `seriesBooksPage`, one per `libraryId:limit` (so bounded
   * by libraries x page sizes), created on first use. */
  private readonly seriesLoaders = new Map<string, (name: string) => Promise<BookPage>>();

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
    this.clientHeaders = shouldIdentify(this.baseUrl, Platform.OS, webOrigin())
      ? { [CLIENT_HEADER]: clientIdentity(APP_VERSION, Platform.OS) }
      : {};
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
    opts: { query?: Query; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...this.clientHeaders, ...this.authHeaders() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    // Abort after timeoutMs (the client's, unless this request sets its own) so a
    // frozen/unreachable server can't hang the caller (and the 15s save loop)
    // indefinitely; still honour a caller-supplied signal.
    // A timeout surfaces as a TimeoutError rather than the AbortError a caller
    // cancel raises, so reachability counts it as unreachable instead of ignoring
    // it as a cancellation.
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
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
      if (timedOut && !(e instanceof ApiError)) throw new TimeoutError(timeoutMs);
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
    return this.request<PairingPayload>('POST', '/auth/redeem', { body: { code } }).then(
      withCleanAddresses,
    );
  }
  exchange(pairingToken: string, deviceName: string) {
    return this.request<AuthSession>('POST', '/auth/exchange', {
      body: { pairing_token: pairingToken, device_name: deviceName },
    }).then(withCleanAddresses);
  }
  login(username: string, password: string, deviceName: string) {
    return this.request<AuthSession>('POST', '/auth/login', {
      body: { username, password, device_name: deviceName },
    }).then(withCleanAddresses);
  }
  /** Mint a throwaway demo account (when the server runs in demo mode). Returns a
   * ready-to-use session plus a pairing payload so the same user can be opened on
   * a phone via the QR. */
  demoSession(deviceName: string) {
    return this.request<DemoSession>('POST', '/demo/session', {
      body: { device_name: deviceName },
    }).then(withCleanAddresses);
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
  /** The server's home and away addresses (capability `addresses`; `{}` when it has
   * neither), cleaned (`cleanAddresses`). Lets a paired device learn an address
   * configured after it paired. The server derives `home` from the request when none is
   * configured, so an answer read through the away address can lack a home the device
   * already knows (`mergeAddresses` keeps it). */
  async addresses(signal?: AbortSignal): Promise<ServerAddresses> {
    return (
      cleanAddresses(await this.request<ServerAddresses>('GET', '/addresses', { signal })) ?? {}
    );
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
  /** One page of a library's indexed books (the computed view), optionally filtered
   * by an exact `author`, `series` or `narrator` value (see {@link BookListQuery}).
   * Pass the previous page's `next_cursor` as `cursor`, with the same filters and
   * sort, to continue. `limit` is 1-200: the server sends 50 for anything else
   * (including more than 200). `narrator` needs the `browse_people` capability: an
   * older server ignores it and returns the unfiltered list, so prefer
   * `useLibraryBooks`, which waits for the flag. */
  async listBooks(
    libraryId: number,
    opts: BookListQuery & { limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ): Promise<BookPage> {
    const { memberships, ...rest } = opts;
    const r = await this.request<BookPage>('GET', `/libraries/${libraryId}/books`, {
      query: { ...rest, memberships: memberships ? 1 : undefined },
      signal,
    });
    return { ...r, books: r.books ?? [] };
  }
  /** The first page of several series' books in one request (capability
   * `series_books`; at most {@link SERIES_BOOKS_MAX_NAMES} distinct names, and at least
   * one): per name, exactly what `listBooks(libraryId, {series: name, memberships: true,
   * limit})` would answer, so its `next_cursor` continues there. Entries come in request
   * order, a repeated name answered once. `seriesBooksPage` batches the callers of one
   * moment into these requests. */
  async seriesBooks(
    libraryId: number,
    names: readonly string[],
    { limit }: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<SeriesBooksEntry[]> {
    const r = await this.request<SeriesBooks>('GET', `/libraries/${libraryId}/series/books`, {
      query: { name: names, limit },
      signal,
    });
    return (r.series ?? []).map((e) => ({ ...e, books: e.books ?? [] }));
  }
  /**
   * The first page of one series' books (as `listBooks` with `series`, `memberships`
   * and `limit`), fetched TOGETHER with every other series asked for in the same few
   * milliseconds (`SERIES_BATCH_WINDOW_MS`) on the same library and `limit`: one
   * `seriesBooks` request per {@link SERIES_BOOKS_MAX_NAMES} distinct names
   * (`createBatchLoader`), so a screen of series cards is one request, not one per card.
   * Needs `series_books`. There is no signal: the request is shared, so no one caller
   * cancels it (it has the client's normal timeout). A failed request rejects every
   * caller in it, and a name its answer leaves out (which the server never does)
   * rejects that caller.
   */
  seriesBooksPage(
    libraryId: number,
    name: string,
    { limit }: { limit?: number } = {},
  ): Promise<BookPage> {
    const key = `${libraryId}:${limit ?? ''}`;
    let load = this.seriesLoaders.get(key);
    if (!load) {
      load = createBatchLoader({
        windowMs: SERIES_BATCH_WINDOW_MS,
        maxKeys: SERIES_BOOKS_MAX_NAMES,
        load: async (names: string[]) =>
          new Map(
            (await this.seriesBooks(libraryId, names, { limit })).map(({ name, ...page }) => [
              name,
              page,
            ]),
          ),
      });
      this.seriesLoaders.set(key, load);
    }
    return load(name);
  }
  // The browse lists (capability `browse_people`): every distinct author, narrator
  // or series in a library with counts, limited to the caller's share scope.
  /** Authors of a library, sorted case-insensitively, plus the count of books with
   * no author. */
  authors(libraryId: number, signal?: AbortSignal): Promise<PeopleList> {
    return this.people(libraryId, 'authors', signal);
  }
  /** Narrators of a library, sorted case-insensitively, plus the count of books
   * with no narrator. */
  narrators(libraryId: number, signal?: AbortSignal): Promise<PeopleList> {
    return this.people(libraryId, 'narrators', signal);
  }
  private async people(
    libraryId: number,
    kind: 'authors' | 'narrators',
    signal?: AbortSignal,
  ): Promise<PeopleList> {
    // The wire envelopes: `{ authors, unknown }` and `{ narrators, unknown }`.
    const r = await this.request<{
      authors?: PersonCount[] | null;
      narrators?: PersonCount[] | null;
      unknown?: number;
    }>('GET', `/libraries/${libraryId}/${kind}`, { signal });
    return { people: r[kind] ?? [], unknown: r.unknown ?? 0 };
  }
  /** Series of a library, sorted case-insensitively. With `memberships` (capability
   * `series_memberships`) a book counts in every series it is in, at its position there. */
  async seriesList(
    libraryId: number,
    { memberships = false }: { memberships?: boolean } = {},
    signal?: AbortSignal,
  ) {
    const r = await this.request<{ series: SeriesCount[] | null }>(
      'GET',
      `/libraries/${libraryId}/series`,
      { query: { memberships: memberships ? 1 : undefined }, signal },
    );
    return r.series ?? [];
  }
  /** What to play after a book, resolved server-side: the community series rail when it
   * places its next work on one of the caller's books, else the local series, else the
   * parent folder, else none (see {@link NextBook}: `source` names the step that
   * answered, a `work` without `local` is the rail's next work this server couldn't
   * place, and a community `next` can be in another of the caller's libraries).
   * Only call this when the server advertises `next_book`. It gets more time than other
   * requests: the server can spend its whole community-metadata budget first. */
  nextBook(libraryId: number, path: string, signal?: AbortSignal) {
    return this.request<NextBook>('GET', `/libraries/${libraryId}/next`, {
      query: { path },
      signal,
      timeoutMs: Math.max(this.timeoutMs, UPSTREAM_TIMEOUT_MS),
    });
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
   * nothing rather than block the page.
   *
   * `opts` needs the `meta_bundle` capability (an older server ignores both and
   * sends the full envelope, without saying so): `includePrevious` adds `previous`
   * (the works before this one, see {@link BookMeta}), `hideSpoilers` has the server
   * drop what the caller's SAVED progress had not reached when it answered (by the
   * stored chapter offsets). That is for thin clients: the player keeps gating on the
   * device (meta-gating.ts, by its live position and corrected offsets) either way.
   * Without them the request is exactly `?path=`. With `includePrevious` it gets more
   * time: the server fetches the previous works upstream after the envelope itself. */
  bookMeta(libraryId: number, path: string, signal?: AbortSignal, opts?: BookMetaOptions) {
    return this.request<BookMeta>('GET', `/libraries/${libraryId}/meta`, {
      query: {
        path,
        include: opts?.includePrevious ? 'previous' : undefined,
        spoilers: opts?.hideSpoilers ? 'hide' : undefined,
      },
      signal,
      timeoutMs: opts?.includePrevious ? Math.max(this.timeoutMs, UPSTREAM_TIMEOUT_MS) : undefined,
    });
  }
  /** One work from the community metadata service, by its meta-site work id (the
   * `id` a series rail entry carries). Used to catch up on the earlier books of a
   * series without leaving the book screen, so it is fetched lazily, per opened
   * row. Unwraps the `{ work }` envelope.
   *
   * Every failure means "not available": a server predating this route 404s
   * exactly like an unknown id, and a down meta service 502s. Callers must render
   * a quiet fallback, never an error. */
  async metaWork(workId: string, signal?: AbortSignal) {
    const res = await this.request<{ work: BookMetaWork }>('GET', '/meta/work', {
      query: { id: workId },
      signal,
    });
    return res.work;
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
  /** Build a cover URL. `size` asks for a JPEG thumbnail ({@link CoverSize}; only
   * when the server advertises `cover_sizes`, an older one ignores it and sends the
   * full art). A thumbnail is a 404 when none can be made, which includes art the
   * server can't decode or that is too large while the full-art URL still serves it,
   * so fall back to the URL without `size`. `version` is the book's `cover_version`,
   * appended as `v` purely as a cache buster (the server ignores it); see
   * `Book.cover_version` for when it moves. */
  coverUrl(libraryId: number, path: string, opts?: { size?: CoverSize; version?: string }) {
    return this.apiUrl(`/libraries/${libraryId}/cover`, {
      path,
      size: opts?.size,
      v: opts?.version || undefined,
      ...this.mediaTokenQuery(),
    });
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
  /** The caller's own edit of a book's progress (capability `progress_edit`; see
   * {@link ProgressEdit}): mark it finished or unfinished, move the position, set or
   * clear the dates. Returns the stored progress, dates included. A 404 means no
   * progress and no book at the path; a 403 that it is outside the caller's access.
   * Only the edit's own fields are sent (the server decodes the body strictly, so a
   * spread `Progress` row would otherwise be a 400); `null` still clears a date. */
  async editProgress(
    libraryId: number,
    path: string,
    { finished, position, started_at, finished_at }: ProgressEdit,
  ) {
    const r = await this.request<{ progress: Progress }>(
      'PATCH',
      `/libraries/${libraryId}/progress`,
      { query: { path }, body: { finished, position, started_at, finished_at } },
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
  /** Bookmark a book at `position`. `label` is sent only when given, and only a server
   * with `annotations` takes it: an older one rejects the unknown field with a 400, so
   * prefer the `addBookmark` helper or `useAddBookmark` (src/api/hooks.ts), which drop it
   * there. */
  addBookmark(libraryId: number, path: string, position: number, note = '', label?: BookmarkLabel) {
    return this.request<Bookmark>('POST', `/libraries/${libraryId}/bookmarks`, {
      query: { path },
      body: label === undefined ? { position, note } : { position, note, label },
    });
  }
  /** Edit one of the caller's bookmarks (capability `annotations`; see
   * {@link BookmarkPatch}) and return it whole. Someone else's, an unknown id, or one
   * on a book outside the caller's current access is a 404. Only the patch's own fields
   * are sent (the server decodes strictly, so a spread `Bookmark` would be a 400). */
  updateBookmark(id: number, { note, label }: BookmarkPatch) {
    return this.request<Bookmark>('PATCH', `/bookmarks/${id}`, { body: { note, label } });
  }
  deleteBookmark(id: number) {
    return this.request<void>('DELETE', `/bookmarks/${id}`);
  }
  /** One page of the caller's bookmarks across books, newest made first (capability
   * `annotations`; see {@link Page}). */
  myBookmarks(page: PageQuery = {}, signal?: AbortSignal) {
    return this.page<MyBookmark, 'bookmarks'>('/me/bookmarks', 'bookmarks', page, signal);
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
  /** Edit one of the caller's notes (capability `annotations`; see {@link NotePatch})
   * and return it whole, with its new `updated_at`. Someone else's, an unknown id, or one
   * on a book outside the caller's current access is a 404. Only the patch's own fields
   * are sent. */
  updateNote(id: number, { body, position }: NotePatch) {
    return this.request<Note>('PATCH', `/notes/${id}`, { body: { body, position } });
  }
  deleteNote(id: number) {
    return this.request<void>('DELETE', `/notes/${id}`);
  }
  /** One page of the caller's notes across books, newest made first (capability
   * `annotations`; see {@link Page}). */
  myNotes(page: PageQuery = {}, signal?: AbortSignal) {
    return this.page<MyNote, 'notes'>('/me/notes', 'notes', page, signal);
  }

  /** GET one page of an across-books list and normalize its `{ <key>: rows,
   * next_cursor? }` envelope to a {@link Page} (a null array reads as none). */
  private async page<T, K extends string>(
    path: string,
    key: K,
    { limit, cursor }: PageQuery,
    signal?: AbortSignal,
  ): Promise<Page<T>> {
    const r = await this.request<Record<K, T[] | null> & { next_cursor?: string }>('GET', path, {
      query: { limit, cursor },
      signal,
    });
    return r.next_cursor
      ? { items: r[key] ?? [], next_cursor: r.next_cursor }
      : { items: r[key] ?? [] };
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

  // --- Up next (capability `queue`) ----------------------------------------
  // The caller's queue, in order, at most 500 books. Every write answers with the
  // whole stored queue, so the caller reconciles with what the server kept.
  async queue(signal?: AbortSignal) {
    const r = await this.request<{ queue: QueueEntry[] }>('GET', '/me/queue', { signal });
    return r.queue;
  }
  /** Replace the whole queue with `items`, in this order. Duplicates collapse (the
   * first wins) and an entry that is not an indexed book inside the caller's access
   * is skipped, not an error. More than 500 items is a 400. Every stored entry not
   * listed is deleted, including the caller's hidden ones (outside their current
   * access, which a read leaves out but keeps): to move one book, use
   * {@link addToQueue} with a `position`, which leaves hidden entries alone. */
  async setQueue(items: BookRef[]) {
    const r = await this.request<{ queue: QueueEntry[] }>('PUT', '/me/queue', {
      body: { items: bareRefs(items) },
    });
    return r.queue;
  }
  /** Queue one book (a part/disc path queues its book). `position` is a 0-based index
   * in the queue as this caller sees it (absent or past the end: the end). A book already queued moves
   * to `position` when one is given, else stays. A full queue is a 409 (`queue_full`). */
  async addToQueue(libraryId: number, path: string, position?: number) {
    const r = await this.request<{ queue: QueueEntry[] }>('POST', '/me/queue', {
      body: { library_id: libraryId, path, position },
    });
    return r.queue;
  }
  /** Remove one book from the queue (idempotent, 204). Exact path, unlike an add: pass
   * the entry's own `path` (a part/disc path the add resolved removes nothing). */
  removeFromQueue(libraryId: number, path: string) {
    return this.request<void>('DELETE', '/me/queue', { query: { library_id: libraryId, path } });
  }

  // --- Collections (capability `collections`) -------------------------------
  // Owned by the caller or shared with them read-only. A collection that is neither
  // is a 404; a viewer's write is a 403 (`not_owner`).
  /** Owned collections first, then those shared with the caller, each newest first. */
  async collections(signal?: AbortSignal) {
    const r = await this.request<{ collections: Collection[] }>('GET', '/me/collections', {
      signal,
    });
    return r.collections;
  }
  /** Create a collection. Over 100 owned is a 409 (`collections_full`); a bad name a
   * 400. Only `name` and `description` are sent (the server decodes strictly). */
  async createCollection({ name, description }: CollectionInput) {
    const r = await this.request<{ collection: Collection }>('POST', '/me/collections', {
      body: { name, description },
    });
    return r.collection;
  }
  /** A collection and its items in order, limited to the caller's own access. */
  collection(id: number, signal?: AbortSignal) {
    return this.request<CollectionDetail>('GET', `/me/collections/${id}`, { signal });
  }
  /** Rename it or change its description (owner only). Only `name` and `description`
   * are sent (the server decodes strictly, so a spread `Collection` would otherwise be a
   * 400); an absent one is left as it is. */
  async updateCollection(id: number, { name, description }: CollectionPatch) {
    const r = await this.request<{ collection: Collection }>('PATCH', `/me/collections/${id}`, {
      body: { name, description },
    });
    return r.collection;
  }
  /** The owner deletes the collection; a viewer leaves it (only their share goes). */
  deleteCollection(id: number) {
    return this.request<void>('DELETE', `/me/collections/${id}`);
  }
  /** Replace the items (owner only), with the queue's rules: duplicates collapse, an
   * entry that is not an indexed book in the caller's access is skipped, and every
   * stored item not listed is deleted, the caller's hidden ones included (to move one
   * book, use {@link addCollectionItem} with a `position`). More than 1000 is a 400.
   * Returns the stored detail. */
  setCollectionItems(id: number, items: BookRef[]) {
    return this.request<CollectionDetail>('PUT', `/me/collections/${id}/items`, {
      body: { items: bareRefs(items) },
    });
  }
  /** Add one book (owner only), placed like {@link addToQueue}. A full collection is
   * a 409 (`collection_full`). Returns the stored detail. */
  addCollectionItem(id: number, libraryId: number, path: string, position?: number) {
    return this.request<CollectionDetail>('POST', `/me/collections/${id}/items`, {
      body: { library_id: libraryId, path, position },
    });
  }
  /** Remove one book (owner only; idempotent, 204). Exact path, unlike an add: pass the
   * item's own `path`. */
  removeCollectionItem(id: number, libraryId: number, path: string) {
    return this.request<void>('DELETE', `/me/collections/${id}/items`, {
      query: { library_id: libraryId, path },
    });
  }
  /** Replace who the collection is shared with (owner only, at most 50). An id that is
   * not a share target rejects the whole request (400 `unknown user`); a demo owner
   * gets a 403. */
  async setCollectionShares(id: number, userIds: number[]) {
    const r = await this.request<{ collection: Collection }>(
      'PUT',
      `/me/collections/${id}/shares`,
      { body: { user_ids: userIds } },
    );
    return r.collection;
  }
  /** The users the caller can share with, by username. A demo account gets a 403. */
  async shareTargets(signal?: AbortSignal) {
    const r = await this.request<{ users: ShareTarget[] }>('GET', '/me/share-targets', {
      signal,
    });
    return r.users;
  }

  // --- Ratings (capability `ratings`) --------------------------------------
  /** The caller's rating of exactly this path, or null when there is none. */
  async rating(libraryId: number, path: string, signal?: AbortSignal) {
    const r = await this.request<{ rating: Rating | null }>(
      'GET',
      `/libraries/${libraryId}/rating`,
      { query: { path }, signal },
    );
    return r.rating ?? null;
  }
  /** Rate a book 1-5 with an optional note (at most 500 characters, trimmed). The
   * PUT replaces the whole rating, so leaving `note` out clears a saved note. A
   * part/disc path rates its book: the returned rating carries the book's own path. */
  async setRating(libraryId: number, path: string, rating: RatingValue, note?: string) {
    const r = await this.request<{ rating: Rating }>('PUT', `/libraries/${libraryId}/rating`, {
      query: { path },
      body: { rating, note },
    });
    return r.rating;
  }
  /** Remove the caller's rating of exactly this path (idempotent, 204): unlike a rate,
   * a part/disc path is not resolved, so pass the path the rating came back with. */
  deleteRating(libraryId: number, path: string) {
    return this.request<void>('DELETE', `/libraries/${libraryId}/rating`, { query: { path } });
  }
  /** Every rating the caller can still see, newest change first. */
  async myRatings(signal?: AbortSignal) {
    const r = await this.request<{ ratings: RatedBook[] }>('GET', '/me/ratings', {
      signal,
    });
    return r.ratings;
  }

  // --- Your listening (capability `user_stats`) -----------------------------
  // `range` defaults to `30d` on the server when omitted (see StatsRange).
  /** The caller's own listening stats for a period. */
  async myStats(range?: StatsRange, signal?: AbortSignal) {
    const r = await this.request<{ stats: UserStats }>('GET', '/me/stats', {
      query: { range },
      signal,
    });
    return r.stats;
  }
  /** The caller's listening day by day for a period. */
  myListening(range?: StatsRange, signal?: AbortSignal) {
    return this.request<MyListening>('GET', '/me/listening', { query: { range }, signal });
  }
  /** The caller's yearly goal (null when unset) and this year's finished books. */
  listeningGoal(signal?: AbortSignal) {
    return this.request<ListeningGoalStatus>('GET', '/me/goal', { signal });
  }
  /** Set the goal: books finished per year, 1-1000 (else a 400). */
  setListeningGoal(booksPerYear: number) {
    return this.request<ListeningGoalStatus>('PUT', '/me/goal', {
      body: { books_per_year: booksPerYear },
    });
  }
  /** Clear the goal (idempotent, 204). */
  clearListeningGoal() {
    return this.request<void>('DELETE', '/me/goal');
  }

  // --- My devices (capability `my_devices`) --------------------------------
  /** The caller's own live sessions and API keys, most recently seen first. */
  async myDevices(signal?: AbortSignal) {
    const r = await this.request<{ devices: MyDevice[] }>('GET', '/me/devices', {
      signal,
    });
    return r.devices;
  }
  /** Sign out one of the caller's own devices. `current: true` means it was this very
   * token, which every later request is refused with (the caller signs out locally).
   * Someone else's, unknown or already revoked is a 404. Don't use it for the device
   * the caller is on (its row has `current: true`): the token would be dead before the
   * app's own sign-out could save the final position and the queued progress; sign out
   * of the connection the usual way instead. */
  revokeMyDevice(id: number) {
    return this.request<MyDeviceRevoked>('DELETE', `/me/devices/${id}`);
  }

  /** A book's listening spans, newest first: the server's default 100, or up to `limit`
   * (it caps at 500). */
  async history(libraryId: number, path: string, limit?: number) {
    const r = await this.request<{ history: History[] | null }>(
      'GET',
      `/libraries/${libraryId}/history`,
      { query: { path, limit } },
    );
    return r.history ?? [];
  }
  /** One page of the caller's listening spans across books, newest ended first (see
   * {@link Page}). Every server has this route: one without `annotations` ignores
   * `cursor`, never sends `next_cursor` (so its answer is one page, the newest `limit`)
   * and leaves out each row's `book`. */
  allHistory(page: PageQuery = {}, signal?: AbortSignal) {
    return this.page<HistoryEntry, 'history'>('/me/history', 'history', page, signal);
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
