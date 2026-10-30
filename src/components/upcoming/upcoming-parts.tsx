import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { formatReleaseDate } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { railPositionLabel } from '@/lib/series-position';
import type { SourcedUpcomingItem } from '@/lib/upcoming';
import { cn } from '@/lib/utils';

import { UpcomingCover } from './upcoming-cover';

/**
 * An upcoming item's date line by its kind: a preorder "Out 12 Nov 2026", a release
 * "Released 3 Oct 2026", a missing volume "First released 2014" (the metadata's one date is
 * the work's first release); none without a date.
 */
export function upcomingDateLabel(
  item: Pick<SourcedUpcomingItem, 'kind' | 'release_date'>,
  t: TFunction,
): string {
  if (!item.release_date) return '';
  const date = formatReleaseDate(item.release_date);
  if (item.kind === 'preorder') return t('upcoming.out', { date });
  if (item.kind === 'released') return t('upcoming.released', { date });
  return t('upcoming.firstReleased', { date });
}

/** "The Expanse, book 10" ("The Expanse" when it has no number). */
function upcomingSeriesLine(item: Pick<SourcedUpcomingItem, 'series'>, t: TFunction) {
  const position = railPositionLabel(item.series.position);
  return position
    ? t('upcoming.seriesBook', { series: item.series.name, position })
    : item.series.name;
}

/** Opens the item's series page: the caller's local series by name, pinned to the work. */
function useOpenItem() {
  const { openSeries } = useOpen();
  return (item: SourcedUpcomingItem) =>
    openSeries(item.connectionId, item.local.library_id, {
      name: item.local.series,
      work: item.work.id,
    });
}

/** The "New" badge (first listed in the last seven days). */
function NewBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge variant="brand" className={className} testID="upcoming-new">
      <Text>{t('upcoming.new')}</Text>
    </Badge>
  );
}

type ItemProps = {
  item: SourcedUpcomingItem;
  /** First listed within the last seven days (`isNewUpcoming`). */
  isNew: boolean;
  /** The server it came from, when more than one is connected (`useServerFlag`). */
  server?: string;
};

/** An item's lines, worked out once per render: the series line, the date line, the
 * server line (when several are connected), and what it says to a screen reader. */
function useItemText({ item, isNew, server }: ItemProps) {
  const { t } = useTranslation();
  const seriesLine = upcomingSeriesLine(item, t);
  const date = upcomingDateLabel(item, t);
  const from = server ? t('upcoming.fromServer', { server }) : '';
  const label = [item.work.title, seriesLine, date, isNew ? t('upcoming.new') : '', from]
    .filter(Boolean)
    .join(', ');
  return { seriesLine, date, from, label };
}

/**
 * The Home rail's tile: the work's community cover when its server serves it, else a ghost
 * cover (`UpcomingCover`: never fake art, the book is on none of the listener's servers),
 * the title, the series and number, the date line, and the server when several are
 * connected. Opens the series page.
 */
export function UpcomingTile({ width, ...props }: ItemProps & { width: number }) {
  const open = useOpenItem();
  const { item, isNew } = props;
  const { seriesLine, date, from, label } = useItemText(props);
  return (
    <AnimatedPressable
      onPress={() => open(item)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ width }}
      className="gap-2.5 rounded-cover"
      testID="upcoming-tile"
    >
      <View>
        <UpcomingCover item={item} width={width} />
        {isNew ? <NewBadge className="absolute left-[7px] top-[7px]" /> : null}
      </View>
      <View className="gap-0.5">
        <Text variant="label" numberOfLines={2}>
          {item.work.title}
        </Text>
        <Text variant="caption" numberOfLines={1}>
          {seriesLine}
        </Text>
        {date ? (
          <Text variant="caption" numberOfLines={1}>
            {date}
          </Text>
        ) : null}
        {from ? (
          <Text variant="caption" numberOfLines={1}>
            {from}
          </Text>
        ) : null}
      </View>
    </AnimatedPressable>
  );
}

/** The Upcoming screen's row (an item of its section's list): the cover thumbnail, title,
 * series and number, the date line, the "New" badge and the server. Opens the series page. */
export function UpcomingRow({ first, ...props }: ItemProps & { first?: boolean }) {
  const open = useOpenItem();
  const phone = useLayout() === 'phone';
  const { item, isNew } = props;
  const { seriesLine, date, from, label } = useItemText(props);
  const meta = [date, from].filter(Boolean).join(' · ');
  return (
    <View role="listitem" className={cn(!first && 'border-t border-border')}>
      <AnimatedPressable
        onPress={() => open(item)}
        accessibilityRole="button"
        accessibilityLabel={label}
        className="flex-row items-center gap-3 py-3"
        testID="upcoming-row"
      >
        <UpcomingCover item={item} width={phone ? 56 : 72} />
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
            <Text variant="label" className="shrink text-[15px]" numberOfLines={2}>
              {item.work.title}
            </Text>
            {isNew ? <NewBadge /> : null}
          </View>
          <Text variant="caption" numberOfLines={1}>
            {seriesLine}
          </Text>
          {meta ? (
            <Text variant="caption" numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </AnimatedPressable>
    </View>
  );
}
