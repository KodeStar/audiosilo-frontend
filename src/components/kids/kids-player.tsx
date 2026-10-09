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
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

/** How far "go back a bit" goes. */
export const KIDS_BACK_SECONDS = 30;

/** The control sizes (STYLEGUIDE section 5: 120 for the kids play button, 64 pt the
 * kids-mode minimum): big from a column that fits them, else the phone's. */
const BIG = { play: 120, button: 84, icon: 32, playIcon: 52, gap: 18 };
const SMALL = { play: 104, button: 72, icon: 28, playIcon: 44, gap: 12 };
/** What a narrow phone shrinks to. */
const MIN_PLAY = 88;
const MIN_BUTTON = 64;
/** The cover beside the controls, and the gap between them. */
const COVER_BESIDE = 300;
const BESIDE_GAP = 40;

const rowWidth = (s: typeof SMALL) => 3 * s.button + s.play + 3 * s.gap;

export type KidsPlayerLayout = typeof SMALL & {
  /** The cover beside the title and controls (else above them). */
  beside: boolean;
  cover: number;
};

/**
 * The player's layout for a content column `width` points wide (0: not measured yet), by
 * the width rather than the form factor: the cover beside the controls once both fit at
 * the big sizes (a landscape tablet, a desktop), the big controls under the cover where
 * only they fit (a portrait tablet), else the phone's sizes, shrunk to keep the four
 * buttons in one row on a narrow phone (a 360 dp Android leaves 328) but never under the
 * kids minimum.
 */
export function kidsPlayerLayout(width: number): KidsPlayerLayout {
  if (width >= COVER_BESIDE + BESIDE_GAP + rowWidth(BIG)) {
    return { ...BIG, beside: true, cover: COVER_BESIDE };
  }
  if (width >= rowWidth(BIG)) return { ...BIG, beside: false, cover: 280 };
  const phone = { ...SMALL, beside: false, cover: 220 };
  if (width <= 0 || width >= rowWidth(SMALL)) return phone;
  const s = width / rowWidth(SMALL);
  return {
    ...phone,
    button: Math.max(MIN_BUTTON, Math.floor(SMALL.button * s)),
    play: Math.max(MIN_PLAY, Math.floor(SMALL.play * s)),
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
export function KidsPlayer({ width }: { width: number }) {
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

  const d = kidsPlayerLayout(width);
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
      className={cn('items-center', d.beside ? 'flex-row justify-center' : 'gap-5')}
      style={d.beside ? { gap: BESIDE_GAP } : undefined}
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
      <View className={cn('items-center gap-4', d.beside ? 'max-w-[480px] flex-1' : 'w-full')}>
        <Text
          className={cn(
            'text-center font-display tracking-tight text-foreground',
            d.beside ? 'text-4xl' : 'text-3xl',
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
            {/* The circular arrow turned to go backwards, with the seconds under it (the
                same arrow unturned is the play button's Try again). */}
            <View className="items-center">
              <View style={{ transform: [{ scaleX: -1 }] }}>
                <Icon name="rotate" size={d.icon - 6} color={themed.foreground} />
              </View>
              <Text className="font-sans-semibold text-sm text-foreground" style={tabularNums}>
                {KIDS_BACK_SECONDS}
              </Text>
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
