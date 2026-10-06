import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Distance between the hatch lines, across them (the prototype's 10px stripes). */
const HATCH = 10;

/** The hatch's 45-degree lines across a `size` square, as [x1, y1, x2, y2]. */
export function hatchLines(size: number): [number, number, number, number][] {
  const step = HATCH * Math.SQRT2;
  const out: [number, number, number, number][] = [];
  for (let x = step; x < size * 2; x += step) out.push([x, 0, x - size, size]);
  return out;
}

/**
 * A book the listener doesn't have (STYLEGUIDE section 8, "Ghost cover"): a hatched
 * muted square with a 1.5px dashed outline, the position ("Book 3"), the REAL title from
 * the community series data, and "Not in your library". `elsewhere` tints it `info`
 * with a server icon and "On <server>": the book is on another connected server. Never
 * fake art for a book that isn't there. Sized like `BookCover` (square, radius 5).
 */
export function GhostCover({
  title,
  position,
  width,
  server,
  className,
}: {
  title: string;
  /** Its place in the series ("3", "2.5"); absent when it has none. */
  position?: string | number;
  width: number;
  /** The connected server that has it (the `info` variant), if any. */
  server?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const elsewhere = !!server;
  const note = elsewhere ? t('covers.onServer', { server }) : t('covers.notInLibrary');
  const has = position !== undefined && position !== '';
  // A thumbnail (a list row's 56-72) has room for the number and title only; the note
  // stays in the accessible name.
  const small = width < 100;
  // Type scales with the cover (the prototype's container units), with readable floors.
  const fs = (k: number, min: number) => Math.max(min, Math.round(width * k));
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={
        has
          ? t('covers.ghostLabelNumbered', { title, position, note })
          : t('covers.ghostLabel', { title, note })
      }
      style={{ width, height: width }}
      className={cn(
        'items-center justify-center overflow-hidden rounded-cover border-[1.5px] border-dashed',
        elsewhere ? 'border-info/70 bg-info-soft' : 'border-subtle-foreground bg-muted',
        className,
      )}
    >
      <Svg width={width} height={width} style={{ position: 'absolute', left: 0, top: 0 }}>
        {hatchLines(width).map(([x1, y1, x2, y2]) => (
          <Line
            key={x1}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={elsewhere ? themed.info : themed.borderStrong}
            strokeOpacity={elsewhere ? 0.18 : 0.45}
            strokeWidth={1}
          />
        ))}
      </Svg>
      <View className="items-center gap-1 px-[10%]">
        {has ? (
          <Text
            className={cn(
              'font-sans-bold uppercase tracking-wider',
              elsewhere ? 'text-info' : 'text-subtle-foreground',
            )}
            style={{ fontSize: fs(0.06, 9) }}
            numberOfLines={1}
          >
            {t('covers.bookNumber', { position })}
          </Text>
        ) : null}
        <Text
          className="text-center font-display text-foreground"
          style={{ fontSize: fs(0.1, 12), lineHeight: fs(0.105, 13) }}
          numberOfLines={small ? 2 : 3}
        >
          {title}
        </Text>
        {small ? null : (
          <View className="flex-row items-center gap-1">
            {elsewhere ? <Icon name="server" size={fs(0.06, 10)} color={themed.info} /> : null}
            <Text
              className={cn(
                'text-center font-sans-semibold',
                elsewhere ? 'text-info' : 'text-muted-foreground',
              )}
              style={{ fontSize: fs(0.054, 9) }}
              numberOfLines={2}
            >
              {note}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}
