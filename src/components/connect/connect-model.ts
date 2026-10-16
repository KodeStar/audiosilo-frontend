import { ApiError, TimeoutError } from '@/api/client';
import type { PeopleList, Progress, ServerAddresses } from '@/api/types';
import { priorConnection, serverIdOf } from '@/lib/connection-id';
import type { KnownServer } from '@/lib/known-servers';
import { normalizeUrl, type PairingScan } from '@/lib/pairing';
import {
  type AddressedConnection,
  isOwnAddress,
  mergeAddresses,
  pickAddress,
  type ServerIdProbe,
} from '@/lib/server-address';
import { isInProgress } from '@/lib/progress-view';
import { isLoopbackHost, urlEndpoint } from '@/lib/url-host';

/**
 * The connect flow's rules (onboarding: connect, sign in, "Your library is ready."),
 * pure so each is tested. The screens are `src/app/connect/*`; their pieces live beside
 * this file.
 */

/** The onboarding steps the step indicator counts (profiles, "Who's listening?", arrive
 * with households). */
export const CONNECT_STEPS = 3;
export type ConnectStep = 0 | 1 | 2;

/** The part of a connection a re-pair reads. */
export type RepairConnection = AddressedConnection & {
  needsReconnect?: string;
  user?: { id?: number };
};

/**
 * What a sign-in stores, given the address it signed in through (`pending`), the
 * `server_id` that answered, the device's connections, and the connection a reconnect
 * was started for (`reconnectId`, from the reconnect banner):
 *
 * Connections are matched to the answering server by `serverIdOf` (a connection id also
 * names its user). `userId` (who signed in) picks that user's connection when the device
 * has several on the server, else any of them: what is read here is server-level.
 *
 * - **The same connection again** (its `server_id` answered, through one of its own
 *   addresses: the reconnect banner signs in through the address in use now, which away
 *   from home is the away address): keep its `serverUrl`, the address it was paired
 *   with. `serverUrl` is never rewritten by the address switching, and the switching
 *   picks the right address by itself.
 * - **A server that was reset** (the banner's connection, reached through one of its own
 *   addresses, answered with a NEW `server_id`): store the old connection's `serverUrl`,
 *   so the session store retires the dead identity (it drops a connection to another
 *   `server_id` at the same `serverUrl`), and carry its addresses over (the home address is
 *   probed against the new `server_id` before it is used, so this never sends a token to
 *   another box).
 * - **A remembered server signed in to again** (`known`, the known-servers entry with the
 *   answering `server_id`, reached through one of its addresses: a "Reconnect to <server>"
 *   row signs in through the home address when it answers as that server): keep the
 *   `serverUrl` it was paired with, so a sign-in at home never turns the home address into
 *   the connection's paired one (away from home that would be the fallback).
 * - Anything else: the address signed in through, as typed or linked.
 *
 * `addresses` is what to hand `setSession` (it merges with what the connection kept).
 */
export function repairPlan(input: {
  pending: string;
  serverId: string;
  connections: readonly RepairConnection[];
  reconnectId?: string;
  answer?: ServerAddresses;
  known?: KnownServer;
  userId?: number;
}): { serverUrl: string; addresses: ServerAddresses | undefined } {
  const { pending, serverId, connections, reconnectId, answer, known, userId } = input;
  // The connection the session will update (`priorConnection`), else another user's on
  // the same server (its address is the server's own all the same).
  const same =
    (userId !== undefined ? priorConnection(connections, serverId, userId) : undefined) ??
    connections.find((c) => serverIdOf(c) === serverId);
  if (same && isOwnAddress(pending, same)) {
    return { serverUrl: same.serverUrl, addresses: answer };
  }
  if (
    !same &&
    known?.serverId === serverId &&
    isOwnAddress(pending, {
      id: serverId,
      serverId,
      serverUrl: known.serverUrl,
      addresses: known.addresses,
    })
  ) {
    return { serverUrl: known.serverUrl, addresses: answer };
  }
  const target = reconnectId ? connections.find((c) => c.id === reconnectId) : undefined;
  if (!same && target && isOwnAddress(pending, target)) {
    return {
      serverUrl: target.serverUrl,
      addresses: mergeAddresses(target.addresses, answer),
    };
  }
  return { serverUrl: pending, addresses: answer };
}

/**
 * The connection already signed in as `userId` on the server `serverId`, its token not
 * refused in this runtime (no `needsReconnect`, which is never stored: `useLinkPairing`
 * also asks the server), or undefined. A link that names both (the console's "Listen in
 * player": `sid` + `uid`) then needs no exchange: its unused token expires by itself, and
 * no second session (or "new device" notice) is made at each press. Only one saved with
 * this user's id: one saved before user ids were kept (`priorConnection`'s fallback) can't
 * be told to be theirs.
 */
export function signedInAs<
  C extends {
    id: string;
    serverId?: string;
    user?: { id?: unknown } | null;
    needsReconnect?: unknown;
  },
>(connections: readonly C[], serverId: string, userId: number): C | undefined {
  return connections.find(
    (c) => serverIdOf(c) === serverId && c.user?.id === userId && !c.needsReconnect,
  );
}

/** Whether a sign-in is the device's first: no connection before it. Only then does the
 * flow end on "Your library is ready."; an added server goes straight back. */
export function isFirstConnection(connections: readonly unknown[]): boolean {
  return connections.length === 0;
}

/** RFC 1918 and link-local IPv4. */
function isPrivateV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Unique local and link-local IPv6. */
function isPrivateV6(host: string): boolean {
  const h = host.toLowerCase();
  if (!h.includes(':')) return false;
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
}

/**
 * Whether an address is a home-network address: one that answers only on the server's
 * own network (a private or link-local IP, a `.local`, `.lan` or `.home.arpa` name, or a
 * single-label name). Loopback is not: no other device can reach it anyway. The same
 * rule the server uses to derive a home address. For the "Couldn't reach" hint.
 */
export function looksLikeHomeAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || isLoopbackHost(host)) return false;
  if (isPrivateV4(host) || isPrivateV6(host)) return true;
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':')) return false;
  return /\.(local|lan|home\.arpa)$/.test(host) || !host.includes('.');
}

/**
 * The plain-http address to try once when the listener typed an address WITHOUT a
 * scheme and its https probe (`normalizeUrl` adds https) could not connect: a server at
 * home often answers plain http only ("mac-studio.local:18571"). Null when a scheme
 * was typed (the listener said which) or the address is not valid.
 */
export function httpFallback(typed: string): string | null {
  const raw = typed.trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  return normalizeUrl(`http://${raw}`) || null;
}

/**
 * Ask `attempt` at `primary`; when that fails without a server answering (not an
 * `ApiError`) and `fallback(error)` names another address, ask there once. Resolves the
 * answer and the address that gave it. A failure at the fallback that isn't its server's
 * own answer reports the primary's error, which says what the listener asked for.
 */
export async function withFallback<T>(
  primary: string,
  attempt: (base: string) => Promise<T>,
  fallback: (error: unknown) => string | null | Promise<string | null>,
): Promise<{ answer: T; base: string }> {
  try {
    return { answer: await attempt(primary), base: primary };
  } catch (e) {
    const alt = e instanceof ApiError ? null : await fallback(e);
    if (!alt) throw e;
    try {
      return { answer: await attempt(alt), base: alt };
    } catch (e2) {
      throw e2 instanceof ApiError ? e2 : e;
    }
  }
}

/**
 * Where to exchange a pairing link's token when its base could not connect (`withFallback`
 * keeps a server's own answer from getting here): its `home` address, or null to give up.
 * A server on its own (self-signed) certificate, which the device can't trust, also
 * answers plain http to home-network devices on the same port, and its links carry that
 * as `home=http://<host:port>` with its `sid=<server_id>`. The token would cross the
 * network in the clear, so only to that server:
 * - the base is https and the home address plain http on the base's own host and port
 *   (no host the link's base didn't name);
 * - the link names the server (`serverId`; an older server's link doesn't, and such a
 *   server serves no home http anyway), and home, asked with no token (`probe`), answers
 *   as exactly that server (another box can sit at the same address on another network);
 * - not after a timeout: a host that never answered would only time out again on http.
 */
export async function pairingFallback(
  scan: PairingScan,
  error: unknown,
  probe: ServerIdProbe,
): Promise<string | null> {
  const home = scan.addresses?.home;
  if (!home || !scan.serverId || error instanceof TimeoutError) return null;
  const base = urlEndpoint(scan.base);
  const at = urlEndpoint(home);
  if (base?.scheme !== 'https' || at?.scheme !== 'http') return null;
  if (at.host !== base.host || at.port !== base.port) return null;
  return (await probe(home)) === scan.serverId ? home : null;
}

/**
 * Whether a certificate the device can't trust (a server on its own, self-signed one) may
 * be why `base` could not connect: an https address that failed without its server
 * answering and without timing out, on native. Not on the web (`web`), where the browser
 * judges the certificate and an https page can't call http.
 */
export function selfSignedMayBeWhy(base: string, error: unknown, web: boolean): boolean {
  return (
    !web &&
    /^https:\/\//i.test(base) &&
    !(error instanceof ApiError) &&
    !(error instanceof TimeoutError)
  );
}

/** The remembered servers the connect screen offers to reconnect to: those this device
 * is not signed in to now. `serverIds` are the signed-in connections' servers
 * (`serverIdOf`), never their connection ids. */
export function knownToOffer(
  known: readonly KnownServer[],
  serverIds: readonly string[],
): KnownServer[] {
  return known.filter((k) => !serverIds.includes(k.serverId));
}

/**
 * The address a "Reconnect to <server>" row signs in through. On the web, the address it
 * remembered (the served player stays same-origin). On native, a remembered server with
 * a home address is asked who it is there first (`pickAddress`: no token, home only on
 * the server's own `server_id`, so a password never goes to another box at the same
 * private IP), else its away address, else the remembered one.
 */
export function reconnectAddress(
  entry: KnownServer,
  probe: ServerIdProbe,
  web: boolean,
): Promise<string> {
  if (web) return Promise.resolve(entry.serverUrl);
  return pickAddress(
    {
      id: entry.serverId,
      serverId: entry.serverId,
      serverUrl: entry.serverUrl,
      addresses: entry.addresses,
    },
    probe,
  );
}

/**
 * Where to scroll so a focused field shows above the keyboard, or null when it already
 * does: the field's top and bottom in the scroll content, the content offset now, and
 * the visible height (the scroll view, already shortened by the keyboard). Keeps
 * `margin` clear below the field; a field taller than the view aligns its top.
 */
export function revealOffset(input: {
  fieldTop: number;
  fieldBottom: number;
  scrollY: number;
  viewport: number;
  margin?: number;
}): number | null {
  const { fieldTop, fieldBottom, scrollY, viewport } = input;
  const margin = input.margin ?? 24;
  if (viewport <= 0) return null;
  if (fieldTop >= scrollY && fieldBottom + margin <= scrollY + viewport) return null;
  if (fieldTop < scrollY) return Math.max(0, fieldTop - margin);
  const target = fieldBottom + margin - viewport;
  return Math.max(0, Math.min(target, fieldTop - margin));
}

/** A box in the connect column's content, top and bottom. */
export type Span = { top: number; bottom: number };

/**
 * What a reveal brings into view: the focused field with whatever is showing under it to
 * keep in view too (the probe's notice, `ConnectReveal`), from the field's top to the
 * lowest bottom. `revealOffset` never scrolls past the span's top, so the field stays in
 * view first. Without a field, the shown boxes alone; null with nothing.
 */
export function revealSpan(field: Span | null, shown: readonly Span[]): Span | null {
  if (!field && !shown.length) return null;
  const top = field ? field.top : Math.min(...shown.map((s) => s.top));
  const bottom = Math.max(field?.bottom ?? -Infinity, ...shown.map((s) => s.bottom));
  return { top, bottom };
}

/**
 * The number of books across a server's libraries, from each library's authors list
 * (capability `browse_people`): every book is counted once, under its one author value
 * or as `unknown`. Null until every list has loaded (a partial sum would undercount).
 */
export function bookTotal(lists: readonly (PeopleList | undefined)[]): number | null {
  let total = 0;
  for (const l of lists) {
    if (!l) return null;
    total += l.unknown + l.people.reduce((n, p) => n + p.books, 0);
  }
  return total;
}

/** The book the listener was last on (newest saved progress that is started and not
 * finished): "Your place in <book> came with you". */
export function latestPlace(rows: readonly Progress[] | undefined): Progress | undefined {
  let best: Progress | undefined;
  for (const p of rows ?? []) {
    if (!isInProgress(p)) continue;
    if (!best || p.updated_at > best.updated_at) best = p;
  }
  return best;
}

/** How many library names the ready screen lists before it gives a count instead. */
export const LISTED_LIBRARIES = 4;

/** What the ready screen says about the library (`onboarding.ready.<kind>`). */
export type ReadyLine =
  | { kind: 'booksIn'; books: number; names: string[] }
  | { kind: 'booksAcross'; books: number; libraries: number }
  | { kind: 'librariesIn'; libraries: number; names: string[] }
  | { kind: 'librariesCount'; libraries: number }
  | { kind: 'empty' };

/**
 * The ready screen's sentence about the library, from the library names (undefined while
 * loading or after an error) and the book count (undefined while counting, null when the
 * server can't count them: no `browse_people`, or a list failed). Null: nothing to say
 * yet. A few libraries are named, more are counted.
 */
export function readyLine(input: {
  libraries: readonly string[] | undefined;
  books: number | null | undefined;
}): ReadyLine | null {
  const { libraries, books } = input;
  if (!libraries || books === undefined) return null;
  if (libraries.length === 0 || books === 0) return { kind: 'empty' };
  const named = libraries.length <= LISTED_LIBRARIES;
  if (books !== null) {
    return named
      ? { kind: 'booksIn', books, names: [...libraries] }
      : { kind: 'booksAcross', books, libraries: libraries.length };
  }
  return named
    ? { kind: 'librariesIn', libraries: libraries.length, names: [...libraries] }
    : { kind: 'librariesCount', libraries: libraries.length };
}

/** A scanned pairing code as `/connect` route params: its server, token, and the
 * server's home and away addresses, its id (`sid`), the user (`uid`) and the book (`book`,
 * `path`) when the code carries them. */
export function scanParams(scan: PairingScan): Record<string, string> {
  return {
    server: scan.base,
    token: scan.token,
    ...(scan.addresses?.home ? { home: scan.addresses.home } : {}),
    ...(scan.addresses?.away ? { away: scan.addresses.away } : {}),
    ...(scan.serverId ? { sid: scan.serverId } : {}),
    ...(scan.userId ? { uid: String(scan.userId) } : {}),
    ...(scan.book ? { book: String(scan.book.libraryId), path: scan.book.path } : {}),
  };
}
