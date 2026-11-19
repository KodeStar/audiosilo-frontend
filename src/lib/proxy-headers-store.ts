import {
  cleanProxyHeaders,
  type ProxyHeader,
  type ProxyHeaders,
  proxyOriginOf,
} from '@/lib/proxy-headers';
import { deleteSecure, getSecure, setSecure } from '@/lib/secure-store';
import { getItemStrict, removeItem, setItemStrict } from '@/lib/storage';
import { isRecord } from '@/lib/storage-keys';
import { tabLock } from '@/lib/tab-lock';

/**
 * Where proxy headers (fe#167, `proxy-headers.ts`) live: ONE set per https origin, shared by
 * every sign-in on this device that reaches the server there (fe#295), in the same storage
 * as the session tokens (`secure-store`: the keychain or keystore, written readable after the
 * first unlock on iOS so CarPlay can stream on a locked phone; localStorage on the web).
 *
 * One secure-store item, `PROXY_SETS_KEY`, holds them all: `{ "<origin>": { headers } }`.
 * A set is never a copy held by a connection, so it outlives no one's sign-out by accident
 * and a re-pair never brings back a set someone removed: it stays until it is removed or
 * replaced on purpose (the Account page's card, a sign-in that got in with a set typed on
 * the connect screen, or forgetting its remembered server once nobody is signed in through
 * it), whoever signs out. A non-secret marker in AsyncStorage
 * (`PROXY_SETS_MARKER_KEY`) says the item exists, so a device with no set costs no keychain
 * read at launch (a locked-phone CarPlay start included).
 *
 * What this build can't read is left as it is, never deleted: an entry another build wrote
 * (a web bundle rolled back, a later build with stricter rules) stays in the item for it.
 *
 * Earlier builds kept a copy per connection (`proxyHeadersKey`, marked `hasProxyHeaders` on
 * the stored connection): `src/stores/session.ts` moves those into this item at launch.
 */

/** The secure-store item holding every origin's set. */
export const PROXY_SETS_KEY = 'audiosilo.proxy-sets';

/** AsyncStorage: `true` while `PROXY_SETS_KEY` holds something. Not a secret. */
export const PROXY_SETS_MARKER_KEY = 'audiosilo.proxySets';

/** Every write of the item and its marker, one at a time (on the web across the tabs too).
 * Never taken by a job already holding it: `readProxySets` is not called under it. */
const writing = tabLock(PROXY_SETS_KEY);

/** The stored item as written: null when there is none, `damaged` when it is not a JSON
 * object (kept as it is). Rejects when the platform refuses the read (a locked keychain). */
async function readDoc(): Promise<Record<string, unknown> | null | 'damaged'> {
  const raw = await getSecure(PROXY_SETS_KEY);
  if (!raw) return null;
  try {
    const doc: unknown = JSON.parse(raw);
    return isRecord(doc) ? doc : 'damaged';
  } catch {
    return 'damaged';
  }
}

/** The sets in `doc` this build can use (`cleanProxyHeaders`); every other entry is skipped. */
function setsOf(doc: Record<string, unknown>): Record<string, ProxyHeaders> {
  const out: Record<string, ProxyHeaders> = {};
  for (const [origin, entry] of Object.entries(doc)) {
    const headers = isRecord(entry) ? (entry.headers as ProxyHeader[] | undefined) : undefined;
    const set = cleanProxyHeaders(origin, headers);
    if (set && set.origin === origin) out[origin] = set;
  }
  return out;
}

/**
 * Every stored set this build can use, by origin; {} when the marker says there is none (no
 * keychain read). A marker left with no item behind it (a delete cut short) is cleared. A read
 * the platform refuses REJECTS: the session's hydrate must fail as it does for a token, never
 * go on as if there were no headers.
 */
export async function readProxySets(): Promise<Record<string, ProxyHeaders>> {
  if ((await getItemStrict<boolean>(PROXY_SETS_MARKER_KEY)) !== true) return {};
  const doc = await readDoc();
  if (doc === null) {
    // Under the writers' lock and only once the item is still missing: a save writes the
    // marker before the item (`saveProxySets`), and clearing it between the two (another
    // tab's save, a save in this runtime) would leave an item that is never read again.
    await writing(async () => {
      if (!(await getSecure(PROXY_SETS_KEY))) await removeItem(PROXY_SETS_MARKER_KEY);
    });
    return {};
  }
  return doc === 'damaged' ? {} : setsOf(doc);
}

/**
 * Keep each set of `change` as its origin's (by `set.origin` for a set, by the key for a
 * null, which removes that origin's). Entries not named are kept as they are, whether this
 * build can read them or not. A damaged item is replaced (only an explicit change writes).
 * Rejects when the item can't be read or written: nothing is changed then, or (a write the
 * platform refused half way) the marker is left for the next read to clear.
 */
export function saveProxySets(
  change: Readonly<Record<string, ProxyHeaders | null>>,
): Promise<void> {
  return writing(async () => {
    const doc = await readDoc();
    const next: Record<string, unknown> = doc && doc !== 'damaged' ? { ...doc } : {};
    for (const [key, set] of Object.entries(change)) {
      if (set?.headers.length) next[set.origin] = { headers: set.headers };
      else delete next[proxyOriginOf(key) ?? key];
    }
    if (!Object.keys(next).length) {
      await deleteSecure(PROXY_SETS_KEY);
      await removeItem(PROXY_SETS_MARKER_KEY);
      return;
    }
    // The marker first: one left with no item is cleared by the next read, while an item
    // with no marker would never be read.
    await setItemStrict(PROXY_SETS_MARKER_KEY, true);
    await setSecure(PROXY_SETS_KEY, JSON.stringify(next));
  });
}

/** Forget every set (the auth reset, which signs everyone out). Best-effort: a locked
 * keychain must not fail the reset. */
export async function forgetProxySets(): Promise<void> {
  await deleteSecure(PROXY_SETS_KEY).catch(() => undefined);
  await removeItem(PROXY_SETS_MARKER_KEY);
}

// --- The per-connection copies of earlier builds ---------------------------------------

/** The secure-store key of a connection's own set, as earlier builds kept it. */
export const proxyHeadersKey = (connectionId: string) => `audiosilo.proxy-headers.${connectionId}`;

/**
 * A connection's set as an earlier build kept it: the set, `unreadable` (an item this build
 * can't read, kept as it is), or null (none). Rejects when the platform refuses the read.
 */
export async function readLegacyProxyHeaders(
  connectionId: string,
): Promise<ProxyHeaders | 'unreadable' | null> {
  const raw = await getSecure(proxyHeadersKey(connectionId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ProxyHeaders> | null;
    return cleanProxyHeaders(v?.origin, v?.headers as ProxyHeader[] | undefined) ?? 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** Forget a connection's own set of an earlier build. Best-effort: a locked keychain must
 * not fail a sign-out. */
export async function forgetProxyHeaders(connectionId: string): Promise<void> {
  await deleteSecure(proxyHeadersKey(connectionId)).catch(() => undefined);
}

/**
 * Copy a connection's set of an earlier build to the id it moves to (the identity migration,
 * which runs before the session moves those sets into `PROXY_SETS_KEY`), byte for byte as the
 * token is copied, so an item this build can't read moves too: written, read back and
 * compared, and REJECTS when the copy is not there as written (or a read is refused), so the
 * migration stops with the old entry untouched and tries again on the next launch. It writes
 * over an item already under the new id (no live connection has it: a copy left by a run cut
 * short). The old entry is deleted only by the migration's clean-up, after every copy was
 * verified.
 */
export async function copyProxyHeaders(from: string, to: string): Promise<void> {
  const raw = await getSecure(proxyHeadersKey(from));
  if (!raw) {
    await deleteSecure(proxyHeadersKey(to));
    return;
  }
  await setSecure(proxyHeadersKey(to), raw);
  if ((await getSecure(proxyHeadersKey(to))) !== raw) {
    throw new Error('the proxy headers copy did not read back');
  }
}
