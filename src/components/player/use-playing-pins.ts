import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { qk } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { usePlayer } from '@/playback/store';

/** Whole-book positions (seconds) of the playing book's bookmarks and notes. */
export type BookPins = { bookmarks: number[]; notes: number[] };

const EMPTY: BookPins = { bookmarks: [], notes: [] };

/** Long: every write to a bookmark or note invalidates the keys read here. */
const PINS_STALE_MS = 10 * 60_000;

/**
 * The playing book's bookmark and note positions, for the pins on the seek bar and the
 * whole-book timeline: call it once per surface (the full player, the dock) and pass
 * the positions down. Through the PLAYING book's own connection, on the same cache
 * entries as `useBookmarks` / `useNotes` (`qk.bookmarks` / `qk.notes`), so a bookmark
 * added anywhere shows here. Unlike those hooks it never throws when the connection is
 * gone (a downloaded book playing after its server was removed): there are simply no
 * pins, because these pieces mount on every page under the docked bar.
 */
export function usePlayingPins(): BookPins {
  const np = usePlayer((s) => s.nowPlaying);
  const api = useOptionalApi(np?.connectionId ?? '');
  const cid = np?.connectionId ?? '';
  const lib = np?.libraryId ?? -1;
  const path = np?.path ?? '';
  const enabled = !!api && !!np;
  // Adding or deleting one invalidates these same keys, so they need no refetch on mount:
  // the dock and the full player each read them once.
  const bookmarks = useQuery({
    queryKey: qk.bookmarks(cid, lib, path),
    queryFn: () => api!.bookmarks(lib, path),
    enabled,
    staleTime: PINS_STALE_MS,
  }).data;
  const notes = useQuery({
    queryKey: qk.notes(cid, lib, path),
    queryFn: () => api!.notes(lib, path),
    enabled,
    staleTime: PINS_STALE_MS,
  }).data;
  return useMemo(
    () =>
      enabled
        ? {
            bookmarks: (bookmarks ?? []).map((b) => b.position),
            notes: (notes ?? []).map((n) => n.position),
          }
        : EMPTY,
    [enabled, bookmarks, notes],
  );
}
