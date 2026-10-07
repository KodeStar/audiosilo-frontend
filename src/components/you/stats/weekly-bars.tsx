import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';

import { Text } from '@/components/ui/text';
import { formatDuration, formatDurationOrZero } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { ChartPointer, ChartTip, TipText } from './chart-pointer';
import { BARS_FRAME, barAt, niceAxis } from './stats-model';

/** A bar `w` x `h` standing at `x`, `bottom`, its top corners rounded `r`. */
function barPath(x: number, bottom: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  const top = bottom - h;
  return `M${x} ${bottom} L${x} ${top + rr} Q${x} ${top} ${x + rr} ${top} L${x + w - rr} ${top} Q${x + w} ${top} ${x + w} ${top + rr} L${x + w} ${bottom}Z`;
}

/**
 * Hours per week (STYLEGUIDE section 8, "Weekly bars"): the last 12 seven-day windows as
 * 18 px bars with 4 px rounded tops, this week in `brand` and the rest ink, on a dashed
 * hour grid; the week under the pointer or a tap in a tooltip. One image with every week
 * spelled out for assistive tech.
 */
export function WeeklyBars({ weeks, width }: { weeks: readonly number[]; width: number }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const [tip, setTip] = useState<number | null>(null);
  const { height, left, bottom, top: pad, bar } = BARS_FRAME;
  const { top, ticks } = niceAxis(Math.max(0, ...weeks));
  const plot = height - bottom - pad;
  const y = (v: number) => height - bottom - (v / top) * plot;
  const pitch = (width - left) / weeks.length;
  const centre = (i: number) => left + i * pitch + pitch / 2;
  const ago = (i: number) => weeks.length - 1 - i;
  const weekName = (i: number) =>
    ago(i) === 0 ? t('stats.weeks.thisWeek') : t('stats.weeks.weeksAgo', { count: ago(i) });
  const label = t('stats.weeks.label', {
    weeks: weeks.map((v, i) => `${weekName(i)}: ${formatDurationOrZero(v)}`).join(', '),
  });

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width, height }}>
      <Svg width={width} height={height} pointerEvents="none">
        {ticks.map((v) => (
          <Line
            key={v}
            x1={left}
            x2={width}
            y1={y(v)}
            y2={y(v)}
            stroke={themed.border}
            strokeDasharray="2 4"
          />
        ))}
        {weeks.map((v, i) => {
          const now = ago(i) === 0;
          return (
            <Path
              key={i}
              d={barPath(centre(i) - bar / 2, height - bottom, bar, (v / top) * plot, 4)}
              fill={now ? themed.brand : themed.foreground}
              fillOpacity={(now ? 1 : 0.22) * (tip === null || tip === i ? 1 : 0.6)}
            />
          );
        })}
      </Svg>
      {ticks.map((v) => (
        <Text
          key={v}
          pointerEvents="none"
          className="absolute text-right font-sans text-[11px] text-muted-foreground"
          style={[tabularNums, { left: 0, width: left - 6, top: y(v) - 8 }]}
        >
          {v === 0 ? '0' : formatDuration(v)}
        </Text>
      ))}
      {weeks.map((_, i) =>
        ago(i) % 3 === 0 ? (
          <Text
            key={i}
            pointerEvents="none"
            numberOfLines={1}
            className={cn(
              'absolute font-sans text-[11px] text-muted-foreground',
              ago(i) === 0 ? 'text-right' : 'text-center',
            )}
            // This week's label ends at the chart's edge rather than past it.
            style={{
              left: ago(i) === 0 ? width - 72 : centre(i) - 36,
              width: 72,
              top: height - bottom + 5,
            }}
          >
            {ago(i) === 0
              ? t('stats.weeks.thisWeekShort')
              : t('stats.weeks.agoShort', { count: ago(i) })}
          </Text>
        ) : null,
      )}
      <ChartPointer
        testID="bars-pointer"
        width={width}
        height={height - bottom}
        onPoint={(p) => setTip(p ? barAt(width, p.x, weeks.length) : null)}
      />
      {tip !== null ? (
        <ChartTip testID="bars-tip" x={centre(tip)} y={y(weeks[tip])} boundsWidth={width}>
          <TipText value={formatDurationOrZero(weeks[tip])} label={weekName(tip)} />
        </ChartTip>
      ) : null}
    </View>
  );
}
