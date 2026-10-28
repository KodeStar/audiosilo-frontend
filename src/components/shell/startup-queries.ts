import type { FetchQueryOptions, QueryClient, QueryKey } from '@tanstack/react-query';

import type { ApiConnection } from '@/api/provider';
import {
  allProgressQuery,
  favouritesQuery,
  librariesQuery,
  recentQuery,
  serverInfoQuery,
} from '@/api/hooks';
import { parseLibraryMode } from '@/components/library/library-modes';
import { wholeLibraryQuery } from '@/components/library/books/use-whole-library';
import type { LibrarySelection } from '@/stores/library-selection';

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
export type StartupQuery = { queryKey: QueryKey; ask: (client: QueryClient) => Promise<void> };

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

/** A query spec as a `StartupQuery`. */
function asked<TQueryFnData, TError, TData, TQueryKey extends QueryKey>(
  spec: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): StartupQuery {
  return { queryKey: spec.queryKey, ask: (qc) => qc.prefetchQuery(spec) };
}

/**
 * The answers `page` paints from, for the person's connections (`apis`): every server's
 * flags, libraries and progress (the shell, the tiles' progress), and Home's Recently added
 * and favourites, or the selected library's first page of books (the grid).
 */
export function startupQueries(
  page: StartPage,
  apis: readonly ApiConnection[],
  selection: LibrarySelection | null,
): StartupQuery[] {
  const out: StartupQuery[] = [];
  for (const { connection, client } of apis) {
    const cid = connection.id;
    out.push(asked(serverInfoQuery(cid, client)));
    out.push(asked(librariesQuery(cid, client)));
    if (page === 'other') continue;
    out.push(asked(allProgressQuery(cid, client)));
    if (page === 'home') {
      out.push(asked(recentQuery(cid, client)));
      out.push(asked(favouritesQuery(cid, client)));
    } else if (selection?.connectionId === cid) {
      const spec = wholeLibraryQuery(cid, client, selection.libraryId);
      out.push({ queryKey: spec.queryKey, ask: (qc) => qc.prefetchInfiniteQuery(spec) });
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
 * `STARTUP_WAIT_MS`); nothing to ask is done at once. Only the first call does anything. */
export function startStartupQueries(client: QueryClient, queries: readonly StartupQuery[]): void {
  if (phase !== 'idle') return;
  const missing = queries.filter((q) => client.getQueryData(q.queryKey) === undefined);
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

/** Whether nothing is being waited for (before the start, or after it). */
export const startupQueriesSettled = (): boolean => phase !== 'waiting';

/** Tests: back to a page load's start. */
export function resetStartupQueries(): void {
  phase = 'idle';
  listeners.clear();
}
