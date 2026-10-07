import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { useDomId } from '@/lib/use-dom-id';
import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';

/** The banner's fixed deep ink and its two glows (the light theme's ink and its blue and
 * violet chart colours: no pink, the page's pink is the clock and this week's bar). */
const INK = colors.light.primary;
const GLOW_A = colors.light.chart5;
const GLOW_B = colors.light.chart2;

/**
 * The Year in listening banner at the foot of Your listening (the prototype's "Your 2026
 * in listening ... Play the story"): a washed ink card, white type, one action. The whole
 * card opens the Year section.
 */
export function YearBanner({
  year,
  summary,
  onPress,
}: {
  year: string;
  /** One sentence from the year's real figures. */
  summary: string;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const a = useDomId('yb-a');
  const b = useDomId('yb-b');
  return (
    <Pressable
      role="button"
      accessibilityLabel={`${t('stats.year.title', { year })}. ${summary}`}
      accessibilityHint={t('stats.year.play')}
      onPress={onPress}
      className={cn(
        'overflow-hidden rounded-dialog',
        Platform.select({ web: `cursor-pointer ${FOCUS_RING_OFFSET_CLASS}` }),
      )}
      style={{ backgroundColor: INK }}
    >
      <Svg width="100%" height="100%" style={{ position: 'absolute' }} pointerEvents="none">
        <Defs>
          <RadialGradient id={a} cx="0" cy="0" rx="0.8" ry="1.2">
            <Stop offset={0} stopColor={GLOW_A} stopOpacity={0.75} />
            <Stop offset={1} stopColor={GLOW_A} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={b} cx="1" cy="1" rx="0.7" ry="1">
            <Stop offset={0} stopColor={GLOW_B} stopOpacity={0.75} />
            <Stop offset={1} stopColor={GLOW_B} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${a})`} />
        <Rect width="100%" height="100%" fill={`url(#${b})`} />
      </Svg>
      <View className="flex-row flex-wrap items-center justify-between gap-4 p-6">
        <View className="min-w-[200px] flex-1 gap-1.5">
          <Text variant="eyebrow" style={{ color: colors.white, opacity: 0.7 }}>
            {t('stats.year.eyebrow')}
          </Text>
          <Text
            className="font-display text-[28px] leading-[30px] tracking-tight"
            style={{ color: colors.white }}
          >
            {t('stats.year.title', { year })}
          </Text>
          <Text className="font-sans text-sm" style={{ color: colors.white, opacity: 0.85 }}>
            {summary}
          </Text>
        </View>
        <View
          className="h-[46px] flex-row items-center gap-2 rounded-control border px-4"
          style={{
            backgroundColor: 'rgba(255,255,255,0.14)',
            borderColor: 'rgba(255,255,255,0.28)',
          }}
        >
          <Text className="font-sans-semibold text-base" style={{ color: colors.white }}>
            {t('stats.year.play')}
          </Text>
          <Icon name="chevron-right" size={16} color={colors.white} />
        </View>
      </View>
    </Pressable>
  );
}
