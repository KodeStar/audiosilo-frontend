import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CapabilityError, useClearListeningGoal, useSetListeningGoal } from '@/api/hooks';
import type { ListeningGoalStatus } from '@/api/types';
import { goalProgress } from '@/components/home/listening';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon, type IconName } from '@/components/ui/icon';
import { ProgressRing } from '@/components/ui/progress-ring';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { touchTarget } from '@/components/ui/touch-target';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { GOAL_MAX, GOAL_MIN, nextGoal, suggestedGoal } from './stats-model';

/** A stat value's figure and unit ("23" "days"), the unit set small: right after the
 * figure ("11h"), or after a space when it is a word (`spaced`: "23 days", "19 of 30"). */
export type ValuePart = { n: string; unit?: string; spaced?: boolean };

/** The stat value (STYLEGUIDE section 4 "Stat": Bricolage 32, 25 on a phone), figures big
 * and units small and muted. */
export function StatValue({ parts, compact }: { parts: readonly ValuePart[]; compact: boolean }) {
  return (
    <Text
      numberOfLines={1}
      className={cn(
        'font-display tracking-tight text-foreground',
        compact ? 'text-[25px] leading-[28px]' : 'text-[32px] leading-[34px]',
      )}
      style={tabularNums}
    >
      {/* Figures are plain strings, so they keep the outer text's style (a nested themed
          Text would reset them to its body variant). */}
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? ' ' : ''}
          {p.n}
          {p.unit ? (
            <Text
              className={cn(
                'font-sans-semibold text-muted-foreground',
                compact ? 'text-sm' : 'text-base',
              )}
            >
              {p.spaced ? ` ${p.unit}` : p.unit}
            </Text>
          ) : null}
        </Fragment>
      ))}
    </Text>
  );
}

function TileLabel({ icon, label }: { icon: IconName; label: string }) {
  const themed = useThemeColors();
  return (
    <View className="flex-row items-center gap-1.5">
      <Icon name={icon} size={14} color={themed.mutedForeground} />
      <Text className="font-sans-semibold text-[12.5px] text-muted-foreground">{label}</Text>
    </View>
  );
}

/**
 * A stat tile (STYLEGUIDE section 8): a label with its icon, the value, one line of
 * context or a delta. Reads as one element: "label, value, context".
 */
export function StatTile({
  icon,
  label,
  parts,
  context,
  accessibilityLabel,
  compact,
  width,
}: {
  icon: IconName;
  label: string;
  parts: readonly ValuePart[];
  context: ReactNode;
  accessibilityLabel: string;
  compact: boolean;
  width: number;
}) {
  return (
    <Card
      accessible
      accessibilityLabel={accessibilityLabel}
      className={cn('gap-1.5', compact ? 'p-3.5' : 'px-5 py-[18px]')}
      style={{ width }}
    >
      <TileLabel icon={icon} label={label} />
      <StatValue parts={parts} compact={compact} />
      {context}
    </Card>
  );
}

/**
 * The yearly goal tile: an ink ring of books finished of the goal (the page's pink is
 * the clock and this week's bar), the figure, and -/+ that save the goal straight away
 * (each step one PUT, run in order; the figure follows the last one asked for), and a
 * way to clear it. Without a goal, "Set a yearly goal" starts one from this year's pace.
 */
export function GoalTile({
  cid,
  status,
  today,
  compact,
  width,
}: {
  cid: string;
  status: ListeningGoalStatus;
  today: string;
  compact: boolean;
  width: number;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const setGoal = useSetListeningGoal(cid);
  const clearGoal = useClearListeningGoal(cid);
  const failed = (e: unknown) => {
    if (!(e instanceof CapabilityError)) toast({ title: t('stats.goal.saveFailed') });
  };
  const save = (books: number) => setGoal.mutate(books, { onError: failed });
  // While a step is on its way, show (and step on from) the value asked for.
  const pending = setGoal.isPending ? setGoal.variables : undefined;
  const shown: ListeningGoalStatus =
    pending !== undefined
      ? { ...status, goal: { books_per_year: pending, updated_at: '' } }
      : clearGoal.isPending
        ? { ...status, goal: null }
        : status;
  const progress = goalProgress(shown, today);
  const target = touchTarget(1.75, 1.875);
  const small = compact || width < 240;

  if (!progress) {
    return (
      <Card className={cn('gap-2', compact ? 'p-3.5' : 'px-5 py-[18px]')} style={{ width }}>
        <TileLabel icon="target" label={t('stats.goal.label')} />
        <Text variant="muted" style={tabularNums}>
          {t('stats.goal.none', { count: status.finished })}
        </Text>
        <Button
          variant="outline"
          size="sm"
          icon="plus"
          title={t('stats.goal.set')}
          className="self-start"
          onPress={() => save(suggestedGoal(status.finished, today))}
        />
      </Card>
    );
  }

  const step = (dir: 1 | -1, icon: IconName, label: string, disabled: boolean) => (
    <Button
      variant="outline"
      size="sm"
      icon={icon}
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={target.hitSlop}
      className={cn('h-7 w-[30px] px-0', target.frameClass)}
      onPress={() => save(nextGoal(progress.goal, dir))}
    />
  );
  const percent = Math.round(progress.fraction * 100);
  const buttons = (
    <View className="flex-row items-center gap-1">
      {step(-1, 'minus', t('stats.goal.lower'), progress.goal <= GOAL_MIN)}
      {step(1, 'plus', t('stats.goal.raise'), progress.goal >= GOAL_MAX)}
      <Button
        variant="ghost"
        size="sm"
        icon="close"
        accessibilityLabel={t('stats.goal.clear')}
        hitSlop={target.hitSlop}
        className={cn('h-7 w-[30px] px-0', target.frameClass)}
        onPress={() => clearGoal.mutate(undefined, { onError: failed })}
      />
    </View>
  );

  return (
    <Card className={cn('gap-2.5', compact ? 'p-3.5' : 'px-5 py-[18px]')} style={{ width }}>
      <View className="flex-row items-center gap-3.5">
        <ProgressRing
          fraction={progress.fraction}
          size={small ? 48 : 62}
          stroke={small ? 5 : 6}
          color={themed.foreground}
          trackColor={themed.mutedForeground}
          trackOpacity={0.22}
        >
          <Text
            className={cn('font-display text-foreground', small ? 'text-[12px]' : 'text-[15px]')}
            style={tabularNums}
          >
            {t('stats.goal.percent', { percent })}
          </Text>
        </ProgressRing>
        <View className="min-w-0 flex-1 gap-1.5">
          <View
            accessible
            accessibilityLabel={t('stats.goal.a11y', {
              count: progress.finished,
              goal: progress.goal,
              percent,
            })}
            className="gap-1"
          >
            <TileLabel icon="target" label={t('stats.goal.label')} />
            <StatValue
              parts={[
                {
                  n: String(progress.finished),
                  unit: t('stats.goal.of', { goal: progress.goal }),
                  spaced: true,
                },
              ]}
              compact={small}
            />
          </View>
          {small ? null : buttons}
        </View>
      </View>
      {small ? buttons : null}
    </Card>
  );
}
