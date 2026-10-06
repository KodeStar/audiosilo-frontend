import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Cross-platform JSON key/value storage (AsyncStorage on native, localStorage on
 * web). For secrets (the session token) use `src/lib/secure-store` instead.
 */
export async function getItem<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function setItem(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort; ignore write failures
  }
}

export async function removeItem(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** One persisted JSON document of a store (see `persistedDocument`). */
export type PersistedDocument<T extends object> = {
  /** Read the stored document and hand the store what it should now hold to `apply`:
   * `base`, then the stored values, then every change made before this call. When
   * there were such changes the merged document is written once. `apply` runs before
   * the document counts as hydrated, so no write can ever land between the two. Only
   * the first call reads (at boot, or lazily on first use); later calls return the
   * same promise. */
  hydrate: (base: T, apply: (doc: T) => void) => Promise<void>;
  /** Record a change. After `hydrate`, `doc` (the whole document, change included) is
   * written. Before it, the change is only remembered for `hydrate` to lay over the
   * stored values - writing then would persist a document missing them. */
  write: (change: Partial<T>, doc: T) => void;
};

/**
 * The ONE hydration rule for a store persisted as a single JSON document under `key`:
 * a change made before hydration finishes (a fast tap on a cold start) wins over the
 * stored value, since it is the newer statement of what the user wants, and it never
 * clobbers the stored values it did not touch. `parse` validates whatever is stored,
 * so a corrupt or foreign value can never reach the store.
 */
export function persistedDocument<T extends object>(
  key: string,
  parse: (raw: unknown) => Partial<T>,
): PersistedDocument<T> {
  let hydrated = false;
  let hydration: Promise<void> | null = null;
  let early: Partial<T> = {};
  const read = async (base: T, apply: (doc: T) => void) => {
    const doc = { ...base, ...parse(await getItem<unknown>(key)), ...early };
    const pending = Object.keys(early).length > 0;
    apply(doc);
    early = {};
    hydrated = true;
    if (pending) void setItem(key, doc);
  };
  return {
    hydrate: (base, apply) => (hydration ??= read(base, apply)),
    write: (change, doc) => {
      if (hydrated) void setItem(key, doc);
      else early = { ...early, ...change };
    },
  };
}
