import type { MyDevice } from '@/api/types';
import type { IconName } from '@/components/ui/icon';
import { parseYouSection, youTitleKey } from '@/components/you/you-model';
import type { NavRoute } from '@/lib/root-stack';

/**
 * The pure parts of a server's account page (`AccountSection`): which server it shows,
 * the pairing code's countdown, and how the signed-in devices read. Kept out of the
 * components so they are tested without rendering.
 */

/** How long a pairing code from `POST /auth/pair` works: the server mints it single-use
 * for 10 minutes (`pairingTTL`), so the page counts down from when it arrived. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Whole seconds left before a code that expires at `expiresAt` (epoch ms) stops working;
 * 0 once it has. Rounded up, so the last second reads 0:01, not 0:00. Never more than the
 * code's 10 minutes: a `now` read before the code arrived (the clock ticks only while a
 * code shows) reads as a fresh code. */
export function pairingSecondsLeft(expiresAt: number, now: number): number {
  return Math.min(PAIRING_TTL_MS / 1000, Math.max(0, Math.ceil((expiresAt - now) / 1000)));
}

/**
 * The server an account page shows: the route's own connection when it names one,
 * else the one the listener picked in the switcher while it is still signed in, else
 * the default connection (or the first, should the default be gone). `null` with no
 * connection at all.
 */
export function resolveAccountCid(
  explicit: string | undefined,
  picked: string | null,
  connectionIds: readonly string[],
  defaultId: string | null,
): string | null {
  if (explicit) return explicit;
  if (picked && connectionIds.includes(picked)) return picked;
  if (defaultId && connectionIds.includes(defaultId)) return defaultId;
  return connectionIds[0] ?? null;
}

/**
 * The signed-in devices the devices list shows: sessions only (an API key is listed in
 * its own section, never twice), this device first, then as the server ordered them
 * (most recently seen first).
 */
export function signedInSessions(devices: readonly MyDevice[] | undefined): MyDevice[] {
  const sessions = (devices ?? []).filter((d) => d.kind === 'session');
  return [...sessions.filter((d) => d.current), ...sessions.filter((d) => !d.current)];
}

/**
 * Whether a device row may be signed out through `useRevokeMyDevice`. Never the device
 * the listener is on: revoking its own token would kill it before the app's sign-out
 * teardown (save the final position, flush the queued progress) could run. That device
 * signs out through `useSignOut`, from the page's sign-out action.
 */
export function canRevoke(device: Pick<MyDevice, 'current'>): boolean {
  return !device.current;
}

/** A device seen within this long reads as "active now". */
export const ACTIVE_NOW_MS = 5 * 60 * 1000;

export type SeenUnit = 'minute' | 'hour' | 'day' | 'month' | 'year';

/** When a device was last seen, in words the page translates: active now (this device,
 * or a request in the last 5 minutes), N units ago, or never (no request since it
 * signed in). */
export type Seen =
  { kind: 'now' } | { kind: 'never' } | { kind: 'ago'; unit: SeenUnit; count: number };

const UNITS: [limit: number, secs: number, unit: SeenUnit][] = [
  [3600, 60, 'minute'],
  [86400, 3600, 'hour'],
  [2592000, 86400, 'day'],
  [31536000, 2592000, 'month'],
  [Infinity, 31536000, 'year'],
];

export function lastSeen(device: Pick<MyDevice, 'current' | 'last_seen'>, now: number): Seen {
  if (device.current) return { kind: 'now' };
  const then = device.last_seen ? Date.parse(device.last_seen) : NaN;
  if (Number.isNaN(then)) return { kind: 'never' };
  const ms = Math.max(0, now - then);
  if (ms < ACTIVE_NOW_MS) return { kind: 'now' };
  const sec = ms / 1000;
  for (const [limit, secs, unit] of UNITS) {
    if (sec < limit) return { kind: 'ago', unit, count: Math.max(1, Math.floor(sec / secs)) };
  }
  return { kind: 'never' };
}

/** The platforms a device row names (`X-AudioSilo-Client`'s platform, lower case). */
export type KnownPlatform = 'ios' | 'android' | 'web';

export function knownPlatform(platform: string | undefined): KnownPlatform | null {
  return platform === 'ios' || platform === 'android' || platform === 'web' ? platform : null;
}

/** A device row's glyph: an API key is a key; a browser is a laptop; an app is a phone,
 * or a tablet when its name says so ("iPad", "Galaxy Tab", "Pixel Tablet"). The platform
 * header doesn't tell a phone from a tablet, so the name the device signed in with does.
 * A device that hasn't said which app it is ("App not reported yet") is a phone or a
 * tablet only when its name says so, else a neutral drive, not a guessed phone. */
export function deviceGlyph(device: {
  kind?: MyDevice['kind'];
  name?: string;
  client?: { platform: string } | null;
}): IconName {
  if (device.kind === 'api') return 'key';
  if (device.client?.platform === 'web') return 'laptop';
  const name = device.name ?? '';
  if (/\b(ipad|tablet|tab)\b/i.test(name)) return 'tablet';
  if (knownPlatform(device.client?.platform)) return 'mobile';
  return /\b(iphone|phone|pixel|galaxy|android)\b/i.test(name) ? 'mobile' : 'hard-drive';
}

/**
 * The route the Account page sits on: the one under the LAST `account` route of its stack
 * (the page is on top when it mounts), or undefined for a cold link.
 */
export function routeUnderAccount(routes: readonly NavRoute[]): NavRoute | undefined {
  const at = routes.map((r) => r.name).lastIndexOf('account');
  return at > 0 ? routes[at - 1] : undefined;
}

/**
 * The Account page's first crumb, naming the page it was opened from: Settings (the page,
 * or the phone You hub's Settings section, both list the signed-in servers) or another of
 * the hub's sections. Null for anything else (the profile menu over any page, a cold
 * link): the chrome's own Back covers it.
 */
export function accountParentKey(parent: NavRoute | undefined) {
  if (parent?.name === 'settings') return 'settings.title' as const;
  if (parent?.name === 'you') {
    const section = (parent.params as { section?: string } | undefined)?.section;
    return youTitleKey(parseYouSection(section));
  }
  return null;
}
