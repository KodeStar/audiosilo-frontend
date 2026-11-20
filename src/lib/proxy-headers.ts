import type { User } from '@/api/types';
import { isKidAccount } from '@/lib/account';
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
 * other address (its home address on the house network, which the proxy does not guard).
 * Https origins only: a set for an http origin is refused at entry and dropped at load
 * (`cleanProxyHeaders`), and an http URL gets none whatever the set says (the tokenless
 * `server_id` probe of the home address included). What a redirect does with a request's
 * headers is the platform's rule, not this one's (CONVENTIONS.md). On the web it goes only
 * same-origin with the page: a custom header on a cross-origin request needs the server's
 * CORS to list it, and the server lists a fixed set (`Authorization`, `Content-Type`,
 * `X-AudioSilo-Client`, `Range`).
 */

/** One header, as the listener typed it (name trimmed). */
export type ProxyHeader = { name: string; value: string };

/** A set of headers and the origin they go to. */
export type ProxyHeaders = { origin: string; headers: readonly ProxyHeader[] };

/** Every origin's set, by origin: one set per https origin on the device (fe#295,
 * `proxy-headers-store.ts`). */
export type ProxySets = Readonly<Record<string, ProxyHeaders>>;

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
 * Empty otherwise, and always for a plain-http URL (even with a set not built by
 * `cleanProxyHeaders`). The one rule every sender follows (`ApiClient`, the downloads, the
 * car's and the widget's covers).
 */
export function proxyHeaderRecord(
  set: ProxyHeaders | null | undefined,
  url: string,
  platform: string,
  pageOrigin: string | null,
): Record<string, string> {
  if (!set?.headers.length) return {};
  if (proxyOriginOf(url) !== set.origin) return {};
  if (platform === 'web' && !sameOrigin(url, pageOrigin ? { origin: pageOrigin } : null)) {
    return {};
  }
  return Object.fromEntries(set.headers.map((h) => [h.name, h.value]));
}

/** The set kept for `url`'s origin in `sets` (null: none, or `url` is not an https URL). A
 * signed-in connection's client on that address sends it (`connectionClient`). */
export function proxySetFor(sets: ProxySets | null | undefined, url: string): ProxyHeaders | null {
  const origin = proxyOriginOf(url);
  return (origin && sets?.[origin]) || null;
}

/**
 * A set one sign-in uses in place of its address's kept one, for as long as the app runs
 * (`useSession`'s `signInProxySets`, by connection; never stored): a kid's account that got in
 * with a set typed on the connect screen, where the kept set, which a full account here also
 * signs in through, is one the proxy refused (`setSession`). `over` is that kept set: once the
 * address's set is anything else (a grown-up updated it), the kept one is used again.
 */
export type SignInProxySet = { set: ProxyHeaders; over: ProxyHeaders };

/** The set a signed-in connection's request to `url` carries: its sign-in's own (`own`,
 * `SignInProxySet`) while that is for `url`'s origin and the kept set there is still the one
 * it stands in for, else the set kept for that origin (`proxySetFor`). */
export function connectionSetFor(
  sets: ProxySets | null | undefined,
  url: string,
  own?: SignInProxySet | null,
): ProxyHeaders | null {
  if (own?.set.origin === proxyOriginOf(url) && ownSetInUse(sets, own)) return own.set;
  return proxySetFor(sets, url);
}

/** Whether a sign-in's own set (`own`) is in use: the kept set it stands in for is still its
 * address's (a grown-up has not updated it since). */
export function ownSetInUse(
  sets: ProxySets | null | undefined,
  own: SignInProxySet | null | undefined,
): own is SignInProxySet {
  return !!own && sameProxyHeaders(sets?.[own.set.origin], own.over);
}

/**
 * The origins a connection's headers can be for, best first: `first` (the one a set is kept
 * for now), the server's away address (the public one a proxy guards), the address it was
 * paired with, then its home address. Distinct, https only (headers never go over plain
 * http): none when the connection knows no https address.
 */
export function proxyOriginChoices(
  conn: {
    serverUrl: string;
    addresses?: { home?: string; away?: string };
  },
  first?: string | null,
): string[] {
  const all = [first, conn.addresses?.away, conn.serverUrl, conn.addresses?.home].map((u) =>
    u ? proxyOriginOf(u) : null,
  );
  return [...new Set(all.filter((o): o is string => !!o))];
}

/** The set kept for the first of `conn`'s addresses that has one (`proxyOriginChoices`'s
 * order), null when none has. */
export function connectionProxySet(
  sets: ProxySets | null | undefined,
  conn: { serverUrl: string; addresses?: { home?: string; away?: string } },
): ProxyHeaders | null {
  for (const o of proxyOriginChoices(conn)) if (sets?.[o]) return sets[o];
  return null;
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

/** What the proxy headers card's rule reads of a connection. */
export type ProxyCardConnection = {
  id: string;
  serverUrl: string;
  addresses?: { home?: string; away?: string };
  user?: Pick<User, 'is_demo' | 'member_kind'> | null;
};

/** A demo or a kid's account: one that never decides for the others on the device. */
export const isLimitedAccount = (user: ProxyCardConnection['user']) =>
  !!user?.is_demo || isKidAccount(user);

/**
 * Whether `conn`'s account page shows the "Proxy headers" card (fe#167), where the set kept
 * for one of its addresses (`set`, null: none) is added, changed, moved to another of them
 * and removed. A set is its address's, shared by everyone on the device who signs in there
 * (fe#295), so a demo or a kid's account never gets the card while a full account here
 * (`connections`) reaches any address the card could write to: removing or replacing a set
 * there would turn that person's requests away too. With no such account it does (their own
 * to manage, like anyone's), except a demo with no set at all, which has no use for one.
 */
export function canManageProxySet(
  conn: ProxyCardConnection | null,
  set: ProxyHeaders | null,
  connections: readonly ProxyCardConnection[],
): boolean {
  if (!conn) return false;
  if (!isLimitedAccount(conn.user)) return true;
  if (!set && conn.user?.is_demo) return false;
  return proxyOriginChoices(conn, set?.origin).every((o) =>
    mayReplaceProxySet(conn.user, conn.id, o, connections),
  );
}

/**
 * Whether `user` (the connection `connId`) may write the set for `origin`: `canManageProxySet`'s
 * rule for that one address (the card asks it of every address it could write to, a set kept
 * there or not), and what a sign-in asks before replacing a kept set with the one it got in
 * with (`finishConnect`, fe#167; where none is kept yet, any sign-in keeps its own). A full
 * account always may; a demo or a kid's account only while no full account on the device
 * (`connections`) reaches `origin`, since the set is theirs too.
 */
export function mayReplaceProxySet(
  user: ProxyCardConnection['user'],
  connId: string,
  origin: string,
  connections: readonly ProxyCardConnection[],
): boolean {
  return (
    !isLimitedAccount(user) ||
    !connections.some(
      (c) => c.id !== connId && !isLimitedAccount(c.user) && proxyOriginChoices(c).includes(origin),
    )
  );
}
