import { getItem } from '@/lib/storage';

/**
 * The connection id: which signed-in account on which server a piece of state belongs to.
 *
 * A connection is ONE user on ONE server, so its id is `<server_id>.<user_id>`
 * (`connectionIdOf`): two people signed in to the same server on one device are two
 * connections with their own tokens, downloads, progress and query cache. The server's
 * `server_id` is base64url (`[A-Za-z0-9_-]`, never `.`) and `user.id` is a positive
 * integer, so the `.` is an unambiguous separator, and the id stays inside
 * expo-secure-store's key alphabet (`audiosilo.token.<id>`, `[\w.-]`), a file name and a
 * URL path segment. It never holds `:` (`contentKey` joins on it), `/`, `%`, `#` or `?`.
 *
 * Before Phase 8 the id was the bare `server_id` (a "legacy" id, `isLegacyConnectionId`).
 * The one-time key migration (`src/lib/identity-migration.ts`) moves every legacy
 * connection to its new id; a connection it could not move (no usable `user.id`, or a
 * migration that has not run yet because the keychain was locked) keeps its legacy id,
 * and every piece of code must keep working with it. So: never split an id yourself and
 * never compare one with a `server_id`; compare servers through `serverIdOf(conn)`.
 *
 * Old ids that arrive after the migration (a widget's deep link, a car snapshot item, a
 * bookmark the Android service queued while no JS ran, a web history entry) are mapped to
 * their new id by `resolveConnectionId`, from the aliases the migration recorded.
 */

/** Where the migration records `{ [legacyId]: newId }` (never wiped by a storage reset). */
export const CONNECTION_ALIASES_KEY = 'audiosilo.connectionAliases';

/** A user id that can be part of a connection id (a positive safe integer), else null. */
export function usableUserId(user: unknown): number | null {
  const id = (user as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The connection id for `userId` on the server `serverId`: `<server_id>.<user_id>`. A user
 * id that can't be part of one (absent, not a positive integer: no server sends that)
 * gives the legacy form, the bare `server_id`, which keeps working everywhere.
 */
export function connectionIdOf(serverId: string, userId: number | null | undefined): string {
  return usableUserId({ id: userId }) === null ? serverId : `${serverId}.${userId}`;
}

const NEW_FORM = /^(.+)\.(\d+)$/;

/** The server and (for a new-form id) the user a connection id names. A legacy id is the
 * bare `server_id`, so it names no user. */
export function parseConnectionId(id: string): { serverId: string; userId?: number } {
  const m = NEW_FORM.exec(id);
  if (m) {
    const userId = Number(m[2]);
    if (Number.isSafeInteger(userId) && userId > 0) return { serverId: m[1], userId };
  }
  return { serverId: id };
}

/** A pre-Phase 8 connection id: the bare `server_id`, with no `.<user_id>`. */
export function isLegacyConnectionId(id: string): boolean {
  return parseConnectionId(id).userId === undefined;
}

/** The server a connection belongs to: its `serverId` (every connection the app writes now
 * carries it), else what its id says (a legacy id IS the `server_id`). The ONE way to
 * compare a connection with a `server_id` or with another connection's server. */
export function serverIdOf(conn: { id: string; serverId?: string }): string {
  return conn.serverId || parseConnectionId(conn.id).serverId;
}

// --- Aliases ----------------------------------------------------------------------------

let aliases: Readonly<Record<string, string>> = {};

/** Only string -> string pairs whose two sides differ survive a stored document. */
export function parseAliases(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
    if (from && typeof to === 'string' && to && to !== from) out[from] = to;
  }
  return out;
}

/**
 * The connection id to use for `id`: its new id when `id` is an old one the migration
 * moved, else `id` itself. Every entry point JS can't rewrite first goes through it (a
 * route's `?connection=`, a car item id, the Android service's loaded book and queued
 * bookmarks, the widget). Synchronous: it reads the copy `loadConnectionAliases` loaded
 * at launch (`bootstrapPlayback`); before that it maps nothing.
 */
export function resolveConnectionId(id: string): string {
  let current = id;
  // A chain can't happen (a new id is never moved again), but a corrupt document must not
  // loop: follow at most a few steps.
  for (let i = 0; i < 4; i++) {
    const next = Object.prototype.hasOwnProperty.call(aliases, current)
      ? aliases[current]
      : undefined;
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

/** Replace the in-memory aliases (the migration, after recording them; tests). */
export function setConnectionAliases(next: Record<string, string>): void {
  aliases = Object.freeze(parseAliases(next));
}

/** The in-memory aliases (the migration merges new ones into them). */
export function connectionAliases(): Readonly<Record<string, string>> {
  return aliases;
}

/** Load the stored aliases into memory. Never rejects (`getItem` swallows): no aliases
 * means old ids stay unknown, which is what they were before any migration. */
export async function loadConnectionAliases(): Promise<void> {
  const stored = parseAliases(await getItem<unknown>(CONNECTION_ALIASES_KEY));
  // Keep any the migration set in this runtime (a reload of the document can't lose them).
  setConnectionAliases({ ...stored, ...aliases });
}
