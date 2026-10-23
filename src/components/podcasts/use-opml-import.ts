import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { myPodcastsQuery, qk } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
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

  useEffect(() => {
    const stopWatching = onForeground(
      () => waves.current?.resume(),
      () => waves.current?.pause(),
    );
    return () => {
      stopWatching();
      waves.current?.dispose();
      waves.current = null;
    };
  }, []);

  const start = useCallback(
    (file: PickedOpml) => {
      waves.current?.dispose();
      waves.current = null;
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
        listRequests: async () =>
          (await qc.fetchQuery({ ...myPodcastsQuery(connectionId, client, qc), staleTime: 0 }))
            .requests,
        mayAct: () => mayActFor(connectionId),
        onChange: setState,
        onWave: () => {
          void qc.invalidateQueries({ queryKey: qk.podcastShows(connectionId, libraryId) });
          void qc.invalidateQueries({ queryKey: qk.myPodcasts(connectionId) });
        },
      });
      waves.current = run;
      run.start();
    },
    [client, connectionId, libraryId, qc],
  );

  return {
    state,
    problem,
    fileName,
    start,
    /** The file could not be picked or read. */
    unreadable: useCallback(() => {
      waves.current?.dispose();
      waves.current = null;
      setState(null);
      setProblem('unreadable');
    }, []),
    stop: useCallback(() => waves.current?.stop(), []),
    retry: useCallback(() => waves.current?.retry(), []),
  };
}
