import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { bookmarksQuery, notesQuery } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import type { Bookmark, Note } from '@/api/types';

import { usePlayingTarget } from './playing-target';
import type { PlayTarget } from './use-play-book';

/** Whole-book positions (seconds) of a book's bookmarks and notes. */
export type BookPins = { bookmarks: number[]; notes: number[] };

const EMPTY: BookPins = { bookmarks: [], notes: [] };

/** Long: every write to a bookmark or note invalidates the keys read here. */
const PINS_STALE_MS = 10 * 60_000;

/** A book's bookmarks and notes as the counts read them (undefined while unknown), and
 * their pins (`pinsOf`; none while unknown) for its whole-book timeline. */
export type BookAnnotations = { bookmarks?: Bookmark[]; notes?: Note[]; pins: BookPins };

/**
 * ANY book's bookmarks and notes, through the book's own connection, on the same cache
 * entries as `useBookmarks` / `useNotes` (`qk.bookmarks` / `qk.notes`), so a bookmark
 * added anywhere shows here. Unlike those hooks it never throws when the connection is
 * gone (a downloaded book whose server was removed): there is simply nothing. Null
 * `target`: nothing is asked. `staleTime` defaults to 10 minutes, for the pieces that
 * mount on every page (the dock); a page that shows the counts passes its own.
 */
export function useBookAnnotations(
  target: PlayTarget | null,
  staleTime: number = PINS_STALE_MS,
): BookAnnotations {
  const api = useOptionalApi(target?.connectionId ?? '');
  const cid = target?.connectionId ?? '';
  const lib = target?.libraryId ?? -1;
  // An empty path is no query function at all (`skipToken`).
  const path = api && target ? target.path : '';
  const bookmarks = useQuery({ ...bookmarksQuery(cid, api, lib, path), staleTime }).data;
  const notes = useQuery({ ...notesQuery(cid, api, lib, path), staleTime }).data;
  const pins = useMemo(
    () => (path && (bookmarks || notes) ? pinsOf(bookmarks ?? [], notes ?? []) : EMPTY),
    [path, bookmarks, notes],
  );
  return path ? { bookmarks, notes, pins } : { pins };
}

/**
 * The PLAYING book's bookmark and note positions, for the pins on the seek bar and the
 * whole-book timeline: call it once per surface (the full player, the dock) and pass
 * the positions down. Adding or deleting one invalidates these same keys, so they need
 * no refetch on mount: the dock and the full player each read them once.
 */
export function usePlayingPins(): BookPins {
  return useBookAnnotations(usePlayingTarget()).pins;
}

/**
 * The pins of `bookmarks` and `notes`: every bookmark at its place, and the notes that
 * have one. Notes are pinned to the listener's place when they are made; a note at 0 is
 * one made before that (older apps wrote every note at 0, which the server keeps), and
 * drawing those all at 0:00 stacked pins on the start of the book and pulled any tap
 * near it there (a tap on a pin lands on it). The note lists still show them at 0:00.
 */
export function pinsOf(
  bookmarks: readonly { position: number }[],
  notes: readonly { position: number }[],
): BookPins {
  return {
    bookmarks: bookmarks.map((b) => b.position),
    notes: notes.filter((n) => n.position > 0).map((n) => n.position),
  };
}
