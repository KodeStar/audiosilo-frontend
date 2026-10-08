import type { ServerAddresses } from '@/api/types';
import { mergeAddresses } from '@/lib/server-address';
import { getItem, setItem } from '@/lib/storage';

/**
 * A durable, minimal record of a server the user has successfully signed in to -
 * enough to offer a one-tap "Reconnect to <server>" on the connect screen after a
 * full logout, with zero typing. It holds NO token or secret (the connect flow
 * re-pairs to mint a fresh one); just the address, display name, and stable
 * `serverId`, and the server's home and away addresses when it has them (capability
 * `addresses`), so a reconnect at home can use the home address and the connection it
 * makes keeps both.
 *
 * It lives under its own AsyncStorage key that `resetStaleStorage()` does NOT
 * clear (neither the auth wipe nor the cache wipe touches it), so the shortcut
 * survives signing out of every connection - which is exactly when it's most
 * useful.
 */
export type KnownServer = {
  serverUrl: string;
  name: string;
  serverId: string;
  addresses?: ServerAddresses;
};

// Deliberately NOT in SCOPED_STORAGE_KEYS or the legacy-key list in session.ts, so
// neither reset axis wipes it. Survives a full logout.
const KEY = 'audiosilo.knownServers';

/** Every remembered server, newest first. */
export async function list(): Promise<KnownServer[]> {
  return (await getItem<KnownServer[]>(KEY)) ?? [];
}

/** Upsert a server, moving it to the front. Dedupes on EITHER the stable
 * `serverId` OR the `serverUrl`: a re-pair at a new URL refreshes the existing
 * entry (same id), and a re-pair at the same address supersedes the old entry even
 * when the server minted a fresh `serverId` (a rebuilt/reset server) - otherwise
 * that address would show two identical "Reconnect to <name>" rows, one pointing at
 * a dead identity. The same server's addresses merge with what the entry knew
 * (`mergeAddresses`: an entry without them keeps the known ones, and a home address
 * survives an answer read away from home). */
export async function remember(entry: KnownServer): Promise<void> {
  if (!entry.serverId) return;
  const current = await list();
  const before = current.find((e) => e.serverId === entry.serverId);
  const addresses = mergeAddresses(before?.addresses, entry.addresses);
  const { addresses: _given, ...rest } = entry;
  const next = [
    addresses ? { ...rest, addresses } : rest,
    ...current.filter((e) => e.serverId !== entry.serverId && e.serverUrl !== entry.serverUrl),
  ];
  await setItem(KEY, next);
}

/** Replace a remembered server's addresses (what the server says now), in place. A
 * no-op for a server that isn't remembered. */
export async function rememberAddresses(
  serverId: string,
  addresses: ServerAddresses | undefined,
): Promise<void> {
  const current = await list();
  if (!current.some((e) => e.serverId === serverId)) return;
  const next = current.map((e) => {
    if (e.serverId !== serverId) return e;
    const { addresses: _old, ...rest } = e;
    return addresses ? { ...rest, addresses } : rest;
  });
  await setItem(KEY, next);
}

/** The addresses a remembered server had, if any. */
export async function knownAddresses(serverId: string): Promise<ServerAddresses | undefined> {
  return (await list()).find((e) => e.serverId === serverId)?.addresses;
}

/** Drop a remembered server (the connect screen's "forget" affordance). */
export async function forget(serverId: string): Promise<void> {
  const current = await list();
  const next = current.filter((e) => e.serverId !== serverId);
  await setItem(KEY, next);
}
