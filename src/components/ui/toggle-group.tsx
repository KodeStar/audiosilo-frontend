import * as ToggleGroupPrimitive from '@rn-primitives/toggle-group';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, Platform, ScrollView, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { formatCount } from '@/lib/format';
import { useDomId } from '@/lib/use-dom-id';
import { useLatestRef } from '@/lib/use-latest';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { HORIZONTAL_SCROLLER } from './horizontal-scroller';
import { FOCUS_RING_CLASS, Text, TextClassContext } from './text';

/**
 * The Stacks segmented control (STYLEGUIDE.md section 8: "muted track + raised card for
 * the active item"), built on react-native-reusables' ToggleGroup in `single` mode.
 *
 * It is a single choice that switches something in place, so it carries radio
 * semantics: the track is a `radiogroup` and each segment a `radio` whose `checked`
 * state says which is chosen (rn-primitives on native; set explicitly on web, where
 * rn-primitives would otherwise mark the items as plain buttons). For tabs that own a
 * panel, use `Tabs` (./tabs) instead.
 */
const track = 'rounded-[11px] border border-border bg-muted p-[3px]';

const itemBase = cn(
  'h-[30px] flex-row items-center justify-center gap-1.5 rounded-lg border border-transparent px-3',
  Platform.select({
    web: `cursor-pointer select-none whitespace-nowrap transition-colors ${FOCUS_RING_CLASS}`,
  }),
);

// The raised segment. Dark mode lifts it to `secondary`: the dark `card` is darker
// than the `muted` track, so a card-coloured segment would read as sunken.
const segmentActive =
  'border-border bg-card shadow-xs dark:border-border-strong dark:bg-secondary dark:shadow-none';

export function ToggleGroup({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & { className?: string }) {
  return (
    <ToggleGroupPrimitive.Root
      role={props.type === 'single' ? 'radiogroup' : 'group'}
      className={cn('flex-row gap-0.5', track, className)}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Root>
  );
}

export function ToggleGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & { className?: string }) {
  const { value, type } = ToggleGroupPrimitive.useRootContext();
  const selected = ToggleGroupPrimitive.utils.getIsSelected(value, props.value);
  return (
    <TextClassContext.Provider
      value={cn(
        'font-sans-semibold text-sm',
        selected ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <ToggleGroupPrimitive.Item
        // A 30 tall segment in a 36 track; the slop makes the touch target 44.
        hitSlop={{ top: 7, bottom: 7 }}
        className={cn(
          itemBase,
          selected && segmentActive,
          props.disabled && 'opacity-50',
          className,
        )}
        // Space presses a radio/checkbox like Enter (@/lib/rnw-button-fix).
        {...(Platform.OS === 'web' && {
          role: type === 'single' ? 'radio' : 'checkbox',
          'aria-checked': selected,
        })}
        {...props}
      >
        {children}
      </ToggleGroupPrimitive.Item>
    </TextClassContext.Provider>
  );
}

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** An optional count after the label, in subtle tabular figures (STYLEGUIDE section 8:
   * the sub-nav's "Authors 612"). It is part of the segment's accessible name. */
  count?: number;
};

/**
 * A typed one-of-N segmented control over a string union: the common case of
 * `ToggleGroup type="single"` with one text segment per option. Pressing the chosen
 * segment again keeps it chosen (a toggle group would otherwise clear it).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  grow,
  scrollable,
  wrap,
  accessibilityLabel,
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Equal-width segments filling the row. Ignored when `scrollable` (a scroller has
   * no width to divide, and a flex-1 segment in one collapses to nothing). */
  grow?: boolean;
  /** Scroll horizontally when the options don't fit (long labels, many options): the
   * chosen segment is kept in view and a fade marks the side with more. */
  scrollable?: boolean;
  /** Wrap onto more lines instead (a long list such as the languages). */
  wrap?: boolean;
  /** The group's accessible name: what is being chosen ("Reading order"). */
  accessibilityLabel?: string;
  className?: string;
}) {
  const items = (onItemLayout?: (value: T, e: LayoutChangeEvent) => void) =>
    options.map((o) => (
      <ToggleGroupItem
        key={o.value}
        value={o.value}
        onLayout={onItemLayout ? (e) => onItemLayout(o.value, e) : undefined}
        accessibilityLabel={o.count === undefined ? o.label : `${o.label}, ${o.count}`}
        className={grow && !scrollable ? 'flex-1' : undefined}
      >
        <Text numberOfLines={1}>{o.label}</Text>
        {o.count === undefined ? null : (
          <Text className="font-sans text-[11px] text-subtle-foreground" style={tabularNums}>
            {formatCount(o.count)}
          </Text>
        )}
      </ToggleGroupItem>
    ));
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
      accessibilityLabel={accessibilityLabel}
      className={cn(wrap && 'flex-wrap', scrollable && 'flex-col', className)}
    >
      {scrollable ? (
        <SegmentScroller value={value}>{(onItemLayout) => items(onItemLayout)}</SegmentScroller>
      ) : (
        items()
      )}
    </ToggleGroup>
  );
}

/** The width of the fade over a cut-off side of a scrolling segmented control. */
const FADE = 28;

/**
 * The horizontal scroller of a `scrollable` SegmentedControl. A plain scroller hid the
 * segments past its edge with nothing to say they were there (the Library's Folders on
 * an 834 wide tablet), and a chosen segment could sit cut off at the edge. So it:
 * - scrolls the chosen segment fully into view (clear of the fade) when it changes or
 *   first lays out;
 * - fades the side(s) that have more, in the track's own colour;
 * - on the web, turns a mouse wheel's vertical scroll into a horizontal one while the
 *   pointer is over it (a mouse can't scroll sideways otherwise).
 */
function SegmentScroller<T extends string>({
  value,
  children,
}: {
  value: T;
  children: (onItemLayout: (value: T, e: LayoutChangeEvent) => void) => ReactNode;
}) {
  const ref = useRef<ScrollView>(null);
  const reduced = useReducedMotion();
  const [layouts, setLayouts] = useState<Partial<Record<string, { x: number; width: number }>>>({});
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);
  const [x, setX] = useState(0);
  // The effect below reads the scroll position without re-running on the reader's scroll.
  const xRef = useLatestRef(x);
  const selected = layouts[value];

  useEffect(() => {
    if (!selected || viewport <= 0) return;
    const cur = xRef.current;
    let next = cur;
    if (selected.x - FADE < cur) next = Math.max(0, selected.x - FADE);
    else if (selected.x + selected.width + FADE > cur + viewport)
      next = Math.min(content - viewport, selected.x + selected.width + FADE - viewport);
    if (Math.abs(next - cur) > 1) ref.current?.scrollTo({ x: next, animated: !reduced });
    // Positions, not the object: a re-render must not scroll back over the reader's own.
  }, [selected?.x, selected?.width, viewport, content, reduced]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = (
      ref.current as unknown as { getScrollableNode?: () => HTMLElement } | null
    )?.getScrollableNode?.();
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (node.scrollWidth <= node.clientWidth) return;
      e.preventDefault();
      node.scrollLeft += e.deltaY;
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  const overflow = content - viewport > 1;
  return (
    <View className="relative min-w-0">
      <ScrollView
        ref={ref}
        testID="segment-scroller"
        horizontal
        style={HORIZONTAL_SCROLLER}
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="flex-row gap-0.5"
        scrollEventThrottle={32}
        onLayout={(e) => setViewport(e.nativeEvent.layout.width)}
        onContentSizeChange={(w) => setContent(w)}
        onScroll={(e) => setX(e.nativeEvent.contentOffset.x)}
      >
        {children((v, e) => {
          const { x: lx, width } = e.nativeEvent.layout;
          setLayouts((prev) =>
            prev[v]?.x === lx && prev[v]?.width === width
              ? prev
              : { ...prev, [v]: { x: lx, width } },
          );
        })}
      </ScrollView>
      {overflow && x > 1 ? <EdgeFade side="left" /> : null}
      {overflow && x + viewport < content - 1 ? <EdgeFade side="right" /> : null}
    </View>
  );
}

function EdgeFade({ side }: { side: 'left' | 'right' }) {
  const id = useDomId('fade');
  const muted = useThemeColors().muted;
  const left = side === 'left';
  return (
    <View
      testID={`segment-fade-${side}`}
      pointerEvents="none"
      aria-hidden
      style={{ position: 'absolute', top: 0, bottom: 0, width: FADE, [side]: 0 }}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
            <Stop offset={0} stopColor={muted} stopOpacity={left ? 1 : 0} />
            <Stop offset={1} stopColor={muted} stopOpacity={left ? 0 : 1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
