import { type RefObject, useCallback, useEffect, useMemo } from 'react';

import { selectPlacedBookKey } from '@/components/player/use-listening-position';
import { contentKey } from '@/lib/content-key';
import { selectBookPosition, selectIsPlaying, usePlayer } from '@/playback/store';

import type { ReadalongPosition } from './protocol';
import type { ReaderHostHandle } from './reader-host-types';

// The narration a reader follows (Bridge Phase 3c): the player's place in the book open in
// the reader, sent to the reader document (`readalongPosition`, `syncPosition`), and a
// tapped sentence played (`onSeek`). Used by the companion's Text tab and the full-screen
// reader's Follow narration.

type PlayerSlice = ReturnType<typeof usePlayer.getState>;

/** A book, by identity. */
export type NarrationTarget = { connectionId: string; libraryId: number; path: string };

/** The narration's place in the book `key` (whole-book seconds, the listener's speed,
 * whether it plays), or null while that book is not the one placed in the player (another
 * book, or its load has not landed: `selectPlacedBookKey`). */
export function narrationOf(s: PlayerSlice, key: string): ReadalongPosition | null {
  if (selectPlacedBookKey(s) !== key) return null;
  return { t: selectBookPosition(s), rate: s.rate, playing: selectIsPlaying(s) };
}

/** One look at the narration: its place (null: not this book) and when it was taken. */
export type NarrationSample = { position: ReadalongPosition | null; at: number };

/** How far the narration may land from where it would have played to on its own before a
 * sample counts as a move (a seek, a skip, a chapter tap): ticks come a few times a second
 * on the web and once a second in the app, so a natural step is well under this. */
export const NARRATION_JUMP_S = 1.5;

/**
 * Whether the narration changed in a way the reader should hear of at once (`syncPosition`)
 * rather than at its next once-a-second sample: the book became (or stopped being) the one
 * placed, it started or stopped playing, its speed changed, or its place moved further than
 * playing on would take it (a seek).
 */
export function narrationMoved(prev: NarrationSample, next: NarrationSample): boolean {
  const a = prev.position;
  const b = next.position;
  if (!a || !b) return a !== b;
  if (a.playing !== b.playing || a.rate !== b.rate) return true;
  const expected = a.playing ? a.t + ((next.at - prev.at) / 1000) * a.rate : a.t;
  return Math.abs(b.t - expected) > NARRATION_JUMP_S;
}

/**
 * The narration of `target` for a reader host: `readalongPosition` (the host reads it each
 * second while a map is in), `onSeek` (a tapped sentence: the player seeks there, on the
 * whole-book timeline) and `narrating` (the book is the one placed in the player now). The
 * host is told at once (`syncPosition`) after a play, a pause, a seek or a speed change
 * (`narrationMoved`), so the highlight never waits for the next sample. Null `target`: no
 * narration.
 */
export function useNarration(
  target: NarrationTarget | null,
  host: RefObject<ReaderHostHandle | null>,
): {
  narrating: boolean;
  readalongPosition: () => ReadalongPosition | null;
  onSeek: (t: number) => void;
} {
  const key = target ? contentKey(target.connectionId, target.libraryId, target.path) : null;
  const narrating = usePlayer((s) => key !== null && selectPlacedBookKey(s) === key);

  useEffect(() => {
    if (key === null) return;
    const sample = (s: PlayerSlice): NarrationSample => ({
      position: narrationOf(s, key),
      at: Date.now(),
    });
    let prev = sample(usePlayer.getState());
    return usePlayer.subscribe((s) => {
      const next = sample(s);
      if (narrationMoved(prev, next)) host.current?.syncPosition();
      prev = next;
    });
  }, [key, host]);

  const readalongPosition = useCallback(
    () => (key === null ? null : narrationOf(usePlayer.getState(), key)),
    [key],
  );
  const onSeek = useCallback(
    (t: number) => {
      const s = usePlayer.getState();
      // Only into the book the player holds: a tap in another book's text plays nothing.
      if (key === null || selectPlacedBookKey(s) !== key) return;
      void s.seekBook(t).then(() => host.current?.syncPosition());
    },
    [key, host],
  );
  return useMemo(
    () => ({ narrating, readalongPosition, onSeek }),
    [narrating, readalongPosition, onSeek],
  );
}
