import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Platform, Pressable, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';

import { FOCUS_RING_CLASS } from '@/components/ui/text';
import { useLatest } from '@/lib/use-latest';
import { cn } from '@/lib/utils';

import { CARD_DESIGN_WIDTH, cardHeight } from './card-size';
import { StoryCard } from './story-card';
import type { StoryPlayer } from './use-story-player';
import { type CardCopy, cardSpeech } from './year-copy';
import type { YearCard } from './year-model';

/**
 * The story on stage (STYLEGUIDE section 8, "Year in listening"): the current card with
 * the progress bars over it, a tap on the left third for the previous card and on the
 * rest for the next (two labelled buttons, each far over 44 pt), the arrow keys on the
 * web, and a hold (a finger or the pointer on the card, the keyboard focus in it) that
 * freezes it (`onHold`). The card itself (`cardRef`, what a share captures) holds none of
 * this: the bars and the buttons are laid over it. A screen reader hears "Card N of M"
 * and the card's words; on a native one, moving to a card announces it.
 */
export function StoryStage({
  cards,
  copies,
  player,
  width,
  connectionId,
  cardRef,
  plainCovers,
  screenReader,
  onHold,
  rounded = true,
  children,
}: {
  cards: readonly YearCard[];
  copies: readonly CardCopy[];
  player: StoryPlayer;
  width: number;
  connectionId: string;
  cardRef: RefObject<View | null>;
  plainCovers: boolean;
  screenReader: boolean;
  /** Whether the listener is holding the card (see above). */
  onHold: (held: boolean) => void;
  /** Rounded corners (the inline stage); the full-screen phone story is square. */
  rounded?: boolean;
  /** Laid over the card and its tap zones (the full-screen story's close button). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const u = width / CARD_DESIGN_WIDTH;
  const { index } = player;
  const card = cards[index];
  const copy = copies[index];
  const cardOf = t('year.cardOf', { n: index + 1, total: cards.length });
  const speech = copy ? `${cardOf}. ${cardSpeech(copy)}` : cardOf;

  // Why the listener is holding the card: a finger or the pointer on it, the keyboard
  // focus in it. Any of them stops the story where it is.
  const [holds, setHolds] = useState({ press: false, hover: false, focus: false });
  const pointer = useRef(false);
  const held = holds.press || holds.hover || holds.focus;
  const report = useLatest(onHold);
  useEffect(() => report(held), [held, report]);

  // A native screen reader hears each card it moves to (the web's live region does that).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (screenReader && Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(speech);
    // Only on a move: the words of the same card don't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  if (!card || !copy) return null;

  const keys =
    Platform.OS === 'web'
      ? {
          onKeyDown: (e: {
            key: string;
            preventDefault: () => void;
            stopPropagation: () => void;
          }) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            // The player's own arrow keys (skip back and forward) must not fire too.
            e.stopPropagation();
            if (e.key === 'ArrowLeft') player.previous();
            else player.next();
          },
        }
      : {};
  const hold = {
    onPressIn: () => {
      pointer.current = true;
      setHolds((h) => ({ ...h, press: true }));
    },
    onPressOut: () => {
      pointer.current = false;
      setHolds((h) => ({ ...h, press: false }));
    },
    onHoverIn: () => setHolds((h) => ({ ...h, hover: true })),
    onHoverOut: () => setHolds((h) => ({ ...h, hover: false })),
    // Only the keyboard's focus holds: a click focuses the button too (the press comes
    // first), and the story should move on once the pointer leaves.
    onFocus: () => {
      if (!pointer.current) setHolds((h) => ({ ...h, focus: true }));
    },
    onBlur: () => setHolds((h) => ({ ...h, focus: false })),
  };

  return (
    <View
      {...keys}
      style={{
        width,
        height: cardHeight(width),
        borderRadius: rounded ? 28 * u : 0,
        boxShadow: rounded ? '0px 30px 70px -20px rgba(14, 22, 48, 0.5)' : undefined,
      }}
      className="overflow-hidden bg-black"
    >
      <View
        ref={cardRef}
        collapsable={false}
        accessible={Platform.OS !== 'web'}
        accessibilityLabel={Platform.OS === 'web' ? cardOf : speech}
        accessibilityLiveRegion="polite"
        role="region"
        aria-live="polite"
        testID="year-story-card"
      >
        <StoryCard
          card={card}
          copy={copy}
          width={width}
          connectionId={connectionId}
          plainCovers={plainCovers}
        />
      </View>
      <StoryBars count={cards.length} index={index} progress={player.progress} u={u} />
      <View className="absolute inset-0 flex-row">
        <Pressable
          role="button"
          accessibilityLabel={t('year.previous')}
          onPress={player.previous}
          {...hold}
          className={cn('flex-1', Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }))}
        />
        <Pressable
          role="button"
          accessibilityLabel={t('year.next')}
          onPress={player.next}
          {...hold}
          className={cn('flex-[2]', Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }))}
        />
      </View>
      {children}
    </View>
  );
}

/** The progress bars along the top: done cards full, the current one filling. */
function StoryBars({
  count,
  index,
  progress,
  u,
}: {
  count: number;
  index: number;
  progress: SharedValue<number>;
  u: number;
}) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute flex-row"
      style={{ top: 12 * u, left: 14 * u, right: 14 * u, gap: 4 * u }}
    >
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          className="h-[3px] flex-1 overflow-hidden rounded-full"
          style={{ backgroundColor: 'rgba(255, 255, 255, 0.3)' }}
        >
          {i < index ? (
            <View className="h-full w-full bg-white" />
          ) : i === index ? (
            <CurrentBar progress={progress} />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function CurrentBar({ progress }: { progress: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({ width: `${Math.round(progress.value * 1000) / 10}%` }));
  return <Animated.View className="h-full bg-white" style={style} />;
}
