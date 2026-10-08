import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { Portrait } from '@/components/series/portrait';
import { Cover } from '@/components/ui/cover';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { formatDurationOrZero } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import type { RankKind, RankRow } from './stats-model';

const THUMB = 40;

/**
 * A rank list (STYLEGUIDE section 8: "top authors, narrators, series use portraits/covers
 * + an ink bar"): the rank, a portrait (authors, narrators) or the series' monogram cover,
 * the name over an ink bar as long as its share of the first, and the hours. Each row
 * opens that author's, narrator's or series' page.
 */
export function RankList({
  rows,
  kind,
  onOpen,
}: {
  rows: readonly RankRow[];
  kind: RankKind;
  onOpen: (row: RankRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <View>
      {rows.map((row) => (
        <Pressable
          key={row.name}
          role="button"
          accessibilityLabel={t('stats.rank.rowLabel', {
            rank: row.rank,
            name: row.name,
            duration: formatDurationOrZero(row.listened),
            count: row.books,
          })}
          accessibilityHint={t(`stats.rank.open.${kind}`)}
          onPress={() => onOpen(row)}
          className={cn(
            'min-h-[56px] flex-row items-center gap-3 rounded-control py-2 active:bg-accent',
            Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
          )}
        >
          <Text
            className="w-[22px] text-center font-display text-[15px] text-subtle-foreground"
            style={tabularNums}
          >
            {row.rank}
          </Text>
          {kind === 'series' ? (
            <View
              style={{ width: THUMB, height: THUMB }}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Cover label={row.name} size={THUMB} rounded="rounded-cover" />
            </View>
          ) : (
            <Portrait name={row.name} kind={kind} size={THUMB} />
          )}
          <View className="min-w-0 flex-1 gap-[5px]">
            <Text variant="label" numberOfLines={1}>
              {row.name}
            </Text>
            <View className="h-1.5 overflow-hidden rounded-full bg-muted">
              <View
                className="h-full rounded-full bg-foreground/80"
                style={{ width: `${Math.max(2, row.fraction * 100)}%` }}
              />
            </View>
          </View>
          <Text className="font-sans-semibold text-sm text-foreground" style={tabularNums}>
            {formatDurationOrZero(row.listened)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
