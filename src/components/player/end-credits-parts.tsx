import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import type { Book, BookMetaAttribution, BookMetaRecording } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { GhostCover } from '@/components/library/ghost-cover';
import { Spine } from '@/components/series/spine';
import { spineDims } from '@/components/series/spine-fit';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { ProgressRing } from '@/components/ui/progress-ring';
import { Skeleton } from '@/components/ui/skeleton';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { useDownloadEntry } from '@/downloads/store';
import { formatCountdown, formatDuration } from '@/lib/format';
import { openExternalUrl } from '@/lib/support';
import { cn } from '@/lib/utils';
import type { UnplacedWork, UpNextBook } from '@/playback/up-next-resolver';
import { useConnectionName } from '@/stores/session';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import {
  GRACE_SECONDS,
  nextAvailability,
  spinesThatFit,
  upNextReason,
  type EndCreditsDecision,
} from './end-credits-logic';

// The pieces of the end-credits screen (`end-credits.tsx`), each taking plain data.

// --- The year shelf ------------------------------------------------------------------

/** One book on the year shelf. */
export type ShelfBook = {
  key: string;
  title: string;
  author?: string;
  /** Seconds, when known (sets the spine's width). */
  seconds?: number;
  coverColor?: Book['cover_color'];
};

const SPINE_GAP = 3;

/**
 * The books finished this year as spines on a shelf, oldest to newest, with the book
 * just finished dropping in at the end (STYLEGUIDE section 6, "Spine drop": a 700-900 ms
 * spring, instant with reduced motion). The oldest are left off when the row would
 * overflow. One image to assistive tech, named by its count.
 */
export function YearShelf({
  others,
  current,
  phone,
  count,
}: {
  others: readonly ShelfBook[];
  current: ShelfBook;
  phone: boolean;
  /** The year's finished books, for the label. */
  count: number;
}) {
  const { t } = useTranslation();
  const [room, setRoom] = useState(0);
  const scale = phone ? 0.62 : 0.74;
  const currentScale = phone ? 0.74 : 0.9;
  const sized = others.map((b) => ({ b, ...spineDims(b.seconds, b.title, scale) }));
  const mine = spineDims(current.seconds, current.title, currentScale);
  const newestFirst = [...sized].reverse();
  const fit =
    room > 0
      ? spinesThatFit(
          newestFirst.map((s) => s.width),
          room - mine.width,
          SPINE_GAP,
        )
      : 0;
  const shown = newestFirst.slice(0, fit).reverse();
  return (
    <View
      accessible
      role="img"
      accessibilityLabel={t('player.finished.yearShelf', { count })}
      onLayout={(e) => setRoom(e.nativeEvent.layout.width)}
      style={{ gap: SPINE_GAP, minHeight: mine.height + 8 }}
      className="w-full flex-row items-end justify-center"
    >
      {shown.map(({ b, width, height }, i) => (
        <View key={b.key} style={{ opacity: 0.35 + ((i + 1) / (shown.length + 1)) * 0.5 }}>
          <Spine
            title={b.title}
            author={b.author}
            width={width}
            height={height}
            scale={scale}
            variant="book"
            coverColor={b.coverColor}
          />
        </View>
      ))}
      <SpineDrop>
        <Spine
          title={current.title}
          author={current.author}
          width={mine.width}
          height={mine.height}
          scale={currentScale}
          variant="book"
          coverColor={current.coverColor}
        />
      </SpineDrop>
    </View>
  );
}

/** The finished book landing on the shelf. */
function SpineDrop({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const drop = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) return;
    drop.value = withDelay(
      300,
      withTiming(1, { duration: 800, easing: Easing.bezier(0.34, 1.36, 0.64, 1) }),
    );
  }, [reduced, drop]);
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, drop.value * 1.6),
    transform: [{ translateY: -90 * (1 - drop.value) }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

// --- Stat tiles ------------------------------------------------------------------------

/** A Stacks stat tile: a label over a Bricolage value. */
export function StatTile({
  label,
  value,
  phone,
}: {
  label: string;
  value: string;
  phone: boolean;
}) {
  return (
    <Card className={cn('min-w-0 max-w-[232px] flex-1 gap-1', phone ? 'p-3' : 'p-4')}>
      <Text variant="caption" numberOfLines={1}>
        {label}
      </Text>
      <Text
        variant="stat"
        numberOfLines={1}
        adjustsFontSizeToFit
        className={phone ? 'text-xl' : 'text-2xl'}
        style={tabularNums}
      >
        {value}
      </Text>
    </Card>
  );
}

// --- The credits dialog -----------------------------------------------------------------

export type CreditsData = {
  title: string;
  author?: string;
  narrator?: string;
  recording?: BookMetaRecording;
  released?: string;
  attribution?: BookMetaAttribution;
  path: string;
};

/** Who made the book and where it lives: written by, read by, publisher and release when
 * known, the community credit the server writes (never composed here), and the path on
 * the server. */
export function CreditsDialog({
  open,
  onOpenChange,
  data,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: CreditsData;
}) {
  const { t } = useTranslation();
  const narrator =
    data.narrator || data.recording?.narrators.map((n) => n.name).join(', ') || undefined;
  const rows: [string, ReactNode][] = [];
  const text = (value: string, mono = false) => (
    <Text variant={mono ? 'mono' : 'body'} className="text-sm" selectable>
      {value}
    </Text>
  );
  if (data.author) rows.push([t('player.finished.writtenBy'), text(data.author)]);
  if (narrator) rows.push([t('player.finished.readBy'), text(narrator)]);
  if (data.recording?.publisher)
    rows.push([t('player.finished.publisher'), text(data.recording.publisher)]);
  if (data.released) rows.push([t('player.finished.released'), text(data.released)]);
  const credit = data.attribution;
  if (credit)
    rows.push([
      t('player.finished.community'),
      <Pressable
        key="credit"
        role="link"
        onPress={() => void openExternalUrl(credit.source_url)}
        className={cn('self-start rounded-sm', Platform.select({ web: FOCUS_RING_CLASS }))}
      >
        <Text className="text-sm text-brand-ink underline">
          {[credit.credit, credit.license].filter(Boolean).join(' · ')}
        </Text>
      </Pressable>,
    ]);
  rows.push([t('player.finished.onServer'), text(data.path, true)]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader className="flex-row items-center gap-3">
          <DialogIcon name="microphone" />
          <View className="min-w-0 flex-1">
            <DialogTitle>{t('player.finished.credits')}</DialogTitle>
            <Text variant="muted" numberOfLines={2}>
              {data.title}
            </Text>
          </View>
        </DialogHeader>
        <View className="mt-4 gap-3">
          {rows.map(([label, value]) => (
            <View key={label} className="flex-row gap-3">
              <Text variant="caption" className="w-[118px] pt-0.5">
                {label}
              </Text>
              <View className="min-w-0 flex-1">{value}</View>
            </View>
          ))}
        </View>
      </DialogContent>
    </Dialog>
  );
}

// --- Up next ------------------------------------------------------------------------------

/** The countdown ring (the view's one pink thing): empties over the grace seconds, the
 * seconds left in the middle. */
function CountdownRing({ seconds }: { seconds: number }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const left = Math.ceil(seconds);
  return (
    <View
      accessible
      role="timer"
      accessibilityLabel={t('player.finished.countdown', { count: left })}
    >
      <ProgressRing
        fraction={seconds / GRACE_SECONDS}
        size={52}
        stroke={4}
        color={themed.brand}
        trackColor={themed.border}
      >
        <Text className="font-display text-base" style={tabularNums}>
          {left}
        </Text>
      </ProgressRing>
    </View>
  );
}

/** The next book: why it is next, its length and where it plays from, Play now and (while
 * auto-play counts down) Not now with the ring. */
export function UpNextCard({
  next,
  decision,
  stillPlaying,
  phone,
  starting = false,
  onPlay,
  onNotNow,
}: {
  next: UpNextBook;
  decision: EndCreditsDecision;
  /** The finished book is still playing: the countdown is its remaining audio. */
  stillPlaying: boolean;
  phone: boolean;
  /** The next book is being started (Play now shows it is busy). */
  starting?: boolean;
  onPlay: () => void;
  onNotNow: () => void;
}) {
  const { t } = useTranslation();
  const server = useConnectionName(next.connectionId);
  const entry = useDownloadEntry(next.connectionId, next.libraryId, next.path);
  const reason = upNextReason(next);
  const where = nextAvailability(entry);
  const whereLabel =
    where.kind === 'downloaded'
      ? t('player.finished.downloaded')
      : where.kind === 'downloading'
        ? t('player.finished.downloading', { percent: where.percent })
        : server
          ? t('player.finished.streamsFrom', { server })
          : '';
  const meta = [formatDuration(next.duration), whereLabel].filter(Boolean).join(' · ');
  const ring = decision.showCountdown && !stillPlaying;
  return (
    <Card
      className={cn(
        'w-full max-w-[560px] flex-row items-center',
        phone ? 'gap-3 p-3' : 'gap-4 p-4',
      )}
    >
      <BookCover
        connectionId={next.connectionId}
        libraryId={next.libraryId}
        path={next.path}
        coverVersion={next.book?.cover_version}
        width={phone ? 72 : 84}
        title={next.title}
        author={next.author}
      />
      <View className="min-w-0 flex-1 gap-1">
        <Text variant="eyebrow" numberOfLines={2}>
          {t(`player.finished.${reason.key}`, reason.values)}
        </Text>
        <Text variant="heading" numberOfLines={2}>
          {next.title}
        </Text>
        {meta ? (
          <Text variant="caption" style={tabularNums} numberOfLines={2}>
            {meta}
          </Text>
        ) : null}
        <View className="mt-1.5 flex-row flex-wrap items-center gap-2">
          <Button
            size="sm"
            icon="play"
            title={t('player.finished.playNow')}
            accessibilityLabel={t('player.finished.playNowLabel', { title: next.title })}
            loading={starting}
            onPress={onPlay}
          />
          {decision.showCountdown ? (
            <Button
              size="sm"
              variant="ghost"
              title={t('player.finished.notNow')}
              onPress={onNotNow}
            />
          ) : null}
        </View>
        {decision.showCountdown && stillPlaying ? (
          <Text variant="caption" style={tabularNums}>
            {t('player.finished.startingIn', { time: formatCountdown(decision.countdownSeconds) })}
          </Text>
        ) : null}
      </View>
      {ring ? <CountdownRing seconds={decision.countdownSeconds} /> : null}
    </Card>
  );
}

/** While the next book is being worked out: the card's shape. */
export function UpNextSkeleton() {
  return (
    <Card className="w-full max-w-[560px] flex-row items-center gap-4 p-4">
      <Skeleton className="h-[84px] w-[84px] rounded-cover" />
      <View className="flex-1 gap-2">
        <Skeleton className="h-3 w-32 rounded-sm" />
        <Skeleton className="h-5 w-3/4 rounded-sm" />
        <Skeleton className="h-[30px] w-24 rounded-lg" />
      </View>
    </Card>
  );
}

/** Nothing on this server follows the book: the end of its series (or folder), or the
 * community's next work that this server doesn't have, as a ghost that is never played. */
export function EndOfSeries({ series, unplaced }: { series?: string; unplaced?: UnplacedWork }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const title = unplaced ? t('player.finished.notOnServerTitle') : t('player.finished.endOfSeries');
  const body = unplaced
    ? unplaced.position
      ? t('player.finished.notOnServerBook', { position: unplaced.position, title: unplaced.title })
      : t('player.finished.notOnServer', { title: unplaced.title })
    : series
      ? t('player.finished.endOfSeriesBody', { series })
      : t('player.finished.endOfSeriesNoName');
  return (
    <Card className="w-full max-w-[560px] flex-row items-start gap-3 p-4">
      {unplaced ? (
        <GhostCover title={unplaced.title} position={unplaced.position || undefined} width={56} />
      ) : (
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-secondary">
          <Icon name="circle-check" size={18} color={themed.secondaryForeground} />
        </View>
      )}
      <View className="min-w-0 flex-1 gap-1">
        <Text variant="label">{title}</Text>
        <Text variant="muted">{body}</Text>
        {unplaced ? (
          <Button
            variant="link"
            size="sm"
            icon="arrow-up-right"
            title={t('book.meta.viewOnMeta')}
            onPress={() => void openExternalUrl(unplaced.webUrl)}
            className="mt-1 self-start"
          />
        ) : null}
      </View>
    </Card>
  );
}
