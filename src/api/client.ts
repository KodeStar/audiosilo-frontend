import { Platform } from 'react-native';

import { webOrigin } from '@/lib/base-url';
import { createBatchLoader } from '@/lib/batch-loader';
import { CLIENT_HEADER, clientIdentity, shouldIdentify } from '@/lib/client-id';
import { cleanAddresses } from '@/lib/pairing';
import { APP_VERSION } from '@/lib/version';

import type {
  AddMemberBody,
  AddMemberResult,
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
  BridgeEstimate,
  BridgeJob,
  BridgeJobList,
  BridgeJobRequest,
  CastToken,
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
  HouseholdMember,
  HouseholdMembers,
  HouseholdSettings,
  HouseListening,
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
  PodcastEpisodeOrder,
  PodcastEpisodePage,
  PodcastFetchPendingCode,
  PodcastFetchResponse,
  PodcastFetchStatus,
  PodcastFollowResult,
  PodcastShow,
  MyPodcasts,
  OpmlExport,
  OpmlImportResult,
  PodcastCheckResult,
  PodcastDiscoveryProvider,
  PodcastDiscoveryProviders,
  PodcastDiscoverySearch,
  Progress,
  ProgressEdit,
  ProgressInput,
  QueueEntry,
  ReadingProgress,
  ReadingProgressInput,
  ReadingProgressSaved,
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
  UpdateMemberBody,
  User,
  UserStats,
} from './types';

/** An answer with its `addresses` checked (`cleanAddresses`: normalised, a malformed
 * one dropped). The client is where addresses arrive from the wire, so this is the one
 * place they are cleaned; everything after it trusts them. */
function withCleanAddresses<T extends { addresses?: ServerAddresses }>(answer: T): T {
  return { ...answer, addresses: cleanAddresses(answer.addresses) };
}

/** The server answered with an error status. `message` is the body's `error` (the
 * server's English, for logs: never shown as it is), `code` the body's machine-readable
 * `code` when the route gives one (`member_limit`, `invalid_name`, ...); branch on the
 * code, with the status as the fallback for an older server or a route without codes. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    /** The answer's `Retry-After` in seconds, when it reads as a non-negative number (any
     * status; a date or a header the browser can't expose cross-origin reads as absent).
     * Bridge Phase 2d-2: the discovery and OPML limits. */
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Whether `e` is the server refusing the session token (a 401): the connection needs
 * signing in again, not another try (frontend#124). */
export function isSignedOutError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

/** Whether `e` is the server saying the content isn't there for this caller: a 404 (no
 * such book or folder), a 403 (a library not shared with them) or a 400 (a path the
 * server refuses, such as one leaving the library). Asking again can't change it, so it
 * is never retried and a page shows `NotInLibraryState`, never a Retry (CONNECT-13). */
export function isNotInLibraryError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 400);
}

/** The refusal codes (`ApiError.code`) the app tells apart: the household members routes'
 * (Phase 8b-1; `member_disabled` is a 409 for a member the admin disabled, on their
 * session and their pairing), and `kid_account` on pairing too. One list, so the type and
 * the set `apiErrorKind` checks can't drift apart. */
const API_ERROR_CODES = [
  'member_limit',
  'username_taken',
  'invalid_name',
  'invalid_collections',
  'feature_off',
  'not_allowed',
  'member_cannot_manage',
  'member_disabled',
  'kid_account',
  'demo_account',
  // The Bridge's admin routes: queueing for a library the Bridge can't write (409), a kind
  // the paired Bridge doesn't offer (409), and (Bridge Phase 1d) a generate job for a book
  // whose chapters a `chapters.detect` job is still finding (409), and (Phase 2b) one for a
  // book whose characters and recaps a `sidecars.contribute` job is sharing (409).
  'library_not_writable',
  'kind_unavailable',
  'detect_open',
  'contribute_open',
  // Podcasts (Bridge Phase 2d-1): the module is off (404 on its writes), no online Bridge
  // can act (409), a listener already has five episodes on their way (409 on a Retry), the
  // episode's identity moved under a fetch (409), and a show that is gone or hidden (404).
  'module_off',
  'bridge_unavailable',
  'fetch_limit',
  'identity_changed',
  'show_not_found',
  // Cast (server v2.4.0): `POST /cast/token` for a podcast episode or any other item that
  // is not a book (403; older servers send the 403 without it).
  'not_a_book',
  // Podcasts, finding shows (Bridge Phase 2d-2): follow by address (an open request of
  // the other privacy 409, five open requests 429, a bad address 400, no whole-library
  // grant 403, a books library 409), Check for new episodes within a minute (429).
  'privacy_conflict',
  'too_many_requests',
  'checked_recently',
  'invalid_feed_url',
  'no_library_access',
  'not_podcast_library',
  // Directory search (`/podcasts/discovery/*`).
  'discovery_off',
  'provider_unavailable',
  'invalid_query',
  'invalid_country',
  'discovery_rate_limited',
  'provider_rate_limited',
  'discovery_busy',
  'discovery_timeout',
  'provider_rejected',
  'discovery_unavailable',
  // OPML import and export.
  'opml_rate_limited',
  'opml_busy',
  'opml_limit',
  'invalid_opml',
  'unsupported_opml_type',
  'opml_export_limit',
  // An invite code's redeem (server v2.5.0): a real invite used on all the devices it
  // allows, or past its expiry (401; older servers send the 401 without them).
  'invite_used',
  'invite_expired',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(API_ERROR_CODES);

/**
 * What kind of failure `e` is ({@link apiErrorKind}): the server's code when it is one the
 * app knows, else the status's kind (an older server, a route without codes, a code the
 * app doesn't know): `too_many` 429 (the server's limiter), `not_found` 404, `forbidden`
 * 403, `invalid` 400, `conflict` 409, and `failed` for anything else, including no answer
 * at all (not an `ApiError`).
 */
export type ApiErrorKind =
  ApiErrorCode | 'too_many' | 'not_found' | 'forbidden' | 'invalid' | 'conflict' | 'failed';

const BY_STATUS: Readonly<Record<number, ApiErrorKind>> = {
  400: 'invalid',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'too_many',
};

/** The kind of failure `e` is (see {@link ApiErrorKind}). Screens branch on it and say it
 * in their own words: never the server's English (`message`). */
export function apiErrorKind(e: unknown): ApiErrorKind {
  if (!(e instanceof ApiError)) return 'failed';
  if (e.code && KNOWN_CODES.has(e.code)) return e.code as ApiErrorCode;
  return BY_STATUS[e.status] ?? 'failed';
}

const FETCH_PENDING_CODES: ReadonlySet<string> = new Set<PodcastFetchPendingCode>([
  'podcast_fetching',
  'podcast_fetch_unavailable',
  'podcast_fetch_failed',
]);

/**
 * A podcast episode that is not on the server yet (Bridge Phase 2c-2b): `/stream` (and any
 * route that would read its file) held the request up to 2 s, then answered `503 {error,
 * code, fetch}`. `code` says which (`podcast_fetching`: on its way; `podcast_fetch_failed`;
 * `podcast_fetch_unavailable`: it can't be fetched now, `fetch.error` says why), `fetch` is
 * the status as the server saw it, and `retryAfterSeconds` how long to wait before asking
 * again (the `Retry-After` header, else the status's own, else 2).
 */
export class PodcastFetchPendingError extends ApiError {
  constructor(
    message: string,
    public code: PodcastFetchPendingCode,
    public fetch: PodcastFetchStatus,
    public retryAfterSeconds: number,
  ) {
    super(503, message, code);
    this.name = 'PodcastFetchPendingError';
  }
}

/** An answer's `Retry-After` in seconds when it reads as a non-negative number, else
 * undefined (absent, a date, or a header the browser can't expose cross-origin). */
function retryAfterHeader(res: Response): number | undefined {
  const header = res.headers?.get?.('Retry-After');
  if (header == null || header.trim() === '') return undefined;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The seconds a 503 asks the caller to wait: `Retry-After` (seconds) when it reads as a
 * number, else the status's `retry_after_seconds`, else 2. A header the browser can't
 * expose cross-origin reads as absent. */
function retryAfterOf(res: Response, fetch: PodcastFetchStatus): number {
  const header = retryAfterHeader(res);
  if (header !== undefined) return header;
  const body = fetch.retry_after_seconds;
  return typeof body === 'number' && Number.isFinite(body) && body >= 0 ? body : 2;
}

/** The error a non-2xx answer with a JSON (or empty) body `data` is: its `error` and
 * `code`, or for a 503 about an episode still on its way, a `PodcastFetchPendingError`
 * keeping its `fetch`. */
function apiErrorOf(res: Response, data: unknown, fallbackMsg: string): ApiError {
  const body = data as { error?: unknown; code?: unknown; fetch?: unknown } | undefined;
  const msg = typeof body?.error === 'string' ? body.error : '';
  const code = typeof body?.code === 'string' && body.code ? body.code : undefined;
  if (
    res.status === 503 &&
    code !== undefined &&
    FETCH_PENDING_CODES.has(code) &&
    typeof body?.fetch === 'object' &&
    body.fetch !== null
  ) {
    const fetch = body.fetch as PodcastFetchStatus;
    return new PodcastFetchPendingError(
      msg || fallbackMsg,
      code as PodcastFetchPendingCode,
      fetch,
      retryAfterOf(res, fetch),
    );
  }
  return new ApiError(res.status, msg || fallbackMsg, code, retryAfterHeader(res));
}

/** A JSON answer: its body (undefined for a 204 or an empty one), or the `ApiError` a
 * non-2xx one is. A body that isn't JSON (an HTML 502/503 from a reverse proxy) is a plain
 * `ApiError` with the status, never a SyntaxError: callers branch on ApiError and its
 * status (isUnrecoverable, sign-in, reachability). */
async function readJson<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  // statusText is '' (not null) under HTTP/2, so use || to reach the fallback.
  const fallbackMsg = res.statusText || 'Request failed';
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(res.status, fallbackMsg, undefined, retryAfterHeader(res));
  }
  if (!res.ok) throw apiErrorOf(res, data, fallbackMsg);
  return data as T;
}

/** A long answer's bytes (an ebook), read piece by piece with `touch` called on each, so
 * a download that keeps arriving keeps its timeout. Written into one buffer of the
 * announced size (grown when more arrives), never a second copy of the whole file. With
 * no body stream (React Native's fetch), the whole answer within the timeout. */
async function readArriving(res: Response, touch: () => void): Promise<ArrayBuffer> {
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const announced = Number(res.headers?.get?.('Content-Length'));
  let bytes = new Uint8Array(
    Number.isSafeInteger(announced) && announced > 0 ? announced : 1 << 20,
  );
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    touch();
    if (size + value.byteLength > bytes.byteLength) {
      const grown = new Uint8Array(Math.max(bytes.byteLength * 2, size + value.byteLength));
      grown.set(bytes.subarray(0, size));
      bytes = grown;
    }
    bytes.set(value, size);
    size += value.byteLength;
  }
  return size === bytes.byteLength ? bytes.buffer : bytes.slice(0, size).buffer;
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

/** Filters and sort of GET /libraries/{id}/books (`listBooks`): exact-match names, and
 * a genre or tag matched case-insensitively. An empty value is no filter. */
export type BookListQuery = {
  author?: string;
  series?: string;
  narrator?: string;
  /** The books with this genre (one name, case-insensitive). An older server ignores
   * it and returns the unfiltered list. */
  genre?: string;
  /** The books with this tag, as `genre`. */
  tag?: string;
  sort?: BookSort;
  /** With `series`: every book in it, those in it beyond their main series too
   * (capability `series_memberships`; an older server matches main series only). */
  memberships?: boolean;
};

/** The timeout of a request that waits on the community metadata service (or indexes a
 * book on demand: `item`, `chapters`). The server
 * can spend its whole metadata budget (15 s, meta's composeTimeout) before it answers
 * from local data or does more upstream work, so this is the server's own request
 * budget instead (30 s, api requestTimeout), by which it always answers (a 503 at
 * worst). */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** The timeout of an OPML upload: past the server's own 30 s import budget, by which it
 * always answers. */
const OPML_IMPORT_TIMEOUT_MS = 45_000;

/** The timeout of an ebook download (`ebook`): for the answer, then restarted by every
 * piece of the file, so a picture-heavy EPUB of tens of megabytes on a slow link arrives
 * however long it takes, and only a stalled download fails. */
const EBOOK_TIMEOUT_MS = 120_000;

/** A directory result's artwork link as the server writes it (relative, one 64-hex id). */
const DISCOVERY_ARTWORK_RE = /^\/api\/v1\/podcasts\/discovery\/artwork\?id=([0-9a-f]{64})$/;

/** A count header (`X-OPML-*`) as a non-negative integer, or null when absent or not a
 * count (`Headers.get` is case-insensitive: Go writes `X-Opml-*`). */
function countHeader(res: Response, name: string): number | null {
  const v = res.headers?.get?.(name);
  return v != null && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null;
}

/** How long `seriesBooksPage` collects series names before it asks: every card
 * rendered in one commit (their queries start in the same task) lands in one request,
 * and a few ms is not felt. */
const SERIES_BATCH_WINDOW_MS = 10;

/** The most distinct names one GET /libraries/{id}/series/books takes (400 beyond). */
export const SERIES_BOOKS_MAX_NAMES = 50;

/** The most bytes of `name=` parameters one batch request carries, well inside the
 * request-line limit of common reverse proxies (nginx: 8 KB with the path and headers
 * around it); a batch with longer names is split into more requests. */
export const SERIES_BATCH_MAX_QUERY_BYTES = 4000;

/** Whether a `listBooks` query is exactly what `seriesBooks` answers: a `series` with
 * `memberships` (which `seriesBooks` always applies) and nothing else, so default sort
 * and no other filter. Checks for keys beyond those two rather than for the ones known
 * today, so a filter added to {@link BookListQuery} later is never answered by the
 * batch by mistake. */
export function isPlainSeriesQuery(q: BookListQuery): boolean {
  return (
    !!q.series &&
    q.memberships === true &&
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
  private readonly onAnswer?: () => void;
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
   *
   * `onAnswer` is invoked whenever the server answers a request at all (the fetch
   * resolved, any status), before the answer is read: reachability counts it, so a check
   * of a slow but healthy server that timed out never marks it down while other requests
   * were answered (FU-SLOWOK).
   */
  constructor(
    baseUrl: string,
    token: string | null = null,
    timeoutMs = 15000,
    onAuthError?: () => void,
    onAnswer?: () => void,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.onAuthError = onAuthError;
    this.onAnswer = onAnswer;
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

  private request<T>(
    method: string,
    path: string,
    opts: {
      query?: Query;
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
      keepalive?: boolean;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...this.clientHeaders, ...this.authHeaders() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return this.send(method, this.apiUrl(path, opts.query), headers, opts, readJson<T>);
  }

  /** One request to `url`, its answer read by `read` (inside the timeout, which `read` can
   * restart with `touch` while a long answer keeps arriving). */
  private async send<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    opts: {
      body?: unknown;
      raw?: BodyInit;
      signal?: AbortSignal;
      timeoutMs?: number;
      /** The request outlives the page (web: a tab closing). */
      keepalive?: boolean;
    },
    read: (res: Response, touch: () => void) => Promise<T>,
  ): Promise<T> {
    // Abort after timeoutMs (the client's, unless this request sets its own) so a
    // frozen/unreachable server can't hang the caller (and the 15s save loop)
    // indefinitely; still honour a caller-supplied signal.
    // A timeout surfaces as a TimeoutError rather than the AbortError a caller
    // cancel raises, so reachability counts it as unreachable instead of ignoring
    // it as a cancellation.
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    let settled = false;
    const expire = () => {
      timedOut = true;
      controller.abort();
    };
    let timer = setTimeout(expire, timeoutMs);
    const touch = () => {
      if (settled || timedOut) return;
      clearTimeout(timer);
      timer = setTimeout(expire, timeoutMs);
    };
    const onCallerAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onCallerAbort);
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        // A raw body (an OPML upload) goes as it is; anything else is JSON.
        body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        signal: controller.signal,
        ...(opts.keepalive ? { keepalive: true } : {}),
      });
      this.onAnswer?.();
      return await read(res, touch);
    } catch (e) {
      // Our timeout fired (not a caller cancel, and not a real server answer in
      // the same tick): report it as a timeout so it's classified as unreachable.
      if (timedOut && !(e instanceof ApiError)) throw new TimeoutError(timeoutMs);
      // A 401 ApiError means the server answered and rejected our token - fire the
      // dead-token callback (every ApiError the readers throw lands here). 403 is a scope
      // denial (valid token, forbidden) and a network/timeout failure has no status, so
      // neither is a dead token - the full rationale is on the constructor doc above.
      if (isSignedOutError(e)) this.onAuthError?.();
      throw e;
    } finally {
      settled = true;
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
   * by an exact `author`, `series` or `narrator` value, or a `genre` or `tag` (see
   * {@link BookListQuery}).
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
        // Long names (a CJK name is about 9 bytes a character encoded) could otherwise
        // make one request line longer than a reverse proxy takes (nginx: 8 KB).
        size: (name) => encodeURIComponent(name).length + '&name='.length,
        maxSize: SERIES_BATCH_MAX_QUERY_BYTES,
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
  /** A book's item. It gets the server's own request budget (30 s): an unscanned book
   * folder (`pending_book`) is indexed on demand by this read, which for a large book
   * takes longer than the default timeout (fe#154); an indexed book answers at once. */
  item(libraryId: number, path: string, signal?: AbortSignal) {
    return this.request<Book>('GET', `/libraries/${libraryId}/item`, {
      query: { path },
      signal,
      timeoutMs: Math.max(this.timeoutMs, UPSTREAM_TIMEOUT_MS),
    });
  }
  /** A book's chapters, with the same budget as `item`: the server indexes an unscanned
   * book folder for this read too, and the player reads the two together (fe#154). */
  chapters(libraryId: number, path: string, signal?: AbortSignal) {
    return this.request<ChaptersResponse>('GET', `/libraries/${libraryId}/chapters`, {
      query: { path },
      signal,
      timeoutMs: Math.max(this.timeoutMs, UPSTREAM_TIMEOUT_MS),
    });
  }
  /** Enriched metadata for a book (description, series rail, meta links) resolved
   * server-side from its asin/isbn against the community metadata service. Only call
   * this when the server advertises the `metadata` capability. Returns
   * `{ matched: false }` when the book has no ids or no upstream match, with a `work`
   * when the book has characters, recaps or a description generated on this server
   * (then it is asked for a book with no ids too, `metaEnabledFor`); throws an
   * `ApiError` (502) when the meta service is unreachable and nothing was generated, so
   * the caller can render nothing rather than block the page.
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

  // --- Podcasts (Bridge Phase 2d-1) ------------------------------------------
  // Reading shows and episodes is core (not gated on the `podcasts` flag): a podcast library
  // (`Library.kind`) is listed only to a client the server knows can show it. Follow and
  // Unfollow are the Podcasts module's (`podcasts`); the fetch routes `podcast_fetch`'s.

  /** A podcast library's shows (title order; the caller's scope applies, and a private
   * show only reaches the people who follow it). */
  async podcastShows(libraryId: number, signal?: AbortSignal): Promise<PodcastShow[]> {
    const r = await this.request<{ shows: PodcastShow[] | null }>(
      'GET',
      `/libraries/${libraryId}/podcasts`,
      { signal },
    );
    return r.shows ?? [];
  }
  /** One page of a show's episodes in `order` (the server orders: by published, then
   * path). `limit` is 1-200 (the server's default 50); pass the last page's `next_cursor`
   * as `cursor`, with the same show and order, to continue. Each row has its `fetch`
   * status while it is not on the server. A show that is gone or hidden is a 404
   * `show_not_found`. */
  async podcastEpisodes(
    libraryId: number,
    q: { show: string; order: PodcastEpisodeOrder; limit?: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<PodcastEpisodePage> {
    const r = await this.request<PodcastEpisodePage>(
      'GET',
      `/libraries/${libraryId}/podcasts/episodes`,
      { query: { show: q.show, order: q.order, limit: q.limit, cursor: q.cursor }, signal },
    );
    return { episodes: r.episodes ?? [], next_cursor: r.next_cursor ?? null };
  }
  /** The shows the caller follows across their podcast libraries, and (Bridge Phase 2d-2)
   * their follow requests still in flight. */
  async myPodcasts(signal?: AbortSignal): Promise<MyPodcasts> {
    const r = await this.request<Partial<MyPodcasts>>('GET', '/me/podcasts', { signal });
    return { shows: r.shows ?? [], requests: r.requests ?? [] };
  }
  /** Follow a show by its path (`200 {state: 'following', show}`). The body is exactly
   * `{library_id, path}`: the server refuses `private` beside a path (400), and a kid's or
   * demo account is refused (403 `kid_account` / `demo_account`), so is a module that is off
   * (404 `module_off`) and a show the caller can't see (404 `show_not_found`). */
  followPodcast(libraryId: number, path: string) {
    return this.request<PodcastFollowResult>('POST', '/podcasts/follow', {
      body: { library_id: libraryId, path },
    });
  }
  /** Stop following a show (204). A private show then leaves the caller's lists: only its
   * feed's address can follow it again. */
  unfollowPodcast(libraryId: number, path: string) {
    return this.request<void>('DELETE', '/podcasts/follow', {
      query: { library_id: libraryId, path },
    });
  }
  /** An episode's fetch status (observation only: it starts nothing). */
  podcastFetchStatus(libraryId: number, path: string, signal?: AbortSignal) {
    return this.request<PodcastFetchResponse>('GET', `/libraries/${libraryId}/podcasts/fetch`, {
      query: { path },
      signal,
    });
  }
  /** Ask for an episode again after it failed: 202 with the new status (a 200 when it is
   * on the server already). This POST skips the failure cooldown a play respects, so it
   * is only ever the listener's own Try again. The body is exactly `{path}`. A listener
   * with five episodes on their way is refused (409 `fetch_limit`), so is a server with
   * no Bridge to fetch it (409 `bridge_unavailable`). */
  retryPodcastFetch(libraryId: number, path: string, signal?: AbortSignal) {
    return this.request<PodcastFetchResponse>('POST', `/libraries/${libraryId}/podcasts/fetch`, {
      body: { path },
      signal,
    });
  }
  /**
   * The play trigger for an episode that is not on the server: one byte of its stream
   * (`Range: bytes=0-0`, the session token in the header, never `?token=`). The server
   * starts fetching an absent episode (respecting a failed one's cooldown), holds the
   * request up to 2 s, then answers. Resolves once the file streams (a 2xx: the episode is
   * ready); rejects with a `PodcastFetchPendingError` while it is on its way, failed or
   * can't be fetched, and an `ApiError` otherwise (a proxy's HTML 503 too).
   */
  prepareEpisodeStream(libraryId: number, path: string, signal?: AbortSignal): Promise<void> {
    const headers: Record<string, string> = {
      ...this.clientHeaders,
      ...this.authHeaders(),
      Range: 'bytes=0-0',
    };
    return this.send(
      'GET',
      this.apiUrl(`/libraries/${libraryId}/stream`, { path }),
      headers,
      { signal },
      async (res) => {
        if (!res.ok) await readJson<void>(res);
      },
    );
  }

  // --- Podcasts: finding shows (Bridge Phase 2d-2) ---------------------------------
  // Directory search is capability `podcast_discovery`, the OPML routes `podcast_opml`
  // (the import is also the module's), follow by address and Check `podcasts`. Every
  // refusal is an `ApiError` with its `code` and, where the route sends one, its
  // `retryAfterSeconds`.

  /** The directories the server can search (`itunes` always; `podcast_index` only with
   * its key pair). */
  podcastDiscoveryProviders(signal?: AbortSignal) {
    return this.request<PodcastDiscoveryProviders>('GET', '/podcasts/discovery/providers', {
      signal,
    });
  }
  /** Search one directory for shows by name. `country` (ISO 3166-1 alpha-2) goes to
   * iTunes only: Podcast Index refuses it (400 `invalid_country`). There is no fallback to
   * the other directory: a refusal is the caller's to say. */
  searchPodcastDirectory(
    q: {
      q: string;
      provider: PodcastDiscoveryProvider;
      country?: string | null;
      limit?: number;
    },
    signal?: AbortSignal,
  ) {
    return this.request<PodcastDiscoverySearch>('GET', '/podcasts/discovery/search', {
      query: {
        q: q.q,
        provider: q.provider,
        limit: q.limit,
        country: q.provider === 'itunes' ? (q.country ?? undefined) : undefined,
      },
      signal,
    });
  }
  /** Follow a feed by its address: `200 {state: 'following', show}` when the library has
   * the show, `202 {state: 'subscribing', request}` otherwise (`GET /me/podcasts` follows
   * it). The body is exactly `{library_id, feed_url}`, plus `private: true` only when the
   * listener says so (`false` can't override the server's own detection). */
  followPodcastByUrl(libraryId: number, feedUrl: string, opts: { private?: boolean } = {}) {
    return this.request<PodcastFollowResult>('POST', '/podcasts/follow', {
      body: {
        library_id: libraryId,
        feed_url: feedUrl,
        ...(opts.private ? { private: true } : {}),
      },
    });
  }
  /** Ask a followed show to check its feed now (202, the poll; an open poll is returned
   * as it is). Within a minute of the last check is 429 `checked_recently`; a show the
   * caller does not follow is 404 `show_not_found`. The body is exactly `{library_id,
   * path}`. */
  checkPodcast(libraryId: number, path: string) {
    return this.request<PodcastCheckResult>('POST', '/podcasts/check', {
      body: { library_id: libraryId, path },
    });
  }
  /** Upload an OPML list to follow its feeds in `libraryId`: the file's bytes as the raw
   * body, always `Content-Type: text/x-opml`, no compression. The answer is one row per
   * subscription (the decisions, not completion). Uploading the same bytes again is the
   * retry (`src/components/podcasts/opml-waves.ts`). The server's import budget is 30 s,
   * so this waits 45. */
  importOpml(libraryId: number, body: Blob | Uint8Array, signal?: AbortSignal) {
    const headers: Record<string, string> = {
      ...this.clientHeaders,
      ...this.authHeaders(),
      'Content-Type': 'text/x-opml',
    };
    return this.send(
      'POST',
      this.apiUrl('/podcasts/opml/import', { library_id: libraryId }),
      headers,
      {
        raw: body as BodyInit,
        signal,
        timeoutMs: Math.max(this.timeoutMs, OPML_IMPORT_TIMEOUT_MS),
      },
      readJson<OpmlImportResult>,
    );
  }
  /** The caller's followed public shows as an OPML document, with the `X-OPML-*` counts
   * (null when unreadable). Fetched with the `Authorization` header: there is no
   * `?token=` link. Private feeds are never in it. Too many is 413 `opml_export_limit`. */
  exportOpml(signal?: AbortSignal): Promise<OpmlExport> {
    const headers: Record<string, string> = { ...this.clientHeaders, ...this.authHeaders() };
    return this.send(
      'GET',
      this.apiUrl('/podcasts/opml/export'),
      headers,
      { signal },
      async (res) => {
        if (!res.ok) await readJson<void>(res);
        const count = (name: string) => countHeader(res, name);
        return {
          text: await res.text(),
          exported: count('X-OPML-Exported'),
          omittedPrivate: count('X-OPML-Omitted-Private'),
          omittedUnavailable: count('X-OPML-Omitted-Unavailable'),
        };
      },
    );
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
  /** Build the URL of a community cover served by this server (`meta_covers`): a
   * JPEG thumbnail of `coverUrl`, a `cover_url` from the `/meta` envelope of the
   * book at `path` (a series rail entry's or the recording's). The server serves
   * only covers that book's envelope hands out (anything else is a 404), so pass
   * the same `libraryId`/`path` the envelope was asked for. `size` defaults to the
   * server's 320. */
  communityCoverUrl(
    libraryId: number,
    path: string,
    coverUrl: string,
    opts?: { size?: CoverSize },
  ) {
    return this.apiUrl(`/libraries/${libraryId}/meta/cover`, {
      path,
      url: coverUrl,
      size: opts?.size,
      ...this.mediaTokenQuery(),
    });
  }
  /** The URL of a directory result's artwork (`PodcastDiscoveryResult.artwork_url`,
   * relative to this server), with the media token: rebuilt from its 64-hex `id` alone,
   * since the route refuses any other parameter. Anything else (null, an absolute URL,
   * another route, a bad id) is null: draw the placeholder. */
  discoveryArtworkUrl(rel: string | null | undefined): string | null {
    const id = rel ? DISCOVERY_ARTWORK_RE.exec(rel)?.[1] : undefined;
    return id
      ? this.apiUrl('/podcasts/discovery/artwork', { id, ...this.mediaTokenQuery() })
      : null;
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
  // --- Reading (capability `ebooks`, Bridge Phase 3b) ------------------------
  /** A book's ebook bytes (`Book.ebook`), asked for by the BOOK's path. Fetched with the
   * `Authorization` header: the route takes no `?token=` (nothing ever holds a URL that
   * carries a credential), and the reader gets the bytes, never a token or an API URL.
   * 404: not a book, no ebook, or the file is gone; 403: outside the caller's access. */
  ebook(libraryId: number, path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const { url, headers } = this.ebookRequest(libraryId, path);
    return this.send(
      'GET',
      url,
      headers,
      { signal, timeoutMs: Math.max(this.timeoutMs, EBOOK_TIMEOUT_MS) },
      async (res, touch) => {
        if (!res.ok) await readJson<void>(res);
        return readArriving(res, touch);
      },
    );
  }
  /** The request `ebook` makes, for a download that is not this client's fetch (the app's
   * reader cache file, a downloaded book's copy): the url, and the headers it must carry.
   * The url holds no credential; the headers do, so they are never stored. */
  ebookRequest(libraryId: number, path: string): { url: string; headers: Record<string, string> } {
    return {
      url: this.apiUrl(`/libraries/${libraryId}/ebook`, { path }),
      headers: { ...this.clientHeaders, ...this.authHeaders() },
    };
  }
  /** The caller's place in a book's ebook; null when they have none there yet. */
  async readingProgress(libraryId: number, path: string, signal?: AbortSignal) {
    const r = await this.request<{ reading_progress: ReadingProgress | null }>(
      'GET',
      `/libraries/${libraryId}/reading-progress`,
      { query: { path }, signal },
    );
    return r.reading_progress;
  }
  /** Save the caller's place in a book's ebook. The answer is the stored row (another
   * device's further place when this save diverged, see {@link ReadingProgressInput}),
   * with the place not kept as `other_place` on a diverged save. */
  saveReadingProgress(libraryId: number, path: string, input: ReadingProgressInput) {
    return this.request<ReadingProgressSaved>('PUT', `/libraries/${libraryId}/reading-progress`, {
      query: { path },
      body: input,
    });
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
   * of the connection the usual way instead.
   *
   * `alsoMembers` (capability `household_members` only: an older server ignores it) also
   * signs out the caller's household members signed in on that device (its
   * `member_sign_ins`), counted in the answer's `members_signed_out`. */
  revokeMyDevice(id: number, opts: { alsoMembers?: boolean } = {}) {
    return this.request<MyDeviceRevoked>('DELETE', `/me/devices/${id}`, {
      query: opts.alsoMembers ? { also_members: 1 } : undefined,
    });
  }

  // --- Household members (capability `household_members`) --------------------
  /** Whether the caller may add members, the most they may have, and the members they
   * manage (oldest first). Never refused for a signed-in session: a member or demo caller
   * reads `allowed: false` with a `reason` and no members. */
  async members(signal?: AbortSignal): Promise<HouseholdMembers> {
    const r = await this.request<HouseholdMembers>('GET', '/me/household/members', {
      signal,
    });
    return { ...r, members: r.members ?? [] };
  }
  /** Add a member (201). With `sign_in_here` the answer carries their session on this
   * device (addresses cleaned, as a sign-in's are). Refused with a coded 403 when adding
   * is not allowed (`feature_off`, `not_allowed`, a member or demo caller) and a 409 at
   * the cap (`member_limit`); a 400 for a bad name or a collection that isn't the
   * caller's. */
  async addMember(body: AddMemberBody): Promise<AddMemberResult> {
    const r = await this.request<AddMemberResult>('POST', '/me/household/members', { body });
    return r.session ? { ...r, session: withCleanAddresses(r.session) } : r;
  }
  /** Sign one of the caller's members in on this device (201): their session, named
   * after this device. */
  memberSession(id: number) {
    return this.request<AuthSession>('POST', `/me/household/members/${id}/session`).then(
      withCleanAddresses,
    );
  }
  /** A single-use pairing (QR, 10 minutes) for one of the caller's members to sign in on
   * their own device. */
  memberPairing(id: number) {
    return this.request<PairingPayload>('POST', `/me/household/members/${id}/pair`).then(
      withCleanAddresses,
    );
  }
  /** One member's signed-in devices (sessions and API keys); `current` is always false. */
  async memberDevices(id: number, signal?: AbortSignal): Promise<MyDevice[]> {
    const r = await this.request<MyDevice[] | null>('GET', `/me/household/members/${id}/devices`, {
      signal,
    });
    return r ?? [];
  }
  /** Sign a member out of one device (204). A device that isn't theirs is a 404. */
  revokeMemberDevice(id: number, deviceId: number) {
    return this.request<void>('DELETE', `/me/household/members/${id}/devices/${deviceId}`);
  }
  /** Change a member's name, kind, access or shared collections; answers the member. */
  updateMember(id: number, body: UpdateMemberBody) {
    return this.request<HouseholdMember>('PATCH', `/me/household/members/${id}`, { body });
  }
  /** Delete a member's account and everything it keeps (204). */
  deleteMember(id: number) {
    return this.request<void>('DELETE', `/me/household/members/${id}`);
  }

  // --- Listening in the house (capability `household`) ---------------------
  /** Whether the caller shares what they are listening to with the house. */
  household(signal?: AbortSignal) {
    return this.request<HouseholdSettings>('GET', '/me/household', { signal });
  }
  /** Share (or stop sharing) what the caller is listening to; answers as GET. A demo
   * account is refused with a 403. */
  setHousehold(share: boolean) {
    return this.request<HouseholdSettings>('PUT', '/me/household', {
      body: { share_listening: share },
    });
  }
  /** What the other people who share are listening to (`[]` unless the caller shares). */
  async houseListening(signal?: AbortSignal): Promise<HouseListening> {
    const r = await this.request<HouseListening>('GET', '/household/listening', { signal });
    return { ...r, listening: r.listening ?? [] };
  }

  // --- Casting (capability `cast`) -------------------------------------------
  /** Mint a cast token for the book at `path` (a part path covers its whole book): the
   * `?token=` for the cover and stream URLs a Cast receiver loads, in place of the
   * session token. 403 outside the caller's access, 404 for no such book; an API-key
   * client is refused (403). */
  castToken(libraryId: number, path: string) {
    return this.request<CastToken>('POST', '/cast/token', {
      body: { library_id: libraryId, path },
    });
  }

  // --- The Bridge (capability `bridge`; admin only: a non-admin gets a 403) -------------
  /** A book's Bridge jobs, every kind, newest first (the first page: up to 50). `path` is
   * matched exactly against the job's, which is the book's own path (`rel_path`). */
  async bridgeJobs(libraryId: number, path: string, signal?: AbortSignal): Promise<BridgeJob[]> {
    const r = await this.request<BridgeJobList>('GET', '/admin/bridge/jobs', {
      query: { library_id: libraryId, path },
      signal,
    });
    return r.jobs ?? [];
  }
  /** Queue a job (201), or get the open one already queued for that kind and book (200):
   * the answer is the job either way. Refused with a 409 `library_not_writable` when the
   * Bridge can't write the library, a 409 `kind_unavailable` when it doesn't offer the
   * kind, a 409 `detect_open` for a generate job while a `chapters.detect` job is queued or
   * working for the book (Bridge Phase 1d), a 409 `contribute_open` for one while a
   * `sidecars.contribute` job is queued or working for it (Phase 2b; a queued one held while
   * the Contributions module is off gives way and is cancelled), a 404 for no such book
   * and a 400 for params the kind refuses. */
  queueBridgeJob(job: BridgeJobRequest) {
    return this.request<BridgeJob>('POST', '/admin/bridge/jobs', { body: job });
  }
  /** Cancel a job: at once while it is queued or parked, else the Bridge is asked to stop
   * (`cancel_requested`). Answers the job; a 409 when it already ended. */
  cancelBridgeJob(id: number) {
    return this.request<BridgeJob>('POST', `/admin/bridge/jobs/${id}/cancel`);
  }
  /** What generating `kind` for a book would take (the confirmation): its source, the
   * transcription hours, the expected agent cost, what the book already has, the earlier
   * books of its series without recaps and any open job. A 404 for no such book, a 409
   * `kind_unavailable` when the Bridge doesn't offer the kind. What the book and the
   * earlier ones have is asked of the community metadata service, so it gets the
   * server's budget (`UPSTREAM_TIMEOUT_MS`). */
  bridgeEstimate(libraryId: number, path: string, kind: string, signal?: AbortSignal) {
    return this.request<BridgeEstimate>('GET', '/admin/bridge/estimate', {
      query: { library_id: libraryId, path, kind },
      signal,
      timeoutMs: Math.max(this.timeoutMs, UPSTREAM_TIMEOUT_MS),
    });
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
  /** Record a listening span. `keepalive`: sent as the page goes (web, a tab closing),
   * the request outliving it. */
  addHistory(
    libraryId: number,
    path: string,
    span: { from_pos: number; to_pos: number; started_at: string; ended_at: string },
    { keepalive = false }: { keepalive?: boolean } = {},
  ) {
    return this.request<void>('POST', `/libraries/${libraryId}/history`, {
      query: { path },
      body: span,
      keepalive,
    });
  }
}
