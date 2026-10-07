import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import type { RatingValue } from '@/api/types';
import { FOCUS_RING_CLASS } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

const VALUES: readonly RatingValue[] = [1, 2, 3, 4, 5];

/** A five-point star on a 24 grid. Drawn here because the vendored glyph set has no star
 * yet (adding one needs the FontAwesome generator); swap it for `<Icon name="star">`
 * once it is vendored. */
const STAR =
  'M12 2.6l2.9 5.88 6.5.94-4.7 4.58 1.1 6.47L12 17.42l-5.8 3.05 1.1-6.47-4.7-4.58 6.5-.94z';

/**
 * "How was it?": 1-5 stars as a radio group (STYLEGUIDE: star ratings are `warning`,
 * targets 44 pt). `value` is the saved rating (undefined: none); pressing a star rates
 * the book. Each star is a radio named "N stars", checked when it is the rating.
 */
export function RatingStars({
  value,
  onRate,
  disabled,
  size = 26,
}: {
  value: RatingValue | undefined;
  onRate: (value: RatingValue) => void;
  disabled?: boolean;
  size?: number;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <View
      role="radiogroup"
      accessibilityLabel={t('player.finished.ratingLabel')}
      className="flex-row"
    >
      {VALUES.map((n) => {
        const on = (value ?? 0) >= n;
        return (
          <Pressable
            key={n}
            role="radio"
            aria-checked={value === n}
            accessibilityState={{ checked: value === n, disabled }}
            accessibilityLabel={t('player.finished.stars', { count: n })}
            disabled={disabled}
            onPress={() => onRate(n)}
            className={cn(
              'h-11 w-11 items-center justify-center rounded-full active:bg-accent',
              Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
            )}
          >
            <Svg width={size} height={size} viewBox="0 0 24 24">
              <Path
                d={STAR}
                fill={on ? themed.warning : 'none'}
                stroke={on ? themed.warning : themed.subtleForeground}
                strokeWidth={1.6}
                strokeLinejoin="round"
              />
            </Svg>
          </Pressable>
        );
      })}
    </View>
  );
}
