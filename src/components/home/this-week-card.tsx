import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { useCapability, useListeningGoal, useMyListening } from '@/api/hooks';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { formatServerDay } from './dates';
import { goalProgress, lastSevenDays, listeningStreak, serverToday } from './listening';

/** Tallest weekday bar, in points. */
const BAR_MAX = 46;

/**
 * This week (STYLEGUIDE section 8, stat tiles): the yearly goal as a ring, hours over the
 * last seven days, the listening streak and a bar per day, all from the DEFAULT server's
 * own stats in that server's time. Renders nothing without `user_stats` (and nothing
 * while that is not known yet); a goal-less listener gets their finished count instead
 * of a ring (setting a goal belongs to the You pages).
 */
export function ThisWeekCard({ className }: { className?: string }) {
  const { t } = useTranslation();
  const supported = useCapability('user_stats');
  const listening = useMyListening('1y');
  const goal = useListeningGoal();
  // A tablet's full-width card puts the bars beside the figures, not under them.
  const wide = useLayout() === 'tablet';
  if (supported !== true) return null;
  const data = listening.data;
  if (!data) {
    if (listening.isError) return null; // a quiet extra: nothing to retry here
    return <Skeleton className={cn('h-[252px] rounded-dialog', className)} />;
  }
  const today = serverToday(data);
  if (!today) return null;
  const week = lastSevenDays(data.days, today);
  const hours = week.reduce((sum, d) => sum + d.listened, 0);
  const streak = listeningStreak(data.days, today);
  const progress = goal.data ? goalProgress(goal.data, today) : null;
  const letters = t('home.week.weekdayLetters').split(',');

  const figures = (
    <View className="flex-row items-center gap-3.5">
      {progress ? (
        <GoalRing fraction={progress.fraction} finished={progress.finished} goal={progress.goal} />
      ) : null}
      <View className="min-w-0 flex-1">
        <Text
          className="font-display text-[26px] leading-[28px] tracking-tight text-foreground"
          style={tabularNums}
          accessibilityLabel={t('home.week.hoursLabel', {
            duration: formatDuration(hours) || '0m',
          })}
        >
          {formatDuration(hours) || '0m'}
        </Text>
        <Text variant="muted" style={tabularNums}>
          {streak > 0 ? t('home.week.streak', { count: streak }) : t('home.week.noStreak')}
        </Text>
      </View>
    </View>
  );
  const goalLine = progress ? (
    <Text variant="caption" style={tabularNums}>
      {progress.everyDays
        ? t('home.week.goalBehind', {
            count: progress.remaining,
            goal: progress.goal,
            every: t('home.week.every', { count: progress.everyDays }),
          })
        : t('home.week.goalReached', { goal: progress.goal })}
    </Text>
  ) : goal.data ? (
    <Text variant="caption" style={tabularNums}>
      {t('home.week.finishedThisYear', { count: goal.data.finished })}
    </Text>
  ) : null;
  const bars = <WeekBars week={week} letters={letters} />;

  return (
    <View
      accessibilityLabel={t('home.week.title')}
      className={cn('gap-3 rounded-dialog border border-border bg-card p-5', className)}
    >
      <Text variant="eyebrow">{t('home.week.title')}</Text>
      {wide ? (
        <View className="flex-row items-end gap-8">
          <View className="min-w-0 flex-1 gap-3">
            {figures}
            {goalLine}
          </View>
          <View className="w-[300px]">{bars}</View>
        </View>
      ) : (
        <>
          {figures}
          {bars}
          {goalLine}
        </>
      )}
    </View>
  );
}

/** The goal ring: books finished this year of the goal, the arc in pink. */
function GoalRing({
  fraction,
  finished,
  goal,
}: {
  fraction: number;
  finished: number;
  goal: number;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const size = 70;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('home.week.goalLabel', { count: finished, goal })}
      style={{ width: size, height: size }}
      className="items-center justify-center"
    >
      <Svg
        width={size}
        height={size}
        style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}
      >
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={themed.mutedForeground}
          strokeOpacity={0.22}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={themed.brand}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${length} ${length}`}
          strokeDashoffset={length * (1 - fraction)}
          fill="none"
        />
      </Svg>
      <Text className="font-display text-[19px] leading-[20px] text-foreground" style={tabularNums}>
        {finished}
      </Text>
      <Text
        className="font-sans-semibold text-[10px] leading-[12px] text-subtle-foreground"
        style={tabularNums}
      >
        {t('home.week.ofGoal', { goal })}
      </Text>
    </View>
  );
}

/** A bar per day of the last seven, today in ink and the rest quiet. One image, with
 * every day spelled out for assistive tech. */
function WeekBars({
  week,
  letters,
}: {
  week: ReturnType<typeof lastSevenDays>;
  letters: string[];
}) {
  const { t } = useTranslation();
  const max = Math.max(1, ...week.map((d) => d.listened));
  const label = week
    .map((d) => `${formatServerDay(d.date)}: ${formatDuration(d.listened) || '0m'}`)
    .join(', ');
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('home.week.barsLabel', { days: label })}
      className="h-16 flex-row items-end gap-1.5"
    >
      {week.map((d) => (
        <View key={d.date} className="h-full flex-1 items-center justify-end gap-[5px]">
          <View
            className={cn(
              'w-full max-w-[22px] rounded-t-[5px] rounded-b-[3px]',
              d.today ? 'bg-foreground' : 'bg-foreground/15',
            )}
            style={{ height: Math.max(6, (d.listened / max) * BAR_MAX) }}
          />
          <Text className="font-sans-semibold text-[10.5px] text-subtle-foreground">
            {letters[d.weekday] ?? ''}
          </Text>
        </View>
      ))}
    </View>
  );
}
