import { CLIENT_HEADER } from '@/lib/client-id';
import { sameOrigin } from '@/lib/same-origin';

/**
 * Custom request headers for a server behind an auth proxy (fe#167): a Cloudflare Access
 * service token pair, an Authentik or Authelia header, and the like. The proxy reads them;
 * the AudioSilo server never sees a need for them, so nothing on the server changes.
 *
 * They are credentials. Each connection keeps its set in the same storage as its session
 * token (`proxy-headers-store.ts`), never in AsyncStorage, the query cache or a log line. A
 * set names the ONE https origin (scheme, host and port) it was entered for, and the app
 * sends it only with requests to that origin (`proxyHeaderRecord`): never to the server's
 * other address (its home address on the house network, which the proxy does not guard),
 * never to a plain-http fallback. Never over plain http at all: a set for an http origin is
 * refused at entry and dropped at load (`cleanProxyHeaders`), so a credential never crosses
 * the network in the clear (the tokenless `server_id` probe of the home address included).
 * What a redirect does with a request's headers is the platform's rule, not this one's (not
 * yet checked on a device: CONVENTIONS.md). On the web it goes only same-origin with the page: a custom header on a cross-origin request needs the server's
 * CORS to list it, and the server lists a fixed set (`Authorization`, `Content-Type`,
 * `X-AudioSilo-Client`, `Range`).
 */

/** One header, as the listener typed it (name trimmed). */
export type ProxyHeader = { name: string; value: string };

/** A connection's headers and the origin they go to. */
export type ProxyHeaders = { origin: string; headers: readonly ProxyHeader[] };

/** How many headers a connection may carry: a proxy needs one or two. */
export const MAX_PROXY_HEADERS = 8;

/** Longest value kept (a JWT-sized token fits; a pasted page does not). */
export const MAX_PROXY_HEADER_VALUE = 4096;

/**
 * Names the app sends itself, or the platform owns: a header of the listener's under one of
 * these would replace the session token (`Authorization`), the client's identity or a
 * request's own framing. A proxy that wants `Authorization` (basic auth) cannot sit in front
 * of AudioSilo, whose API takes its token there.
 */
const RESERVED = new Set([
  'authorization',
  'content-type',
  'content-length',
  'range',
  'host',
  'cookie',
  'connection',
  'transfer-encoding',
  CLIENT_HEADER.toLowerCase(),
]);

/** An HTTP header name (RFC 9110 `token`). */
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Visible ASCII and spaces or tabs inside: no line breaks or other control characters,
 * which the platform's HTTP stack would refuse (or worse, split into a second header). */
const VALUE = /^[\x21-\x7e]([\t\x20-\x7e]*[\x21-\x7e])?$/;

/** Why a header can't be kept: its name (empty or not a header name), a name the app owns,
 * the same name twice, or its value (empty, too long, or holding a control character). */
export type ProxyHeaderProblem = 'name' | 'reserved' | 'duplicate' | 'value';

/** What is wrong with `h` (null: nothing). `seen` holds the lower-cased names before it. */
export function proxyHeaderProblem(
  h: ProxyHeader,
  seen: ReadonlySet<string> = new Set(),
): ProxyHeaderProblem | null {
  const name = h.name.trim();
  if (!NAME.test(name)) return 'name';
  const lower = name.toLowerCase();
  if (RESERVED.has(lower)) return 'reserved';
  if (seen.has(lower)) return 'duplicate';
  const value = h.value.trim();
  if (!value || value.length > MAX_PROXY_HEADER_VALUE || !VALUE.test(value)) return 'value';
  return null;
}

/** Each header's problem, in order (null where it is fine). */
export function proxyHeaderProblems(
  headers: readonly ProxyHeader[],
): (ProxyHeaderProblem | null)[] {
  const seen = new Set<string>();
  return headers.map((h) => {
    const problem = proxyHeaderProblem(h, seen);
    seen.add(h.name.trim().toLowerCase());
    return problem;
  });
}

/** The origin of `url` (`https://books.example.com`), null when it is not an http(s) URL. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** The origin of `url` when it is an https one, the only kind proxy headers go to; else null. */
export function proxyOriginOf(url: string): string | null {
  const o = originOf(url);
  return o?.startsWith('https://') ? o : null;
}

/**
 * The set to keep for `origin`: each header trimmed, every one that has a problem left out,
 * at most `MAX_PROXY_HEADERS`. Null when none is left or the origin is not an https one
 * (nothing to keep: a set for plain http would cross the network in the clear).
 */
export function cleanProxyHeaders(
  origin: string | null | undefined,
  headers: readonly ProxyHeader[] | null | undefined,
): ProxyHeaders | null {
  const o = origin ? proxyOriginOf(origin) : null;
  if (!o || !Array.isArray(headers)) return null;
  const kept: ProxyHeader[] = [];
  const seen = new Set<string>();
  for (const h of headers) {
    if (!h || typeof h.name !== 'string' || typeof h.value !== 'string') continue;
    if (proxyHeaderProblem(h, seen)) continue;
    const name = h.name.trim();
    seen.add(name.toLowerCase());
    kept.push({ name, value: h.value.trim() });
    if (kept.length === MAX_PROXY_HEADERS) break;
  }
  return kept.length ? { origin: o, headers: kept } : null;
}

/**
 * The headers to put on a request to `url`: the set's, when `url` is an https URL on the set's
 * origin, and on the web only when that is also the page's own origin (see the file comment).
 * Empty otherwise, a plain-http URL always (even for a set not built by `cleanProxyHeaders`). The one rule every sender follows (`ApiClient`, the downloads, the car's and the
 * widget's covers).
 */
export function proxyHeaderRecord(
  set: ProxyHeaders | null | undefined,
  url: string,
  platform: string,
  pageOrigin: string | null,
): Record<string, string> {
  if (!set?.headers.length) return {};
  const origin = proxyOriginOf(url);
  if (!origin || origin !== set.origin) return {};
  if (platform === 'web' && !sameOrigin(url, pageOrigin ? { origin: pageOrigin } : null)) {
    return {};
  }
  return Object.fromEntries(set.headers.map((h) => [h.name, h.value]));
}

/** What the screen shows in place of a value: the same dots for every one, so what is drawn
 * never depends on a stored value (or its length). */
export const MASKED_PROXY_VALUE = '•'.repeat(8);

/** Two sets carry the same headers to the same origin. */
export function sameProxyHeaders(
  a: ProxyHeaders | null | undefined,
  b: ProxyHeaders | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.origin === b.origin &&
    a.headers.length === b.headers.length &&
    a.headers.every((h, i) => h.name === b.headers[i].name && h.value === b.headers[i].value)
  );
}
