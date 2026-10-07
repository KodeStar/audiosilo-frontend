import { useShallow } from 'zustand/react/shallow';

import { usePlayer } from '@/playback/store';

import type { PlayTarget } from './use-play-book';

/** What the identity reads need from the player. */
type Loaded = { nowPlaying: PlayTarget | null };

/** A selector: is `target` the book loaded in the player (same connection, library and
 * path)? False without a target. A boolean, so a subscriber re-renders only when the
 * answer flips, never per tick. */
export function selectIsLoaded(target: PlayTarget | null | undefined) {
  return (s: Loaded): boolean => {
    const np = s.nowPlaying;
    return (
      !!target &&
      !!np &&
      np.connectionId === target.connectionId &&
      np.libraryId === target.libraryId &&
      np.path === target.path
    );
  };
}

/** The loaded book by identity, or null: the same object until another book loads (the
 * companion and its reveal toast key their reads on it). */
export function usePlayingTarget(): PlayTarget | null {
  return usePlayer(
    useShallow((s) =>
      s.nowPlaying
        ? {
            connectionId: s.nowPlaying.connectionId,
            libraryId: s.nowPlaying.libraryId,
            path: s.nowPlaying.path,
          }
        : null,
    ),
  );
}
