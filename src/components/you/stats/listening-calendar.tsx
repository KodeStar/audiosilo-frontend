import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import type { ListeningDay } from '@/api/types';
import { HORIZONTAL_SCROLLER } from '@/components/ui/horizontal-scroller';
import { Text } from '@/components/ui/text';
import { formatDurationOrZero } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import { ChartPointer, ChartTip, TipText } from './chart-pointer';
import { formatServerShortDay } from './stats-format';
import {
  CALENDAR_WEEKS,
  type CalendarCell,
  calendarCellAt,
  calendarGrid,
  daysWithListening,
} from './stats-model';

/** The heatmap ramp (STYLEGUIDE: `--seq-0..5`), as literal classes for the compiler. */
const SEQ = ['bg-seq-0', 'bg-seq-1', 'bg-seq-2', 'bg-seq-3', 'bg-seq-4', 'bg-seq-5'] as const;

const GAP = 3;
const MIN_CELL = 11;
const MAX_CELL = 16;
/** The weekday labels' column and its gap to the grid. */
const DAYS_COLUMN = 30;
const MONTHS_ROW = 18;

/**
 * The listening calendar (STYLEGUIDE section 8): 53 weeks of rounded squares on the
 * `seq` ramp, Monday at the top, month and weekday labels, today outlined, the day under
 * the pointer (web) or the tap (everywhere) in a tooltip, a Less/More legend and how
 * many days had listening. Fills `width`; below the minimum cell size it scrolls
 * sideways and starts at today.
 */
export function ListeningCalendar({
  days,
  today,
  width,
}: {
  days: readonly ListeningDay[];
  today: string;
  width: number;
}) {
  const { t } = useTranslation();
  const grid = useMemo(() => calendarGrid(days, today), [days, today]);
  const [tip, setTip] = useState<CalendarCell | null>(null);
  const scroller = useRef<ScrollView>(null);
  const room = Math.max(0, width - DAYS_COLUMN);
  const cell = Math.max(
    MIN_CELL,
    Math.min(MAX_CELL, Math.floor((room - GAP * (CALENDAR_WEEKS - 1)) / CALENDAR_WEEKS)),
  );
  const pitch = cell + GAP;
  const gridWidth = CALENDAR_WEEKS * pitch - GAP;
  const gridHeight = 7 * pitch - GAP;
  const months = t('stats.calendar.months').split(',');
  const weekdays = t('stats.calendar.weekdays').split(',');
  const listenedDays = daysWithListening(days);
  const place = (c: CalendarCell) => {
    const i = grid.columns.findIndex((col) => col.includes(c));
    const r = grid.columns[i].indexOf(c);
    return { x: i * pitch, y: r * pitch };
  };
  const todayCell = grid.columns.flat().find((c) => c?.today) ?? null;

  const body = (
    <View style={{ width: gridWidth, height: MONTHS_ROW + gridHeight }}>
      {grid.months.map((m) => (
        <Text
          key={m.column}
          className="absolute font-sans-semibold text-[11px] text-subtle-foreground"
          style={{ left: m.column * pitch, top: 0 }}
        >
          {months[m.month] ?? ''}
        </Text>
      ))}
      <View
        pointerEvents="none"
        className="absolute flex-row"
        style={{ top: MONTHS_ROW, gap: GAP }}
      >
        {grid.columns.map((col, c) => (
          <View key={c} style={{ gap: GAP }}>
            {col.map((d, r) => (
              <View
                key={r}
                className={cn('rounded-[3px]', d ? SEQ[d.level] : undefined)}
                style={{ width: cell, height: cell }}
              />
            ))}
          </View>
        ))}
      </View>
      {todayCell ? (
        <View
          pointerEvents="none"
          className="absolute rounded-[5px] border-2 border-foreground"
          style={{
            left: place(todayCell).x - 3,
            top: MONTHS_ROW + place(todayCell).y - 3,
            width: cell + 6,
            height: cell + 6,
          }}
        />
      ) : null}
      <ChartPointer
        testID="calendar-pointer"
        top={MONTHS_ROW}
        width={gridWidth}
        height={gridHeight}
        onPoint={(p) => setTip(p ? calendarCellAt(grid, p.x, p.y, cell, GAP) : null)}
      />
      {tip ? (
        <ChartTip
          testID="calendar-tip"
          x={place(tip).x + cell / 2}
          y={MONTHS_ROW + place(tip).y}
          boundsWidth={gridWidth}
        >
          <TipText
            value={tip.listened > 0 ? formatDurationOrZero(tip.listened) : t('stats.calendar.none')}
            label={formatServerShortDay(tip.date)}
          />
        </ChartTip>
      ) : null}
    </View>
  );

  return (
    <View className="gap-3">
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={t('stats.calendar.label', { count: listenedDays })}
        className="flex-row"
      >
        <View style={{ width: DAYS_COLUMN, paddingTop: MONTHS_ROW, gap: GAP }}>
          {weekdays.map((d, i) => (
            <Text
              key={i}
              numberOfLines={1}
              className="font-sans-semibold text-[10.5px] text-subtle-foreground"
              style={{ height: cell, lineHeight: cell }}
            >
              {d}
            </Text>
          ))}
        </View>
        {gridWidth > room ? (
          <ScrollView
            ref={scroller}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={HORIZONTAL_SCROLLER}
            // Start at today, the right-hand end.
            onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
          >
            {body}
          </ScrollView>
        ) : (
          body
        )}
      </View>
      <View className="flex-row flex-wrap items-center justify-between gap-2.5">
        <Text variant="caption" style={tabularNums}>
          {t('stats.calendar.days', { count: listenedDays })}
        </Text>
        <View
          className="flex-row items-center gap-1.5"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text variant="caption">{t('stats.calendar.less')}</Text>
          {SEQ.map((c) => (
            <View key={c} className={cn('h-[11px] w-[11px] rounded-[3px]', c)} />
          ))}
          <Text variant="caption">{t('stats.calendar.more')}</Text>
        </View>
      </View>
    </View>
  );
}
