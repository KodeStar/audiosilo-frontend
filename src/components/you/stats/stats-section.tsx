import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';

import {
  useCapabilitiesAll,
  useCapability,
  useLibrariesAll,
  useListeningGoal,
  useMyListening,
  useMyStats,
} from '@/api/hooks';
import { useApis, useCid } from '@/api/provider';
import type { ListeningGoalStatus, MyListening, UserStats } from '@/api/types';
import { listeningStreak, serverToday } from '@/components/home/listening';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { GhostSpines } from '@/components/ui/ghost-art';
import { Icon } from '@/components/ui/icon';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { formatDurationOrZero } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { FinishedShelf } from './finished-shelf';
import { ListeningCalendar } from './listening-calendar';
import { ListeningClock, usePeakWords } from './listening-clock';
import { RankList } from './rank-list';
import { GoalTile, StatTile } from './stat-tiles';
import { durationParts } from './stats-format';
import {
  clockSummary,
  columnWidth,
  dailyAverage,
  libraryForName,
  longestStreak,
  type RankKind,
  type RankRow,
  rankRows,
  statsColumns,
  statsServerChoice,
  weekComparison,
  weeklyTotals,
} from './stats-model';
import { WeeklyBars } from './weekly-bars';
import { YearBanner } from './year-banner';

/** A card's border and padding, each side (Card: `p-5` + a 1px hairline). */
const CARD_INSET = 21;
const GAP = 16;

/**
 * Your listening (the You hub's Stats section, STYLEGUIDE section 8 "Stat tile, listening
 * calendar, listening clock"): one server's own listening, in that server's time. The
 * default connection's, with a server picker when two or more signed-in servers keep
 * stats. A plain vertical stack with no scroller or page gutters of its own (the hub
 * provides both); it lays out by the width it is given, measured, not the window's.
 */
export function StatsSection() {
  const { t } = useTranslation();
  const apis = useApis();
  const caps = useCapabilitiesAll();
  const defaultId = useCid();
  const [picked, setPicked] = useState<string | null>(null);
  const window = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);
  const width = measured ?? Math.max(0, Math.min(window.width - 32, 1480));

  const ids = apis.map((a) => a.connection.id);
  const userStats = Object.fromEntries(
    ids.map((id) => [id, caps[id] ? !!caps[id]?.user_stats : undefined]),
  );
  const { cid, choices } = statsServerChoice({
    connectionIds: ids,
    userStats,
    defaultId,
    picked,
  });
  const nameOf = (id: string) => apis.find((a) => a.connection.id === id)?.connection.name ?? '';

  return (
    <View className="gap-4" onLayout={(e) => setMeasured(e.nativeEvent.layout.width)}>
      {choices.length > 1 ? (
        <SegmentedControl
          scrollable
          accessibilityLabel={t('stats.server.pick')}
          options={choices.map((id) => ({ value: id, label: nameOf(id) }))}
          value={cid}
          onChange={setPicked}
          className="self-start"
        />
      ) : null}
      {cid ? <StatsBody key={cid} cid={cid} server={nameOf(cid)} width={width} /> : null}
    </View>
  );
}

function StatsBody({ cid, server, width }: { cid: string; server: string; width: number }) {
  const { t } = useTranslation();
  const supported = useCapability('user_stats', cid);
  const listening = useMyListening('1y', cid);
  const stats = useMyStats('year', cid);
  const goal = useListeningGoal(cid);

  if (supported === false) {
    return (
      <Notice
        icon="circle-info"
        title={t('stats.unsupported.title')}
        body={t('stats.unsupported.body', { server })}
      />
    );
  }
  const today = listening.data ? serverToday(listening.data) : null;
  if (listening.isError || stats.isError || (listening.data && !today)) {
    return (
      <Card className="gap-3 p-6">
        <Text variant="title">{t('stats.error.title')}</Text>
        <Text variant="muted">{t('stats.error.body', { server })}</Text>
        <Button
          title={t('common.retry')}
          icon="rotate"
          variant="outline"
          onPress={() => {
            void listening.refetch();
            void stats.refetch();
            void goal.refetch();
          }}
          className="self-start"
        />
      </Card>
    );
  }
  if (supported !== true || !listening.data || !stats.data || !today) {
    return <StatsSkeleton width={width} />;
  }
  return (
    <StatsContent
      cid={cid}
      server={server}
      width={width}
      listening={listening.data}
      stats={stats.data}
      goal={goal.data}
      goalLoading={goal.isLoading}
      today={today}
    />
  );
}

function StatsContent({
  cid,
  server,
  width,
  listening,
  stats,
  goal,
  goalLoading,
  today,
}: {
  cid: string;
  server: string;
  width: number;
  listening: MyListening;
  stats: UserStats;
  goal: ListeningGoalStatus | undefined;
  goalLoading: boolean;
  today: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const open = useOpen();
  const wide = useLayout() !== 'phone';
  const libraries = useLibrariesAll().groups.find((g) => g.connectionId === cid)?.libraries;
  const compact = width < 640;
  const cols = statsColumns(width);
  const weeks = useMemo(() => weeklyTotals(listening.days, today), [listening.days, today]);
  const week = weekComparison(listening.days, today);
  const clock = useMemo(() => clockSummary(stats.hour_weekday), [stats.hour_weekday]);
  const peaks = usePeakWords(clock);
  const year = /^\d{4}$/.test(stats.range) ? stats.range : today.slice(0, 4);
  const openYear = () => open.openYou('year');

  const nothingYet = stats.totals.listened <= 0 && !listening.days.some((d) => d.listened > 0);
  const header = (
    <View className="flex-row flex-wrap items-end justify-between gap-3">
      <View className="min-w-0 flex-1 gap-1">
        <Text variant="eyebrow" numberOfLines={1}>
          {t('stats.header.eyebrow', { server })}
        </Text>
        <Text variant="display" accessibilityRole="header" style={tabularNums}>
          {t('stats.header.thisWeek', { duration: formatDurationOrZero(week.thisWeek) })}
        </Text>
      </View>
      {wide && !nothingYet ? (
        <Button
          variant="outline"
          icon="sparkles"
          title={t('stats.header.openYear', { year })}
          onPress={openYear}
        />
      ) : null}
    </View>
  );

  if (nothingYet) {
    return (
      <View className="gap-4">
        {header}
        <EmptyState
          variant="card"
          art={<GhostSpines />}
          title={t('stats.empty.title')}
          hint={t('stats.empty.body')}
        />
      </View>
    );
  }

  const tileGap = compact ? 10 : GAP;
  const tileW = columnWidth(width, cols.tiles, tileGap);
  const streak = listeningStreak(listening.days, today);
  const longest = longestStreak(stats.days);
  const average = dailyAverage(stats.days);
  const deltaText =
    week.delta === 0
      ? t('stats.tiles.deltaSame')
      : t(week.delta > 0 ? 'stats.tiles.deltaUp' : 'stats.tiles.deltaDown', {
          duration: formatDurationOrZero(Math.abs(week.delta)),
        });
  const thisWeekValue = formatDurationOrZero(week.thisWeek);
  const averageValue = formatDurationOrZero(average);

  const chartW = columnWidth(width, cols.charts, GAP);
  const rankW = columnWidth(width, cols.ranks, GAP);
  const firstLibrary = libraries?.[0]?.id ?? null;
  const openRank = (kind: RankKind) => (row: RankRow) => {
    const lib = libraryForName(stats, kind, row.name) ?? firstLibrary;
    if (lib === null) return;
    if (kind === 'author') open.openAuthor(cid, lib, row.name);
    else if (kind === 'narrator') open.openNarrator(cid, lib, row.name);
    else open.openSeries(cid, lib, { name: row.name });
  };
  const authors = rankRows(stats.top_authors);
  const narrators = rankRows(stats.top_narrators);
  const series = rankRows(stats.top_series);
  const ranks: { kind: RankKind; title: string; sub: string; rows: RankRow[] }[] = [
    {
      kind: 'author',
      title: t('stats.rank.authors'),
      sub: t('stats.rank.authorsSub'),
      rows: authors,
    },
    {
      kind: 'narrator',
      title: t('stats.rank.narrators'),
      sub: narrators[0]
        ? t('stats.rank.narratorsSub', {
            duration: formatDurationOrZero(narrators[0].listened),
            name: narrators[0].name,
          })
        : '',
      rows: narrators,
    },
    { kind: 'series', title: t('stats.rank.series'), sub: t('stats.rank.seriesSub'), rows: series },
  ];
  const shownRanks = ranks.filter((r) => r.rows.length > 0);

  return (
    <View className="gap-4">
      {header}

      <View className="flex-row flex-wrap" style={{ gap: tileGap }}>
        <StatTile
          icon="clock"
          label={t('stats.tiles.week')}
          parts={durationParts(week.thisWeek)}
          compact={compact}
          width={tileW}
          accessibilityLabel={`${t('stats.tiles.week')}, ${thisWeekValue}, ${deltaText}`}
          context={
            <Text
              variant="caption"
              numberOfLines={2}
              className={cn(week.delta > 0 && 'font-sans-semibold text-success')}
              style={tabularNums}
            >
              {week.delta > 0 ? '↑ ' : week.delta < 0 ? '↓ ' : ''}
              {deltaText}
            </Text>
          }
        />
        <StatTile
          icon="flame"
          label={t('stats.tiles.streak')}
          parts={[
            { n: String(streak), unit: t('stats.tiles.days', { count: streak }), spaced: true },
          ]}
          compact={compact}
          width={tileW}
          accessibilityLabel={`${t('stats.tiles.streak')}, ${t('stats.tiles.streakValue', { count: streak })}, ${t('stats.tiles.longest', { count: longest })}`}
          context={
            <Text variant="caption" numberOfLines={2} style={tabularNums}>
              {t('stats.tiles.longest', { count: longest })}
            </Text>
          }
        />
        {goal ? (
          <GoalTile cid={cid} status={goal} today={today} compact={compact} width={tileW} />
        ) : goalLoading ? (
          <View style={{ width: tileW }}>
            <Skeleton className="h-[112px] rounded-card" testID="goal-skeleton" />
          </View>
        ) : null}
        <StatTile
          icon="gauge"
          label={t('stats.tiles.average')}
          parts={durationParts(average)}
          compact={compact}
          width={tileW}
          accessibilityLabel={`${t('stats.tiles.average')}, ${averageValue}, ${t('stats.tiles.books', { count: stats.totals.books })}`}
          context={
            <Text variant="caption" numberOfLines={2} style={tabularNums}>
              {t('stats.tiles.books', { count: stats.totals.books })}
            </Text>
          }
        />
      </View>

      <Card className="gap-4">
        <View className="flex-row flex-wrap items-start justify-between gap-2">
          <SectionTitle title={t('stats.calendar.title')} sub={t('stats.calendar.sub')} />
          <View className="flex-row items-center gap-1.5">
            <Icon name="cloud" size={12} color={themed.subtleForeground} />
            <Text className="font-sans text-[11px] text-subtle-foreground">
              {t('stats.calendar.everyDevice')}
            </Text>
          </View>
        </View>
        <ListeningCalendar days={listening.days} today={today} width={width - CARD_INSET * 2} />
      </Card>

      <View className="flex-row flex-wrap" style={{ gap: GAP }}>
        <Card className="gap-3" style={{ width: chartW }}>
          <SectionTitle title={t('stats.clock.title')} sub={peaks ?? t('stats.clock.none')} />
          <View className="items-center">
            <ListeningClock
              summary={clock}
              size={Math.max(180, Math.min(compact ? 250 : 280, chartW - CARD_INSET * 2))}
            />
          </View>
        </Card>
        <Card className="gap-3" style={{ width: chartW }}>
          <SectionTitle
            title={t('stats.weeks.title')}
            sub={t('stats.weeks.sub', {
              duration: formatDurationOrZero(weeks.reduce((s, v) => s + v, 0)),
            })}
          />
          <WeeklyBars weeks={weeks} width={chartW - CARD_INSET * 2} />
        </Card>
      </View>

      {shownRanks.length ? (
        <View className="flex-row flex-wrap" style={{ gap: GAP }}>
          {shownRanks.map((r, i) => (
            <Card
              key={r.kind}
              className="gap-1.5"
              // A last card alone on its row takes the whole row.
              style={{
                width:
                  i === shownRanks.length - 1 &&
                  cols.ranks > 1 &&
                  shownRanks.length % cols.ranks === 1
                    ? width
                    : rankW,
              }}
            >
              <SectionTitle title={r.title} sub={r.sub} small />
              <RankList rows={r.rows} kind={r.kind} onOpen={openRank(r.kind)} />
            </Card>
          ))}
        </View>
      ) : null}

      <Card className="gap-3">
        <View className="flex-row flex-wrap items-start justify-between gap-2">
          <SectionTitle
            title={t('stats.finished.title')}
            sub={
              stats.totals.finished > 0
                ? t('stats.finished.count', { count: stats.totals.finished })
                : t('stats.finished.none')
            }
          />
          {/* Ink, not a pink link: the page's pink is the clock and this week's bar. */}
          <Button variant="ghost" size="sm" onPress={() => open.openJournal()}>
            <Text>{t('stats.finished.journal')}</Text>
            <Icon name="chevron-right" size={14} color={themed.foreground} />
          </Button>
        </View>
        {stats.finished_books.length ? (
          <FinishedShelf
            books={stats.finished_books}
            onOpen={(b) => open.openBook(cid, b.library_id, b.path)}
          />
        ) : null}
      </Card>

      <YearBanner
        year={year}
        summary={t('stats.year.summary', {
          duration: formatDurationOrZero(stats.totals.listened),
          count: stats.totals.finished,
        })}
        onPress={openYear}
      />
    </View>
  );
}

function SectionTitle({ title, sub, small }: { title: string; sub: ReactNode; small?: boolean }) {
  return (
    <View className="min-w-0 shrink gap-0.5">
      <Text variant={small ? 'title' : 'heading'} accessibilityRole="header">
        {title}
      </Text>
      {sub ? (
        <Text variant={small ? 'caption' : 'muted'} style={tabularNums}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

/** The loading state: placeholders shaped like the header, the tiles, the calendar and
 * the two charts, at their sizes (no shift when the data lands). */
function StatsSkeleton({ width }: { width: number }) {
  const cols = statsColumns(width);
  const compact = width < 640;
  const tileGap = compact ? 10 : GAP;
  const tileW = columnWidth(width, cols.tiles, tileGap);
  const chartW = columnWidth(width, cols.charts, GAP);
  return (
    <View className="gap-4" testID="stats-skeleton">
      <View className="gap-2">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-8 w-64" />
      </View>
      <View className="flex-row flex-wrap" style={{ gap: tileGap }}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={{ width: tileW }}>
            <Skeleton className="h-[112px] rounded-card" />
          </View>
        ))}
      </View>
      <Skeleton className="h-[230px] rounded-card" />
      <View className="flex-row flex-wrap" style={{ gap: GAP }}>
        {[0, 1].map((i) => (
          <View key={i} style={{ width: chartW }}>
            <Skeleton className="h-[330px] rounded-card" />
          </View>
        ))}
      </View>
    </View>
  );
}
