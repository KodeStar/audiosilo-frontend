import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatTimeOfDay } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { isBedtime } from '@/playback/auto-sleep-controller';
import { useSleepTimer } from '@/playback/sleep-timer';
import { ScopedThemeColors, useThemeColors } from '@/theme/use-theme-colors';

/**
 * Kids mode's bedtime card (the prototype's moon card): "Bedtime is at 19:30", and what
 * happens then. Inside the bedtime window (until 06:00, `isBedtime`, re-read every 30 s)
 * it says it is bedtime, and that the sleep timer comes on when a story starts, or, while
 * a timer runs, the minutes it has left; before it, what bedtime does.
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
  // A duration timer counting down (the bedtime rule arms one): its minutes left, rounded
  // up, so "1 minute" lasts until the fade.
  const minutesLeft = useSleepTimer((s) =>
    (s.phase === 'running' || s.phase === 'ending') && s.endsAt !== null && s.remaining !== null
      ? Math.max(1, Math.ceil(s.remaining / 60))
      : null,
  );
  return (
    <View
      accessible
      testID="kids-moon-card"
      className="flex-row items-center gap-4 rounded-[24px] border border-border bg-card px-5 py-4"
    >
      <Icon name="moon" size={30} color={themed.warning} />
      <View className="flex-1 gap-1">
        <Text className="font-display text-xl text-foreground">
          {inside
            ? t('kids.bedtime.nowTitle')
            : t('kids.bedtime.at', { time: formatTimeOfDay(bedtime) })}
        </Text>
        <Text className="font-sans text-base text-muted-foreground">
          {minutesLeft !== null
            ? t('kids.bedtime.timerLeft', { count: minutesLeft })
            : inside
              ? t('kids.bedtime.now')
              : t('kids.bedtime.later')}
        </Text>
      </View>
    </View>
  );
}
