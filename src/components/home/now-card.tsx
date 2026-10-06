import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  useBook,
  useBookMeta,
  useBookmarks,
  useCapability,
  useChapters,
  useMyStats,
  type SourcedProgress,
} from '@/api/hooks';
import { ConnectionScope } from '@/api/provider';
import { matchedMeta } from '@/components/library/book-meta';
import { BookCover } from '@/components/library/book-cover';
import { CoverWash } from '@/components/library/cover-wash';
import { listeningProgressFor, splitCharacters } from '@/components/library/meta-gating';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { formatDuration } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { pathLeaf } from '@/lib/paths';
import { chapterBookOffset } from '@/playback/book-queue';
import { selectBookPosition, selectIsPlaying, usePlayer } from '@/playback/store';
import { tabularNums } from '@/theme/tabular-nums';
import { usePlayBook } from '@/components/player/use-play-book';

import { BookScale } from './book-scale';
import { formatDayMonth } from './dates';
import type { BookAt } from './home-model';
import { dailyPace, estimatedFinish } from './listening';
import {
  bookmarkPins,
  bookScale,
  chapterPlace,
  percentHeard,
  timeLeftAtSpeed,
} from './now-card-model';

/** The live position is read in steps this long, so the card redraws every few
 * seconds rather than on every engine tick (its figures are minutes). */
const LIVE_STEP_S = 10;

/**
 * Home's hero (STYLEGUIDE section 8, "Now card"): the book the listener is on, on a card
 * washed with its cover colour. Its hooks run against the book's own server.
 */
export function NowCard({ at, saved }: { at: BookAt; saved?: SourcedProgress }) {
  return (
    <ConnectionScope connectionId={at.connectionId}>
      <NowCardBody at={at} saved={saved} />
    </ConnectionScope>
  );
}

function NowCardBody({ at, saved }: { at: BookAt; saved?: SourcedProgress }) {
  const { t } = useTranslation();
  const layout = useLayout();
  const phone = layout === 'phone';
  const { openBook } = useOpen();
  const play = usePlayBook();
  const { libraryId, path } = at;

  const { data: book } = useBook(libraryId, path);
  const { data: chapterData } = useChapters(libraryId, path);
  const { data: bookmarks } = useBookmarks(libraryId, path);
  const metadata = useCapability('metadata') === true;
  const metaEnabled = metadata && !!(book?.asin || book?.isbn);
  const { data: meta } = useBookMeta(libraryId, path, metaEnabled);
  const { data: stats } = useMyStats('30d');

  // Only this book's own figures follow the player; any other book reads its save.
  const loaded = usePlayer(
    (s) =>
      s.nowPlaying?.connectionId === at.connectionId &&
      s.nowPlaying.libraryId === libraryId &&
      s.nowPlaying.path === path,
  );
  const livePosition = usePlayer((s) =>
    loaded ? Math.floor(selectBookPosition(s) / LIVE_STEP_S) * LIVE_STEP_S : 0,
  );
  const playing = usePlayer((s) => loaded && selectIsPlaying(s));
  const rate = usePlayer((s) => s.rate);

  // Chapter starts recomputed from the file durations, as the book page does (the
  // server's `book_offset` is unreliable on some books).
  const { titles, starts } = useMemo(() => {
    const chapters = chapterData?.chapters ?? [];
    const files = (chapterData?.files ?? []).map((f) => ({
      path: f.rel_path,
      duration: f.duration,
    }));
    return {
      titles: chapters.map((c) => c.title),
      starts: chapters.map((c) => (files.length ? chapterBookOffset(files, c) : c.book_offset)),
    };
  }, [chapterData]);

  const total = chapterData?.duration || saved?.duration || book?.duration || 0;
  // While a book is still loading the player reports 0: keep the saved place until it
  // has really moved.
  const position = loaded && livePosition > 0 ? livePosition : (saved?.position ?? 0);
  const finished = !!saved?.finished && !loaded;
  const speed = loaded ? rate : saved?.playback_speed || 1;
  const percent = percentHeard(position, total, finished);
  const left = timeLeftAtSpeed(position, total, speed);
  const place = chapterPlace(titles, starts, position);
  const segments = bookScale(starts, total, position, phone ? 60 : undefined);
  const pins = bookmarkPins(
    (bookmarks ?? []).map((b) => b.position),
    total,
  );
  const pace = stats ? dailyPace(stats.days) : null;
  const finishOn =
    pace && left > 0 ? formatDayMonth(estimatedFinish(left, pace, new Date())) : null;

  const work = matchedMeta(meta, metaEnabled)?.work;
  const characters = work?.characters ?? [];
  // Characters met so far, gated exactly like the book page's Characters tab.
  const met = splitCharacters(
    characters,
    listeningProgressFor({ chapterStarts: starts, position, finished: !!saved?.finished }),
  ).visible.length;
  const hasStory = (work?.recaps?.length ?? 0) > 0;

  const title = book?.title || pathLeaf(path);
  const series = book?.series
    ? book.series_index
      ? t('home.now.seriesBook', { series: book.series, position: book.series_index })
      : book.series
    : '';
  const eyebrow = phone
    ? series || book?.author || ''
    : [t('home.continueListening'), series].filter(Boolean).join(' · ');

  const onResume = () =>
    void play(at, { toggle: true, viaBookPage: true }).catch((e: unknown) => {
      console.warn('[home] resume failed', e);
      toast({ title: t('home.now.resumeFailed') });
    });
  const resumeLabel = playing
    ? t('home.now.pause')
    : place
      ? t('home.now.resumeChapter', { chapter: place.number })
      : t('home.now.resume');

  const cover = (
    <AnimatedPressable
      onPress={() => openBook(at.connectionId, libraryId, path)}
      accessibilityRole="button"
      accessibilityLabel={t('home.now.openBook', { title })}
    >
      <BookCover
        connectionId={at.connectionId}
        libraryId={libraryId}
        path={path}
        coverVersion={book?.cover_version}
        width={phone ? 108 : 220}
        title={title}
        author={book?.author}
        shadow="lg"
      />
    </AnimatedPressable>
  );

  const chapterLine = place ? (
    <View className="flex-row items-center gap-2.5">
      <View className="rounded-md bg-muted px-[7px] py-0.5">
        <Text variant="mono" className="text-muted-foreground">
          {phone
            ? t('home.now.chapterShort', { chapter: place.number, total: place.count })
            : t('home.now.chapterOf', { chapter: place.number, total: place.count })}
        </Text>
      </View>
      <Text variant="label" className="min-w-0 flex-1 text-[15px]" numberOfLines={1}>
        {place.title}
      </Text>
    </View>
  ) : null;

  const statsRow = (
    <View className="mt-1 flex-row flex-wrap gap-x-[22px] gap-y-2">
      <Stat value={`${percent}%`} label={t('home.now.through')} />
      {left > 0 ? (
        <Stat
          value={formatDuration(left)}
          label={t('home.now.leftAt', { speed: formatSpeed(speed) })}
        />
      ) : null}
      {finishOn ? <Stat value={finishOn} label={t('home.now.finishPace')} /> : null}
    </View>
  );

  const resumeButton = (
    <Button
      size="lg"
      icon={playing ? 'pause' : 'play'}
      title={resumeLabel}
      onPress={onResume}
      className={phone ? 'w-full' : undefined}
    />
  );
  const companion = [
    characters.length > 0 ? (
      <Button
        key="who"
        size="lg"
        variant="outline"
        icon="users"
        onPress={() => openBook(at.connectionId, libraryId, path, 'characters')}
        accessibilityLabel={t('home.now.whosWhoLabel', { count: met })}
        className={phone ? 'flex-1 px-3' : undefined}
      >
        <Text numberOfLines={1}>{t('home.now.whosWho')}</Text>
        <Text className="text-muted-foreground" style={tabularNums}>
          {met}
        </Text>
      </Button>
    ) : null,
    hasStory ? (
      <Button
        key="story"
        size="lg"
        variant={phone ? 'outline' : 'ghost'}
        icon="book-open"
        title={t('home.now.storySoFar')}
        onPress={() => openBook(at.connectionId, libraryId, path, 'recaps')}
        className={phone ? 'flex-1 px-3' : undefined}
      />
    ) : null,
  ].filter(Boolean);

  return (
    <View
      accessibilityLabel={t('home.continueListening')}
      className={
        phone
          ? 'relative gap-4 overflow-hidden rounded-[22px] border border-border bg-card p-[18px]'
          : 'relative flex-row gap-8 overflow-hidden rounded-sheet border border-border bg-card p-7'
      }
    >
      <CoverWash color={book?.cover_color} variant="card" />
      {phone ? (
        <>
          <View className="flex-row items-center gap-3.5">
            {cover}
            <View className="min-w-0 flex-1 gap-1.5">
              {eyebrow ? (
                <Text variant="eyebrow" className="text-[10.5px]" numberOfLines={2}>
                  {eyebrow}
                </Text>
              ) : null}
              <Text variant="display" className="text-[24px] leading-[26px]" numberOfLines={3}>
                {title}
              </Text>
            </View>
          </View>
          {chapterLine}
          <BookScale segments={segments} pins={pins} percent={percent} />
          {statsRow}
          <View className="gap-2">
            {resumeButton}
            {companion.length > 0 ? <View className="flex-row gap-2">{companion}</View> : null}
          </View>
        </>
      ) : (
        <>
          {cover}
          <View className="min-w-0 flex-1 gap-2.5">
            {eyebrow ? (
              <Text variant="eyebrow" numberOfLines={2}>
                {eyebrow}
              </Text>
            ) : null}
            <Text
              variant="display"
              className="text-[36px] leading-[38px] tracking-tighter"
              numberOfLines={3}
            >
              {title}
            </Text>
            {chapterLine}
            <BookScale segments={segments} pins={pins} percent={percent} />
            {statsRow}
            <View className="mt-auto flex-row flex-wrap gap-2 pt-2">
              {resumeButton}
              {companion}
            </View>
          </View>
        </>
      )}
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View>
      <Text className="font-display text-lg tracking-tight text-foreground" style={tabularNums}>
        {value}
      </Text>
      <Text variant="caption">{label}</Text>
    </View>
  );
}

/** "1.25×", as the player writes speeds. */
function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}

/** The Now card's shape while Home's progress loads, so nothing shifts when it lands. */
export function NowCardSkeleton() {
  const phone = useLayout() === 'phone';
  return phone ? (
    <Skeleton className="h-[380px] w-full rounded-[22px]" />
  ) : (
    <Skeleton className="h-[278px] w-full rounded-sheet" />
  );
}
