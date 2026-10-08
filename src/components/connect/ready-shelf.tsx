import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import type { Book } from '@/api/types';
import { spinesThatFit } from '@/components/player/end-credits-logic';
import { Plank } from '@/components/series/bookcase';
import { Spine } from '@/components/series/spine';
import { spineDims } from '@/components/series/spine-fit';
import { GhostSpines } from '@/components/ui/ghost-art';

const GAP = 4;
/** Between one spine's drop and the next (the prototype's 70 ms). */
const STAGGER_MS = 70;

/**
 * The first run's shelf ("Your library is ready.", STYLEGUIDE sections 6 and 8): the
 * listener's own newest books as spines dropping onto a plank one by one (a 700-900 ms
 * spring each, staggered); with reduced motion they are simply there. As many as fit the
 * row. Before the books arrive the shelf keeps its height (no shift when they land); a
 * library with no books shows dashed ghost spines. Decorative: the sentence under it
 * carries the counts.
 */
export function ReadyShelf({
  books,
  phone,
}: {
  /** Undefined while loading. */
  books: readonly Book[] | undefined;
  phone: boolean;
}) {
  const [room, setRoom] = useState(0);
  const scale = phone ? 0.6 : 0.82;
  const sized = (books ?? []).map((b) => ({ b, ...spineDims(b.duration, b.title, scale) }));
  const fit =
    room > 0
      ? spinesThatFit(
          sized.map((s) => s.width),
          room,
          GAP,
        )
      : 0;
  const shown = sized.slice(0, fit);
  const height = Math.round(210 * scale);
  return (
    <View
      testID="ready-shelf"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="w-full max-w-[560px]"
    >
      <View
        testID="ready-shelf-row"
        onLayout={(e) => setRoom(e.nativeEvent.layout.width - 24)}
        style={{ height, gap: GAP }}
        className="flex-row items-end justify-center px-3"
      >
        {books && books.length === 0 ? (
          <GhostSpines />
        ) : (
          shown.map(({ b, width, height: h }, i) => (
            <Drop key={`${b.library_id}:${b.rel_path}`} index={i}>
              <Spine
                title={b.title}
                author={b.author}
                width={width}
                height={h}
                scale={scale}
                variant="book"
                coverColor={b.cover_color}
              />
            </Drop>
          ))
        )}
      </View>
      <Plank />
    </View>
  );
}

/** One spine dropping onto the plank, `index` places into the row. */
function Drop({ index, children }: { index: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  const drop = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) return;
    drop.value = withDelay(
      200 + index * STAGGER_MS,
      withTiming(1, { duration: 760, easing: Easing.bezier(0.34, 1.36, 0.64, 1) }),
    );
  }, [reduced, drop, index]);
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, drop.value * 1.8),
    transform: [{ translateY: -200 * (1 - drop.value) }, { rotate: `${-8 * (1 - drop.value)}deg` }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}
