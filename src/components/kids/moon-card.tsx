import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatTimeOfDay } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { isBedtime } from '@/playback/auto-sleep-controller';
import { ScopedThemeColors, useThemeColors } from '@/theme/use-theme-colors';

/**
 * Kids mode's bedtime card (the prototype's moon card): "Bedtime is at 19:30", and what
 * happens then. Inside the bedtime window (until 06:00, `isBedtime`, re-read every 30 s)
 * it says the sleep timer comes on when a story starts; before it, what bedtime does.
 */
export function MoonCard({ bedtime }: { bedtime: string }) {
  return (
    // The night sky in both themes (Home's Previously on card does the same): a bright card
    // would be the brightest thing on a child's screen at bedtime in dark mode.
    <ScopedThemeColors theme="dark">
      <MoonCardBody bedtime={bedtime} />
    </ScopedThemeColors>
  );
}

function MoonCardBody({ bedtime }: { bedtime: string }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const now = useNow(30_000);
  const inside = isBedtime(bedtime, new Date(now));
  return (
    <View
      accessible
      testID="kids-moon-card"
      className="flex-row items-center gap-4 rounded-[24px] border border-border bg-card px-5 py-4"
    >
      <Icon name="moon" size={30} color={themed.warning} />
      <View className="flex-1 gap-1">
        <Text className="font-display text-xl text-foreground">
          {t('kids.bedtime.at', { time: formatTimeOfDay(bedtime) })}
        </Text>
        <Text className="font-sans text-base text-muted-foreground">
          {inside ? t('kids.bedtime.now') : t('kids.bedtime.later')}
        </Text>
      </View>
    </View>
  );
}
