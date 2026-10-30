import { Linking, Platform } from 'react-native';

import type { Capabilities, UpcomingCalendarStatus, User } from '@/api/types';
import { isKidAccount } from '@/lib/account';
import { deleteSecure, getSecure, setSecure } from '@/lib/secure-store';

/**
 * The upcoming releases calendar (Track U3): the pure rules behind the Upcoming page's
 * calendar card, and this device's copy of a connection's calendar link.
 *
 * The link (`<address>/api/v1/me/upcoming/releases.ics?token=<secret>`) is a credential:
 * anyone holding it can read the listener's upcoming list. The server shows it once, when
 * it is made, so the device keeps its own copy per connection in the same storage as that
 * connection's session token (`secure-store`: the keychain or keystore, localStorage on
 * the web), never in AsyncStorage or the query cache's startup copy. It goes with the
 * connection (sign-out, a retired identity, the auth reset: `src/stores/session.ts`), on
 * Turn off, and is replaced on Reset.
 */

/** This device's copy of a connection's calendar link: the full URL and when the server
 * made it (`created_at`, compared with `GET /me/upcoming/calendar`'s to tell a link
 * replaced on another device from this one). */
export type StoredCalendarLink = { url: string; created_at: string };

/** The secure-store key of a connection's calendar link. */
export const calendarLinkKey = (connectionId: string) =>
  `audiosilo.upcoming-calendar.${connectionId}`;

/** This device's copy of the connection's calendar link, or null (none, unreadable, or not
 * the shape this build writes). */
export async function readCalendarLink(connectionId: string): Promise<StoredCalendarLink | null> {
  try {
    const raw = await getSecure(calendarLinkKey(connectionId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredCalendarLink> | null;
    return v && typeof v.url === 'string' && typeof v.created_at === 'string'
      ? { url: v.url, created_at: v.created_at }
      : null;
  } catch {
    return null;
  }
}

/** Keep the connection's calendar link on this device (replacing any earlier one). */
export function saveCalendarLink(connectionId: string, link: StoredCalendarLink): Promise<void> {
  return setSecure(calendarLinkKey(connectionId), JSON.stringify(link));
}

/** Forget this device's copy of the connection's calendar link. Best-effort: a locked
 * keychain must not fail a sign-out. */
export async function forgetCalendarLink(connectionId: string): Promise<void> {
  await deleteSecure(calendarLinkKey(connectionId)).catch(() => undefined);
}

/** Move this device's copy of a connection's calendar link to the id the connection moved
 * to (the identity migration), keeping one already there. Best-effort, never rejects: the
 * old key never outlives the move (a copy lost on the way, the row offers Reset). */
export async function moveCalendarLink(from: string, to: string): Promise<void> {
  try {
    const link = await readCalendarLink(from);
    if (link && !(await readCalendarLink(to))) await saveCalendarLink(to, link);
  } catch {
    // Not kept under the new id.
  }
  await forgetCalendarLink(from);
}

/**
 * The full calendar link: the server's `path` on the address a calendar app should fetch
 * it from. That is the server's away address (capability `addresses`: the public one that
 * works from anywhere) when it has one, else the address this device reaches it at now
 * (which may be a home address only the house can reach).
 */
export function calendarFeedUrl(
  path: string,
  addresses: { away?: string } | undefined,
  baseUrl: string,
): string {
  const base = (addresses?.away || baseUrl).replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The `webcal://` form of a calendar link, which a calendar app opens as a subscription.
 * Null for a link that is not http(s). */
export function webcalUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url.replace(/^https?:\/\//i, 'webcal://') : null;
}

/** Whether "Subscribe" can hand a `webcal://` link to a calendar app: the iOS app, and a
 * browser on an Apple device (macOS, and an iPad or iPhone, whose Calendar takes it). On
 * Android and elsewhere no app is known to take it: Copy only. */
export function canSubscribeWebcal(
  os: string = Platform.OS,
  userAgent: string | undefined = globalThis.navigator?.userAgent,
): boolean {
  if (os === 'ios') return true;
  if (os !== 'web' || !userAgent) return false;
  return /Macintosh|Mac OS X|iPhone|iPad|iPod/.test(userAgent) && !/Android/.test(userAgent);
}

/** Hand a calendar link to the calendar app as a subscription (`webcal://`). The web
 * navigates to it (the browser passes the scheme to the OS without leaving the page; a
 * new tab would stay behind empty); the app opens it through `Linking`. */
export async function openWebcal(url: string): Promise<void> {
  const webcal = webcalUrl(url);
  if (!webcal) return;
  try {
    if (Platform.OS === 'web') globalThis.location?.assign(webcal);
    else await Linking.openURL(webcal);
  } catch {
    // No app takes webcal: the link is still there to copy.
  }
}

/** A connection the calendar card shows a row for: its server offers the calendar
 * (`upcoming_calendar`) and its user is not a kid (the routes refuse a kid, and a kid is
 * never asked). `demo`: a demo account, which the mint refuses; its row explains and asks
 * nothing. */
export type CalendarConnection = { id: string; demo: boolean };

/** The connections the calendar card has a row for (see {@link CalendarConnection}), in
 * the order given. A connection whose flags are not known yet has none. */
export function calendarConnections(
  connections: readonly {
    id: string;
    user?: Pick<User, 'member_kind' | 'is_demo'> | null;
  }[],
  caps: Record<string, Capabilities | undefined>,
): CalendarConnection[] {
  return connections.flatMap((c) =>
    !isKidAccount(c.user) && caps[c.id]?.upcoming_calendar
      ? [{ id: c.id, demo: !!c.user?.is_demo }]
      : [],
  );
}

/**
 * What a connection's calendar row shows:
 * - `loading`: the server's status or this device's copy is still being read;
 * - `error`: the status could not be read (a Retry);
 * - `none`: no link ("Get calendar link");
 * - `shown`: a link this device holds, the one the server has now (its URL, Copy,
 *   Subscribe where it works, Reset, Turn off);
 * - `elsewhere`: a link is active but this device has no copy of it (made on another
 *   device, or replaced there): "Reset to see it here".
 * `staleCopy`: this device's copy is no longer the server's link (turned off or replaced
 * elsewhere) and should be forgotten.
 */
export type CalendarRowState =
  | { kind: 'loading' | 'error' | 'none'; staleCopy: boolean }
  | { kind: 'shown'; url: string; staleCopy: false }
  | { kind: 'elsewhere'; staleCopy: boolean };

export function calendarRowState(opts: {
  /** The server's answer, undefined until it comes. */
  status: UpcomingCalendarStatus | undefined;
  /** The status read failed with nothing known. */
  failed: boolean;
  /** This device's copy: undefined while it is read, null for none. */
  stored: StoredCalendarLink | null | undefined;
}): CalendarRowState {
  const { status, failed, stored } = opts;
  if (!status) return { kind: failed ? 'error' : 'loading', staleCopy: false };
  if (stored === undefined) return { kind: 'loading', staleCopy: false };
  if (!status.active) return { kind: 'none', staleCopy: stored !== null };
  // An older answer without `created_at` can't tell: the copy stands.
  if (stored && (!status.created_at || sameInstant(stored.created_at, status.created_at))) {
    return { kind: 'shown', url: stored.url, staleCopy: false };
  }
  return { kind: 'elsewhere', staleCopy: stored !== null };
}

/** Whether two RFC 3339 times are the same instant (the text when either won't parse). */
function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
}
