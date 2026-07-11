import { getItem, setItem } from '@/lib/storage';

/**
 * A durable, minimal record of a server the user has successfully signed in to -
 * enough to offer a one-tap "Reconnect to <server>" on the connect screen after a
 * full logout, with zero typing. It holds NO token or secret (the connect flow
 * re-pairs to mint a fresh one); just the address, display name, and stable
 * `serverId`.
 *
 * It lives under its own AsyncStorage key that `resetStaleStorage()` does NOT
 * clear (neither the auth wipe nor the cache wipe touches it), so the shortcut
 * survives signing out of every connection - which is exactly when it's most
 * useful.
 */
export type KnownServer = { serverUrl: string; name: string; serverId: string };

// Deliberately NOT in SCOPED_STORAGE_KEYS or the legacy-key list in session.ts, so
// neither reset axis wipes it. Survives a full logout.
const KEY = 'audiosilo.knownServers';

/** Every remembered server, newest first. */
export async function list(): Promise<KnownServer[]> {
  return (await getItem<KnownServer[]>(KEY)) ?? [];
}

/** Upsert a server by its stable `serverId` (a re-pair at a new URL refreshes the
 * existing entry rather than duplicating it), moving it to the front. */
export async function remember(entry: KnownServer): Promise<void> {
  if (!entry.serverId) return;
  const current = await list();
  const next = [entry, ...current.filter((e) => e.serverId !== entry.serverId)];
  await setItem(KEY, next);
}

/** Drop a remembered server (the connect screen's "forget" affordance). */
export async function forget(serverId: string): Promise<void> {
  const current = await list();
  const next = current.filter((e) => e.serverId !== serverId);
  await setItem(KEY, next);
}
