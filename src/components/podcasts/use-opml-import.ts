import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CapabilityError, myPodcastsQuery, qk, useFollowPodcastByUrl } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import type { OpmlImportRow } from '@/api/types';
import { toast } from '@/components/ui/toast';
import { FOLLOW_REQUEST_POLL_MS } from '@/lib/podcast-requests';
import { onForeground } from '@/lib/when-active';
import { mayActFor } from '@/stores/profiles';

import { followByUrlErrorKey, OPML_MAX_BYTES } from './find-shows-model';
import { opmlText, outlineFeeds, rowFeedUrl } from './opml-feeds';
import type { PickedOpml } from './opml-pick';
import { isQueuedRow, OpmlWaves, type WaveState } from './opml-waves';

/** A row the listener followed again by its address (its Try again): on its way, or what
 * the follow answered, which stands over the waves' answer for that row. */
type RowRetry = { kind: 'busy' } | { kind: 'answered'; row: OpmlImportRow };

/** The rows with each one followed again by hand in its answer's place. */
export function withRetries(
  rows: readonly OpmlImportRow[],
  retries: Readonly<Record<number, RowRetry>>,
): OpmlImportRow[] {
  return rows.map((r) => {
    const retry = retries[r.outline_index];
    return retry?.kind === 'answered' ? retry.row : r;
  });
}

/** An import the page could not start: the file is over the limit, or could not be
 * read. */
export type OpmlLocalProblem = 'tooLarge' | 'unreadable';

/** The page's import (`useOpmlImport`). */
export type OpmlImport = ReturnType<typeof useOpmlImport>;

/**
 * One OPML import on the Find shows page (Bridge Phase 2d-2): the wave controller
 * (`OpmlWaves`) for a picked list, living as long as the page (the bytes are kept in
 * memory here only). It reads the follow requests through the shared cache entry (so the
 * Shows mode's notice moves too), pauses in the background, checks `mayActFor` before
 * each upload, and reads the library's shows again after each wave. A file over 1 MiB is
 * refused here, before any upload. A row that could not be added has its own Try again
 * (`retryRow`): a single follow by the address the list holds at that place
 * (`rowFeedUrl`), which the server always tries again (a wave never does: it answers a
 * feed that failed within the hour `recently_failed`).
 */
export function useOpmlImport(connectionId: string, libraryId: number) {
  const { t } = useTranslation();
  const client = useOptionalApi(connectionId);
  const qc = useQueryClient();
  // The stable call alone: the mutation's result changes identity with its state.
  const { mutateAsync: followByUrl } = useFollowPodcastByUrl(connectionId);
  const [state, setState] = useState<WaveState | null>(null);
  /** The list's feed addresses by `outline_index`, once its bytes are read. */
  const [feeds, setFeeds] = useState<ReadonlyMap<number, string> | null>(null);
  const [retries, setRetries] = useState<Record<number, RowRetry>>({});
  const [problem, setProblem] = useState<OpmlLocalProblem | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const waves = useRef<OpmlWaves | null>(null);
  const drop = useCallback(() => {
    waves.current?.dispose();
    waves.current = null;
  }, []);

  useEffect(() => {
    const stopWatching = onForeground(
      () => waves.current?.resume(),
      () => waves.current?.pause(),
    );
    return () => {
      stopWatching();
      drop();
    };
  }, [drop]);

  // A new list (or none): its rows, held addresses and row retries start over.
  const reset = useCallback((why: OpmlLocalProblem | null) => {
    setState(null);
    setProblem(why);
    setFeeds(null);
    setRetries({});
  }, []);

  // The page moved to another connection or library: the import was the other one's, so
  // it ends and its rows go (the search and address sections are keyed the same way).
  const scope = `${connectionId}:${libraryId}`;
  const [lastScope, setLastScope] = useState(scope);
  if (scope !== lastScope) {
    setLastScope(scope);
    reset(null);
    setFileName(null);
  }
  useEffect(() => drop, [connectionId, libraryId, drop]);

  const start = useCallback(
    (file: PickedOpml) => {
      drop();
      reset(null);
      setFileName(file.name);
      if (file.size > OPML_MAX_BYTES) {
        setProblem('tooLarge');
        return;
      }
      if (!client) {
        setProblem('unreadable');
        return;
      }
      setProblem(null);
      const run = new OpmlWaves({
        upload: (signal) => client.importOpml(libraryId, file.body, signal),
        // A read the page's own follow-request poll made a moment ago stands (a wave's
        // invalidation below makes the next one fresh).
        listRequests: async () =>
          (
            await qc.fetchQuery({
              ...myPodcastsQuery(connectionId, client),
              staleTime: FOLLOW_REQUEST_POLL_MS / 2,
            })
          ).requests,
        mayAct: () => mayActFor(connectionId),
        onChange: setState,
        // A followed row is in the show list and the followed shows now; a queued one is a
        // follow request (the show list follows when it ends done: `myPodcastsQuery`). An
        // already queued one may be one the cache has not seen (another device's), and the
        // panel reads every queued row's request live, so either reads the requests again.
        onWave: ({ rows }) => {
          const followed = rows.some((r) => r.status === 'followed');
          if (followed) {
            void qc.invalidateQueries({ queryKey: qk.podcastShows(connectionId, libraryId) });
          }
          if (followed || rows.some(isQueuedRow)) {
            void qc.invalidateQueries({ queryKey: qk.myPodcasts(connectionId) });
          }
        },
      });
      waves.current = run;
      run.start();
      // The addresses the rows' Try again follows (only while this list is the page's).
      void opmlText(file.body).then(
        (text) => {
          if (waves.current === run) setFeeds(outlineFeeds(text));
        },
        () => undefined,
      );
    },
    [client, connectionId, libraryId, qc, drop, reset],
  );

  const retryRow = useCallback(
    (row: OpmlImportRow) => {
      const feedUrl = rowFeedUrl(feeds, row);
      if (!feedUrl || retries[row.outline_index]?.kind === 'busy') return;
      const index = row.outline_index;
      const settle = (next: RowRetry | null) =>
        setRetries(({ [index]: _, ...rest }) => (next ? { ...rest, [index]: next } : rest));
      settle({ kind: 'busy' });
      followByUrl({ libraryId, feedUrl }).then(
        (answer) =>
          settle({
            kind: 'answered',
            row:
              answer.state === 'following'
                ? {
                    ...row,
                    status: 'followed',
                    path: answer.show.path,
                    request_id: null,
                    error: null,
                  }
                : { ...row, status: 'queued', request_id: answer.request.id, error: null },
          }),
        (e: unknown) => {
          settle(null);
          if (!(e instanceof CapabilityError)) toast({ title: t(followByUrlErrorKey(e)) });
        },
      );
    },
    [feeds, retries, followByUrl, libraryId, t],
  );

  return {
    state,
    problem,
    fileName,
    start,
    /** The file could not be picked or read. */
    unreadable: useCallback(() => {
      drop();
      reset('unreadable');
    }, [drop, reset]),
    stop: useCallback(() => waves.current?.stop(), []),
    retry: useCallback(() => waves.current?.retry(), []),
    /** The rows followed again by hand, by `outline_index` (`withRetries`). */
    retries,
    /** Whether a row has a Try again of its own: it could not be added and the list holds
     * its address. */
    canRetryRow: useCallback(
      (row: OpmlImportRow) =>
        (row.status === 'error' || row.status === 'cancelled') && !!rowFeedUrl(feeds, row),
      [feeds],
    ),
    retryRow,
  };
}
