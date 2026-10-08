import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelAnimation,
  Easing,
  type SharedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { CARD_MS, clampCard, stepCard } from './story-model';

export type StoryPlayer = {
  /** The card on show. */
  index: number;
  goTo: (index: number) => void;
  next: () => void;
  previous: () => void;
  /** The current card's bar, 0..1, filling over `CARD_MS`. */
  progress: SharedValue<number>;
};

/**
 * The story's clock: which card is up and how full its bar is. The advance is a plain
 * timer (so a test can drive it); the bar is a Reanimated timing over the same time
 * left. A held story (`held`: a share, a screen reader, a finger on the card) freezes
 * both and resumes with the time the card had left; a `still` one (reduced motion) never
 * moves by itself and shows its bar full. Moving to a card, or going to the same card
 * again, starts its time over.
 */
export function useStoryPlayer(
  count: number,
  opts: { held: boolean; still: boolean; initial?: number },
): StoryPlayer {
  const { held, still } = opts;
  // `turn` restarts a card the listener moved to (also the one already up).
  const [at, setAt] = useState(() => ({ index: clampCard(opts.initial ?? 0, count), turn: 0 }));
  const index = clampCard(at.index, count);
  const progress = useSharedValue(0);
  const left = useRef(CARD_MS);
  const running = useRef<string | null>(null);

  useEffect(() => {
    const key = `${index}:${at.turn}`;
    if (running.current !== key) {
      running.current = key;
      left.current = CARD_MS;
      cancelAnimation(progress);
      progress.value = 0;
    }
    if (count === 0) return;
    if (still) {
      cancelAnimation(progress);
      progress.value = 1;
      return;
    }
    if (held) {
      cancelAnimation(progress);
      return;
    }
    const began = Date.now();
    progress.value = withTiming(1, { duration: left.current, easing: Easing.linear });
    const timer =
      index < count - 1
        ? setTimeout(() => setAt((s) => ({ index: s.index + 1, turn: s.turn })), left.current)
        : null;
    return () => {
      if (timer) clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - began));
      cancelAnimation(progress);
    };
  }, [index, at.turn, count, held, still, progress]);

  const goTo = useCallback(
    (i: number) => setAt((s) => ({ index: clampCard(i, count), turn: s.turn + 1 })),
    [count],
  );
  const next = useCallback(
    () => setAt((s) => ({ index: stepCard(s.index, 1, count), turn: s.turn + 1 })),
    [count],
  );
  const previous = useCallback(
    () => setAt((s) => ({ index: stepCard(s.index, -1, count), turn: s.turn + 1 })),
    [count],
  );
  return { index, goTo, next, previous, progress };
}
