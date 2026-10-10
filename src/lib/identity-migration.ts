import AsyncStorage from '@react-native-async-storage/async-storage';

import { engine } from '@/downloads/engine';
import {
  CONNECTION_ALIASES_KEY,
  connectionAliases,
  connectionIdOf,
  isLegacyConnectionId,
  parseAliases,
  serverIdOf,
  setConnectionAliases,
  usableUserId,
} from '@/lib/connection-id';
import { contentKey } from '@/lib/content-key';
import { randomUUID } from '@/lib/random';
import { deleteSecure, getSecure, setSecure } from '@/lib/secure-store';
import type { ProfilesDoc } from '@/stores/profiles';
import { CONNECTIONS_KEY, DEFAULT_KEY, type PersistedConnection, tokenKey } from '@/stores/session';

/**
 * The one-time connection identity migration (Phase 8): every connection saved with a
 * legacy id (the bare `server_id`) moves to `<server_id>.<user_id>` (`connectionIdOf`),
 * with everything keyed by it, and NOBODY is signed out. Run by `migrateStorage()` after
 * `resetStaleStorage()` and before any store hydrates or any lazy reader runs.
 *
 * Ordered so a crash, a locked keychain or a failed write at ANY step leaves a working app
 * (legacy ids keep working everywhere; it simply runs again next launch):
 *
 * 1. Read the connections; plan `{ legacyId: newId }` for each with a usable `user.id`
 *    (plus the plan a run cut short left, `IDENTITY_PLAN_KEY`). A connection with no
 *    usable user id, or whose new id another connection already has, stays legacy.
 *    Nothing to move when the Android playback service holds a book of a connection being
 *    moved (`busy`: its file:// tracks would move under the playing engine).
 * 2. Tokens first: copy each `audiosilo.token.<old>` to `audiosilo.token.<new>` and read it
 *    back. Any failure (a CarPlay launch with the phone locked) aborts with nothing else
 *    changed. Old tokens are never deleted here, and a copy is never undone (a run cut
 *    short may already have documents naming the new id).
 * 3. Record the plan, then move the files: native `downloads/<old>` -> `downloads/<new>`, web
 *    the Cache API's `/_offline/<old>/` -> `/_offline/<new>/` (`engine.moveConnection`). A
 *    failure moves back what this run moved and aborts: the registry still names the old
 *    ids, so the files must stay where it says.
 * 4. Rewrite every document naming a connection id in ONE `setMany` (the list below), plus
 *    the aliases (`resolveConnectionId`) and the first profiles document, and forget that a
 *    car snapshot was written (the next one is built fresh, even offline). A failed write
 *    puts the documents back as they were and moves the files back.
 * 5. Mark it done (`IDENTITY_VERSION_KEY` = 2).
 * 6. Delete the old tokens and the plan, best effort (a later launch finishes them).
 *
 * Every rewrite maps ids through the plan, so it is idempotent: a run cut short mid-write
 * (`setMany` is not atomic on iOS or the web) is finished by the next run with the same
 * plan. A legacy connection that comes back after the mark (a web tab still running the old
 * code wrote its list back) is moved by the next launch the same way.
 */

export const IDENTITY_VERSION_KEY = 'audiosilo.identityVersion';
const IDENTITY_VERSION = 2;
/** The moves of a run that has not finished, `{ legacyId: newId }`. */
export const IDENTITY_PLAN_KEY = 'audiosilo.identityPlan';
/** The profiles document (`src/stores/profiles.ts` owns it; the migration writes the first). */
export const PROFILES_KEY = 'audiosilo.profiles';

// Every document that names a connection id. Duplicated here (like `SCOPED_STORAGE_KEYS` in
// session.ts) so the migration reads no store module: they hydrate after it.
export const ID_DOCUMENTS = {
  connections: CONNECTIONS_KEY,
  defaultId: DEFAULT_KEY,
  /** Registry keyed by `contentKey`; each entry's `connectionId`. */
  downloads: 'audiosilo.downloads',
  /** Keyed by `contentKey`; each value's `connectionId`. */
  progressMirror: 'audiosilo.progressMirror',
  /** Array of saves, each with a `connectionId`. */
  progressQueue: 'audiosilo.progressQueue',
  /** Keyed by connection id. */
  offlineServers: 'audiosilo.offlineServers',
  /** Array of car bookmarks to retry, each with a `connectionId`. */
  carBookmarks: 'audiosilo.carBookmarks',
  /** `{ selection: { connectionId, libraryId } }`. */
  librarySelection: 'audiosilo.librarySelection',
  /** `{ lifetime, books }`, books keyed by `contentKey`. */
  timeSaved: 'audiosilo.timeSaved',
  /** Keyed by `contentKey`. */
  driftOffs: 'audiosilo.driftOffs',
  aliases: CONNECTION_ALIASES_KEY,
  profiles: PROFILES_KEY,
} as const;

/** Native keeps the car snapshot it was last handed; this says one was (car-controller.ts). */
export const CAR_SNAPSHOT_WRITTEN_KEY = 'audiosilo.carSnapshotWritten';

/** Which step stopped a run (nothing after it changed; it runs again next launch). */
export type IdentityMigrationStep = 'read' | 'busy' | 'tokens' | 'plan' | 'files' | 'documents';

export type IdentityMigrationResult =
  | { status: 'skipped' }
  | { status: 'migrated'; moved: Record<string, string> }
  | { status: 'aborted'; step: IdentityMigrationStep; error?: unknown };

export type IdentityMigrationDeps = {
  /** The downloads engine's move (absent where there are no downloads). */
  moveConnection?: (fromId: string, toId: string) => Promise<void>;
  /** The connection of the book the Android playback service holds, else null; `unknown`
   * when the service did not say in time (the run waits for a launch where it does). */
  loadedConnectionId: () => Promise<string | null | typeof UNKNOWN>;
  /** A new profile's id (a random v4 UUID, `randomUUID`: device-local, not a secret). */
  newProfileId: () => string;
};

/** `loadedConnectionId` could not tell. */
export const UNKNOWN = Symbol('unknown');
/** How long the playback service gets to say which book it holds. The launch waits on the
 * migration (the theme, every store), so a native call that never answers must not hang it. */
const LOADED_BOOK_TIMEOUT_MS = 3_000;

function defaultDeps(): IdentityMigrationDeps {
  return {
    moveConnection: engine.moveConnection?.bind(engine),
    // Loaded on first use (only when there is something to move): the car seam pulls in the
    // native module, which nothing else on this launch path needs yet.
    loadedConnectionId: async () => {
      const { carNative } = await import('@/car/car-native');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<typeof UNKNOWN>((resolve) => {
        timer = setTimeout(() => resolve(UNKNOWN), LOADED_BOOK_TIMEOUT_MS);
      });
      try {
        const loaded = await Promise.race([carNative.getLoadedBook(), late]);
        return loaded === UNKNOWN ? UNKNOWN : (loaded?.connectionId ?? null);
      } finally {
        clearTimeout(timer);
      }
    },
    newProfileId: randomUUID,
  };
}

const aborted = (step: IdentityMigrationStep, error?: unknown): IdentityMigrationResult => ({
  status: 'aborted',
  step,
  ...(error !== undefined ? { error } : {}),
});

function parse(raw: string | null | undefined): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null; // corrupt: left as it is (its own store's parser drops it)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function readConnections(raw: unknown): PersistedConnection[] {
  return Array.isArray(raw)
    ? raw.filter((c): c is PersistedConnection => isObject(c) && typeof c.id === 'string' && !!c.id)
    : [];
}

/** The moves to make: the stored plan of a run cut short, plus each legacy connection with a
 * usable user id whose new id no other connection has. */
export function planMoves(
  connections: readonly PersistedConnection[],
  stored: Record<string, string>,
): Record<string, string> {
  const ids = new Set(connections.map((c) => c.id));
  const plan: Record<string, string> = { ...stored };
  for (const c of connections) {
    if (!isLegacyConnectionId(c.id)) continue;
    const userId = usableUserId(c.user);
    if (userId === null) continue;
    const to = connectionIdOf(serverIdOf(c), userId);
    if (to === c.id || ids.has(to)) continue;
    plan[c.id] = to;
  }
  return plan;
}

// --- Document rewrites (pure, idempotent under one plan) ----------------------------------

type Plan = Readonly<Record<string, string>>;

const mapId = (plan: Plan, id: unknown): unknown =>
  typeof id === 'string' && Object.prototype.hasOwnProperty.call(plan, id) ? plan[id] : id;

/** A `contentKey` (`<connectionId>:<libraryId>:<path>`) with its connection id mapped. A
 * connection id never holds `:`, so the first one ends it. */
export function rekey(plan: Plan, key: string): string {
  const at = key.indexOf(':');
  if (at <= 0) return key;
  const id = key.slice(0, at);
  return Object.prototype.hasOwnProperty.call(plan, id) ? plan[id] + key.slice(at) : key;
}

function withConnectionId<T>(plan: Plan, v: T): T {
  return isObject(v) && typeof v.connectionId === 'string'
    ? ({ ...v, connectionId: mapId(plan, v.connectionId) } as T)
    : v;
}

function rekeyRecord(plan: Plan, doc: unknown, mapValue = <T>(v: T) => v): unknown {
  if (!isObject(doc)) return doc;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) out[rekey(plan, k)] = mapValue(v);
  return out;
}

/** Each document rewritten through `plan` (`undefined` = absent, left alone). */
export const rewrite = {
  connections(plan: Plan, doc: unknown): unknown {
    if (!Array.isArray(doc)) return doc;
    return doc.map((c: unknown) => {
      if (!isObject(c) || typeof c.id !== 'string') return c;
      const conn = c as PersistedConnection;
      return { ...conn, id: mapId(plan, conn.id), serverId: serverIdOf(conn) };
    });
  },
  defaultId: (plan: Plan, doc: unknown): unknown => mapId(plan, doc),
  downloads(plan: Plan, doc: unknown): unknown {
    if (!isObject(doc)) return doc;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc)) {
      const e = withConnectionId(plan, v);
      const key =
        isObject(e) &&
        typeof e.connectionId === 'string' &&
        typeof e.libraryId === 'number' &&
        typeof e.path === 'string'
          ? contentKey(e.connectionId, e.libraryId, e.path)
          : rekey(plan, k);
      out[key] = e;
    }
    return out;
  },
  progressMirror: (plan: Plan, doc: unknown): unknown =>
    rekeyRecord(plan, doc, (v) => withConnectionId(plan, v)),
  progressQueue: (plan: Plan, doc: unknown): unknown =>
    Array.isArray(doc) ? doc.map((s: unknown) => withConnectionId(plan, s)) : doc,
  offlineServers(plan: Plan, doc: unknown): unknown {
    if (!isObject(doc)) return doc;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc)) out[mapId(plan, k) as string] = v;
    return out;
  },
  carBookmarks: (plan: Plan, doc: unknown): unknown =>
    Array.isArray(doc) ? doc.map((b: unknown) => withConnectionId(plan, b)) : doc,
  librarySelection(plan: Plan, doc: unknown): unknown {
    if (!isObject(doc) || !isObject(doc.selection)) return doc;
    return { ...doc, selection: withConnectionId(plan, doc.selection) };
  },
  timeSaved(plan: Plan, doc: unknown): unknown {
    if (!isObject(doc) || !isObject(doc.books)) return doc;
    return { ...doc, books: rekeyRecord(plan, doc.books) };
  },
  driftOffs: (plan: Plan, doc: unknown): unknown => rekeyRecord(plan, doc),
};

/**
 * The first profiles document: every connection in one profile, except that a profile holds
 * at most one connection per server (a second user on a server, signed in while the
 * migration had not run yet, gets a profile of their own). Named after the profile's first
 * connection's user (the default connection's for the profile that holds it), which is the
 * active one.
 */
export function initialProfiles<C extends Pick<PersistedConnection, 'id' | 'serverId' | 'user'>>(
  connections: readonly C[],
  defaultId: string | null,
  newId: () => string,
): ProfilesDoc {
  const groups: C[][] = [];
  for (const c of connections) {
    const server = serverIdOf(c);
    const home = groups.find((g) => !g.some((m) => serverIdOf(m) === server));
    if (home) home.push(c);
    else groups.push([c]);
  }
  const profiles = groups.map((g) => {
    const named = g.find((c) => c.id === defaultId) ?? g[0];
    return {
      id: newId(),
      name: typeof named.user?.username === 'string' ? named.user.username : '',
      connectionIds: g.map((c) => c.id),
    };
  });
  const active =
    profiles.find((p) => defaultId !== null && p.connectionIds.includes(defaultId)) ?? profiles[0];
  return { version: 1, profiles, activeProfileId: active?.id ?? null, askAtLaunch: false };
}

/** An existing profiles document with its connection ids mapped (and deduplicated). */
function remapProfiles(plan: Plan, doc: unknown): unknown {
  if (!isObject(doc) || !Array.isArray(doc.profiles)) return doc;
  return {
    ...doc,
    profiles: doc.profiles.map((p: unknown) =>
      isObject(p) && Array.isArray(p.connectionIds)
        ? {
            ...p,
            connectionIds: [...new Set(p.connectionIds.map((id: unknown) => mapId(plan, id)))],
          }
        : p,
    ),
  };
}

// --- The run -------------------------------------------------------------------------------

/** Delete each moved-from token no connection still uses, then the plan. Best effort. */
async function cleanUp(plan: Plan, liveIds: ReadonlySet<string>): Promise<void> {
  await Promise.all(
    Object.keys(plan)
      .filter((from) => !liveIds.has(from))
      .map((from) => deleteSecure(tokenKey(from)).catch(() => undefined)),
  );
  await AsyncStorage.removeItem(IDENTITY_PLAN_KEY).catch(() => undefined);
}

/** Move back what this run moved (newest first). Best effort: a failure here is logged. */
async function moveBack(deps: IdentityMigrationDeps, moved: [string, string][]): Promise<void> {
  for (const [from, to] of [...moved].reverse()) {
    try {
      await deps.moveConnection?.(to, from);
    } catch (e) {
      console.warn('[identity] could not move the files back', from, e);
    }
  }
}

/** Run the migration (see the file comment). Never rejects. */
export async function migrateConnectionIdentity(
  deps: IdentityMigrationDeps = defaultDeps(),
): Promise<IdentityMigrationResult> {
  // 1. Read. Straight from AsyncStorage (its reads reject on a storage error, where
  // `getItem` would answer null): a document that could not be read must never be taken as
  // empty and written over.
  let connections: PersistedConnection[];
  let done: boolean;
  let stored: Record<string, string>;
  try {
    const raw = await AsyncStorage.getMany([
      CONNECTIONS_KEY,
      IDENTITY_VERSION_KEY,
      IDENTITY_PLAN_KEY,
    ]);
    connections = readConnections(parse(raw[CONNECTIONS_KEY]));
    done = parse(raw[IDENTITY_VERSION_KEY]) === IDENTITY_VERSION;
    stored = parseAliases(parse(raw[IDENTITY_PLAN_KEY]));
  } catch (e) {
    return aborted('read', e);
  }
  const liveIds = () => new Set(connections.map((c) => c.id));
  const fresh = planMoves(connections, {});
  if (done && Object.keys(fresh).length === 0) {
    // A run that stopped after its mark: only its clean-up is left.
    if (Object.keys(stored).length > 0) await cleanUp(stored, liveIds());
    return { status: 'skipped' };
  }
  const plan = planMoves(connections, stored);
  const moves = Object.entries(plan);
  if (connections.length === 0 && moves.length === 0) {
    await AsyncStorage.setItem(IDENTITY_VERSION_KEY, JSON.stringify(IDENTITY_VERSION)).catch(
      () => undefined,
    );
    return { status: 'skipped' };
  }

  // Not while the Android playback service plays a book of a connection being moved: its
  // tracks are files under `downloads/<old>` (a car start with no JS, or a resumption).
  if (moves.length > 0) {
    // (Either side of a move: the id it reports may already read through an alias.)
    const loaded = await deps.loadedConnectionId().catch(() => null);
    const involved = new Set(moves.flat());
    if (loaded === UNKNOWN || (loaded && involved.has(loaded))) return aborted('busy');
  }

  // 2. Tokens: copy and verify every one before anything else changes.
  const present = liveIds();
  try {
    for (const [from, to] of moves) {
      if (!present.has(from)) continue; // a plan entry whose connection is gone
      const token = await getSecure(tokenKey(from));
      if (token == null) continue; // no token: the session drops it at hydrate anyway
      await setSecure(tokenKey(to), token);
      if ((await getSecure(tokenKey(to))) !== token) {
        throw new Error('the token copy did not read back');
      }
    }
  } catch (e) {
    return aborted('tokens', e);
  }

  // 3. The plan, so a run cut short from here on finishes with the same moves; then files.
  if (moves.length > 0) {
    try {
      await AsyncStorage.setItem(IDENTITY_PLAN_KEY, JSON.stringify(plan));
    } catch (e) {
      return aborted('plan', e);
    }
  }
  const moved: [string, string][] = [];
  try {
    for (const [from, to] of moves) {
      if (!deps.moveConnection) break;
      await deps.moveConnection(from, to);
      moved.push([from, to]);
    }
  } catch (e) {
    await moveBack(deps, moved);
    return aborted('files', e);
  }

  // 4. Documents: read every one (strictly), rewrite, write the changed ones at once.
  const keys = Object.values(ID_DOCUMENTS);
  let before: Record<string, string | null>;
  try {
    before = await AsyncStorage.getMany([...keys]);
  } catch (e) {
    await moveBack(deps, moved);
    return aborted('documents', e);
  }
  const next: Record<string, string> = {};
  const put = (key: string, value: unknown) => {
    const json = JSON.stringify(value);
    if (json !== before[key]) next[key] = json;
  };
  for (const [name, key] of Object.entries(ID_DOCUMENTS)) {
    const raw = before[key];
    if (raw == null) continue;
    const doc = parse(raw);
    if (doc === null) continue;
    const fn = (rewrite as Record<string, ((p: Plan, d: unknown) => unknown) | undefined>)[name];
    if (fn) put(key, fn(plan, doc));
  }
  const aliases = { ...parseAliases(parse(before[CONNECTION_ALIASES_KEY])), ...plan };
  put(CONNECTION_ALIASES_KEY, aliases);
  const migrated = readConnections(rewrite.connections(plan, connections));
  const existingProfiles = parse(before[PROFILES_KEY]);
  put(
    PROFILES_KEY,
    isObject(existingProfiles)
      ? remapProfiles(plan, existingProfiles)
      : initialProfiles(
          migrated,
          (mapId(plan, parse(before[DEFAULT_KEY])) as string | null) ?? null,
          deps.newProfileId,
        ),
  );
  try {
    if (Object.keys(next).length > 0) await AsyncStorage.setMany(next);
  } catch (e) {
    // Put back what was there (a write that failed part-way: iOS and the web write key by
    // key), then the files, which must stay where the documents say.
    try {
      const restore: Record<string, string> = {};
      const absent: string[] = [];
      for (const key of Object.keys(next)) {
        const raw = before[key];
        if (raw == null) absent.push(key);
        else restore[key] = raw;
      }
      await AsyncStorage.setMany(restore);
      if (absent.length) await AsyncStorage.removeMany(absent);
      await moveBack(deps, moved);
    } catch (restoreError) {
      // The documents are part old, part new: leave the files where they are now. The
      // stored plan finishes the move next launch (every rewrite is idempotent).
      console.warn('[identity] could not put the documents back', restoreError);
    }
    return aborted('documents', e);
  }
  // A fresh car snapshot is built (and written even offline) instead of native keeping the
  // one with the old ids.
  await AsyncStorage.removeItem(CAR_SNAPSHOT_WRITTEN_KEY).catch(() => undefined);
  setConnectionAliases({ ...connectionAliases(), ...aliases });

  // 5. Done. A failed mark only means the next launch re-runs (and changes nothing).
  await AsyncStorage.setItem(IDENTITY_VERSION_KEY, JSON.stringify(IDENTITY_VERSION)).catch(
    () => undefined,
  );

  // 6. The old tokens and the plan.
  await cleanUp(plan, new Set(migrated.map((c) => c.id)));
  return { status: 'migrated', moved: plan };
}
