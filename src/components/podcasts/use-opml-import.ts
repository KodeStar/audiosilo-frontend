import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { myPodcastsQuery, qk } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { FOLLOW_REQUEST_POLL_MS } from '@/lib/podcast-requests';
import { onForeground } from '@/lib/when-active';
import { mayActFor } from '@/stores/profiles';

import { OPML_MAX_BYTES } from './find-shows-model';
import type { PickedOpml } from './opml-pick';
import { OpmlWaves, type WaveState } from './opml-waves';

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
 * refused here, before any upload.
 */
export function useOpmlImport(connectionId: string, libraryId: number) {
  const client = useOptionalApi(connectionId);
  const qc = useQueryClient();
  const [state, setState] = useState<WaveState | null>(null);
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

  const start = useCallback(
    (file: PickedOpml) => {
      drop();
      setFileName(file.name);
      setState(null);
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
        // new follow request (the show list follows when it ends done: `myPodcastsQuery`).
        onWave: ({ rows }) => {
          const followed = rows.some((r) => r.status === 'followed');
          if (followed) {
            void qc.invalidateQueries({ queryKey: qk.podcastShows(connectionId, libraryId) });
          }
          if (followed || rows.some((r) => r.status === 'queued')) {
            void qc.invalidateQueries({ queryKey: qk.myPodcasts(connectionId) });
          }
        },
      });
      waves.current = run;
      run.start();
    },
    [client, connectionId, libraryId, qc, drop],
  );

  return {
    state,
    problem,
    fileName,
    start,
    /** The file could not be picked or read. */
    unreadable: useCallback(() => {
      drop();
      setState(null);
      setProblem('unreadable');
    }, [drop]),
    stop: useCallback(() => waves.current?.stop(), []),
    retry: useCallback(() => waves.current?.retry(), []),
  };
}
