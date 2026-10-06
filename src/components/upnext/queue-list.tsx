import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type AccessibilityActionEvent, Platform, Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import type { QueueEntry } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';
import { useLatest } from '@/lib/use-latest';

import {
  dragShift,
  dragTarget,
  entryKey,
  entryState,
  keyMove,
  moveItem,
  orderByKeys,
  type ProgressIndex,
} from './up-next-model';

const SHIFT_MS = 150;

/** A queued book's name, from its indexed metadata, else its folder. */
export function entryTitle(e: QueueEntry): string {
  return bookTitle(e.book?.title, e.path);
}

/** The row's second line: "Series · 2" or the author, then where the listener is
 * ("55%", "Finished") or, before they start, the book's length. */
export function entryCaption(e: QueueEntry, progress: ProgressIndex, t: TFunction): string {
  const b = e.book;
  const where = b?.series
    ? b.series_index > 0
      ? `${b.series} · ${b.series_index}`
      : b.series
    : (b?.author ?? '');
  const state = entryState(progress.get(entryKey(e)));
  const status =
    state.kind === 'finished'
      ? t('upnext.finished')
      : state.kind === 'progress'
        ? t('upnext.percent', { percent: state.percent })
        : formatDuration(b?.duration);
  return [where, status].filter(Boolean).join(' · ');
}

type DragValues = {
  from: SharedValue<number>;
  to: SharedValue<number>;
  dy: SharedValue<number>;
  step: SharedValue<number>;
};

/**
 * The queue, reorderable three ways, every one a positioned add of ONE entry (`onMove`
 * with its index in this visible list - never a whole-list PUT, which would drop the
 * rows the listener can't see):
 * - drag the grip (gesture-handler: a mouse on the web; on touch, hold the grip briefly
 *   so a scroll isn't taken for a drag);
 * - the keyboard (web): ArrowUp/ArrowDown on a focused grip, or Alt/Option+Arrow anywhere
 *   in the row; focus stays on the moved row;
 * - a screen reader's "Move up" / "Move down" actions on the grip.
 * The new order shows at once and gives way to the server's answer when it arrives.
 */
export function QueueList({
  entries,
  progress,
  connectionId,
  onMove,
  onRemove,
  onPlay,
}: {
  entries: readonly QueueEntry[];
  progress: ProgressIndex;
  connectionId: string;
  onMove: (entry: QueueEntry, to: number) => Promise<boolean>;
  onRemove: (entry: QueueEntry) => void;
  onPlay: (entry: QueueEntry) => void;
}) {
  // An optimistic order (entry keys) until the server's queue next changes.
  const [pending, setPending] = useState<{ base: readonly QueueEntry[]; keys: string[] } | null>(
    null,
  );
  const shown = useMemo(
    () => (pending && pending.base === entries ? orderByKeys(entries, pending.keys) : entries),
    [pending, entries],
  );
  const { t } = useTranslation();
  const [refocus, setRefocus] = useState<string | null>(null);
  const from = useSharedValue(-1);
  const to = useSharedValue(-1);
  const dy = useSharedValue(0);
  const step = useSharedValue(0);
  const drag = useMemo<DragValues>(() => ({ from, to, dy, step }), [from, to, dy, step]);

  // Stable for the rows' gestures: a gesture rebuilt mid-drag (a hover re-render)
  // would reattach its handlers.
  const move = useLatest((fromIndex: number, toIndex: number, viaKeyboard = false) => {
    drag.from.set(-1);
    drag.dy.set(0);
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || toIndex >= shown.length) return;
    const entry = shown[fromIndex];
    setPending({ base: entries, keys: moveItem(shown, fromIndex, toIndex).map(entryKey) });
    if (viaKeyboard) setRefocus(entryKey(entry));
    void onMove(entry, toIndex).then((ok) => {
      if (!ok) setPending(null);
    });
  });
  const focused = useCallback(() => setRefocus(null), []);

  return (
    <View role="list">
      {shown.map((e, i) => (
        <QueueRow
          key={entryKey(e)}
          entry={e}
          index={i}
          count={shown.length}
          caption={entryCaption(e, progress, t)}
          connectionId={connectionId}
          drag={drag}
          focusGrip={refocus === entryKey(e)}
          onFocused={focused}
          onMove={move}
          onRemove={() => onRemove(e)}
          onPlay={() => onPlay(e)}
        />
      ))}
    </View>
  );
}

function QueueRow({
  entry,
  index,
  count,
  caption,
  connectionId,
  drag,
  focusGrip,
  onFocused,
  onMove,
  onRemove,
  onPlay,
}: {
  entry: QueueEntry;
  index: number;
  count: number;
  caption: string;
  connectionId: string;
  drag: DragValues;
  focusGrip: boolean;
  onFocused: () => void;
  onMove: (from: number, to: number, viaKeyboard?: boolean) => void;
  onRemove: () => void;
  onPlay: () => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const reduced = useReducedMotion();
  const { openBook } = useOpen();
  const web = Platform.OS === 'web';
  const title = entryTitle(entry);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Lifted off the list while dragged: an opaque card with the overlay shadow.
  const [dragging, setDragging] = useState(false);
  const height = useSharedValue(0);
  const grip = useRef<View>(null);

  useEffect(() => {
    if (!focusGrip) return;
    (grip.current as unknown as { focus?: () => void } | null)?.focus?.();
    onFocused();
  }, [focusGrip, onFocused]);

  const pan = useMemo(() => {
    const g = Gesture.Pan()
      .onStart(() => {
        drag.step.set(height.get());
        runOnJS(setDragging)(true);
        drag.from.set(index);
        drag.to.set(index);
      })
      .onUpdate((e) => {
        drag.dy.set(e.translationY);
        drag.to.set(dragTarget(index, e.translationY, drag.step.get(), count));
      })
      .onEnd(() => {
        runOnJS(onMove)(index, drag.to.get());
      })
      .onFinalize((_e, success) => {
        runOnJS(setDragging)(false);
        if (!success) {
          drag.from.set(-1);
          drag.dy.set(0);
        }
      });
    // Touch: a brief hold first, so scrolling the list over a grip still scrolls.
    return web ? g : g.activateAfterLongPress(180);
  }, [drag, height, index, count, onMove, web]);

  const style = useAnimatedStyle(() => {
    const from = drag.from.get();
    if (from === index) {
      return { transform: [{ translateY: drag.dy.get() }], zIndex: 2 };
    }
    // No drag (or one just dropped): rows sit where they are at once, since the new
    // order has already moved them; easing back from the shifted spot would jump.
    if (from < 0) return { transform: [{ translateY: 0 }], zIndex: 0 };
    const offset = dragShift(index, from, drag.to.get()) * drag.step.get();
    return {
      transform: [{ translateY: reduced ? offset : withTiming(offset, { duration: SHIFT_MS }) }],
      zIndex: 0,
    };
  });

  const moves = [
    index > 0 ? { name: 'moveUp', label: t('upnext.moveUp') } : null,
    index < count - 1 ? { name: 'moveDown', label: t('upnext.moveDown') } : null,
  ].filter((a): a is { name: string; label: string } => a !== null);
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'moveUp') onMove(index, index - 1, true);
    if (e.nativeEvent.actionName === 'moveDown') onMove(index, index + 1, true);
  };
  type Key = {
    key: string;
    altKey: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  };
  const keyHandler = (onGrip: boolean) =>
    web
      ? {
          onKeyDown: (e: Key) => {
            const to = keyMove(e, onGrip, index, count);
            if (to === null) return;
            e.preventDefault();
            e.stopPropagation();
            onMove(index, to, true);
          },
        }
      : {};

  // Hover or focus shows the row's actions on the web; touch has no hover, so they stay.
  const showActions = !web || hovered || focused;

  return (
    <Animated.View
      style={style}
      onLayout={(e) => height.set(e.nativeEvent.layout.height)}
      role="listitem"
    >
      <Pressable
        accessible={false}
        focusable={false}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        // Focus bubbles from the row's buttons on the web (focusin).
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...keyHandler(false)}
        className={cn(
          'mb-[2px] flex-row items-center gap-2.5 rounded-xl py-2 pl-1 pr-1.5',
          dragging ? 'bg-popover shadow-overlay' : Platform.select({ web: 'hover:bg-muted' }),
        )}
      >
        <GestureDetector gesture={pan}>
          <Pressable
            ref={grip}
            testID={`upnext-grip-${index}`}
            accessibilityRole="button"
            accessibilityLabel={t('upnext.reorder', { title })}
            accessibilityHint={web ? t('upnext.reorderHint') : undefined}
            accessibilityActions={moves}
            onAccessibilityAction={onAction}
            {...keyHandler(true)}
            className={cn(
              'h-11 w-6 items-center justify-center rounded-md',
              Platform.select({
                web: `cursor-grab touch-none hover:bg-accent ${FOCUS_RING_CLASS}`,
              }),
            )}
          >
            <Icon name="grip" size={16} color={themed.subtleForeground} />
          </Pressable>
        </GestureDetector>
        <AnimatedPressable
          onPress={() => openBook(connectionId, entry.library_id, entry.path)}
          accessibilityRole="button"
          accessibilityLabel={`${title}, ${caption}`}
          className={cn(
            'flex-1 flex-row items-center gap-2.5 rounded-lg',
            Platform.select({
              web: FOCUS_RING_CLASS,
            }),
          )}
        >
          <BookCover
            connectionId={connectionId}
            libraryId={entry.library_id}
            path={entry.path}
            coverVersion={entry.book?.cover_version}
            width={44}
            title={title}
            author={entry.book?.author}
          />
          <View className="flex-1 gap-0.5">
            <Text variant="label" className="text-[13px] leading-[17px]" numberOfLines={2}>
              {title}
            </Text>
            <Text variant="caption" numberOfLines={1}>
              {caption}
            </Text>
          </View>
        </AnimatedPressable>
        <View className={cn('flex-row', !showActions && 'opacity-0')}>
          <RowButton
            icon="play"
            label={t('upnext.playNow', { title })}
            onPress={onPlay}
            size={14}
          />
          <RowButton
            icon="close"
            label={t('upnext.remove', { title })}
            onPress={onRemove}
            size={15}
          />
        </View>
      </Pressable>
    </Animated.View>
  );
}

function RowButton({
  icon,
  label,
  onPress,
  size,
}: {
  icon: 'play' | 'close';
  label: string;
  onPress: () => void;
  size: number;
}) {
  const themed = useThemeColors();
  return (
    <AnimatedPressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={cn(
        'h-9 w-9 items-center justify-center rounded-lg active:bg-accent',
        Platform.select({
          web: `hover:bg-accent ${FOCUS_RING_CLASS}`,
        }),
      )}
    >
      <Icon name={icon} size={size} color={themed.foreground} />
    </AnimatedPressable>
  );
}

/** Cover-shaped placeholder rows while the queue loads. */
export function QueueSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <View testID="upnext-skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} className="flex-row items-center gap-2.5 py-2 pl-1">
          <View className="w-6" />
          <Skeleton className="h-[44px] w-[44px] rounded-cover" />
          <View className="flex-1 gap-1.5">
            <Skeleton className="h-3.5 w-3/4 rounded" />
            <Skeleton className="h-3 w-1/2 rounded" />
          </View>
        </View>
      ))}
    </View>
  );
}
