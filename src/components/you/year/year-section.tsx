import { router } from 'expo-router';
import { type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { useMyStats } from '@/api/hooks';
import { useCid } from '@/api/provider';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';

import { StoryBackground } from './story-background';
import { cardHeight } from './card-size';
import { StoryStage } from './story-stage';
import { StoryText } from './story-text';
import { useScreenReaderEnabled } from './use-screen-reader';
import { useShareCard } from './use-share-card';
import { useStoryPlayer } from './use-story-player';
import { type YearRange, type YearStory, useStatsServers, useYearStory } from './use-year-story';
import { yearHref } from './year-href';
import { shareFileName } from './year-model';
import { YearPickers, YearThumbs } from './year-parts';
import { useStoryYears } from './year-probes';

/** The stage's card width on a tablet or desktop (the prototype's 360). */
const STAGE_WIDTH = 360;
/** From this measured width the column sits beside the stage, not under it. */
const SIDE_BY_SIDE_MIN = 720;
const SIDE_GAP = 48;

type Ready = Extract<YearStory, { status: 'ready' }>;

/**
 * Year in listening (STYLEGUIDE section 8), the You hub's Year section: the listener's
 * year on one server as story cards, from their own stats (`useYearStory`).
 *
 * - **Tablet and desktop**, laid out by the MEASURED width (the Up next drawer can take
 *   300-480 px): the story on stage (`StoryStage`: progress bars, tap left/right, 6 s per
 *   card, held while reduced motion is on, a screen reader runs, a share is being made or
 *   the pointer, a finger or the keyboard focus is on it; arrow keys on the web) beside a
 *   column with the title, how it works and the privacy line, the thumbnails and "Share
 *   this card". Under the stage when the width is too narrow for both.
 * - **Phone**: an intro (the year banner, the thumbnails) whose "Play the story" (or a
 *   thumbnail) opens the full-screen story (`/year`, `yearHref`).
 *
 * The server picker shows with more than one server that keeps stats; the year picker once
 * an earlier year has a story too (`useStoryYears`). A server without `user_stats` gets a
 * calm notice, a year with too little listening a calm empty state, never empty cards.
 * Shares are images (`useShareCard`); there is no share link.
 */
export function YearSection() {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const defaultCid = useCid();
  const servers = useStatsServers();
  const [picked, setPicked] = useState<string | null>(null);
  const cid = picked && servers.some((s) => s.id === picked) ? picked : defaultCid;
  const [range, setRange] = useState<YearRange>('year');
  const story = useYearStory(cid, range);
  // This year's number (server time), whichever year is on show.
  const thisYearRange = useMyStats('year', cid).data?.range;
  const thisYear = thisYearRange ? Number(thisYearRange) : null;
  const { past, probe } = useStoryYears(cid, thisYear);
  const shownYear = range === 'year' ? thisYear : Number(range);
  const [width, setWidth] = useState(0);

  const pickers = (
    <YearPickers
      servers={servers}
      cid={cid}
      onServer={(id) => {
        setPicked(id);
        setRange('year');
      }}
      years={thisYear ? [thisYear, ...past] : []}
      year={shownYear}
      onYear={(y) => setRange(y === thisYear ? 'year' : `${y}`)}
    />
  );
  const privacy = t('year.privacy', { server: story.serverName });

  let body: ReactNode;
  if (story.status === 'ready' && width > 0) {
    body = phone ? (
      <YearIntro
        story={story}
        width={width}
        pickers={pickers}
        privacy={privacy}
        onOpen={(card) =>
          router.push(
            yearHref({
              year: range === 'year' ? undefined : Number(range),
              connection: cid !== defaultCid ? cid : undefined,
              card,
            }),
          )
        }
      />
    ) : (
      <YearStage
        key={`${cid}:${range}`}
        story={story}
        cid={cid}
        width={width}
        pickers={pickers}
        privacy={privacy}
      />
    );
  } else {
    body = (
      <View className="gap-5">
        {story.status === 'unsupported' ? null : pickers}
        <YearState story={story} phone={phone} width={width} />
      </View>
    );
  }

  return (
    <View
      className="w-full"
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      testID="year-section"
    >
      {body}
      {probe}
    </View>
  );
}

/** Loading, unsupported, error and empty: a calm state in the section's place. */
function YearState({ story, phone, width }: { story: YearStory; phone: boolean; width: number }) {
  const { t } = useTranslation();
  switch (story.status) {
    case 'unsupported':
      return (
        <Notice
          icon="circle-info"
          title={t('year.unsupported.title')}
          body={t('year.unsupported.body', { server: story.serverName })}
        />
      );
    case 'error':
      return (
        <EmptyState
          variant="card"
          icon="circle-exclamation"
          title={t('year.error.title')}
          hint={t('year.error.body', { server: story.serverName })}
          action={{ label: t('common.retry'), onPress: story.retry, icon: 'rotate' }}
        />
      );
    case 'empty':
      return (
        <EmptyState
          variant="card"
          icon="sparkles"
          title={t('year.empty.title')}
          hint={
            story.current
              ? t('year.empty.current')
              : t('year.empty.past', { server: story.serverName, year: story.year })
          }
        />
      );
    default: {
      // Loading (or the first layout): the stage's shapes, no layout shift.
      const stage = Math.min(STAGE_WIDTH, width || STAGE_WIDTH);
      return (
        <View accessibilityLabel={t('year.loading')} accessibilityRole="progressbar">
          {phone ? (
            <View className="gap-5">
              <Skeleton className="h-[188px] rounded-sheet" />
              <SkeletonText lines={2} />
            </View>
          ) : (
            <View className={cn(width >= SIDE_BY_SIDE_MIN ? 'flex-row' : 'items-center', 'gap-12')}>
              <View style={{ width: stage, height: cardHeight(stage) }}>
                <Skeleton className="h-full w-full rounded-[28px]" testID="year-stage-skeleton" />
              </View>
              <View className="w-full min-w-0 flex-1 gap-4">
                <SkeletonText lines={3} />
              </View>
            </View>
          )}
        </View>
      );
    }
  }
}

/** Tablet and desktop: the story on stage beside (or over) its column. */
function YearStage({
  story,
  cid,
  width,
  pickers,
  privacy,
}: {
  story: Ready;
  cid: string;
  width: number;
  pickers: ReactNode;
  privacy: string;
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const screenReader = useScreenReaderEnabled();
  const share = useShareCard();
  const [held, setHeld] = useState(false);
  const player = useStoryPlayer(story.cards.length, {
    held: held || share.busy || screenReader,
    still: reduced,
  });
  const cardRef = useRef<View>(null);
  const side = width >= SIDE_BY_SIDE_MIN;
  const stageWidth = Math.min(STAGE_WIDTH, width);
  const column = side ? width - stageWidth - SIDE_GAP : width;
  const card = story.cards[player.index];

  return (
    <View
      className={side ? 'flex-row items-start' : 'items-center'}
      style={{ gap: side ? SIDE_GAP : 24 }}
    >
      <StoryStage
        cards={story.cards}
        copies={story.copies}
        player={player}
        width={stageWidth}
        connectionId={cid}
        cardRef={cardRef}
        plainCovers={share.coversOff}
        screenReader={screenReader}
        onHold={setHeld}
      />
      <View style={{ width: column }} className="gap-5">
        <View className="gap-2">
          <Text variant="eyebrow">{t('year.eyebrow')}</Text>
          <Text variant="display" accessibilityRole="header">
            {t('year.title', { year: story.year })}
          </Text>
          <Text variant="muted" className="max-w-[520px]">
            {Platform.OS === 'web' ? t('year.howToKeys') : t('year.howTo')} {privacy}
          </Text>
        </View>
        {pickers}
        <YearThumbs
          cards={story.cards}
          copies={story.copies}
          current={player.index}
          width={column}
          onSelect={player.goTo}
        />
        <Button
          title={t('year.share')}
          icon="share"
          loading={share.busy}
          className="self-start"
          onPress={() =>
            card &&
            void share.share(cardRef, {
              fileName: shareFileName(story.year, player.index, card.kind),
              title: t('year.shareTitle', { year: story.year }),
            })
          }
        />
      </View>
    </View>
  );
}

/** Phone: the year banner and the thumbnails; the story itself opens full screen. */
function YearIntro({
  story,
  width,
  pickers,
  privacy,
  onOpen,
}: {
  story: Ready;
  width: number;
  pickers: ReactNode;
  privacy: string;
  onOpen: (card: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="gap-5">
      <View className="overflow-hidden rounded-sheet p-[22px]" style={{ gap: 6 }}>
        <StoryBackground theme="dusk" />
        <StoryText
          className="font-sans-bold uppercase"
          style={{ fontSize: 12, lineHeight: 16, letterSpacing: 1.2, opacity: 0.8 }}
        >
          {t('year.ready')}
        </StoryText>
        <StoryText
          className="font-display"
          style={{ fontSize: 28, lineHeight: 30, letterSpacing: -0.8 }}
          accessibilityRole="header"
        >
          {t('year.bannerTitle', { year: story.year })}
        </StoryText>
        <StoryText style={{ fontSize: 14, lineHeight: 20, opacity: 0.85 }}>
          {t('year.bannerCards', { count: story.cards.length })}
        </StoryText>
        <Pressable
          role="button"
          onPress={() => onOpen(0)}
          className={cn(
            'mt-3 h-[46px] flex-row items-center self-start rounded-xl bg-white px-5 active:opacity-90',
            Platform.select({ web: `cursor-pointer ${FOCUS_RING_OFFSET_CLASS}` }),
          )}
        >
          <Text className="font-sans-semibold text-base" style={{ color: colors.light.foreground }}>
            {t('year.play')}
          </Text>
        </Pressable>
      </View>
      {pickers}
      <YearThumbs cards={story.cards} copies={story.copies} width={width} onSelect={onOpen} />
      <Text variant="caption">{privacy}</Text>
    </View>
  );
}
