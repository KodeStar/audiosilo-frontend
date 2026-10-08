import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { formatDurationOrZero, formatHour } from '@/lib/format';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { ChartPointer } from './chart-pointer';
import { ClockFace } from './clock-face';
import {
  type ClockSummary,
  clockAxis,
  clockCentreWidth,
  clockGeometry,
  petalAt,
} from './stats-model';

/** The words for a clock's peak windows ("07:00-09:00 and 22:00-23:00"), or null without
 * listening. */
export function usePeakWords(summary: ClockSummary): string | null {
  const { t } = useTranslation();
  const span = ({ from, to }: { from: number; to: number }) =>
    from === to ? t('stats.clock.allDay') : `${formatHour(from)}-${formatHour(to)}`;
  const [a, b] = summary.windows;
  if (!a) return null;
  return b
    ? t('stats.clock.peaksTwo', { a: span(a), b: span(b) })
    : t('stats.clock.peaksOne', { a: span(a) });
}

/**
 * The listening clock (STYLEGUIDE section 8): 24 radial petals from 00 at the top, each
 * as long as that hour's listening this year, the peaks in `brand` (the style guide's
 * one place for pink here) and the rest ink; the busiest hour in the centre, or the
 * hour under the pointer or a tap. One image with a text summary for assistive tech.
 */
export function ListeningClock({ summary, size }: { summary: ClockSummary; size: number }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const [hour, setHour] = useState<number | null>(null);
  const { c, r0 } = clockGeometry(size);
  const peaks = usePeakWords(summary);
  const shown = hour ?? summary.busiest;
  // Every centre line gets the same definite width (see `clockCentreWidth`).
  const line = { width: clockCentreWidth(size), textAlign: 'center' } as const;
  const label =
    summary.busiest === null
      ? t('stats.clock.labelEmpty')
      : t('stats.clock.label', { hour: formatHour(summary.busiest), peaks: peaks ?? '' });

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width: size, height: size }}
    >
      <ClockFace
        size={size}
        hours={summary.hours}
        ring={themed.border}
        fill={(p) => ({
          color: p.peak ? themed.brand : themed.foreground,
          opacity: (p.peak ? 1 : 0.3) * (hour === null || hour === p.hour ? 1 : 0.5),
        })}
      />
      {clockAxis(size).map(({ hour: h, x, y }) => (
        <Text
          key={h}
          pointerEvents="none"
          className="absolute w-6 text-center font-sans text-[11px] text-muted-foreground"
          style={[tabularNums, { left: x - 12, top: y - 8 }]}
        >
          {String(h).padStart(2, '0')}
        </Text>
      ))}
      <View
        pointerEvents="none"
        className="absolute items-center justify-center"
        style={{ left: c - r0, top: c - r0, width: r0 * 2, height: r0 * 2 }}
      >
        {shown === null ? (
          <Text variant="caption" style={line} numberOfLines={3} testID="clock-caption">
            {t('stats.clock.none')}
          </Text>
        ) : (
          <>
            <Text
              className="font-display text-foreground"
              style={[tabularNums, line, { fontSize: size * 0.075, lineHeight: size * 0.085 }]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {formatHour(shown)}
            </Text>
            <Text variant="caption" style={line} numberOfLines={2} testID="clock-caption">
              {hour === null
                ? t('stats.clock.busiest')
                : t('stats.clock.hourTotal', {
                    duration: formatDurationOrZero(summary.hours[hour]),
                  })}
            </Text>
          </>
        )}
      </View>
      <ChartPointer
        testID="clock-pointer"
        width={size}
        height={size}
        onPoint={(p) => setHour(p ? petalAt(size, p.x, p.y) : null)}
      />
    </View>
  );
}
