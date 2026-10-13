import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMemo } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';

import { isKidAccount, personName } from '@/lib/account';
import { serverIdOf } from '@/lib/connection-id';
import { parseHhMm } from '@/lib/hhmm';
import { initialProfiles } from '@/lib/identity-migration';
import { randomUUID } from '@/lib/random';
import { setItem } from '@/lib/storage';
import { isRecord, PROFILES_KEY } from '@/lib/storage-keys';
import {
  type Connection,
  onConnectionRemoved,
  onConnectionReplaced,
  sessionHydrateFailed,
  useSession,
} from '@/stores/session';

/**
 * Profiles (Phase 8): a profile is a PERSON on this device, a device-local group of
 * connections (signed-in accounts), at most one per server (`serverIdOf`). Each person
 * keeps their own place in every book, queue and stats because each connection is one
 * user on one server; the profile only says which of the device's connections belong to
 * whom, so the screens show one person's servers at a time.
 *
 * Persisted as ONE document, `audiosilo.profiles` (`ProfilesDoc`, exactly the shape the
 * identity migration writes first: `initialProfiles`), hydrated in `bootstrapPlayback()`.
 * A document that is missing on an install with connections (the migration aborted, or
 * an install from before profiles signed in again) is built from the session's
 * connections with the same `initialProfiles` rule.
 *
 * Kept consistent with the session (`reconcileProfiles`, run on every change of the
 * session's connections once the session has settled, and on `onConnectionRemoved`):
 * a removed connection leaves its profile, a profile with no connections is deleted, a
 * connection no profile holds is placed (the active profile when it has no connection to
 * that server, else another profile without one, else a profile of its own), and a
 * profile never holds two connections of one server. A connection the connect flow just
 * added is placed by `placeConnection` instead (the contract's rule: the active profile
 * unless it already has this server, or the flow was "Add someone").
 *
 * Background work keeps using ALL connections (the offline save queue, downloads, car
 * bookmarks, address routing, reachability): a switch must never make another person's
 * saves unroutable. Every list a person SEES uses the active profile's
 * (`useProfileConnections`, `profileConnections`).
 */

/** The library and bedtime of a profile in kids mode (workstream E reads them). */
export type KidsSettings = {
  /** The one library kids mode shows, when the kid's account sees several. */
  library?: { connectionId: string; libraryId: number };
  /** 'HH:MM', 24 h. */
  bedtime: string;
};

export interface Profile {
  /** Local and random (a UUID); never sent anywhere. */
  id: string;
  /** Defaults to the first connection's `user.username` (the reconcile fills an empty
   * one); editable on this device. Read it through `profileName`. */
  name: string;
  /** At most one per server (`serverIdOf`). */
  connectionIds: string[];
  kids?: KidsSettings;
  /** Mirrors whether a PIN is set; the hash itself is in the secure store
   * (`audiosilo.profilePin.<id>`, `src/lib/profile-pin.ts`). */
  hasPin?: boolean;
}

export interface ProfilesDoc {
  version: 1;
  profiles: Profile[];
  activeProfileId: string | null;
  /** Show "Who's listening?" when the app opens (with 2+ profiles). Turned on when a
   * second profile is created. */
  askAtLaunch: boolean;
}

/** The kids mode bedtime a profile starts with. */
export const DEFAULT_BEDTIME = '19:30';

const EMPTY_DOC: ProfilesDoc = {
  version: 1,
  profiles: [],
  activeProfileId: null,
  askAtLaunch: false,
};

// --- Parsing ------------------------------------------------------------------------------

function parseKids(raw: unknown): KidsSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const bedtime =
    typeof raw.bedtime === 'string' && parseHhMm(raw.bedtime) !== null
      ? raw.bedtime
      : DEFAULT_BEDTIME;
  const lib = raw.library;
  const library =
    isRecord(lib) &&
    typeof lib.connectionId === 'string' &&
    lib.connectionId &&
    typeof lib.libraryId === 'number' &&
    Number.isSafeInteger(lib.libraryId) &&
    lib.libraryId > 0
      ? { connectionId: lib.connectionId, libraryId: lib.libraryId }
      : undefined;
  return library ? { library, bedtime } : { bedtime };
}

function parseProfile(raw: unknown): Profile | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const ids = Array.isArray(raw.connectionIds)
    ? [...new Set(raw.connectionIds.filter((x): x is string => typeof x === 'string' && !!x))]
    : [];
  const kids = parseKids(raw.kids);
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    connectionIds: ids,
    ...(kids ? { kids } : {}),
    ...(raw.hasPin === true ? { hasPin: true } : {}),
  };
}

/** A stored document, validated: anything unreadable is an empty document (rebuilt from
 * the session by `reconcileProfiles`). */
export function parseProfilesDoc(raw: unknown): ProfilesDoc {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.profiles)) return EMPTY_DOC;
  const seen = new Set<string>();
  const profiles: Profile[] = [];
  for (const p of raw.profiles.map(parseProfile)) {
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    profiles.push(p);
  }
  const active = typeof raw.activeProfileId === 'string' ? raw.activeProfileId : null;
  return {
    version: 1,
    profiles,
    // Nobody (or someone who is not on the device any more) is never read as the first
    // person: that person may have a PIN, and nobody gave it (`mustChoose`).
    activeProfileId: active && seen.has(active) ? active : null,
    askAtLaunch: raw.askAtLaunch === true,
  };
}

// --- The rules (pure) ---------------------------------------------------------------------

/** What the rules need of a connection. */
export type ProfileConnection = Pick<Connection, 'id' | 'serverId' | 'user'>;

function sameDoc(a: ProfilesDoc, b: ProfilesDoc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A new profile for one connection, named after its user. */
function newProfileFor(c: ProfileConnection, newId: () => string): Profile {
  return { id: newId(), name: personName(c.user), connectionIds: [c.id] };
}

/** Whether `p` holds a connection to `server` (other than `exceptId`). */
function holdsServer(
  p: Profile,
  server: string,
  byId: ReadonlyMap<string, ProfileConnection>,
  exceptId?: string,
): boolean {
  return p.connectionIds.some((id) => {
    if (id === exceptId) return false;
    const c = byId.get(id);
    return !!c && serverIdOf(c) === server;
  });
}

/**
 * The document made consistent with the session's `connections` (only call it with a
 * SETTLED list: never while the session is loading or its hydrate failed, when the list
 * is empty without meaning it). Returns `doc` itself when nothing changes.
 *
 * 1. Ids the session no longer has leave their profiles.
 * 2. A profile keeps one connection per server (a later one is unplaced).
 * 3. Profiles with no connections are deleted.
 * 4. Unplaced connections: with no profiles at all, the identity migration's
 *    `initialProfiles` (one profile, one per server); else the active profile when it has
 *    no connection to that server, else the first profile without one, else a profile of
 *    their own (not made active: nobody chose to switch).
 * 5. The active profile is still there. When it is gone and others are left, NOBODY is
 *    active (`mustChoose`): the next person may have a PIN, so they are chosen on "Who's
 *    listening?", never assumed. Only a document built from nothing (no profiles before)
 *    starts with someone: the default connection's profile, else the first.
 * 6. Every profile has a name (trimmed): its own, else its first connection's name
 *    (`personName`: a household member's display name, else the username) in
 *    the session's order (a profile made before the username was known gets it once the
 *    session has it), so screens read `profile.name` (`profileName`) and never the raw
 *    connections for it.
 */
export function reconcileProfiles(
  doc: ProfilesDoc,
  connections: readonly ProfileConnection[],
  defaultId: string | null,
  newId: () => string = randomUUID,
): ProfilesDoc {
  const byId = new Map(connections.map((c) => [c.id, c]));
  const placed = new Set<string>();
  let profiles: Profile[] = doc.profiles.map((p) => {
    const keep: string[] = [];
    const servers = new Set<string>();
    for (const id of p.connectionIds) {
      const c = byId.get(id);
      if (!c || placed.has(id)) continue;
      const server = serverIdOf(c);
      if (servers.has(server)) continue;
      servers.add(server);
      placed.add(id);
      keep.push(id);
    }
    return keep.length === p.connectionIds.length &&
      keep.every((id, i) => id === p.connectionIds[i])
      ? p
      : { ...p, connectionIds: keep };
  });
  profiles = profiles.filter((p) => p.connectionIds.length > 0);

  const unplaced = connections.filter((c) => !placed.has(c.id));
  let activeProfileId = doc.activeProfileId;
  if (unplaced.length > 0) {
    if (profiles.length === 0) {
      const built = initialProfiles(unplaced, defaultId, newId);
      profiles = built.profiles;
      activeProfileId = built.activeProfileId;
    } else {
      for (const c of unplaced) {
        const server = serverIdOf(c);
        const fits = (p: Profile) => !holdsServer(p, server, byId);
        const active = profiles.find((p) => p.id === activeProfileId);
        const home = active && fits(active) ? active : profiles.find(fits);
        profiles = home
          ? profiles.map((p) =>
              p === home ? { ...p, connectionIds: [...p.connectionIds, c.id] } : p,
            )
          : [...profiles, newProfileFor(c, newId)];
      }
    }
  }

  if (!profiles.some((p) => p.id === activeProfileId)) {
    activeProfileId =
      doc.profiles.length === 0
        ? (profiles.find((p) => defaultId !== null && p.connectionIds.includes(defaultId))?.id ??
          profiles[0]?.id ??
          null)
        : null;
  }
  profiles = profiles.map((p) => {
    const name =
      p.name.trim() || personName(connections.find((c) => p.connectionIds.includes(c.id))?.user);
    return name === p.name ? p : { ...p, name };
  });
  const next: ProfilesDoc = { ...doc, profiles, activeProfileId };
  return sameDoc(next, doc) ? doc : next;
}

/** How `placeInDoc` places a connection. */
export type PlaceOptions = {
  /** A profile of its own ("Add someone", a household member signed in here). */
  newProfile?: boolean;
  /** The new profile does NOT become active: the person listening stays (a household
   * member signed in on the owner's device, `addMemberHere`). */
  keepActive?: boolean;
  /** The new profile's name (trimmed; empty: the user's `personName`). */
  name?: string;
};

/**
 * Where a connection the connect flow just signed in goes (the contract's rule): into the
 * active profile, unless that profile already has a connection to this server (another
 * user: another person), or the flow was "Add someone" (`newProfile`); then into a new
 * profile, which becomes active unless `keepActive` (the active person then stays, or
 * nobody when the active person was only this connection). A connection already in a
 * profile is taken out of it first (the reconcile may have placed it a moment earlier).
 * Returns the document and the profile now holding the connection.
 */
export function placeInDoc(
  doc: ProfilesDoc,
  conn: ProfileConnection,
  connections: readonly ProfileConnection[],
  opts: PlaceOptions,
  newId: () => string = randomUUID,
): { doc: ProfilesDoc; profileId: string } {
  const byId = new Map(connections.map((c) => [c.id, c]));
  byId.set(conn.id, conn);
  const current = doc.profiles.find((p) => p.connectionIds.includes(conn.id));
  // Already in the active person (the reconcile put it there): where the rule puts it too.
  if (!opts.newProfile && current && current.id === doc.activeProfileId) {
    return { doc, profileId: current.id };
  }
  const without = withoutConnection(doc.profiles, conn.id);
  const active = without.find((p) => p.id === doc.activeProfileId);
  if (!opts.newProfile && active && !holdsServer(active, serverIdOf(conn), byId)) {
    return {
      doc: {
        ...doc,
        profiles: without.map((p) =>
          p === active ? { ...p, connectionIds: [...p.connectionIds, conn.id] } : p,
        ),
      },
      profileId: active.id,
    };
  }
  const made = newProfileFor(conn, newId);
  const created = opts.name?.trim() ? { ...made, name: opts.name.trim() } : made;
  const profiles = [...without, created];
  return {
    doc: opts.keepActive
      ? withProfiles(doc, profiles)
      : { ...doc, profiles, activeProfileId: created.id },
    profileId: created.id,
  };
}

/** `profiles` with `connectionId` taken out of the one holding it; a profile left with no
 * connection is dropped. */
function withoutConnection(profiles: readonly Profile[], connectionId: string): Profile[] {
  return profiles
    .map((p) =>
      p.connectionIds.includes(connectionId)
        ? { ...p, connectionIds: p.connectionIds.filter((id) => id !== connectionId) }
        : p,
    )
    .filter((p) => p.connectionIds.length > 0);
}

/**
 * `doc` with `newId` in the place of `oldId` (a sign-in to a server that was reset retired
 * the person's dead identity, `retire` on the session's `setSession`): the profile that held
 * the old id holds the new one, at the same place, and a kids library picked on the old one
 * names the new one (the library may not exist there any more: kids mode then shows the
 * first, `kidsLibrary`). The profile's id, name, PIN and kids settings stay. `doc` itself
 * when no profile holds `oldId`.
 */
export function replaceInDoc(doc: ProfilesDoc, oldId: string, newId: string): ProfilesDoc {
  const holder = doc.profiles.find((p) => p.connectionIds.includes(oldId));
  if (!holder) return doc;
  const profiles = doc.profiles.map((p) => {
    // The new id leaves any profile the reconcile may already have put it in.
    const ids = p.connectionIds.filter((id) => id !== newId);
    if (p !== holder)
      return ids.length === p.connectionIds.length ? p : { ...p, connectionIds: ids };
    const kids =
      p.kids?.library?.connectionId === oldId
        ? { ...p.kids, library: { ...p.kids.library, connectionId: newId } }
        : p.kids;
    return {
      ...p,
      connectionIds: ids.map((id) => (id === oldId ? newId : id)),
      ...(kids ? { kids } : {}),
    };
  });
  return { ...doc, profiles: profiles.filter((p) => p.connectionIds.length > 0) };
}

/**
 * Which stale identities (`staleIds`, the session's `staleIdentities` for a sign-in: the
 * same address under another `server_id`, a server that was reset) a sign-in may retire:
 * only those of the person signing in, the profile holding `reconnectId` (the reconnect
 * banner's connection) or, without one, the person listening. "Add someone" retires
 * nobody's (a new person owns none of them). Another person's stay on the device, flagged,
 * for them to sign in again: retiring them would delete that person (profile, PIN, kids
 * settings). With nobody on the device every one goes (there is no one else); while the
 * profiles are unread (not hydrated, or the read failed) none does (whose they are is not
 * known).
 */
export function staleToRetire(
  staleIds: readonly string[],
  state: Pick<ProfilesState, 'profiles' | 'activeProfileId' | 'hydrated' | 'hydrationFailed'>,
  opts: { reconnectId?: string; newPerson?: boolean } = {},
): string[] {
  if (!state.hydrated || state.hydrationFailed || opts.newPerson) return [];
  if (state.profiles.length === 0) return [...staleIds];
  const owner = opts.reconnectId ? profileOf(opts.reconnectId, state) : activeProfile(state);
  return owner ? staleIds.filter((id) => owner.connectionIds.includes(id)) : [];
}

/** `doc` with `profiles`: the active person stays when still among them, else nobody is
 * active until someone is chosen (`mustChoose`). */
function withProfiles(doc: ProfilesDoc, profiles: Profile[]): ProfilesDoc {
  const kept = profiles.some((p) => p.id === doc.activeProfileId);
  return { ...doc, profiles, activeProfileId: kept ? doc.activeProfileId : null };
}

/** A second person appeared on a device that had one (the reconcile placed a connection
 * of its own, or the connect flow added someone): ask who's listening at launch from now
 * on. The one place the rule lives (`commit`). */
export function askOnSecondPerson(prev: ProfilesDoc, next: ProfilesDoc): ProfilesDoc {
  const second = prev.profiles.length === 1 && next.profiles.length >= 2;
  return second && !next.askAtLaunch ? { ...next, askAtLaunch: true } : next;
}

/** The connections of `ids` (a profile's), in the session's order; every connection when
 * there is no profile (`ids` null: not hydrated yet, or nobody is signed in). Pass
 * `visibleConnectionIds(doc)`, which is empty (not null) while nobody is chosen. */
export function connectionsOfProfile<C extends { id: string }>(
  connections: readonly C[],
  ids: readonly string[] | null | undefined,
): C[] {
  if (!ids) return [...connections];
  return connections.filter((c) => ids.includes(c.id));
}

/** No connections: what a person sees while nobody is chosen (one array, so a selector
 * returning it doesn't re-render). */
const NO_IDS: readonly string[] = Object.freeze([]);

/**
 * Whether someone must be chosen on "Who's listening?" before the app is anyone's: there
 * are people on this device and none of them is active (the active person left: signed
 * out of their last server, or removed). Persisted (it IS `activeProfileId: null`), so a
 * reload or a cold start asks again, and nothing of anyone shows meanwhile: the auth gate
 * holds the shell, every person-facing list is empty (`visibleConnectionIds`), the car
 * lists nothing, the widget clears and a link to anyone's book meets `OtherPersonGate`.
 */
export function mustChoose(doc: Pick<ProfilesDoc, 'profiles' | 'activeProfileId'>): boolean {
  return doc.profiles.length > 0 && !doc.profiles.some((p) => p.id === doc.activeProfileId);
}

/** The ids of the connections a person may see: the active profile's; none while someone
 * must be chosen (`mustChoose`); null (every connection) with no profiles at all (not
 * hydrated yet, or the device has nobody, as before profiles). */
export function visibleConnectionIds(
  doc: Pick<ProfilesDoc, 'profiles' | 'activeProfileId'> & {
    hydrationFailed?: boolean;
    unread?: boolean;
  },
): readonly string[] | null {
  if (doc.hydrationFailed) return NO_IDS;
  const active = doc.profiles.find((p) => p.id === doc.activeProfileId);
  if (active) return active.connectionIds;
  // The stored document was never read (`unread`): people may be on this device that this
  // run does not know, so "no profiles" never means "everyone's".
  return doc.profiles.length > 0 || doc.unread ? NO_IDS : null;
}

// --- The store ------------------------------------------------------------------------------

type ProfilesState = ProfilesDoc & {
  /** The stored document has been read (and reconciled once the session settles), or the
   * store gave up on it with nobody signed in (`unread`). */
  hydrated: boolean;
  /** The stored document can't be read (yet): nothing of anyone shows or plays. */
  hydrationFailed: boolean;
  /** The stored document could not be read and nobody was signed in this run (web with
   * site data blocked): the store runs in memory, for the people who sign in now only. It
   * never writes the document (it never read it), never places a connection it did not
   * see signed in (`placeConnection`), and a connection no profile holds is nobody's to
   * see or play (another person's, maybe, with a PIN this run can't check). */
  unread?: boolean;
  hydrate: () => Promise<void>;
};

export const useProfiles = create<ProfilesState>()(() => ({
  ...EMPTY_DOC,
  hydrated: false,
  hydrationFailed: false,
  unread: false,
  hydrate: () => hydrateProfiles(),
}));

/** How many times a read of the document that throws is tried (`HYDRATE_RETRY_MS` apart)
 * before the store stops waiting on it (`giveUpOnRead`). The launch steps wait on the
 * hydrate, so it must end: a read that never works (web storage blocked) held the app on
 * its first screen forever. */
export const HYDRATE_ATTEMPTS = 5;
export const HYDRATE_RETRY_MS = 1000;

let hydration: Promise<void> | null = null;
let unsubscribeSession: (() => void) | null = null;

const docOf = (s: ProfilesDoc): ProfilesDoc => ({
  version: 1,
  profiles: s.profiles,
  activeProfileId: s.activeProfileId,
  askAtLaunch: s.askAtLaunch,
});

/** Set and persist a new document (only once hydrated: before that the stored one isn't
 * known, and a write would replace it), asking at launch once a second person appears
 * (`askOnSecondPerson`). */
function commit(change: ProfilesDoc): void {
  const state = useProfiles.getState();
  if (!state.hydrated) return;
  const prev = docOf(state);
  const next = docOf(askOnSecondPerson(prev, change));
  if (sameDoc(next, prev)) return;
  useProfiles.setState(next);
  // A document never read is never written over (`unread`).
  if (!state.unread) void setItem(PROFILES_KEY, next);
}

/** Whether the session's connection list means what it says (loaded, not a failed read). */
function sessionSettled(): boolean {
  return useSession.getState().status !== 'loading' && !sessionHydrateFailed();
}

/** Bring the document in line with the session's connections, once both are loaded. */
function reconcileNow(): void {
  const state = useProfiles.getState();
  if (!state.hydrated || !sessionSettled()) return;
  const { connections, defaultConnectionId } = useSession.getState();
  // Unread: only the connections already placed (signed in this run, `placeConnection`)
  // take part; any other is left in no profile, so nobody sees or plays it.
  const known = state.unread ? connections.filter((c) => profileOf(c.id, state)) : connections;
  commit(reconcileProfiles(docOf(state), known, defaultConnectionId));
  void alignDefaultConnection();
}

/** A removed connection leaves its profile at once (the session's own change already
 * reconciles; this also covers a removal while the list counts as unsettled). */
function onRemoved(id: string): void {
  const s = useProfiles.getState();
  if (!s.hydrated || !profileOf(id, s)) return;
  commit(withProfiles(docOf(s), withoutConnection(s.profiles, id)));
}

/** A sign-in replaced the person's stale identity (`replaceInDoc`): run by the session just
 * before its list changes, so the reconcile that follows finds the new id placed. */
function onReplaced(oldId: string, newId: string): void {
  const s = useProfiles.getState();
  if (!s.hydrated) return;
  commit(replaceInDoc(docOf(s), oldId, newId));
}

/** Keep the document consistent with the session from now on (once: nothing to keep
 * consistent before the store has a document). */
function followSession(): void {
  if (unsubscribeSession) return;
  const unsubChanges = useSession.subscribe((s, prev) => {
    if (s.connections !== prev.connections || s.status !== prev.status) reconcileNow();
  });
  const unsubRemoved = onConnectionRemoved(onRemoved);
  const unsubReplaced = onConnectionReplaced(onReplaced);
  unsubscribeSession = () => {
    unsubChanges();
    unsubRemoved();
    unsubReplaced();
  };
}

/** Take the stored document that was read (`raw`; null when there is none). A document
 * that reads but does not parse cannot get better by waiting, so it counts as missing. */
function adopt(raw: string | null): void {
  stopRetrying();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // corrupt: as missing
  }
  const doc = parseProfilesDoc(parsed);
  useProfiles.setState({ ...doc, hydrated: true, hydrationFailed: false, unread: false });
  followSession();
  reconcileNow();
}

/** Asks for the document again when the app comes back to the front, while it can't be
 * read and someone is signed in (`giveUpOnRead`). */
let retryWhenActive: NativeEventSubscription | null = null;
/** Waits for the session to settle before deciding how to give up. */
let awaitSession: (() => void) | null = null;

function stopRetrying(): void {
  retryWhenActive?.remove();
  retryWhenActive = null;
  awaitSession?.();
  awaitSession = null;
}

/**
 * The document could not be read `HYDRATE_ATTEMPTS` times: stop holding the launch steps,
 * and never bypass a PIN. Decided once the session has settled:
 * - Someone is signed in (their connections loaded): they may have a PIN or a kids profile
 *   this run can't know, so the store stays failed (`hydrationFailed`: nothing of anyone
 *   shows or plays, nobody new signs in) and reads again whenever the app comes to the
 *   front.
 * - Nobody is (web with site data blocked: the session could not read its list either):
 *   there is nobody to protect from this run, so the store runs `unread`, in memory, and
 *   whoever signs in now gets a profile of their own.
 */
function giveUpOnRead(): void {
  const decide = (): boolean => {
    const session = useSession.getState();
    if (session.status === 'loading') return false;
    if (session.connections.length > 0) {
      retryWhenActive ??= AppState.addEventListener('change', (next) => {
        if (next !== 'active') return;
        AsyncStorage.getItem(PROFILES_KEY).then(adopt, () => undefined);
      });
      return true;
    }
    useProfiles.setState({ ...EMPTY_DOC, hydrated: true, hydrationFailed: false, unread: true });
    followSession();
    reconcileNow();
    return true;
  };
  if (decide()) return;
  awaitSession = useSession.subscribe(() => {
    if (!decide()) return;
    awaitSession?.();
    awaitSession = null;
  });
}

function hydrateProfiles(): Promise<void> {
  hydration ??= (async () => {
    // A read that fails is retried, never taken as a missing document: reconciling an empty
    // one would replace every profile (new ids, no PIN, no kids settings). After
    // `HYDRATE_ATTEMPTS` the store stops waiting (`giveUpOnRead`), safely.
    for (let attempt = 1; ; attempt++) {
      let raw: string | null;
      try {
        raw = await AsyncStorage.getItem(PROFILES_KEY);
      } catch {
        useProfiles.setState({ hydrationFailed: true });
        if (attempt >= HYDRATE_ATTEMPTS) break;
        await new Promise<void>((resolve) => setTimeout(resolve, HYDRATE_RETRY_MS));
        continue;
      }
      adopt(raw);
      return;
    }
    giveUpOnRead();
  })();
  return hydration;
}

// --- Reads ----------------------------------------------------------------------------------

type ProfilesRead = Pick<ProfilesDoc, 'profiles' | 'activeProfileId'> & {
  hydrationFailed?: boolean;
  unread?: boolean;
};

/** The active profile (null with no profiles). Framework-free. */
export function activeProfile(state: ProfilesRead = useProfiles.getState()): Profile | null {
  return state.profiles.find((p) => p.id === state.activeProfileId) ?? null;
}

/** The profile holding `connectionId`, if any. */
export function profileOf(
  connectionId: string,
  state: Pick<ProfilesDoc, 'profiles'> = useProfiles.getState(),
): Profile | null {
  return state.profiles.find((p) => p.connectionIds.includes(connectionId)) ?? null;
}

/** The person a content link's connection belongs to when that is not the active person
 * (the link must switch first), else null (the active person's, or no profile yet). */
export function otherOwner(doc: ProfilesRead, connectionId: string): Profile | null {
  const owner = connectionId ? profileOf(connectionId, doc) : null;
  return owner && owner.id !== doc.activeProfileId ? owner : null;
}

/**
 * Whether a book of `connectionId` may play for the person listening on this device: never
 * while nobody is chosen (`mustChoose`), never another person's (`otherOwner`: playing it
 * would save to their account without their PIN). A connection no profile holds is not
 * refused (no profiles at all, or a session not read yet: a CarPlay launch with the phone
 * locked still plays its downloads, as before profiles). The ONE rule: the playback store
 * enforces it at every start (`playBook`, `startBookInPlace`, `adoptLoaded`: the player
 * route, the car, a Cast session resumed with a receiver's book), and screens only offer
 * the switch (`OtherPersonGate`).
 */
export function mayActFor(
  connectionId: string,
  doc: ProfilesRead = useProfiles.getState(),
): boolean {
  if (doc.hydrationFailed) return false;
  // Unread: only the people who signed in this run, and only their own connections.
  if (doc.unread) return activeProfile(doc)?.connectionIds.includes(connectionId) ?? false;
  return !mustChoose(doc) && otherOwner(doc, connectionId) === null;
}

/** The active profile's connections, in the session's order (every connection while
 * there is no profile, none while someone must be chosen). Framework-free: the car
 * snapshot, the widget. */
export function profileConnections(): Connection[] {
  return connectionsOfProfile(
    useSession.getState().connections,
    visibleConnectionIds(useProfiles.getState()),
  );
}

/** The ids of `profileConnections()`. */
export function profileConnectionIds(): string[] {
  return profileConnections().map((c) => c.id);
}

/** Whether someone must be chosen before the app is anyone's (`mustChoose`). */
export function useMustChoose(): boolean {
  return useProfiles(mustChoose);
}

/** The active profile, or null. */
export function useActiveProfile(): Profile | null {
  return useProfiles(activeProfile);
}

/** The active profile's connections, in the session's order: every user-facing list of
 * connections reads this (never `useSession((s) => s.connections)`). The same array while
 * neither changes. */
export function useProfileConnections(): Connection[] {
  const connections = useSession((s) => s.connections);
  const ids = useProfiles(visibleConnectionIds);
  return useMemo(() => connectionsOfProfile(connections, ids), [connections, ids]);
}

// --- Changes --------------------------------------------------------------------------------

function updateProfile(profileId: string, change: (p: Profile) => Profile): void {
  const s = useProfiles.getState();
  if (!s.profiles.some((p) => p.id === profileId)) return;
  commit({
    ...docOf(s),
    profiles: s.profiles.map((p) => (p.id === profileId ? change(p) : p)),
  });
}

/**
 * Whether every connection of `profile` is a kid's account (the server says so:
 * `user.member_kind === 'kid'`, a household member, Phase 8b-1). False for a profile with
 * no connection the session knows, and on a server without household members.
 */
export function isKidsAccount(
  profile: Pick<Profile, 'connectionIds'>,
  connections: readonly ProfileConnection[],
): boolean {
  const own = connections.filter((c) => profile.connectionIds.includes(c.id));
  return own.length > 0 && own.every((c) => isKidAccount(c.user));
}

/**
 * Whether kids mode may be turned on for `profileId`: only while another profile on the
 * device stays a grown-up (not in kids mode). Leaving kids mode is a grown-up's (the
 * Grown-ups hold opens "Who's listening?", and only a grown-up's Settings turn it off), so
 * a device whose every profile is a kids profile would have no way out but "Add someone"
 * (`mayAddPerson` keeps that open for exactly this case). The one exception: a profile
 * whose accounts the server says are a kid's (`isKidsAccount`) may be in kids mode with no
 * grown-up on the device (a kid's own phone, paired from their owner's QR): the server
 * already limits that account, and it has no grown-up to leave kids mode for. True for a
 * profile already in kids mode (a change of its library or bedtime).
 */
export function mayTurnOnKids(
  profileId: string,
  state: Pick<ProfilesDoc, 'profiles'> = useProfiles.getState(),
  connections: readonly ProfileConnection[] = useSession.getState().connections,
): boolean {
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) return false;
  if (profile.kids) return true;
  if (isKidsAccount(profile, connections)) return true;
  return state.profiles.some((p) => p.id !== profileId && !p.kids);
}

/** Turn kids mode on (with its library and bedtime) or off (`undefined`). A bedtime that
 * isn't 'HH:MM' is the default. Turning it on is refused (nothing changes) when it would
 * leave no grown-up on the device (`mayTurnOnKids`). */
export function setProfileKids(profileId: string, kids: KidsSettings | undefined): void {
  if (kids && !mayTurnOnKids(profileId)) return;
  updateProfile(profileId, (p) => {
    const { kids: _old, ...rest } = p;
    if (!kids) return rest;
    const parsed = parseKids(kids) ?? { bedtime: DEFAULT_BEDTIME };
    return { ...rest, kids: parsed };
  });
}

/** Rename a profile on this device (trimmed; an empty name is ignored). */
export function renameProfile(profileId: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  updateProfile(profileId, (p) => ({ ...p, name: trimmed }));
}

/** Mirror whether the profile has a PIN (`src/lib/profile-pin.ts` keeps the hash). */
export function setProfileHasPin(profileId: string, hasPin: boolean): void {
  updateProfile(profileId, (p) => {
    const { hasPin: _old, ...rest } = p;
    return hasPin ? { ...rest, hasPin: true } : rest;
  });
}

/** "Ask who's listening when the app opens". */
export function setAskAtLaunch(ask: boolean): void {
  const s = useProfiles.getState();
  commit({ ...docOf(s), askAtLaunch: ask });
}

/** Delete a profile from this device (its connections are signed out first by the
 * caller; a profile left with connections would be rebuilt by the reconcile). */
export function deleteProfile(profileId: string): void {
  const s = useProfiles.getState();
  const profiles = s.profiles.filter((p) => p.id !== profileId);
  if (profiles.length === s.profiles.length) return;
  commit(withProfiles(docOf(s), profiles));
}

/**
 * Place a connection the connect flow just signed in (`placeInDoc`). Returns the id of
 * the profile holding it, or null before hydration or for an unknown connection.
 */
export function placeConnection(connectionId: string, opts: PlaceOptions = {}): string | null {
  const s = useProfiles.getState();
  const { connections } = useSession.getState();
  const conn = connections.find((c) => c.id === connectionId);
  if (!s.hydrated || !conn) return null;
  const { doc, profileId } = placeInDoc(docOf(s), conn, connections, opts);
  commit(doc);
  return profileId;
}

/**
 * Switch to another person on this device (the caller has asked for their PIN, and
 * navigates Home: `src/components/profiles/use-choose-profile.ts`):
 *
 * - The playing book, when it belongs to a connection outside the new profile, is
 *   paused, its place saved (the store's own persist) and unloaded (`stop`), so the next
 *   person finds no mini player with someone else's book.
 * - The session's default connection becomes the new profile's first (in session order)
 *   unless the default is already one of theirs: the chrome's fallback scope (`useCid`).
 * - The car snapshot rebuilds and the widget clears: both follow `activeProfileId`
 *   (`car-controller.ts`, `widget-sync.ios.ts`).
 *
 * Nothing about another person's state is touched: their downloads, queued saves and
 * car bookmarks keep going through ALL connections.
 */
export async function switchProfile(profileId: string): Promise<void> {
  const s = useProfiles.getState();
  const target = s.profiles.find((p) => p.id === profileId);
  if (!target) return;
  commit({ ...docOf(s), activeProfileId: profileId });
  // Required on use: the player store imports most of the app (and, through the API
  // provider, this module), so a static import would be a cycle at load.
  const { usePlayer } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: see above
    require('@/playback/store') as typeof import('@/playback/store');
  const playing = usePlayer.getState().nowPlaying;
  if (playing && !target.connectionIds.includes(playing.connectionId)) {
    await usePlayer.getState().stop();
  }
  await alignDefaultConnection();
}

/** The session's default connection follows the active profile: its first connection
 * when the default is someone else's (a switch, a removal that left the default on
 * another person's server). */
async function alignDefaultConnection(): Promise<void> {
  const profile = activeProfile();
  if (!profile) return;
  const { connections, defaultConnectionId, setDefaultConnection } = useSession.getState();
  if (defaultConnectionId && profile.connectionIds.includes(defaultConnectionId)) return;
  const first = connectionsOfProfile(connections, profile.connectionIds)[0];
  if (first) await setDefaultConnection(first.id);
}

/** Tests only: forget the hydration and the store's state. */
export function resetProfilesForTests(): void {
  hydration = null;
  unsubscribeSession?.();
  unsubscribeSession = null;
  stopRetrying();
  useProfiles.setState({ ...EMPTY_DOC, hydrated: false, hydrationFailed: false, unread: false });
}
