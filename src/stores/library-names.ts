import { useEffect } from 'react';
import { create } from 'zustand';

import { persistedDocument } from '@/lib/storage';
import { isRecord } from '@/lib/storage-keys';
import { onConnectionRemoved } from '@/stores/session';

/** Each connection's library names by library id (a string: it is a JSON key). */
type Names = Record<string, Record<string, string>>;
type Doc = { names: Names };

function parseDoc(raw: unknown): Partial<Doc> {
  if (!isRecord(raw) || !isRecord(raw.names)) return {};
  const names: Names = {};
  for (const [cid, libs] of Object.entries(raw.names)) {
    if (!isRecord(libs)) continue;
    const kept: Record<string, string> = {};
    for (const [id, name] of Object.entries(libs)) {
      if (typeof name === 'string' && name) kept[id] = name;
    }
    names[cid] = kept;
  }
  return { names };
}

// Device-local and connection-scoped (a removed connection's names are dropped below).
// Only this store reads it, so the key lives here, not in `storage-keys`. Not in
// session.ts's SCOPED_STORAGE_KEYS: a stale name is harmless (the live list wins) and the
// next list read rewrites it. The string is persisted: never change it.
const stored = persistedDocument<Doc>('audiosilo.libraryNames', parseDoc);

type LibraryNamesState = Doc & {
  hydrate: () => Promise<void>;
  /** Keep the names a connection's server just listed (its whole list: a library that is
   * gone loses its name). */
  remember: (connectionId: string, libraries: { id: number; name: string }[]) => Promise<void>;
  forget: (connectionId: string) => Promise<void>;
};

/**
 * The names of the libraries each server last listed, kept on the device (PLAYER-09): a
 * downloaded book opened offline names its library as it did online, not "Library". The
 * live list always wins (`useLibraryName`). Written whenever a library list arrives
 * (`useLibraries`, `useLibrariesAll`); hydrated on first use. A write waits for the
 * hydration, so it never stands in for the other connections' stored names.
 */
export const useLibraryNames = create<LibraryNamesState>()((set, get) => ({
  names: {},
  hydrate: () => stored.hydrate({ names: {} }, (doc) => set(doc)),
  remember: async (connectionId, libraries) => {
    await get().hydrate();
    const next: Record<string, string> = {};
    for (const l of libraries) if (l.name) next[String(l.id)] = l.name;
    const cur = get().names[connectionId];
    if (cur && sameNames(cur, next)) return;
    const names = { ...get().names, [connectionId]: next };
    set({ names });
    stored.write({ names }, { names });
  },
  forget: async (connectionId) => {
    await get().hydrate();
    if (!(connectionId in get().names)) return;
    const { [connectionId]: _gone, ...names } = get().names;
    set({ names });
    stored.write({ names }, { names });
  },
}));

function sameNames(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** Keep a library list's names; never throws (a list read must not fail on it). */
export function rememberLibraryNames(
  connectionId: string,
  libraries: { id: number; name: string }[],
): void {
  if (!Array.isArray(libraries)) return;
  void useLibraryNames
    .getState()
    .remember(connectionId, libraries)
    .catch(() => undefined);
}

/** A library's name as its server last listed it, or undefined when never seen. */
export function useLibraryName(connectionId: string, libraryId: number): string | undefined {
  useEffect(() => {
    void useLibraryNames.getState().hydrate();
  }, []);
  return useLibraryNames((s) => s.names[connectionId]?.[String(libraryId)]);
}

onConnectionRemoved((id) => useLibraryNames.getState().forget(id));
