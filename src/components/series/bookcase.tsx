import type { TFunction } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import Animated, {
  Easing,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { BookCover } from '@/components/library/book-cover';
import { GhostCover } from '@/components/library/ghost-cover';
import { HORIZONTAL_SCROLLER } from '@/components/ui/horizontal-scroller';
import { FOCUS_RING_OFFSET_CLASS } from '@/components/ui/text';
import { type LayoutClass } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { useDomId } from '@/lib/use-dom-id';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import type { SeriesEntry } from './series-model';
import { READING_LIFT, Ribbon, RIBBON_WIDTH, Spine } from './spine';
import { spineDims } from './spine-fit';

/** The bookcase's scale per form factor (the prototype's 0.92 / 1.2 / 1.42). */
export function bookcaseScale(layout: LayoutClass): number {
  return layout === 'phone' ? 0.92 : layout === 'tablet' ? 1.2 : 1.42;
}

/** How much of the ribbon shows above a book, and its full length behind it. */
const RIBBON_SHOW = 34;
const RIBBON_LENGTH = 44;
/** Room above the row for a lifted spine and its ribbon. */
const HEADROOM = READING_LIFT + RIBBON_SHOW + 10;
const GAP = 5;

/** The words an entry's spine and face-out cover are read by. */
function entryLabel(entry: SeriesEntry, t: TFunction, current: boolean): string {
  const title = entry.title ?? t('covers.bookNumber', { position: entry.position });
  const parts = [
    entry.title && entry.position ? t('series.bookN', { position: entry.position }) : '',
    title,
  ];
  const state = current
    ? t('series.listeningNow')
    : entry.finished
      ? t('covers.finished')
      : entry.kind === 'elsewhere'
        ? t('covers.onServer', { server: entry.copy.connectionName })
        : entry.kind === 'ghost'
          ? t('covers.notInLibrary')
          : '';
  return [...parts, state].filter(Boolean).join(', ');
}

/**
 * The series bookcase (STYLEGUIDE section 8, "Series shelf"): every entry as a spine on
 * a plank, in the chosen reading order, with the SELECTED entry taken off the shelf and
 * turned face-out as its cover (a ghost cover for a book on no server). The book you're
 * on carries the pink ribbon, tucked behind it. Choosing a spine selects it; switching
 * the reading order slides the spines to their new places (`slide`); the slide and the
 * face-out turn play only without reduced motion. The row scrolls sideways when it is wider than the page, and
 * keeps the selected book in view.
 */
export function Bookcase({
  entries,
  selectedKey,
  currentKey,
  onSelect,
  layout,
  typicalSeconds,
  slide,
  accessibilityLabel,
}: {
  entries: readonly SeriesEntry[];
  selectedKey?: string;
  currentKey?: string;
  onSelect: (key: string) => void;
  layout: LayoutClass;
  typicalSeconds?: number;
  /** True while the reading order has just changed: the spines slide to their new
   * places. Only then: a selection resizes two slots, which a layout transition would
   * draw as a stretched spine. */
  slide?: boolean;
  accessibilityLabel: string;
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const scale = bookcaseScale(layout);
  const face = Math.round(212 * scale);
  const pad = layout === 'desktop' ? 32 : 16;
  const scroller = useRef<ScrollView>(null);
  const slots = useRef(new Map<string, { x: number; width: number }>());
  const [viewWidth, setViewWidth] = useState(0);
  const [laidOut, setLaidOut] = useState(0);

  // Keep the face-out book in view: centred when the row is wider than the page.
  useEffect(() => {
    const slot = selectedKey ? slots.current.get(selectedKey) : undefined;
    if (!slot || !viewWidth) return;
    scroller.current?.scrollTo({
      x: Math.max(0, slot.x - (viewWidth - slot.width) / 2),
      animated: !reduced,
    });
    // `laidOut` re-runs this once the slots have measured.
  }, [selectedKey, viewWidth, laidOut, reduced]);

  return (
    <View accessibilityLabel={accessibilityLabel} role="list">
      <ScrollView
        ref={scroller}
        testID="bookcase-scroller"
        horizontal
        style={HORIZONTAL_SCROLLER}
        showsHorizontalScrollIndicator={false}
        onLayout={(e) => setViewWidth(e.nativeEvent.layout.width)}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: layout === 'phone' ? 'flex-start' : 'center',
          alignItems: 'flex-end',
          gap: GAP,
          paddingTop: HEADROOM,
          paddingHorizontal: pad,
        }}
      >
        {entries.map((e) => {
          const faced = e.key === selectedKey;
          const current = e.key === currentKey;
          const title = e.title ?? t('covers.bookNumber', { position: e.position });
          const { width, height } = spineDims(e.seconds ?? typicalSeconds, title, scale);
          return (
            <Animated.View
              key={e.key}
              role="listitem"
              layout={slide && !reduced ? LinearTransition.duration(520) : undefined}
              onLayout={(ev) => {
                const { x, width: w } = ev.nativeEvent.layout;
                slots.current.set(e.key, { x, width: w });
                if (faced) setLaidOut((n) => n + 1);
              }}
              style={faced ? { marginHorizontal: 10 } : undefined}
            >
              {current ? (
                // Drawn first, so the book covers all but the part above its top edge.
                <Ribbon
                  height={RIBBON_LENGTH}
                  style={
                    faced
                      ? { top: -RIBBON_SHOW, right: Math.round(face * 0.16) }
                      : { top: -(READING_LIFT + RIBBON_SHOW), left: (width - RIBBON_WIDTH) / 2 }
                  }
                />
              ) : null}
              {faced ? (
                <FaceOut
                  key={`face:${e.key}`}
                  entry={e}
                  size={face}
                  label={entryLabel(e, t, current)}
                  animate={!reduced}
                />
              ) : (
                <Spine
                  title={title}
                  position={e.position}
                  width={width}
                  height={height}
                  scale={scale}
                  variant={e.kind === 'owned' ? 'book' : e.kind}
                  coverColor={e.coverColor}
                  author={e.copy?.book?.author}
                  finished={e.finished}
                  reading={current}
                  onPress={() => onSelect(e.key)}
                  accessibilityLabel={entryLabel(e, t, current)}
                />
              )}
            </Animated.View>
          );
        })}
      </ScrollView>
      <Plank />
    </View>
  );
}

/** The selected book turned face-out: its cover (from the server that has it) or a
 * ghost cover, opening the book when there is one. */
function FaceOut({
  entry,
  size,
  label,
  animate,
}: {
  entry: SeriesEntry;
  size: number;
  label: string;
  animate: boolean;
}) {
  const { t } = useTranslation();
  const { openBook } = useOpen();
  const turn = useSharedValue(animate ? 0 : 1);
  useEffect(() => {
    if (animate)
      turn.value = withTiming(1, { duration: 560, easing: Easing.bezier(0.2, 0.8, 0.2, 1) });
  }, [animate, turn]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.3 + 0.7 * turn.value,
    transform: [
      { perspective: 900 },
      { rotateY: `${-75 * (1 - turn.value)}deg` },
      { scaleX: 0.35 + 0.65 * turn.value },
    ],
  }));
  const copy = entry.copy;
  const cover = copy ? (
    <BookCover
      connectionId={copy.connectionId}
      libraryId={copy.libraryId}
      path={copy.path}
      coverVersion={entry.coverVersion}
      width={size}
      title={entry.title}
      author={copy.book?.author}
      shadow="lg"
    />
  ) : (
    <GhostCover
      title={entry.title ?? t('covers.bookNumber', { position: entry.position })}
      position={entry.title ? entry.position : undefined}
      width={size}
    />
  );
  return (
    <Animated.View style={[{ transformOrigin: 'left bottom' }, style]}>
      {copy ? (
        <Pressable
          onPress={() => openBook(copy.connectionId, copy.libraryId, copy.path)}
          accessibilityRole="button"
          accessibilityLabel={t('series.openBookLabel', { label })}
          className={Platform.select({
            web: `cursor-pointer rounded-cover ${FOCUS_RING_OFFSET_CLASS}`,
          })}
        >
          {cover}
        </Pressable>
      ) : (
        cover
      )}
    </Animated.View>
  );
}

/** The bookcase's plank: 16px of `shelf-edge` with a light top edge, a darker foot and a
 * soft shadow under it. Decorative. */
export function Plank({ className }: { className?: string }) {
  const themed = useThemeColors();
  const id = useDomId('plank');
  return (
    <View
      className={cn('mx-2', className)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View className="h-4 rounded-[3px] border-b-2 border-t border-b-foreground/10 border-t-card/70 bg-shelf-edge" />
      <Svg width="100%" height={18}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset={0} stopColor={themed.shelfShadow} />
            <Stop offset={1} stopColor={themed.shelfShadow} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="2%" width="96%" height={18} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
