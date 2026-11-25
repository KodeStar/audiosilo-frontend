import type { QueryClient } from '@tanstack/react-query';

import type { ApiConnection } from '@/api/provider';
import {
  librariesQuery,
  serverInfoQuery,
  startupRead,
  startupReads,
  type StartupPage,
  type StartupRead,
} from '@/api/startup-reads';
import type { Library, ServerInfo } from '@/api/types';
import { parseLibraryMode } from '@/components/library/library-modes';
import { isPodcastLibrary } from '@/lib/library-kind';
import type { LibrarySelection } from '@/stores/library-selection';
import { profileConnections } from '@/stores/profiles';

/**
 * Web: the first screen's answers asked for before it mounts, on a start with none kept
 * (a first visit, a private window: the startup cache, `startup-cache.ts`, keeps them for
 * the next reload). Without it the screen renders twice, its skeleton (whose queries ask)
 * and then again with the answers, so its covers wait on both renders; with it the gate
 * (`AuthGate`) holds its spinner the few milliseconds the answers take and the screen
 * renders once, with them. At most `STARTUP_WAIT_MS`: a slow server gets the skeleton.
 *
 * Once per page load, for the page it opens on (Home, the Library grid; any other page
 * asks only what the shell reads). Only the entries the cache doesn't hold yet are asked,
 * so a reload the startup cache filled waits for nothing. Every entry is the one its screen
 * reads (the same query specs), so the screen finds it fresh and asks nothing again.
 * Native never waits (`use-startup-queries.ts`): its start is not a page load.
 */

/** The longest the first screen waits for its answers. */
export const STARTUP_WAIT_MS = 200;

/** One answer the first screen reads: its cache key, and how to ask for it. */
export type StartupQuery = Omit<StartupRead, 'meta'> & {
  enabled?: (client: QueryClient) => boolean;
};

/** The page a load opens on, as far as its first answers go. */
export type StartPage = 'home' | 'library' | 'other';

/** Which first page a load opens on: its route `pathname` (without the base path) and the
 * Library's `mode` param. */
export function startPage(pathname: string, mode?: string | null): StartPage {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 'home';
  if (path === '/library' && parseLibraryMode(mode ?? undefined) === 'books') return 'library';
  return 'other';
}

/** A dependent read joins the shell's in-flight read. It can start while the gate is
 * waiting, provided the connection is still visible and the answer allows it. `allows`
 * runs in the gate's render on whatever the cache holds (a restored answer included), so
 * it never assumes the answer's shape. */
function afterAnswer<T>(
  read: StartupRead,
  dependency: StartupRead,
  allows: (data: T) => boolean,
  current: () => boolean,
): StartupQuery {
  const permitted = (qc: QueryClient) => {
    const data = qc.getQueryData<T>(dependency.queryKey);
    return data === undefined ? undefined : allows(data);
  };
  return {
    queryKey: read.queryKey,
    enabled: (qc) => permitted(qc) !== false,
    ask: async (qc) => {
      if (permitted(qc) === undefined) await dependency.ask(qc);
      if (phase === 'waiting' && permitted(qc) && current()) await read.ask(qc);
    },
  };
}

/** Whether a read marked for `readPage` is asked on a load opening on `page`. */
function opensOn(readPage: StartupPage, page: StartPage): boolean {
  if (readPage === 'shell') return true;
  if (readPage === 'homeAndLibrary') return page !== 'other';
  return readPage === page;
}

/** Build the first page's reads from the same marked options its components observe. */
export function startupQueries(
  page: StartPage,
  apis: readonly ApiConnection[],
  selection: LibrarySelection | null,
  defaultCid: string | null,
  queueCid: string | undefined,
): StartupQuery[] {
  const out: StartupQuery[] = [];
  for (const { connection, client } of apis) {
    const cid = connection.id;
    const selected = selection?.connectionId === cid ? selection.libraryId : 0;
    const current = () =>
      profileConnections().some(
        (c) => c.id === cid && c.token === connection.token && !c.needsReconnect,
      );
    for (const read of startupReads(cid, client, selected)) {
      const meta = read.meta;
      if (!meta?.page || !opensOn(meta.page, page)) continue;
      if (
        (meta.owner === 'default' && defaultCid !== cid) ||
        (meta.owner === 'queue' && queueCid !== cid)
      )
        continue;
      if (meta.capability) {
        const flag = meta.capability;
        out.push(
          afterAnswer<ServerInfo>(
            read,
            startupRead(serverInfoQuery(cid, client)),
            (info) => info?.capabilities?.[flag] === true,
            current,
          ),
        );
      } else if (meta.page === 'library') {
        if (!selected) continue;
        out.push(
          afterAnswer<Library[]>(
            read,
            startupRead(librariesQuery(cid, client)),
            (libs) =>
              Array.isArray(libs) &&
              libs.some((lib) => lib?.id === selected && !isPodcastLibrary(lib)),
            current,
          ),
        );
      } else {
        out.push(read);
      }
    }
  }
  return out;
}

// Once per page load: 'idle' until the gate first opens, 'waiting' while the answers are
// on their way (at most STARTUP_WAIT_MS), then 'done' for good.
let phase: 'idle' | 'waiting' | 'done' = 'idle';
const listeners = new Set<() => void>();

function finish() {
  if (phase === 'done') return;
  phase = 'done';
  for (const l of listeners) l();
}

/** Ask the `queries` the cache doesn't hold yet and wait for them (at most
 * `STARTUP_WAIT_MS`); nothing to ask is done at once. Only the first call does anything
 * (later ones never build their list). */
export function startStartupQueries(
  client: QueryClient,
  queries: () => readonly StartupQuery[],
): void {
  if (phase !== 'idle') return;
  const missing = queries().filter(
    (q) => client.getQueryData(q.queryKey) === undefined && q.enabled?.(client) !== false,
  );
  if (missing.length === 0) {
    phase = 'done';
    return;
  }
  phase = 'waiting';
  const timer = setTimeout(finish, STARTUP_WAIT_MS);
  void Promise.allSettled(missing.map((q) => q.ask(client))).then(() => {
    clearTimeout(timer);
    finish();
  });
}

/** Subscribe to the wait's end (`useSyncExternalStore`). */
export function subscribeStartupQueries(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The anchored app layout may mount its screens once this load has spent its wait. */
export const startupQueriesComplete = (): boolean => phase === 'done';

/** Tests: back to a page load's start. */
export function resetStartupQueries(): void {
  phase = 'idle';
  listeners.clear();
}
