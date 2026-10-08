import type { ServerAddresses } from '@/api/types';

/**
 * Home and away addresses (capability `addresses`, player redesign Phase 5): which of a
 * server's addresses the player talks to right now. Pure, so every rule is tested here;
 * the store and the runner that apply it are `src/api/address-route.ts` and
 * `src/api/address-runner.ts`.
 *
 * - `serverUrl` is what the listener paired with or typed. It is never rewritten.
 * - With no `home`, the player uses `serverUrl` (exactly as before addresses existed).
 * - With a `home`, the player asks `GET <home>/api/v1/server` WITHOUT a token and uses
 *   `home` only when it answers with this connection's own `server_id`. Another box at
 *   the same private IP on someone else's network must never receive the token.
 *   Otherwise it uses `away`, else `serverUrl`.
 */

/** Which of a connection's addresses a URL is: its home or away address, or neither
 * (the address it was paired with). */
export type AddressKind = 'home' | 'away' | 'paired';

/** The part of a connection the address rules read. */
export type AddressedConnection = {
  /** The server-minted `server_id`. */
  id: string;
  serverUrl: string;
  addresses?: ServerAddresses;
};

/** Asks `GET <url>/api/v1/server` with no token and resolves the `server_id` it
 * answered, or null when nothing answered (unreachable, timed out, not a server). */
export type ServerIdProbe = (url: string) => Promise<string | null>;

const trimSlashes = (url: string) => url.replace(/\/+$/, '');

/** Two addresses are the same address (stored URLs are normalised already; a trailing
 * slash must not tell them apart). */
export function sameUrl(a: string, b: string): boolean {
  return trimSlashes(a) === trimSlashes(b);
}

/** Two address pairs say the same. */
export function sameAddresses(
  a: ServerAddresses | undefined,
  b: ServerAddresses | undefined,
): boolean {
  return (a?.home ?? '') === (b?.home ?? '') && (a?.away ?? '') === (b?.away ?? '');
}

/**
 * What the device keeps after the server told it `fresh` (already cleaned), given what
 * it kept before. `undefined` fresh = nothing was said (a pairing without the field):
 * keep `prior`. Otherwise `away` is the server's configuration and the answer is
 * authoritative (absent = none), while `home` falls back to `prior`: when no home
 * address is configured the server derives it from the request, so an answer read
 * through the away address (or a pairing link made outside the home network) simply
 * cannot know it.
 */
export function mergeAddresses(
  prior: ServerAddresses | undefined,
  fresh: ServerAddresses | undefined,
): ServerAddresses | undefined {
  if (!fresh) return prior;
  const away = fresh.away;
  let home = fresh.home ?? prior?.home;
  if (home && away && sameUrl(home, away)) home = undefined;
  if (!home && !away) return undefined;
  return { ...(home ? { home } : {}), ...(away ? { away } : {}) };
}

/** Whether `url` is one of the connection's own addresses (its paired URL, home or
 * away): a pick that no longer is (the addresses changed) is ignored. */
export function isOwnAddress(url: string, c: AddressedConnection): boolean {
  return (
    sameUrl(url, c.serverUrl) ||
    (!!c.addresses?.home && sameUrl(url, c.addresses.home)) ||
    (!!c.addresses?.away && sameUrl(url, c.addresses.away))
  );
}

/** The address to use when home is not an option: away, else the paired URL. */
export function fallbackAddress(c: AddressedConnection): string {
  return c.addresses?.away ?? c.serverUrl;
}

/**
 * The pick rule, given what the home address answered (`homeServerId`: the
 * `server_id` it answered, or null for no answer). Home only on a matching
 * `server_id`; no home at all keeps the paired URL.
 */
export function chooseAddress(c: AddressedConnection, homeServerId: string | null): string {
  const home = c.addresses?.home;
  if (!home) return c.serverUrl;
  if (homeServerId !== null && homeServerId === c.id) return home;
  return fallbackAddress(c);
}

/** Pick the address for a connection now: probes its home address (when it has one)
 * through `probe`, then applies `chooseAddress`. */
export async function pickAddress(c: AddressedConnection, probe: ServerIdProbe): Promise<string> {
  const home = c.addresses?.home;
  if (!home) return c.serverUrl;
  let answered: string | null = null;
  try {
    answered = await probe(home);
  } catch {
    answered = null;
  }
  return chooseAddress(c, answered);
}

/** Which address `url` is for this connection. Home wins over away when the server
 * reports one URL as both (it never should). */
export function addressKind(url: string, c: AddressedConnection): AddressKind {
  if (c.addresses?.home && sameUrl(url, c.addresses.home)) return 'home';
  if (c.addresses?.away && sameUrl(url, c.addresses.away)) return 'away';
  return 'paired';
}

/** The server base a streamed track URL was built on (`<base>/api/v1/...`), or null
 * for anything else (a downloaded file). The runner compares it with the connection's
 * address now to tell a playing book still streaming from the previous address. */
export function streamBase(trackUrl: string): string | null {
  if (!/^https?:\/\//i.test(trackUrl)) return null;
  const at = trackUrl.indexOf('/api/v1/');
  return at > 0 ? trackUrl.slice(0, at) : null;
}
