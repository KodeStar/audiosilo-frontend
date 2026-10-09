import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { stepSegment, currentSegment } from '@/components/player/transport';
import { BookCover } from '@/components/library/book-cover';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { chapterLabel } from '@/lib/chapter-label';
import { cn } from '@/lib/utils';
import {
  selectBookPosition,
  selectCurrentChapter,
  selectIsPlaying,
  usePlayer,
} from '@/playback/store';
import { useThemeColors } from '@/theme/use-theme-colors';

/** How far "go back a bit" goes. */
export const KIDS_BACK_SECONDS = 30;

/** Sizes per form: the cover, the play button, the other buttons and the gap between
 * them (STYLEGUIDE section 5: 120 for the kids play button, 64 pt the kids minimum). */
const SIZES = {
  phone: { cover: 220, play: 104, button: 72, icon: 28, playIcon: 44, gap: 12 },
  wide: { cover: 300, play: 120, button: 84, icon: 32, playIcon: 52, gap: 18 },
} as const;

/** The play button and kids minimum a narrow phone shrinks to. */
const MIN_PLAY = 88;
const MIN_BUTTON = 64;

export type KidsPlayerSizes = { [K in keyof (typeof SIZES)['phone']]: number };

/**
 * The player's sizes for a content column `width` points wide (0: not measured yet): the
 * wide set from a tablet up, else the phone set, shrunk to fit the four buttons in one row
 * on a narrow phone (a 360 dp Android leaves 328), never under the kids minimum.
 */
export function kidsPlayerSizes(wide: boolean, width: number): KidsPlayerSizes {
  if (wide) return SIZES.wide;
  const p = SIZES.phone;
  const row = 3 * p.button + p.play + 3 * p.gap;
  if (width <= 0 || width >= row) return p;
  const s = width / row;
  return {
    ...p,
    button: Math.max(MIN_BUTTON, Math.floor(p.button * s)),
    play: Math.max(MIN_PLAY, Math.floor(p.play * s)),
    gap: 8,
  };
}

/** One round control: a real frame of `size` points, with a label for screen readers. */
function RoundButton({
  size,
  label,
  onPress,
  className,
  testID,
  busy,
  children,
}: {
  size: number;
  label: string;
  onPress: () => void;
  className?: string;
  testID?: string;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <AnimatedPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={busy ? { busy: true } : undefined}
      testID={testID}
      className={cn(
        'items-center justify-center rounded-full',
        className,
        Platform.select({ web: cn('cursor-pointer', FOCUS_RING_OFFSET_CLASS) }),
      )}
      style={{ width: size, height: size }}
    >
      {children}
    </AnimatedPressable>
  );
}

/**
 * Kids mode's player (it replaces the full player there): the cover, the title, the
 * chapter, a simple progress line through the chapter (no scrubbing), and four big
 * buttons, previous chapter, go back 30 s, play/pause and next chapter. Nothing else (no
 * speed, sleep, bookmarks, Up next or sharing). Bound to the player store; renders
 * nothing with no book loaded. The progress line is the view's one pink thing; the play
 * button is ink, as everywhere in Stacks.
 */
export function KidsPlayer({ wide, width }: { wide: boolean; width: number }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const state = usePlayer((s) => s.snapshot.state);
  const playing = usePlayer(selectIsPlaying);
  const chapter = usePlayer(selectCurrentChapter);
  const bookPosition = usePlayer(selectBookPosition);
  const trackPosition = usePlayer((s) => s.snapshot.position);
  const trackDuration = usePlayer((s) => s.snapshot.duration);
  const rate = usePlayer((s) => s.rate);
  if (!nowPlaying) return null;

  const d = kidsPlayerSizes(wide, width);
  const segment = currentSegment({
    total: nowPlaying.queue.total,
    bookPosition,
    chapter,
    trackPosition,
    trackDuration,
  });
  const fraction = Math.min(1, Math.max(0, segment.elapsed / segment.length));
  const minutesLeft = Math.max(
    1,
    Math.ceil((segment.length - segment.elapsed) / Math.max(0.1, rate) / 60),
  );
  const chapterName = chapter ? chapterLabel(chapter, t) : '';
  const isError = state === 'error';
  const store = () => usePlayer.getState();
  const playLabel = isError
    ? t('kids.player.retry')
    : playing
      ? t('kids.player.pause')
      : t('kids.player.play');

  return (
    <View
      testID="kids-player"
      className={cn('items-center', wide ? 'flex-row justify-center gap-10' : 'gap-5')}
    >
      <BookCover
        connectionId={nowPlaying.connectionId}
        libraryId={nowPlaying.libraryId}
        path={nowPlaying.path}
        width={d.cover}
        title={nowPlaying.title}
        author={nowPlaying.author}
        shadow="lg"
        className="rounded-[22px]"
      />
      <View className={cn('items-center gap-4', wide ? 'max-w-[480px] flex-1' : 'w-full')}>
        <Text
          className={cn(
            'text-center font-display tracking-tight text-foreground',
            wide ? 'text-4xl' : 'text-3xl',
          )}
          numberOfLines={3}
          accessibilityRole="header"
        >
          {nowPlaying.title}
        </Text>
        {chapterName ? (
          <Text
            testID="kids-chapter"
            className="text-center font-sans text-lg text-muted-foreground"
            numberOfLines={2}
          >
            {t('kids.player.chapterLeft', { chapter: chapterName, count: minutesLeft })}
          </Text>
        ) : null}
        <View
          testID="kids-progress"
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t('kids.player.progress')}
          accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
          className="h-3 w-full max-w-[360px] overflow-hidden rounded-full bg-muted"
        >
          <View className="h-full rounded-full bg-brand" style={{ width: `${fraction * 100}%` }} />
        </View>
        <View className="flex-row items-center justify-center" style={{ gap: d.gap }}>
          <RoundButton
            size={d.button}
            label={t('kids.player.previous')}
            onPress={() => stepSegment(store(), -1)}
            className="bg-secondary"
            testID="kids-previous"
          >
            <Icon name="prev" size={d.icon} color={themed.foreground} />
          </RoundButton>
          <RoundButton
            size={d.button}
            label={t('kids.player.back', { count: KIDS_BACK_SECONDS })}
            onPress={() => void store().skipSeconds(-KIDS_BACK_SECONDS)}
            className="bg-secondary"
            testID="kids-back"
          >
            {/* The circular arrow, turned to go backwards. */}
            <View style={{ transform: [{ scaleX: -1 }] }}>
              <Icon name="rotate" size={d.icon} color={themed.foreground} />
            </View>
          </RoundButton>
          <RoundButton
            size={d.play}
            label={playLabel}
            busy={state === 'loading'}
            onPress={() => void (isError ? store().retry() : store().toggle())}
            className="bg-primary shadow-overlay"
            testID="kids-play"
          >
            {state === 'loading' ? (
              <Spinner size="large" color={themed.primaryForeground} />
            ) : (
              <View style={playing || isError ? undefined : { marginLeft: d.playIcon * 0.12 }}>
                <Icon
                  name={isError ? 'rotate' : playing ? 'pause' : 'play'}
                  size={d.playIcon}
                  color={themed.primaryForeground}
                />
              </View>
            )}
          </RoundButton>
          <RoundButton
            size={d.button}
            label={t('kids.player.next')}
            onPress={() => stepSegment(store(), 1)}
            className="bg-secondary"
            testID="kids-next"
          >
            <Icon name="next" size={d.icon} color={themed.foreground} />
          </RoundButton>
        </View>
      </View>
    </View>
  );
}
